import { apiFetch } from "@/lib/client";
import type { AppRefusalReason, AppRequest } from "@/lib/apps/bridge";
import type { TreeNode } from "@/lib/store/types";

/** A refusal on its way back through the bridge. The host reads `reason` off
 *  it, so a read that fails says the same word the MCP would. */
export class AppBridgeError extends Error {
  constructor(
    message: string,
    readonly reason: AppRefusalReason,
  ) {
    super(message);
    this.name = "AppBridgeError";
  }
}

/** WHAT AN APP MAY SEE OF A PAGE.
 *
 *  Michael's decision (spec §4): an app may read the whole notebook. That is
 *  about REACH, not about detail. `/api/tree` answers the full node and
 *  `/api/page` the full meta, both of which carry the shadow of a share's
 *  credentials (`public`, `shareLocked`, `shareExpiresAt`, `shareEdit`,
 *  `sharedUnder`), collection definitions and Notion binding ids — none of
 *  which an app has a use for, and all of which would be crossing a frame
 *  boundary for nothing.
 *
 *  So both reads are allowlists and they agree: the tree's five fields, and
 *  the same five plus the page facts an app can draw with. Chosen rather
 *  than filtered, so a new key on `TreeNode` or on `PageMeta` does not
 *  silently become something an app can read. An app holds every page id
 *  from `read.tree`, so a pass-through on one of the two would be the whole
 *  notebook, one request at a time, whatever the other one withheld. */
interface AppTreeNode {
  id: string;
  parentId: string | null;
  title: string;
  icon?: string;
  kind?: "app";
}

function flatten(nodes: readonly TreeNode[], into: AppTreeNode[]): AppTreeNode[] {
  for (const node of nodes) {
    into.push({
      id: node.id,
      parentId: node.parentId,
      title: node.title,
      ...(node.icon === undefined ? {} : { icon: node.icon }),
      ...(node.kind === undefined ? {} : { kind: node.kind }),
    });
    flatten(node.children, into);
  }
  return into;
}

/** The tree's five, and then what an app needs to draw a page it read: when
 *  it was written and by whom, and the labels the owner put on it. `cover`
 *  and the body's own attachment links are left out because the frame can
 *  paint neither of them: `img-src` is the app's own asset folder, `blob:`
 *  and `data:`, nothing else. `parentId` is here for agreement with the tree
 *  and is never present, because hierarchy comes only from the folder tree. */
const APP_PAGE_META_KEYS = [
  "id",
  "parentId",
  "title",
  "icon",
  "kind",
  "created",
  "updated",
  "updatedBy",
  "tags",
  "status",
  "category",
  "view",
  "sections",
  "pinned",
] as const;

function projectMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const into: Record<string, unknown> = {};
  for (const key of APP_PAGE_META_KEYS) {
    // A key that is merely absent stays absent, so an app's JSON is the
    // shape it reads rather than a map of undefined.
    if (meta[key] !== undefined) into[key] = meta[key];
  }
  return into;
}

/** The same two words the MCP uses for the same two failures, so an app and
 *  an agent branch on one vocabulary. */
async function read(path: string): Promise<unknown> {
  try {
    const response = await apiFetch(path);
    if (response.status === 404) {
      throw new AppBridgeError("that page is not there", "not_found");
    }
    if (!response.ok) {
      throw new AppBridgeError("Brain could not answer that request", "store_failed");
    }
    // Parsing is inside the try as well: a body that is not the JSON this
    // asked for would otherwise reach the app as the engine's own SyntaxError
    // text, which says nothing an app or its owner can act on.
    return await response.json();
  } catch (error) {
    if (error instanceof AppBridgeError) throw error;
    throw new AppBridgeError("Brain could not answer that request", "store_failed");
  }
}

/** The owner's read side. Every request the spec lists as a read, and
 *  `undefined` for everything else, so the write side layers over it with a
 *  `??` rather than a second switch that could disagree with this one.
 *
 *  THE LIVE TREE IS ALSO THE GUEST LIST.
 *
 *  Spec §4 lets an app read any page and refuses a deleted one. The store's
 *  `readPage` answers a soft-deleted page, because the owner's own trash
 *  dialog reads it, so the tree — which never holds one — is the check.
 *
 *  It is the SHELL'S tree, read through a getter on every request, not a set
 *  this module caches. The shell's copy is the one the sidebar draws and the
 *  one the SSE stream keeps current, so a page deleted while an app is open
 *  is refused on the next read and a page created while it is open becomes
 *  readable at once. A set cached at the first `read.tree` would answer both
 *  of those with the notebook as it looked when the app started. */
export function createAppReads(
  liveTree: () => readonly TreeNode[],
): (request: AppRequest) => Promise<unknown> {
  const has = (id: string): boolean => {
    const walk = (nodes: readonly TreeNode[]): boolean =>
      nodes.some((node) => node.id === id || walk(node.children));
    return walk(liveTree());
  };

  return async (request) => {
    if (request.type === "read.tree") return { tree: flatten(liveTree(), []) };
    if (request.type === "read.page") {
      if (!has(request.id)) {
        throw new AppBridgeError("that page is not there", "not_found");
      }
      const body = (await read(`/api/page/${encodeURIComponent(request.id)}`)) as {
        meta: Record<string, unknown>;
        markdown: string;
        rev: string;
      };
      // The route redacted the secrets; this is the allowlist above it, so
      // what an app reads of a page agrees with what it reads of the tree.
      return { meta: projectMeta(body.meta ?? {}), markdown: body.markdown, rev: body.rev };
    }
    if (request.type === "read.pages") {
      const body = (await read(`/api/search?q=${encodeURIComponent(request.query)}`)) as {
        hits?: unknown[];
      };
      return { hits: body.hits ?? [] };
    }
    return undefined;
  };
}
