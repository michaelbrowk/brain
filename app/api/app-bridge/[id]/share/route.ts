import { NextRequest, NextResponse } from "next/server";
import { getStore, isNotFound } from "@/lib/store";
import {
  resolveShareAccess,
  ShareAccessBusyError,
  ShareAccessNotFoundError,
} from "@/lib/share-access";
import type { TreeNode } from "@/lib/store/types";

export const dynamic = "force-dynamic";

/** A VISITOR'S READ SIDE, AND NOTHING ELSE.
 *
 *  Spec §7. A shared app runs the same entry the owner runs, in the same
 *  sandbox, through the same bridge. What changes is what is on the other
 *  side of it: the owner's host reaches the whole notebook and three write
 *  routes, and this one reaches the shared subtree and no route at all.
 *
 *  THERE IS NO WRITE VERB IN THIS FILE, and that absence is the guarantee,
 *  the way `lib/share-write.test.ts` makes it one for `/api/share-edit/`. A
 *  refusal can be softened by a later edit; a verb that was never written has
 *  to be added by somebody who meant to.
 *
 *  Authority is the grant and only the grant. There is no session check here
 *  and no owner branch: the owner has their own canvas, and a second door
 *  into the same data is a second place for the subtree check to be wrong.
 *  Every request re-resolves the live grant, so a revoked link, a rotated
 *  version and a page moved out of the subtree all stop answering at once. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const rootId = req.nextUrl.searchParams.get("root");
  const requestedVersion = req.nextUrl.searchParams.get("v");
  // The two the link itself carries. A visitor who names neither is not a
  // visitor of anything, and nothing is asked of the store on their behalf.
  if (!rootId || requestedVersion === null) return missing();

  const store = await getStore();
  try {
    const access = await resolveShareAccess(store, {
      rootId,
      targetId: id,
      requestedVersion,
      token: req.cookies.get(`brain_share_${rootId}`)?.value,
    });
    // `password-required` is the gate, not a grant. The app's own frame is
    // past the gate or it is nothing.
    if (access.kind !== "granted") return missing();
  } catch (error) {
    if (error instanceof ShareAccessBusyError) return busy();
    if (error instanceof ShareAccessNotFoundError) return missing();
    throw error;
  }

  const pageId = req.nextUrl.searchParams.get("page");
  if (pageId === null) {
    return NextResponse.json(
      { tree: withinSubtree(store, rootId) },
      { headers: noStore },
    );
  }

  // The subtree check runs before the read, so a page outside the share is
  // never opened on the way to being refused.
  if (!store.isWithinSubtree(rootId, pageId) || store.isDeleted(pageId)) {
    return missing();
  }
  try {
    const page = await store.readPage(pageId);
    return NextResponse.json(
      { meta: visitorMeta(page.meta), markdown: page.markdown, rev: page.rev },
      { headers: noStore },
    );
  } catch (error) {
    if (isNotFound(error)) return missing();
    return NextResponse.json(
      { error: "the notes folder could not answer", reason: "store_failed" },
      { status: 500, headers: noStore },
    );
  }
}

const noStore = { "Cache-Control": "private, no-store" };

/** The shared subtree as a flat list, the same shape and the same five fields
 *  the owner's `read.tree` projects. Chosen rather than filtered: a new key
 *  on `TreeNode` does not become something a stranger's browser can read. */
function withinSubtree(
  store: { getTree(): readonly TreeNode[]; isWithinSubtree(rootId: string, id: string): boolean },
  rootId: string,
) {
  const out: {
    id: string;
    parentId: string | null;
    title: string;
    icon?: string;
    kind?: "app";
  }[] = [];
  const walk = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      if (store.isWithinSubtree(rootId, node.id)) {
        out.push({
          id: node.id,
          parentId: node.parentId,
          title: node.title,
          ...(node.icon === undefined ? {} : { icon: node.icon }),
          ...(node.kind === undefined ? {} : { kind: node.kind }),
        });
      }
      walk(node.children);
    }
  };
  walk(store.getTree());
  return out;
}

/** WHAT A STRANGER'S BROWSER MAY SEE OF ONE PAGE.
 *
 *  Four fields, the ones the tree already carries. The owner's own
 *  `read.page` answers more because it is answering the owner; here the
 *  reader is whoever has the link, so this is the shorter list on purpose and
 *  it is an allowlist rather than a filter for the same reason the tree
 *  projection is. The body and the rev are the two the app is actually
 *  after. */
function visitorMeta(meta: { id: string; title: string; icon?: string; kind?: "app" }) {
  return {
    id: meta.id,
    title: meta.title,
    ...(meta.icon === undefined ? {} : { icon: meta.icon }),
    ...(meta.kind === undefined ? {} : { kind: meta.kind }),
  };
}

function missing() {
  return NextResponse.json({ error: "not found" }, { status: 404, headers: noStore });
}

function busy() {
  return NextResponse.json(
    { error: "temporarily unavailable" },
    { status: 503, headers: { ...noStore, "Retry-After": "1" } },
  );
}
