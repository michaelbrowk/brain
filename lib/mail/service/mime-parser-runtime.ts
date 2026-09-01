import { createHash, randomBytes } from "node:crypto";
import type { Duplex, Readable } from "node:stream";

import { MailParser } from "mailparser";

import type {
  MailBlobDescriptor,
  MailMimeWorkerRequest,
  ParsedMailAttachmentDisposition,
} from "../ports";
import {
  MAIL_RESOURCE_LIMITS,
  validateMailMimeParseRequest,
} from "../security";
import { sanitizeMailHtmlWithRemoteImages } from "./mail-html-sanitizer";
import {
  BMP1_FRAME,
  BMP1_MAX_DATA_BYTES,
  decodeBmp1Json,
  readBmp1Frames,
  writeBmp1Frame,
  writeBmp1JsonFrame,
} from "./mime-protocol";

interface ParserTextItem {
  readonly type: "text";
  readonly text?: string;
  readonly html?: string;
}

interface ParserAttachmentItem {
  readonly type: "attachment";
  readonly content: Readable;
  readonly contentType?: string;
  readonly contentDisposition?: string;
  readonly filename?: string;
  readonly contentId?: string;
  readonly cid?: string;
  release(): void;
}

type ParserItem = ParserTextItem | ParserAttachmentItem;

interface ArtifactBegin {
  readonly kind: "text" | "sanitized_html" | "remote_images" | "attachment";
  readonly filename?: string | null;
  readonly mimeType?: string;
  readonly disposition?: ParsedMailAttachmentDisposition;
  readonly contentId?: string | null;
}

class WorkerProtocolError extends Error {
  constructor(
    readonly category: "transient" | "permanent" | "integrity",
    readonly errorCode:
      | "mail_mime_worker_timeout"
      | "mail_mime_integrity_failed"
      | "mail_mime_invalid"
      | "mail_mime_limit_exceeded",
  ) {
    super(errorCode);
    this.name = "WorkerProtocolError";
  }
}

/** Handles one BMP1 connection. Production systemd starts one process per connection. */
export async function runMimeParserWorkerConnection(socket: Duplex): Promise<void> {
  let request: MailMimeWorkerRequest | null = null;
  let parser: MailParser | null = null;
  let parserOutput: Promise<{
    attachments: number;
    text: boolean;
    html: boolean;
    remoteImages: number;
  }> | null =
    null;
  let rawBytes = 0;
  const rawHash = createHash("sha256");
  let rawEnded = false;

  try {
    const frames = readBmp1Frames(socket)[Symbol.asyncIterator]();
    while (true) {
      const next = await frames.next();
      if (next.done) break;
      const frame = next.value;
      assertBeforeDeadline(request);
      if (request === null) {
        if (frame.type !== BMP1_FRAME.request) throw permanentInvalid();
        request = parseWorkerRequest(frame.payload);
        parser = createParser(request);
        parserOutput = collectParserOutput(parser, socket, request);
        void parserOutput.catch(() => undefined);
        continue;
      }
      if (rawEnded || parser === null || parserOutput === null) throw permanentInvalid();
      if (frame.type === BMP1_FRAME.rawData) {
        if (frame.payload.length === 0) throw permanentInvalid();
        if (
          rawBytes + frame.payload.length > request.rawMime.bytes ||
          rawBytes + frame.payload.length > request.budget.maxRawBytes
        ) {
          throw permanentLimit();
        }
        rawBytes += frame.payload.length;
        rawHash.update(frame.payload);
        await writeParserChunk(parser, frame.payload);
        continue;
      }
      if (frame.type !== BMP1_FRAME.rawEnd || frame.payload.length !== 0) {
        throw permanentInvalid();
      }
      rawEnded = true;
      if (
        rawBytes !== request.rawMime.bytes ||
        rawHash.digest("hex") !== request.rawMime.sha256
      ) {
        throw integrityFailure();
      }
      parser.end();
      const output = await parserOutput;
      assertBeforeDeadline(request);
      await writeBmp1JsonFrame(socket, BMP1_FRAME.done, output);
      socket.end();
      return;
    }
    if (!rawEnded) throw permanentInvalid();
  } catch (error) {
    parser?.destroy();
    await parserOutput?.catch(() => undefined);
    const mapped = mapWorkerError(error);
    await writeBmp1JsonFrame(socket, BMP1_FRAME.error, mapped).catch(
      () => undefined,
    );
    socket.end();
  }
}

function createParser(request: MailMimeWorkerRequest): MailParser {
  return new MailParser({
    checksumAlgo: "sha256",
    keepCidLinks: true,
    skipHtmlToText: true,
    maxHtmlLengthToParse: request.budget.maxHtmlCharacters,
    maxHeadSize: request.budget.maxHeaderBytes,
    maxTotalHeadSize: request.budget.maxHeaderBytes,
    maxChildNodes: request.budget.maxParts,
    maxNestingDepth: request.budget.maxDepth,
    // mailsplit applies this guard to body lines as well as headers. A bounded
    // raw message can legitimately contain one long HTML or base64 body line,
    // while maxHeadSize/maxTotalHeadSize still enforce the tighter header
    // budget independently.
    maxLineSize: request.budget.maxRawBytes,
    maxDecodedBytes: request.budget.maxDecodedBytes,
    maxHtmlCharacters: request.budget.maxHtmlCharacters,
    maxTextCharacters: request.budget.maxTextCharacters,
  });
}

async function collectParserOutput(
  parser: MailParser,
  socket: Duplex,
  request: MailMimeWorkerRequest,
): Promise<{
  attachments: number;
  text: boolean;
  html: boolean;
  remoteImages: number;
}> {
  let attachments = 0;
  let hasText = false;
  let hasHtml = false;
  let remoteImages = 0;
  let outputBytes = 0;
  let addressCount = 0;
  parser.once("headers", (headers: Map<string, unknown>) => {
    addressCount = countAddresses(headers);
    if (addressCount > request.budget.maxAddresses) parser.destroy(permanentLimit());
  });

  for await (const value of parser as AsyncIterable<ParserItem>) {
    assertBeforeDeadline(request);
    if (value.type === "attachment") {
      attachments++;
      if (attachments > request.budget.maxParts) throw permanentLimit();
      const contentId = normalizeContentId(value.contentId ?? value.cid);
      const begin: ArtifactBegin = Object.freeze({
        kind: "attachment",
        filename: normalizeMetadata(value.filename),
        mimeType: normalizeMimeType(value.contentType),
        disposition: normalizeDisposition(value.contentDisposition, contentId),
        contentId,
      });
      try {
        outputBytes = await sendArtifact(
          socket,
          begin,
          value.content,
          outputBytes,
          request.budget.maxDecodedBytes,
          request,
        );
      } finally {
        value.release();
      }
      continue;
    }

    const text = normalizeText(value.text);
    if (text !== null) {
      if (text.length > request.budget.maxTextCharacters) throw permanentLimit();
      outputBytes = await sendArtifact(
        socket,
        { kind: "text" },
        chunksFor(Buffer.from(text, "utf8")),
        outputBytes,
        request.budget.maxDecodedBytes,
        request,
      );
      hasText = true;
    }
    if (typeof value.html === "string" && value.html.length > 0) {
      if (value.html.length > request.budget.maxHtmlCharacters) throw permanentLimit();
      const sanitized = sanitizeMailHtmlWithRemoteImages(
        value.html,
        {
          maxCharacters: request.budget.maxHtmlCharacters,
          maxNodes: request.budget.maxDomNodes,
          maxAttributes: request.budget.maxDomAttributes,
          maxRemoteImages: request.budget.maxRemoteImages,
        },
        () => `remote-image-a${randomBytes(16).toString("hex")}`,
      );
      if (sanitized.html !== null) {
        outputBytes = await sendArtifact(
          socket,
          { kind: "sanitized_html" },
          chunksFor(Buffer.from(sanitized.html, "utf8")),
          outputBytes,
          request.budget.maxDecodedBytes,
          request,
        );
        hasHtml = true;
      }
      if (sanitized.remoteImages.length > 0) {
        const manifest = Buffer.from(JSON.stringify(sanitized.remoteImages), "utf8");
        try {
          if (manifest.byteLength > MAIL_RESOURCE_LIMITS.maxRemoteImageManifestBytes) {
            throw permanentLimit();
          }
          outputBytes = await sendArtifact(
            socket,
            { kind: "remote_images" },
            chunksFor(manifest),
            outputBytes,
            request.budget.maxDecodedBytes,
            request,
          );
        } finally {
          manifest.fill(0);
        }
        remoteImages = sanitized.remoteImages.length;
      }
    }
  }
  if (addressCount > request.budget.maxAddresses) throw permanentLimit();
  return Object.freeze({
    attachments,
    text: hasText,
    html: hasHtml,
    remoteImages,
  });
}

async function sendArtifact(
  socket: Duplex,
  begin: ArtifactBegin,
  chunks: AsyncIterable<Uint8Array>,
  priorOutputBytes: number,
  maxOutputBytes: number,
  request: MailMimeWorkerRequest,
): Promise<number> {
  await writeBmp1JsonFrame(socket, BMP1_FRAME.artifactBegin, begin);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const candidate of chunks) {
    assertBeforeDeadline(request);
    if (!(candidate instanceof Uint8Array)) throw permanentInvalid();
    let offset = 0;
    while (offset < candidate.byteLength) {
      const end = Math.min(offset + BMP1_MAX_DATA_BYTES, candidate.byteLength);
      const chunk = Buffer.from(
        candidate.buffer,
        candidate.byteOffset + offset,
        end - offset,
      );
      if (priorOutputBytes + bytes + chunk.length > maxOutputBytes) throw permanentLimit();
      hash.update(chunk);
      bytes += chunk.length;
      await writeBmp1Frame(socket, BMP1_FRAME.artifactData, chunk);
      offset = end;
    }
  }
  const descriptor: MailBlobDescriptor = Object.freeze({
    sha256: hash.digest("hex"),
    bytes,
  });
  await writeBmp1JsonFrame(socket, BMP1_FRAME.artifactEnd, descriptor);
  return priorOutputBytes + bytes;
}

function parseWorkerRequest(payload: Buffer): MailMimeWorkerRequest {
  try {
    return validateMailMimeParseRequest(
      decodeBmp1Json(payload) as MailMimeWorkerRequest,
      Date.now(),
    );
  } catch {
    throw permanentInvalid();
  }
}

function writeParserChunk(parser: MailParser, chunk: Buffer): Promise<void> {
  const owned = Buffer.from(chunk);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error | null) => {
      if (settled) return;
      settled = true;
      parser.off("error", onError);
      if (error) reject(error);
      else resolve();
    };
    const onError = (error: Error) => {
      finish(error);
    };
    parser.once("error", onError);
    parser.write(owned, (error) => finish(error));
  }).finally(() => owned.fill(0));
}

function countAddresses(headers: Map<string, unknown>): number {
  let count = 0;
  for (const key of ["from", "to", "cc", "bcc", "reply-to"]) {
    const value = headers.get(key);
    if (!isPlainRecord(value) || !Array.isArray(value.value)) continue;
    count += countAddressList(value.value);
  }
  return count;
}

function countAddressList(values: readonly unknown[]): number {
  let count = 0;
  for (const value of values) {
    if (!isPlainRecord(value)) continue;
    if (typeof value.address === "string" && value.address.length > 0) count++;
    if (Array.isArray(value.group)) count += countAddressList(value.group);
  }
  return count;
}

function normalizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  return normalized.length === 0 ? null : normalized;
}

function normalizeMetadata(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 512);
  return normalized.length === 0 ? null : normalized;
}

function normalizeContentId(value: unknown): string | null {
  const metadata = normalizeMetadata(value);
  if (metadata === null) return null;
  const normalized = metadata.replace(/^<|>$/g, "").trim();
  return /^[\x21-\x7e]{1,512}$/.test(normalized) ? normalized : null;
}

function normalizeMimeType(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 127 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(value)
  ) {
    return "application/octet-stream";
  }
  return value.toLowerCase();
}

function normalizeDisposition(
  value: unknown,
  contentId: string | null,
): ParsedMailAttachmentDisposition {
  if (value === "attachment") return "attachment";
  return value === "inline" || (value == null && contentId !== null)
    ? "inline"
    : "attachment";
}

async function* chunksFor(value: Buffer): AsyncIterable<Uint8Array> {
  try {
    if (value.length > 0) yield value;
  } finally {
    value.fill(0);
  }
}

function assertBeforeDeadline(request: MailMimeWorkerRequest | null): void {
  if (request !== null && Date.now() >= request.budget.deadlineAt) {
    throw new WorkerProtocolError("transient", "mail_mime_worker_timeout");
  }
}

function permanentInvalid(): WorkerProtocolError {
  return new WorkerProtocolError("permanent", "mail_mime_invalid");
}

function permanentLimit(): WorkerProtocolError {
  return new WorkerProtocolError("permanent", "mail_mime_limit_exceeded");
}

function integrityFailure(): WorkerProtocolError {
  return new WorkerProtocolError("integrity", "mail_mime_integrity_failed");
}

function mapWorkerError(error: unknown): {
  readonly category: "transient" | "permanent" | "integrity";
  readonly errorCode:
    | "mail_mime_worker_timeout"
    | "mail_mime_integrity_failed"
    | "mail_mime_invalid"
    | "mail_mime_limit_exceeded";
} {
  if (error instanceof WorkerProtocolError) {
    return Object.freeze({ category: error.category, errorCode: error.errorCode });
  }
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "EMAXLEN"
  ) {
    return Object.freeze({
      category: "permanent" as const,
      errorCode: "mail_mime_limit_exceeded" as const,
    });
  }
  return Object.freeze({
    category: "permanent" as const,
    errorCode: "mail_mime_invalid" as const,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
