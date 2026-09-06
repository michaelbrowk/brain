"use client";

import dynamic from "next/dynamic";

/** The island loads only when a valid edit cookie was already verified on the
 *  server. An anonymous reader downloads no editor bundle, and the read-only
 *  render underneath stays the no-JS fallback. Client-only on purpose: the
 *  island decides about a local draft in its first render, and a server
 *  render would hydrate against a different body when one exists. */
const ShareEditor = dynamic(() => import("./share-editor"), { ssr: false });

export function ShareEditorMount(props: {
  rootId: string;
  pageId: string;
  shareVersion: number;
  vid: string;
  initialMarkdown: string;
  initialRev: string;
  linkablePageIds: readonly string[];
}) {
  return <ShareEditor {...props} />;
}
