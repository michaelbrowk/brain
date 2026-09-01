import { NextRequest, NextResponse } from "next/server";
import {
  AttachmentValidationError,
  getStore,
  isAttachmentValidation,
  isNotionImportConflict,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/store";
import { acquireNotionUploadSlot } from "@/lib/notion/upload-admission";

export async function handleNotionUpload(req: NextRequest) {
  const releaseUpload = acquireNotionUploadSlot();
  if (!releaseUpload) {
    return NextResponse.json(
      { error: "another notion attachment is uploading", code: "upload_busy" },
      { status: 429, headers: { "Retry-After": "1" } },
    );
  }
  try {
    const notionId = req.headers.get("x-notion-id") ?? "";
    const sourceHash = req.headers.get("x-source-hash") ?? "";
    const expectedSha256 = req.headers.get("x-expected-sha256") ?? "";
    const reservationToken = req.headers.get("x-reservation-token") ?? "";
    const originalName = decodeFileNameHeader(
      req.headers.get("x-file-name-b64"),
    );
    const mimeType = req.headers.get("content-type") ?? "application/octet-stream";
    if (
      !/^(?:[A-Fa-f0-9]{32}|[A-Fa-f0-9-]{36})$/.test(notionId) ||
      !/^[A-Fa-f0-9]{64}$/.test(sourceHash) ||
      !/^[A-Fa-f0-9]{64}$/.test(expectedSha256) ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(reservationToken) ||
      !originalName ||
      originalName.length > 500
    ) {
      return NextResponse.json({ error: "invalid upload headers" }, { status: 400 });
    }
    const declaredLength = Number(req.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      declaredLength > MAX_ATTACHMENT_BYTES
    ) {
      return NextResponse.json(
        { error: "too large", code: "too_large" },
        { status: 413 },
      );
    }
    const data = await readBoundedBody(req, MAX_ATTACHMENT_BYTES);
    const store = await getStore();
    const saved = await store.saveNotionAttachment(
      notionId,
      sourceHash,
      reservationToken,
      { data, originalName, mimeType, expectedSha256 },
      "notion-import",
    );
    return NextResponse.json(saved);
  } catch (error) {
    if (isNotionImportConflict(error) || isAttachmentValidation(error)) {
      const status = isNotionImportConflict(error)
        ? 409
        : error.code === "too_large" || error.code === "quota_exceeded"
          ? 413
          : error.code === "hash_mismatch"
            ? 422
            : 415;
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status },
      );
    }
    throw error;
  } finally {
    releaseUpload();
  }
}

/** HTTP header values are ByteString, so UTF-8 filenames travel as strict
 *  base64 instead of raw x-file-name bytes. */
export function decodeFileNameHeader(value: string | null): string {
  if (!value || value.length > 2_048 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return "";
  }
  const unpadded = value.replace(/=+$/, "");
  const padded = `${unpadded}${"=".repeat((4 - (unpadded.length % 4)) % 4)}`;
  let bytes: Buffer;
  try {
    bytes = Buffer.from(padded, "base64");
    if (bytes.toString("base64").replace(/=+$/, "") !== unpadded) return "";
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!decoded || decoded.includes("\0")) return "";
    return decoded;
  } catch {
    return "";
  }
}

export async function readBoundedBody(
  req: NextRequest,
  maxBytes: number,
): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("attachment too large");
      throw new AttachmentValidationError(
        "too_large",
        `attachment exceeds ${maxBytes} bytes`,
      );
    }
    chunks.push(value);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}
