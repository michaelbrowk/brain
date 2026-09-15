import { marked, type Token } from "marked";
import path from "node:path";

const LOCAL_ATTACHMENT_URL =
  /^\/(?:_attachments(?:-v2)?|api\/media)\/([A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9][A-Za-z0-9_-]{0,31})?)(?:[?#].*)?$/;

export function localAttachmentName(url: string): string | null {
  return LOCAL_ATTACHMENT_URL.exec(url)?.[1] ?? null;
}

/** Shared pages render editor container directives as their inner Markdown.
 * Authorization must tokenize that exact same source, otherwise an attachment
 * hidden by the rendering cleanup can accidentally become readable. Leaf
 * directives (`::empty-block`) are editor-only too and would otherwise print
 * literally on a shared page. */
export function stripEditorDirectiveFences(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^\s*:{2,}(\w|\{|\s*$)/.test(line.trim()))
    .join("\n");
}

/** Only actual Markdown link/image destinations publish an attachment. Fenced
 *  code, inline code, comments, and plain-text examples never grant access. */
export function referencedAttachmentNames(markdown: string): Set<string> {
  const names = new Set<string>();
  for (const url of referencedAttachmentUrls(markdown)) {
    const name = localAttachmentName(url);
    if (name) names.add(name);
  }
  return names;
}

/** Exact link/image destinations only. This is used by finalized import
 * read-back so plain text, comments, and code cannot claim attachment ownership. */
export function referencedAttachmentUrls(markdown: string): Set<string> {
  const urls = new Set<string>();
  const tokens = marked.lexer(stripEditorDirectiveFences(markdown), { gfm: true });
  marked.walkTokens(tokens, (token: Token) => {
    if (token.type !== "link" && token.type !== "image") return;
    if (localAttachmentName(token.href)) urls.add(token.href);
  });
  return urls;
}

const ATTACHMENT_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "application/json": ".json",
  "application/zip": ".zip",
};

const ATTACHMENT_MIME_ALIASES: Readonly<Record<string, string>> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
  "image/svg": "image/svg+xml",
  "image/x-svg+xml": "image/svg+xml",
  "application/svg+xml": "image/svg+xml",
  "text/svg": "image/svg+xml",
  "text/svg+xml": "image/svg+xml",
};

/** One MIME identity drives signature checks, deterministic filenames, API
 *  responses, and image-renderability policy. */
export function canonicalAttachmentMimeType(mimeType: string): string {
  const normalized = mimeType.split(";", 1)[0].trim().toLowerCase();
  return ATTACHMENT_MIME_ALIASES[normalized] ?? normalized;
}

const ACTIVE_ATTACHMENT_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".xhtml",
  ".js",
  ".mjs",
  ".cjs",
  ".xml",
]);

export function canonicalAttachmentExtension(
  originalName: string,
  mimeType: string,
): string {
  const normalizedMime = canonicalAttachmentMimeType(mimeType);
  const canonical = ATTACHMENT_EXTENSIONS[normalizedMime];
  if (canonical) return canonical;
  const original = path.extname(originalName).toLowerCase();
  if (
    /^\.[a-z0-9][a-z0-9_-]{0,31}$/.test(original) &&
    !ACTIVE_ATTACHMENT_EXTENSIONS.has(original)
  ) {
    return original;
  }
  return ".bin";
}

/** The type a stored file is served and sent as, read off the name the store
 *  minted for it. The extension is the only record of an attachment's type
 *  once it is on disk: `canonicalAttachmentExtension` above chose it from the
 *  type the file was accepted under, and nothing else about that type is
 *  kept.
 *
 *  An extension outside this list answers `application/octet-stream`, and so
 *  does `.svg`: the media route has never served an SVG as an image and this
 *  list is that route's, so one answer decides what a file is called in a
 *  response header and in a MIME part. `app/api/media/[name]/route.ts` and
 *  `lib/portable/model.ts` each hold a copy of it and should read it here. */
const ATTACHMENT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
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

export function attachmentMimeTypeForName(name: string): string {
  const extension = name.includes(".")
    ? (name.split(".").at(-1) ?? "").toLowerCase()
    : "";
  return ATTACHMENT_MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/** The extensions an agent may not save into a note out of a message.
 *
 *  `BLOCKED_ATTACHMENT_MIME` and `ACTIVE_ATTACHMENT_EXTENSIONS` above are
 *  about a file a browser could run while rendering a note. This list is
 *  about a file a person could run after opening one, and it exists for a
 *  provenance the upload path does not have: a remote sender picks the bytes
 *  and the name, and an agent, not a person, decides to keep them. An owner
 *  dragging `setup.exe` into their own note chose it, and that path is
 *  unchanged.
 *
 *  Named by the extension the store would mint for the file, so a sender who
 *  declares `application/octet-stream` and calls it `setup.exe` is turned
 *  down on the `.exe`, whatever the type claimed. */
const EXECUTABLE_ATTACHMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe",
  ".dll",
  ".com",
  ".scr",
  ".bat",
  ".cmd",
  ".ps1",
  ".msi",
  ".jar",
  ".sh",
  ".app",
  ".dmg",
  ".pkg",
]);

export function isExecutableAttachmentExtension(extension: string): boolean {
  return EXECUTABLE_ATTACHMENT_EXTENSIONS.has(extension.toLowerCase());
}

export function normalizeAttachmentDisplayName(originalName: string): string {
  return (
    originalName
      .split(/[\\/]/)
      .at(-1)
      ?.replace(/[\r\n]/g, " ")
      .trim() || "attachment"
  );
}

/** Deterministic URL known before upload, so cyclic page reservation and
 *  attachment conversion do not depend on a prior upload response. */
export function notionAttachmentUrl(
  sha256: string,
  originalName: string,
  mimeType: string,
): string {
  const hash = sha256.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("attachment sha256 must be 64 hexadecimal characters");
  }
  return `/_attachments-v2/${hash}${canonicalAttachmentExtension(normalizeAttachmentDisplayName(originalName), mimeType)}`;
}
