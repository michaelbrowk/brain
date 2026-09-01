import { NextResponse } from "next/server";

import {
  BrainMailClientError,
  type MailAttachmentPayload,
} from "./brain-mail-client";
import { MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY } from "./content-types";
import { writeMailLogRecord } from "./security";
import { MAIL_SERVICE_HTTP_LIMITS } from "./service/limits";
import {
  MAIL_THREAD_STATE_CONTRACT_HEADER,
  mailThreadStateContractTier,
  projectMailThreadStateContract,
} from "./thread-contract";

const MAX_ACCOUNT_REQUEST_BYTES = 16 * 1024;
const MAX_EMPTY_BODY_ZERO_CHUNKS = 8;
const EMPTY_BODY_READ_DEADLINE_MS = 1_000;
const MAX_JSON_BODY_ZERO_CHUNKS = 32;
const JSON_BODY_READ_DEADLINE_MS = 30_000;

export function validateMailMutationRequest(
  request: Request,
  requiresJson: boolean,
  forbidsBody = false,
  errorCode = "account_request_invalid",
  errorApiVersion: 1 | 2 = 2,
): Response | null {
  if (!hasExactSameOrigin(request)) {
    return mailApiError(403, errorCode, errorApiVersion);
  }
  if (requiresJson && !hasJsonContentType(request)) {
    return mailApiError(415, errorCode, errorApiVersion);
  }
  if (
    forbidsBody &&
    (request.headers.has("Transfer-Encoding") ||
      (request.headers.get("Content-Length") !== null &&
        request.headers.get("Content-Length") !== "0") ||
      request.body !== null)
  ) {
    return mailApiError(400, errorCode, errorApiVersion);
  }
  return null;
}

export async function validateEmptyMailMutationRequest(
  request: Request,
  errorCode = "account_request_invalid",
  errorApiVersion: 1 | 2 = 2,
): Promise<Response | null> {
  const rejected = validateMailMutationRequest(
    request,
    false,
    false,
    errorCode,
    errorApiVersion,
  );
  if (rejected) return rejected;

  const contentLength = request.headers.get("Content-Length");
  if (
    request.headers.has("Transfer-Encoding") ||
    (contentLength !== null && contentLength !== "0")
  ) {
    return mailApiError(400, errorCode, errorApiVersion);
  }
  if (request.body === null) return null;

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = request.body.getReader();
  } catch {
    return mailApiError(400, errorCode, errorApiVersion);
  }

  let stopReading!: () => void;
  const stopped = new Promise<"stopped">((resolve) => {
    stopReading = () => resolve("stopped");
  });
  const abortReading = () => stopReading();
  request.signal.addEventListener("abort", abortReading, { once: true });
  const deadline = setTimeout(stopReading, EMPTY_BODY_READ_DEADLINE_MS);
  const cancelReader = () => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // The response must not wait for an uncooperative request-body source.
    }
  };

  try {
    let zeroChunks = 0;
    if (request.signal.aborted) stopReading();

    while (true) {
      const outcome = await Promise.race([
        reader.read().then((next) => ({ kind: "read" as const, next })),
        stopped.then(() => ({ kind: "stopped" as const })),
      ]);
      if (outcome.kind === "stopped") {
        cancelReader();
        return mailApiError(400, errorCode, errorApiVersion);
      }
      const { next } = outcome;
      if (next.done) return null;
      if (next.value.byteLength === 0) {
        zeroChunks += 1;
        if (zeroChunks <= MAX_EMPTY_BODY_ZERO_CHUNKS) continue;
      }
      next.value.fill(0);
      cancelReader();
      return mailApiError(400, errorCode, errorApiVersion);
    }
  } catch {
    cancelReader();
    return mailApiError(400, errorCode, errorApiVersion);
  } finally {
    clearTimeout(deadline);
    request.signal.removeEventListener("abort", abortReading);
    try {
      reader.releaseLock();
    } catch {
      // Cancellation is best-effort; never turn a rejected body into a route crash.
    }
  }
}

export async function readBoundedMailJson(
  request: Request,
  maxBytes = MAX_ACCOUNT_REQUEST_BYTES,
): Promise<unknown> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAIL_SERVICE_HTTP_LIMITS.maxDraftBodyBytes
  ) {
    throw new MailApiBodyError(400);
  }
  const declaredLength = readDeclaredLength(request, maxBytes);
  const reader = request.body?.getReader();
  if (!reader) throw new MailApiBodyError(400);

  const chunks: Uint8Array[] = [];
  let total = 0;
  let zeroChunks = 0;
  let joined: Buffer | undefined;
  let stopReading!: () => void;
  const stopped = new Promise<"stopped">((resolve) => {
    stopReading = () => resolve("stopped");
  });
  const abortReading = () => stopReading();
  request.signal.addEventListener("abort", abortReading, { once: true });
  const deadline = setTimeout(stopReading, JSON_BODY_READ_DEADLINE_MS);
  const cancelReader = () => {
    try {
      void reader.cancel().catch(() => undefined);
    } catch {
      // The response must not wait for an uncooperative request-body source.
    }
  };
  try {
    if (request.signal.aborted) stopReading();
    while (true) {
      const outcome = await Promise.race([
        reader.read().then((next) => ({ kind: "read" as const, next })),
        stopped.then(() => ({ kind: "stopped" as const })),
      ]);
      if (outcome.kind === "stopped") {
        cancelReader();
        throw new MailApiBodyError(400);
      }
      const { next } = outcome;
      if (next.done) break;
      if (next.value.byteLength === 0) {
        zeroChunks += 1;
        if (zeroChunks > MAX_JSON_BODY_ZERO_CHUNKS) {
          cancelReader();
          throw new MailApiBodyError(400);
        }
        continue;
      }
      total += next.value.byteLength;
      if (total > maxBytes) {
        next.value.fill(0);
        await reader.cancel().catch(() => undefined);
        throw new MailApiBodyError(413);
      }
      chunks.push(next.value.slice());
      next.value.fill(0);
    }
    if (declaredLength !== null && total !== declaredLength) {
      throw new MailApiBodyError(400);
    }
    joined = Buffer.alloc(total);
    let offset = 0;
    for (const chunk of chunks) {
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).copy(
        joined,
        offset,
      );
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(joined);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof MailApiBodyError) throw error;
    throw new MailApiBodyError(400);
  } finally {
    clearTimeout(deadline);
    request.signal.removeEventListener("abort", abortReading);
    for (const chunk of chunks) chunk.fill(0);
    joined?.fill(0);
    try {
      reader.releaseLock();
    } catch {
      // Cancellation is best-effort; the rejected request is already bounded.
    }
  }
}

export async function runMailApiAction(
  action: () => Promise<unknown>,
  errorApiVersion: 1 | 2 = 2,
  successStatus: number | ((value: unknown) => number) = 200,
): Promise<Response> {
  try {
    const value = await action();
    return NextResponse.json(value, {
      status:
        typeof successStatus === "function"
          ? successStatus(value)
          : successStatus,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof BrainMailClientError) {
      return mailApiError(error.status, error.code, errorApiVersion);
    }
    /*
      Something threw that is not a service answer at all — a route handler bug,
      a validator, a runtime fault. The browser is told the service is
      unavailable, which is the only safe public sentence, and until now that
      was the whole record of it. The thrown value is never projected: it can
      carry a subject, an address or a credential, and the log allowlist has no
      room for any of them.
    */
    writeMailLogRecord({
      event: "mail_api_action_failed",
      errorCode: "mail_service_unavailable",
    });
    return mailApiError(503, "mail_service_unavailable", errorApiVersion);
  }
}

export async function runMailThreadApiAction(
  request: Request,
  action: () => Promise<unknown>,
  successStatus = 200,
): Promise<Response> {
  return runMailApiAction(
    async () =>
      projectMailThreadStateContract(
        await action(),
        mailThreadStateContractTier(
          request.headers.get(MAIL_THREAD_STATE_CONTRACT_HEADER),
        ),
      ),
    1,
    successStatus,
  );
}

export async function runMailAttachmentApiAction(
  action: () => Promise<MailAttachmentPayload>,
): Promise<Response> {
  let payload: MailAttachmentPayload | null = null;
  try {
    payload = await action();
    if (
      !(payload.body instanceof ReadableStream) ||
      !Number.isSafeInteger(payload.bytes) ||
      payload.bytes < 0
    ) {
      if (payload.body instanceof ReadableStream) {
        await payload.body.cancel().catch(() => undefined);
      }
      payload = null;
      return mailApiError(503, "mail_service_unavailable", 1);
    }
    return new Response(payload.body, {
      status: 200,
      headers: {
        "Content-Type": payload.contentType,
        "Content-Length": String(payload.bytes),
        "Content-Disposition": payload.contentDisposition,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY,
      },
    });
  } catch (error) {
    if (payload?.body instanceof ReadableStream) {
      await payload.body.cancel().catch(() => undefined);
    }
    if (error instanceof BrainMailClientError) {
      return mailApiError(error.status, error.code, 1);
    }
    return mailApiError(503, "mail_service_unavailable", 1);
  }
}

export function mailApiBodyError(
  error: unknown,
  code = "account_request_invalid",
  apiVersion: 1 | 2 = 2,
): Response {
  return mailApiError(
    error instanceof MailApiBodyError ? error.status : 400,
    code,
    apiVersion,
  );
}

function hasExactSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  const trustedOrigin = readTrustedPublicOrigin();
  return origin !== null && trustedOrigin !== null && origin === trustedOrigin;
}

function readTrustedPublicOrigin(): string | null {
  const configured = process.env.BRAIN_PUBLIC_ORIGIN?.trim();
  if (!configured) return null;
  try {
    const parsed = new URL(configured);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.origin !== configured
    ) {
      return null;
    }
    return configured;
  } catch {
    return null;
  }
}

function hasJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("Content-Type")?.trim() ?? "";
  return /^application\/json(?:;\s*charset=utf-8)?$/i.test(contentType);
}

class MailApiBodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super("account_request_invalid");
  }
}

function readDeclaredLength(request: Request, maxBytes: number): number | null {
  const value = request.headers.get("Content-Length");
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new MailApiBodyError(400);
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > maxBytes) {
    throw new MailApiBodyError(413);
  }
  return length;
}

export function mailApiError(
  status: number,
  code: string,
  apiVersion: 1 | 2,
): Response {
  return NextResponse.json(
    { apiVersion, error: { code } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
