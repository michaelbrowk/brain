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

/** WHAT AN APP MAY SEE OF ONE PAGE IN THE TREE.
 *
 *  Michael's decision (spec §4): an app may read the whole notebook. That is
 *  about REACH, not about detail. `/api/tree` answers the full node, which
 *  carries the shadow of a share's credentials (`shareLocked`,
 *  `shareExpiresAt`), collection definitions and Notion binding ids — none of
 *  which an app has a use for, and all of which would be crossing a frame
 *  boundary for nothing. Five fields, chosen rather than filtered: a new key
 *  on TreeNode does not silently become something an app can read. */
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

/** The same two words the MCP uses for the same two failures, so an app and
 *  an agent branch on one vocabulary. */
async function read(path: string): Promise<unknown> {
  let response: Response;
  try {
    response = await apiFetch(path);
  } catch {
    throw new AppBridgeError("Brain could not answer that request", "store_failed");
  }
  if (response.status === 404) {
    throw new AppBridgeError("that page is not there", "not_found");
  }
  if (!response.ok) {
    throw new AppBridgeError("Brain could not answer that request", "store_failed");
  }
  return response.json();
}

/** The owner's read side. Every request the spec lists as a read, and
 *  `undefined` for everything else, so the write side layers over it with a
 *  `??` rather than a second switch that could disagree with this one.
 *
 *  `liveTree` is the shell's own tree, read through on every request rather
 *  than fetched: the shell already holds that answer and keeps it current over
 *  SSE, so an app sees the notebook as the sidebar does and a second fetch
 *  would only risk showing it something staler. Task 12 is where the same
 *  getter starts deciding which pages may be read at all. */
export function createAppReads(
  liveTree: () => readonly TreeNode[],
): (request: AppRequest) => Promise<unknown> {
  return async (request) => {
    if (request.type === "read.tree") return { tree: flatten(liveTree(), []) };
    if (request.type === "read.page") {
      const body = (await read(`/api/page/${encodeURIComponent(request.id)}`)) as {
        meta: Record<string, unknown>;
        markdown: string;
        rev: string;
      };
      // The route already redacted the secrets; this drops the keys that are
      // merely undefined, so an app's JSON is the shape it reads rather than
      // a map of absences.
      const meta = Object.fromEntries(
        Object.entries(body.meta ?? {}).filter(([, value]) => value !== undefined),
      );
      return { meta, markdown: body.markdown, rev: body.rev };
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
