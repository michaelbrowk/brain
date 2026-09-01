import { NextRequest, NextResponse } from "next/server";
import fs from "node:fs/promises";
import { constants as fsConstants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";
import { referencedAttachmentNames } from "@/lib/attachments";
import { getStore, isNotFound, NOTES_ROOT } from "@/lib/store";
import {
  resolveShareAccess,
  ShareAccessBusyError,
  ShareAccessNotFoundError,
} from "@/lib/share-access";

export const dynamic = "force-dynamic";

const MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
};
const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "heic",
  "heif",
]);

/** Serves private attachments to the owner. Shared pages use a page/version
 *  scoped URL, and the route verifies that the requested page actually
 *  references this attachment. Unguessable filenames are not authorization. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const { name } = await params;
  if (!/^[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9][A-Za-z0-9_-]{0,31})?$/.test(name))
    return missing();
  try {
    if (!(await canReadAttachment(req, name))) {
      return missing();
    }
  } catch (error) {
    if (error instanceof ShareAccessBusyError) return busy();
    throw error;
  }
  const directory = path.join(NOTES_ROOT, "_attachments");
  const file = path.join(directory, name);
  const opened = await openStableAttachment(directory, file);
  if (!opened) return missing();
  let fileHandle: FileHandle | undefined = opened.handle;
  let nodeStream: ReturnType<FileHandle["createReadStream"]> | undefined;
  try {
    const stat = opened.stat;
    const ext = name.split(".").pop()!.toLowerCase();
    const headers: Record<string, string> = {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes",
    };
    if (!IMAGE_EXT.has(ext)) headers["Content-Disposition"] = "attachment";
    const range = parseRange(req.headers.get("range"), stat.size);
    if (range === "invalid") {
      headers["Content-Range"] = `bytes */${stat.size}`;
      await fileHandle.close();
      fileHandle = undefined;
      return new NextResponse(null, { status: 416, headers });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, stat.size - 1);
    const length = stat.size === 0 ? 0 : end - start + 1;
    headers["Content-Length"] = String(length);
    if (range) headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
    nodeStream = fileHandle.createReadStream({
      ...(stat.size > 0 ? { start, end } : {}),
      highWaterMark: 64 * 1024,
      autoClose: true,
      emitClose: true,
    });
    // The ReadStream now owns the already-verified descriptor. Pathname swaps
    // after this point cannot redirect the response, and stream completion or
    // cancellation closes the descriptor.
    fileHandle = undefined;
    const body = Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
    return new NextResponse(body, {
      status: range ? 206 : 200,
      headers,
    });
  } catch {
    nodeStream?.destroy();
    await fileHandle?.close().catch(() => undefined);
    return missing();
  }
}

/** Open both the attachment directory and file without following their final
 * path components. The before/open/after identity checks catch parent or file
 * swaps during open; the caller then streams only from the returned descriptor. */
async function openStableAttachment(
  directory: string,
  file: string,
): Promise<{ handle: FileHandle; stat: Stats } | null> {
  let directoryHandle: FileHandle | undefined;
  let fileHandle: FileHandle | undefined;
  try {
    const directoryBefore = await fs.lstat(directory);
    if (!isRealDirectory(directoryBefore)) return null;

    directoryHandle = await fs.open(
      directory,
      fsConstants.O_RDONLY |
        fsConstants.O_DIRECTORY |
        fsConstants.O_NOFOLLOW,
    );
    const openedDirectory = await directoryHandle.stat();
    const directoryAfterOpen = await fs.lstat(directory);
    if (
      !openedDirectory.isDirectory() ||
      !isRealDirectory(directoryAfterOpen) ||
      !sameIdentity(directoryBefore, openedDirectory) ||
      !sameIdentity(openedDirectory, directoryAfterOpen)
    ) {
      return null;
    }

    fileHandle = await fs.open(
      file,
      fsConstants.O_RDONLY |
        fsConstants.O_NOFOLLOW |
        fsConstants.O_NONBLOCK,
    );
    const openedFile = await fileHandle.stat();
    if (!openedFile.isFile() || openedFile.nlink !== 1) return null;

    const [fileAfterOpen, directoryAfterFileOpen] = await Promise.all([
      fs.lstat(file),
      fs.lstat(directory),
    ]);
    if (
      !fileAfterOpen.isFile() ||
      fileAfterOpen.isSymbolicLink() ||
      fileAfterOpen.nlink !== 1 ||
      !sameIdentity(openedFile, fileAfterOpen) ||
      !isRealDirectory(directoryAfterFileOpen) ||
      !sameIdentity(openedDirectory, directoryAfterFileOpen)
    ) {
      return null;
    }

    await directoryHandle.close();
    directoryHandle = undefined;
    const result = { handle: fileHandle, stat: openedFile };
    fileHandle = undefined;
    return result;
  } catch {
    return null;
  } finally {
    await fileHandle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
  }
}

function isRealDirectory(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink();
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function parseRange(
  header: string | null,
  size: number,
): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size === 0) return "invalid";
  let start: number;
  let end: number;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  } else {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  ) {
    return "invalid";
  }
  return { start, end: Math.min(end, size - 1) };
}

function missing() {
  return NextResponse.json(
    { error: "not found" },
    { status: 404, headers: { "Cache-Control": "private, no-store" } },
  );
}

function busy() {
  return NextResponse.json(
    { error: "temporarily unavailable" },
    {
      status: 503,
      headers: {
        "Cache-Control": "private, no-store",
        "Retry-After": "1",
      },
    },
  );
}

async function canReadAttachment(
  req: NextRequest,
  name: string,
): Promise<boolean> {
  if (await verifySession(req.cookies.get(SESSION_COOKIE)?.value)) return true;

  const pageId = req.nextUrl.searchParams.get("page");
  const rootId = req.nextUrl.searchParams.get("root") ?? pageId;
  const requestedVersion = req.nextUrl.searchParams.get("v");
  if (!rootId || !pageId || requestedVersion === null) return false;

  try {
    const store = await getStore();
    const access = await resolveShareAccess(store, {
      rootId,
      targetId: pageId,
      requestedVersion,
      token: req.cookies.get(`brain_share_${rootId}`)?.value,
    });
    return (
      access.kind === "granted" &&
      referencesAttachment(access.target.markdown, name)
    );
  } catch (error) {
    if (
      isNotFound(error) ||
      error instanceof ShareAccessNotFoundError
    )
      return false;
    throw error;
  }
}

function referencesAttachment(markdown: string, name: string): boolean {
  return referencedAttachmentNames(markdown).has(name);
}
