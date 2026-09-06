"use client";

/**
 * How a bare `/_attachments-v2/<name>` becomes a URL the browser may fetch,
 * and how it becomes bare again.
 *
 * The owner needs no rewrite: their session authorizes /api/media. A link
 * visitor needs the access triple `?root=&page=&v=`, and it must NOT be written
 * into the document. The serializer emits exactly what it parsed, so the
 * rewrite happens at display time, in the node and mark views, and nowhere
 * else. Every schema `toDOM` stays bare: it is what a copy puts on the
 * clipboard. And because a paste of live DOM (a selection that started outside
 * the editor, or the read-only share page) reaches parseDOM with the rendered
 * URL, `bareAttachmentSrc` is applied there as the exact inverse.
 *
 * Module-scoped on purpose: a ProseMirror view is plain DOM with no React
 * context, and Brain never mounts two editors at once. The owner shell and the
 * visitor island are different pages. `ShareEditor` sets the resolver on mount
 * and clears it on unmount, and its test asserts the clearing.
 */
type Resolver = (url: string) => string;

const identity: Resolver = (url) => url;
let resolver: Resolver = identity;

/** The name grammar lib/attachments.ts accepts, on the two paths a browser can
 *  hand back: the bare one the document stores and the resolved one it shows.
 *  A query or a fragment after the name is dropped by the inverse. */
const ATTACHMENT_PATH =
  /^\/(_attachments(?:-v2)?|api\/media)\/([A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9][A-Za-z0-9_-]{0,31})?)(?:[?#].*)?$/;

export function setAttachmentSrcResolver(next: Resolver | null): void {
  resolver = next ?? identity;
}

export function attachmentSrc(url: string): string {
  return resolver(url);
}

/** The inverse: a resolved media URL, or a bare path that picked up a query,
 *  back to the bare path the document stores. Anything else is returned as is. */
export function bareAttachmentSrc(url: string): string {
  const match = ATTACHMENT_PATH.exec(url);
  if (!match) return url;
  const [, prefix, name] = match;
  return `/${prefix === "api/media" ? "_attachments-v2" : prefix}/${name}`;
}

/** Images that failed to load, by the bare path they were rendered from. A
 *  freshly uploaded image is refused by the media route until the page's
 *  stored markdown references it, which the next save does; the island then
 *  asks for one retry per successful save. An image that fails again is
 *  noted again and retried after the save after that. */
const failed = new Map<HTMLImageElement, string>();
let retries = 0;

export function noteAttachmentLoadFailure(img: HTMLImageElement, src: string): void {
  if (!ATTACHMENT_PATH.test(src)) return;
  failed.set(img, src);
}

/** Re-requests every noted image, once per call, under a fresh URL so the
 *  browser does not answer from the failed load. Returns how many it touched. */
export function retryFailedAttachmentImages(): number {
  let retried = 0;
  for (const [img, src] of failed) {
    if (!img.isConnected) continue;
    const resolved = attachmentSrc(src);
    retries += 1;
    img.src = `${resolved}${resolved.includes("?") ? "&" : "?"}retry=${retries}`;
    retried += 1;
  }
  failed.clear();
  return retried;
}
