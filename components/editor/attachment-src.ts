"use client";

/**
 * How a bare `/_attachments-v2/<name>` becomes a URL the browser may fetch.
 *
 * The owner needs no rewrite: their session authorizes /api/media. A link
 * visitor needs the access triple `?root=&page=&v=`, and it must NOT be written
 * into the document. The serializer emits exactly what it parsed, so the
 * rewrite happens at display time, in the image NodeView, and nowhere else.
 * The schema's `toDOM` stays bare as well: it is what a copy puts on the
 * clipboard, and the paste parser reads that `src` back into the document.
 *
 * Module-scoped on purpose: a ProseMirror node view is plain DOM with no React
 * context, and Brain never mounts two editors at once. The owner shell and the
 * visitor island are different pages. `ShareEditor` sets it on mount and clears
 * it on unmount, and its test asserts the clearing.
 */
type Resolver = (url: string) => string;

const identity: Resolver = (url) => url;
let resolver: Resolver = identity;

export function setAttachmentSrcResolver(next: Resolver | null): void {
  resolver = next ?? identity;
}

export function attachmentSrc(url: string): string {
  return resolver(url);
}
