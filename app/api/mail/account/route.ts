import { NextResponse } from "next/server";
import {
  BrainMailClientError,
  createBrainMailClient,
  type MailAccountConnectInput,
} from "@/lib/mail/brain-mail-client";

export const dynamic = "force-dynamic";
// Keep the public Next boundary aligned with the mail-service HTTP boundary.
const MAX_ACCOUNT_REQUEST_BYTES = 16 * 1024;

export async function GET(request: Request) {
  return run(() => createBrainMailClient().status(request.signal));
}

export async function POST(request: Request) {
  if (!hasExactSameOrigin(request)) {
    return errorResponse(403, "account_request_invalid");
  }
  if (!hasJsonContentType(request)) {
    return errorResponse(415, "account_request_invalid");
  }
  let input: MailAccountConnectInput;
  try {
    input = (await readBoundedJson(request)) as MailAccountConnectInput;
  } catch (error) {
    return errorResponse(
      error instanceof AccountRequestBodyError ? error.status : 400,
      "account_request_invalid",
    );
  }
  return run(() => createBrainMailClient().connect(input, request.signal));
}

export async function DELETE(request: Request) {
  if (!hasExactSameOrigin(request)) {
    return errorResponse(403, "account_request_invalid");
  }
  return run(() => createBrainMailClient().disconnect(request.signal));
}

function hasExactSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin");
  const trustedOrigin = readTrustedPublicOrigin();
  if (origin === null || trustedOrigin === null) return false;
  return origin === trustedOrigin;
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

class AccountRequestBodyError extends Error {
  constructor(readonly status: 400 | 413) {
    super("account_request_invalid");
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = readDeclaredLength(request);
  const reader = request.body?.getReader();
  if (!reader) throw new AccountRequestBodyError(400);

  const chunks: Uint8Array[] = [];
  let total = 0;
  let joined: Buffer | undefined;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_ACCOUNT_REQUEST_BYTES) {
        next.value.fill(0);
        await reader.cancel().catch(() => {});
        throw new AccountRequestBodyError(413);
      }
      chunks.push(next.value.slice());
      next.value.fill(0);
    }
    if (declaredLength !== null && total !== declaredLength) {
      throw new AccountRequestBodyError(400);
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
    // JSON.parse necessarily creates JS strings; wipe every byte buffer we own.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(joined);
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof AccountRequestBodyError) throw error;
    throw new AccountRequestBodyError(400);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    joined?.fill(0);
    reader.releaseLock();
  }
}

function readDeclaredLength(request: Request): number | null {
  const value = request.headers.get("Content-Length");
  if (value === null) return null;
  if (!/^\d+$/.test(value)) throw new AccountRequestBodyError(400);
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > MAX_ACCOUNT_REQUEST_BYTES) {
    throw new AccountRequestBodyError(413);
  }
  return length;
}

async function run(action: () => Promise<unknown>) {
  try {
    return NextResponse.json(await action(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof BrainMailClientError) {
      return errorResponse(error.status, error.code);
    }
    return errorResponse(503, "mail_service_unavailable");
  }
}

function errorResponse(status: number, code: string) {
  return NextResponse.json(
    { apiVersion: 1, error: { code } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}
