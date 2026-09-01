import { createHash } from "node:crypto";
import { createConnection, type Socket } from "node:net";

import type {
  IsolatedMailParserPort,
  MailBlobDescriptor,
  MailMimeParseOutcome,
  MailMimeParseRequest,
  MailMimePermanentErrorCode,
  MailMimeTransientErrorCode,
  MailMimeWorkerRequest,
  ParsedMailArtifactSet,
  ParsedMailAttachment,
  ParsedMailAttachmentDisposition,
  ParsedMailRemoteImage,
  ParsedMailStagedBlob,
} from "../ports";
import {
  MAIL_RESOURCE_LIMITS,
  validateMailMimeParseRequest,
  validateParsedMailArtifactSet,
} from "../security";
import {
  BMP1_FRAME,
  BMP1_MAX_DATA_BYTES,
  decodeBmp1Json,
  readBmp1Frames,
  writeBmp1Frame,
  writeBmp1JsonFrame,
} from "./mime-protocol";

const DEFAULT_PARSER_SOCKET = "/run/brain-mail-mime/brain-mail-mime.sock";

interface CurrentArtifact {
  readonly begin: ArtifactBegin;
  readonly chunks: Buffer[];
  bytes: number;
  readonly hash: ReturnType<typeof createHash>;
}

interface ArtifactBegin {
  readonly kind: "text" | "sanitized_html" | "remote_images" | "attachment";
  readonly filename: string | null;
  readonly mimeType: string | null;
  readonly disposition: ParsedMailAttachmentDisposition | null;
  readonly contentId: string | null;
}

class ParseFailure extends Error {
  constructor(
    readonly outcome: Exclude<MailMimeParseOutcome, { readonly kind: "parsed" }>,
  ) {
    super(outcome.errorCode);
    this.name = "ParseFailure";
  }
}

export class UnixSocketMailMimeParser implements IsolatedMailParserPort {
  readonly isolation = Object.freeze({
    networkAccess: false as const,
    credentialAccess: false as const,
    sandboxVersion: 1,
  });
  private readonly socketPath: string;

  constructor(options: { readonly socketPath?: string } = {}) {
    this.socketPath = validateSocketPath(options.socketPath ?? DEFAULT_PARSER_SOCKET);
  }

  async parse(request: MailMimeParseRequest): Promise<MailMimeParseOutcome> {
    let projected: MailMimeWorkerRequest;
    try {
      projected = validateMailMimeParseRequest(request, Date.now());
      if (!isAsyncIterable(request.rawMimeStream) || !isAbortSignal(request.signal)) {
        return permanentFailure("mail_mime_invalid");
      }
    } catch {
      return permanentFailure("mail_mime_invalid");
    }
    if (request.signal.aborted) return transientFailure("mail_mime_aborted");

    let socket: Socket;
    try {
      socket = await connectToWorker(this.socketPath);
    } catch {
      return transientFailure("mail_mime_worker_unavailable");
    }

    let terminal: MailMimeTransientErrorCode | null = null;
    const abort = () => {
      terminal = "mail_mime_aborted";
      socket.destroy();
    };
    request.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      terminal = "mail_mime_worker_timeout";
      socket.destroy();
    }, Math.max(1, projected.budget.deadlineAt - Date.now()));
    timeout.unref();

    try {
      await writeBmp1JsonFrame(socket, BMP1_FRAME.request, projected);
      const sendTask = settle("send", sendRawMime(socket, request, projected));
      const receiveTask = settle(
        "receive",
        receiveWorkerResponse(socket, projected),
      );
      const first = await Promise.race([sendTask, receiveTask]);
      if (first.error !== null) {
        if (first.source === "send" && !(first.error instanceof ParseFailure)) {
          const remote = await Promise.race([
            receiveTask,
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 25)),
          ]);
          if (remote !== null && remote.error instanceof ParseFailure) {
            socket.destroy();
            throw remote.error;
          }
        }
        socket.destroy();
        if (first.source === "receive") await sendTask;
        throw first.error;
      }
      const second = first.source === "send" ? await receiveTask : await sendTask;
      if (second.error !== null) {
        if (
          first.source === "receive" &&
          first.error === null &&
          first.value !== null
        ) {
          zeroParsedArtifacts(first.value);
        }
        throw second.error;
      }
      const artifacts =
        first.source === "receive"
          ? first.value
          : second.source === "receive"
            ? second.value
            : null;
      if (artifacts === null) throw integrity();
      try {
        return Object.freeze({
          kind: "parsed" as const,
          artifacts: validateParsedMailArtifactSet(artifacts),
        });
      } catch (error) {
        zeroParsedArtifacts(artifacts);
        throw error;
      }
    } catch (error) {
      if (terminal !== null) return transientFailure(terminal);
      if (error instanceof ParseFailure) return error.outcome;
      return transientFailure("mail_mime_worker_crashed");
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abort);
      socket.destroy();
    }
  }
}

async function settle<T, S extends "send" | "receive">(
  source: S,
  promise: Promise<T>,
): Promise<
  | { readonly source: S; readonly value: T; readonly error: null }
  | { readonly source: S; readonly value: null; readonly error: unknown }
> {
  try {
    return { source, value: await promise, error: null };
  } catch (error) {
    return { source, value: null, error };
  }
}

async function sendRawMime(
  socket: Socket,
  request: MailMimeParseRequest,
  projected: MailMimeWorkerRequest,
): Promise<void> {
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const candidate of request.rawMimeStream) {
      if (request.signal.aborted) throw transient("mail_mime_aborted");
      if (!(candidate instanceof Uint8Array)) throw integrity();
      let offset = 0;
      while (offset < candidate.byteLength) {
        const end = Math.min(offset + BMP1_MAX_DATA_BYTES, candidate.byteLength);
        const chunk = Buffer.from(
          candidate.buffer,
          candidate.byteOffset + offset,
          end - offset,
        );
        if (
          bytes + chunk.length > projected.rawMime.bytes ||
          bytes + chunk.length > projected.budget.maxRawBytes
        ) {
          throw integrity();
        }
        hash.update(chunk);
        bytes += chunk.length;
        if (chunk.length > 0) await writeBmp1Frame(socket, BMP1_FRAME.rawData, chunk);
        offset = end;
      }
    }
  } catch (error) {
    if (error instanceof ParseFailure) throw error;
    throw transient("mail_mime_source_unavailable");
  }
  if (
    bytes !== projected.rawMime.bytes ||
    hash.digest("hex") !== projected.rawMime.sha256
  ) {
    throw integrity();
  }
  await writeBmp1Frame(socket, BMP1_FRAME.rawEnd);
}

async function receiveWorkerResponse(
  socket: Socket,
  request: MailMimeWorkerRequest,
): Promise<ParsedMailArtifactSet> {
  let current: CurrentArtifact | null = null;
  let text: ParsedMailStagedBlob | null = null;
  let sanitizedHtml: ParsedMailStagedBlob | null = null;
  let remoteImages: readonly ParsedMailRemoteImage[] | null = null;
  const attachments: ParsedMailAttachment[] = [];
  let aggregateBytes = 0;
  let completed = false;

  try {
    for await (const frame of readBmp1Frames(socket)) {
      if (frame.type === BMP1_FRAME.error) throw parseRemoteFailure(frame.payload);
      if (frame.type === BMP1_FRAME.artifactBegin) {
        if (current !== null) throw integrity();
        current = {
          begin: parseArtifactBegin(frame.payload),
          chunks: [],
          bytes: 0,
          hash: createHash("sha256"),
        };
        continue;
      }
      if (frame.type === BMP1_FRAME.artifactData) {
        if (current === null || frame.payload.length === 0) throw integrity();
        if (
          aggregateBytes + current.bytes + frame.payload.length >
          request.budget.maxDecodedBytes
        ) {
          throw integrity();
        }
        const owned = Buffer.from(frame.payload);
        current.hash.update(owned);
        current.bytes += owned.length;
        current.chunks.push(owned);
        continue;
      }
      if (frame.type === BMP1_FRAME.artifactEnd) {
        if (current === null) throw integrity();
        const descriptor = parseDescriptor(frame.payload);
        if (
          descriptor.bytes !== current.bytes ||
          descriptor.sha256 !== current.hash.digest("hex")
        ) {
          throw integrity();
        }
        aggregateBytes += current.bytes;
        const begin = current.begin;
        const data = Buffer.concat(current.chunks, current.bytes);
        zeroCurrentArtifact(current);
        current = null;
        const blob = Object.freeze({ descriptor, data });
        if (begin.kind === "text") {
          if (text !== null || descriptor.bytes === 0) {
            data.fill(0);
            throw integrity();
          }
          text = blob;
        } else if (begin.kind === "sanitized_html") {
          if (sanitizedHtml !== null || descriptor.bytes === 0) {
            data.fill(0);
            throw integrity();
          }
          sanitizedHtml = blob;
        } else if (begin.kind === "remote_images") {
          if (remoteImages !== null || descriptor.bytes === 0) {
            data.fill(0);
            throw integrity();
          }
          try {
            remoteImages = parseRemoteImageManifest(data, request.budget.maxRemoteImages);
          } finally {
            data.fill(0);
          }
        } else {
          if (
            begin.mimeType === null ||
            begin.disposition === null ||
            attachments.length >= request.budget.maxParts
          ) {
            data.fill(0);
            throw integrity();
          }
          attachments.push(
            Object.freeze({
              filename: begin.filename,
              mimeType: begin.mimeType,
              disposition: begin.disposition,
              contentId: begin.contentId,
              blob,
            }),
          );
        }
        continue;
      }
      if (frame.type === BMP1_FRAME.done) {
        if (current !== null) throw integrity();
        validateDone(
          frame.payload,
          attachments.length,
          text !== null,
          sanitizedHtml !== null,
          remoteImages?.length ?? 0,
        );
        completed = true;
        return Object.freeze({
          text,
          sanitizedHtml,
          attachments: Object.freeze(attachments),
          remoteImages: remoteImages ?? Object.freeze([]),
        });
      }
      throw integrity();
    }
    throw transient("mail_mime_worker_crashed");
  } finally {
    if (!completed) {
      if (current !== null) zeroCurrentArtifact(current);
      zeroParsedArtifacts({
        text,
        sanitizedHtml,
        attachments,
        remoteImages: remoteImages ?? [],
      });
    }
  }
}

function zeroCurrentArtifact(current: CurrentArtifact): void {
  for (const chunk of current.chunks) chunk.fill(0);
  current.chunks.length = 0;
  current.bytes = 0;
}

function zeroParsedArtifacts(artifacts: ParsedMailArtifactSet): void {
  artifacts.text?.data.fill(0);
  artifacts.sanitizedHtml?.data.fill(0);
  for (const attachment of artifacts.attachments) {
    attachment.blob.data.fill(0);
  }
}

function parseArtifactBegin(payload: Buffer): ArtifactBegin {
  const value = decodeBmp1Json(payload);
  if (!isPlainRecord(value)) throw integrity();
  const keys = Object.keys(value).sort();
  if (
    value.kind === "text" ||
    value.kind === "sanitized_html" ||
    value.kind === "remote_images"
  ) {
    if (keys.length !== 1 || keys[0] !== "kind") throw integrity();
    return Object.freeze({
      kind: value.kind,
      filename: null,
      mimeType: null,
      disposition: null,
      contentId: null,
    });
  }
  if (
    value.kind !== "attachment" ||
    keys.join(",") !== "contentId,disposition,filename,kind,mimeType"
  ) {
    throw integrity();
  }
  const filename = parseOptionalMetadata(value.filename);
  const contentId = parseOptionalMetadata(value.contentId);
  if (
    typeof value.mimeType !== "string" ||
    value.mimeType.length > 127 ||
    !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value.mimeType) ||
    (value.disposition !== "attachment" && value.disposition !== "inline")
  ) {
    throw integrity();
  }
  return Object.freeze({
    kind: "attachment",
    filename,
    mimeType: value.mimeType,
    disposition: value.disposition,
    contentId,
  });
}

function parseDescriptor(payload: Buffer): MailBlobDescriptor {
  const value = decodeBmp1Json(payload);
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !== "bytes,sha256" ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 0
  ) {
    throw integrity();
  }
  return Object.freeze({ sha256: value.sha256, bytes: value.bytes as number });
}

function validateDone(
  payload: Buffer,
  attachments: number,
  text: boolean,
  html: boolean,
  remoteImages: number,
): void {
  const value = decodeBmp1Json(payload);
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !== "attachments,html,remoteImages,text" ||
    value.attachments !== attachments ||
    value.text !== text ||
    value.html !== html ||
    value.remoteImages !== remoteImages
  ) {
    throw integrity();
  }
}

function parseRemoteImageManifest(
  data: Buffer,
  maxRemoteImages: number,
): readonly ParsedMailRemoteImage[] {
  if (
    data.length > MAIL_RESOURCE_LIMITS.maxRemoteImageManifestBytes ||
    !Number.isSafeInteger(maxRemoteImages) ||
    maxRemoteImages < 1
  ) {
    throw integrity();
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    throw integrity();
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > maxRemoteImages) {
    throw integrity();
  }
  return Object.freeze(
    value.map((candidate) => {
      if (
        !isPlainRecord(candidate) ||
        Object.keys(candidate).sort().join(",") !== "remoteImageId,sourceUrl" ||
        typeof candidate.remoteImageId !== "string" ||
        typeof candidate.sourceUrl !== "string" ||
        candidate.remoteImageId.length > 64 ||
        Buffer.byteLength(candidate.sourceUrl) >
          MAIL_RESOURCE_LIMITS.maxRemoteImageUrlBytes
      ) {
        throw integrity();
      }
      return Object.freeze({
        remoteImageId: candidate.remoteImageId,
        sourceUrl: candidate.sourceUrl,
      });
    }),
  );
}

function parseRemoteFailure(payload: Buffer): ParseFailure {
  const value = decodeBmp1Json(payload);
  if (
    !isPlainRecord(value) ||
    Object.keys(value).sort().join(",") !== "category,errorCode"
  ) {
    return integrity();
  }
  if (
    value.category === "transient" &&
    value.errorCode === "mail_mime_worker_timeout"
  ) {
    return transient("mail_mime_worker_timeout");
  }
  if (
    value.category === "permanent" &&
    (value.errorCode === "mail_mime_invalid" ||
      value.errorCode === "mail_mime_limit_exceeded")
  ) {
    return new ParseFailure(permanentFailure(value.errorCode));
  }
  if (value.category === "integrity" && value.errorCode === "mail_mime_integrity_failed") {
    return integrity();
  }
  return integrity();
}

function parseOptionalMetadata(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw integrity();
  }
  return value;
}

function connectToWorker(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath, allowHalfOpen: true });
    const onError = (error: Error) => {
      socket.off("connect", onConnect);
      reject(error);
    };
    const onConnect = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("connect", onConnect);
  });
}

function validateSocketPath(value: string): string {
  if (!value.startsWith("/") || value.length > 103 || /[\u0000\r\n]/.test(value)) {
    throw new Error("mail MIME socket path is invalid");
  }
  return value;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] ===
      "function"
  );
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as AbortSignal).aborted === "boolean" &&
    typeof (value as AbortSignal).addEventListener === "function" &&
    typeof (value as AbortSignal).removeEventListener === "function"
  );
}

function transient(errorCode: MailMimeTransientErrorCode): ParseFailure {
  return new ParseFailure(transientFailure(errorCode));
}

function integrity(): ParseFailure {
  return new ParseFailure(
    Object.freeze({
      kind: "integrity_failure" as const,
      errorCode: "mail_mime_integrity_failed" as const,
    }),
  );
}

function transientFailure(
  errorCode: MailMimeTransientErrorCode,
): Exclude<MailMimeParseOutcome, { readonly kind: "parsed" }> {
  return Object.freeze({ kind: "transient_failure" as const, errorCode });
}

function permanentFailure(
  errorCode: MailMimePermanentErrorCode,
): Exclude<MailMimeParseOutcome, { readonly kind: "parsed" }> {
  return Object.freeze({ kind: "permanent_failure" as const, errorCode });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
