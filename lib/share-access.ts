import { verifyShareToken } from "./auth";
import { isShareExpired } from "./sharing";
import { isNotFound, type Page } from "./store/types";

export class ShareAccessNotFoundError extends Error {
  constructor() {
    super("shared page not found");
    this.name = "ShareAccessNotFoundError";
  }
}

export class ShareAccessBusyError extends Error {
  constructor() {
    super("shared page temporarily unavailable");
    this.name = "ShareAccessBusyError";
  }
}

class ShareAccessUnstableError extends Error {
  constructor(readonly authority?: RootAuthority) {
    super("shared page changed during authorization");
    this.name = "ShareAccessUnstableError";
  }
}

export interface ShareAccessStore {
  readPage(id: string): Promise<Page>;
  readDirectChildren(id: string): readonly ShareDirectChild[];
  isDeleted(id: string): boolean;
  isWithinSubtree(rootId: string, targetId: string): boolean;
  readMutationState(): { generation: number; active: boolean };
  waitForMutationIdle(timeoutMs: number): Promise<boolean>;
}

export type ShareDirectChild = Readonly<{
  id: string;
  title: string;
  icon?: string;
  /** An app page. A visitor sees the same mark the owner does, because the
   *  question it answers, who built this, is the visitor's question too. */
  kind?: "app";
}>;

/** What the index knows about one page's share standing: whether it is a root
 *  of its own, when that grant ends, and which ancestor absorbed the grant it
 *  used to carry. */
export type ShareFoldNode = Readonly<{
  public: boolean;
  shareExpiresAt: string | null;
  sharedUnder: string | null;
}>;

export interface ShareFoldStore {
  readShareNode(id: string): ShareFoldNode | null;
  isDeleted(id: string): boolean;
  isWithinSubtree(rootId: string, targetId: string): boolean;
}

/** A page whose own grant was absorbed by an ancestor's keeps the address the
 *  reader already has: this is the root that now answers for it, or null when
 *  nothing does and the old address is a 404 like any revoked share.
 *
 *  The pointer is a record of what the owner did, never a second source of
 *  hierarchy, and never authority of its own. A page that is a live grant is
 *  answered by that grant whatever a leftover pointer says: the fold clears
 *  `public` on the pages it absorbs, so the two can only be true together in a
 *  file somebody edited by hand, and sending that page to an ancestor would
 *  walk past its own password and widen the link to the ancestor's subtree.
 *
 *  Every hop is checked against the live tree — the named page has to exist,
 *  to still contain this one, to be undeleted and to be an active public root
 *  — so a page moved out from under the root that absorbed it, or a root whose
 *  share has since ended, resolves to nothing. A fold that was itself folded
 *  is followed up the chain, and a cycle in a hand-edited file runs out of
 *  hops rather than out of stack. */
export function resolveFoldedShareRoot(
  store: ShareFoldStore,
  id: string,
  now = Date.now(),
): string | null {
  if (store.isDeleted(id)) return null;
  const seen = new Set<string>([id]);
  let current = store.readShareNode(id);
  if (isLiveGrant(current, now)) return null;
  while (current?.sharedUnder) {
    const rootId: string = current.sharedUnder;
    if (seen.has(rootId)) return null;
    seen.add(rootId);
    const root = store.readShareNode(rootId);
    if (
      !root ||
      store.isDeleted(rootId) ||
      !store.isWithinSubtree(rootId, id)
    ) {
      return null;
    }
    if (isLiveGrant(root, now)) return rootId;
    current = root;
  }
  return null;
}

function isLiveGrant(node: ShareFoldNode | null, now: number): boolean {
  return (
    !!node?.public && !isShareExpired(node.shareExpiresAt ?? undefined, now)
  );
}

/** What a shared page may draw for a page it links: the name and icon that
 *  page carries now, rather than the label the body was written with. */
export type SharePageLabel = Readonly<{
  title: string;
  icon?: string;
  kind?: "app";
}>;

export interface ShareLabelStore {
  isWithinSubtree(rootId: string, targetId: string): boolean;
  isDeleted(id: string): boolean;
  readPageLabel(id: string): ShareDirectChild | null;
}

/** Live titles for the pages a shared body links.
 *
 *  Markdown is the source of truth and a rename must not rewrite another
 *  file, so the label in a parent's `[📄 Untitled](/p/<id>)` stays whatever
 *  the child was called that day. The owner never sees it — the editor's
 *  page-ref node draws the live title and icon from the tree — and this is
 *  the same answer for a visitor.
 *
 *  Authorization is the rule the shared page already applies to those links:
 *  inside the root's subtree and not deleted, which is what decides whether a
 *  ref may link at all. A page outside the share is never read, so nothing
 *  about one reaches the visitor. The work is bounded by the links the body
 *  carries, and each id is asked once however many times it appears. */
export function resolveShareLabels(
  store: ShareLabelStore,
  rootId: string,
  ids: Iterable<string>,
): ReadonlyMap<string, SharePageLabel> {
  const labels = new Map<string, SharePageLabel>();
  for (const id of new Set(ids)) {
    if (!store.isWithinSubtree(rootId, id) || store.isDeleted(id)) continue;
    const label = store.readPageLabel(id);
    if (!label) continue;
    labels.set(
      id,
      Object.freeze({
        title: label.title,
        ...(label.icon === undefined ? {} : { icon: label.icon }),
        ...(label.kind === undefined ? {} : { kind: label.kind }),
      }),
    );
  }
  return labels;
}

type GrantedShareAccess = {
  kind: "granted";
  root: Page;
  target: Page;
  shareVersion: number;
  directChildren: readonly ShareDirectChild[];
};

type PasswordRequiredShareAccess = {
  kind: "password-required";
  root: Page;
  shareVersion: number;
};

export type ShareAccess =
  | GrantedShareAccess
  | PasswordRequiredShareAccess;

type RootAuthority = {
  public: boolean;
  sharePass: string | null;
  shareVersion: number;
  shareExpiresAt: string | null;
  deleted: boolean;
};

const SHARE_ACCESS_ATTEMPTS = 3;
const SHARE_ACCESS_BUDGET_MS = 400;

/** Resolve one public shared subtree from its live root on every request.
 * Only root metadata grants access. Descendant sharing metadata is deliberately
 * ignored so moving a page cannot silently broaden or narrow inherited access. */
export async function resolveShareAccess(
  store: ShareAccessStore,
  input: {
    rootId: string;
    targetId?: string;
    requestedVersion?: string;
    token?: string;
    verifyToken?: typeof verifyShareToken;
    allowPasswordGate?: boolean;
  },
): Promise<ShareAccess> {
  const deadline = Date.now() + SHARE_ACCESS_BUDGET_MS;
  let previousAuthority: RootAuthority | undefined;
  for (let attempt = 0; attempt < SHARE_ACCESS_ATTEMPTS; attempt += 1) {
    try {
      return await resolveShareAccessAttempt(
        store,
        input,
        deadline,
        previousAuthority,
      );
    } catch (error) {
      if (!(error instanceof ShareAccessUnstableError)) throw error;
      previousAuthority = error.authority ?? previousAuthority;
      if (
        attempt === SHARE_ACCESS_ATTEMPTS - 1 ||
        Date.now() >= deadline
      ) {
        throw new ShareAccessBusyError();
      }
    }
  }
  throw new ShareAccessBusyError();
}

async function resolveShareAccessAttempt(
  store: ShareAccessStore,
  input: {
    rootId: string;
    targetId?: string;
    requestedVersion?: string;
    token?: string;
    verifyToken?: typeof verifyShareToken;
    allowPasswordGate?: boolean;
  },
  deadline: number,
  previousAuthority?: RootAuthority,
): Promise<ShareAccess> {
  const targetId = input.targetId ?? input.rootId;
  let initialMutation = store.readMutationState();
  if (initialMutation.active) {
    const remaining = deadline - Date.now();
    if (
      remaining <= 0 ||
      !(await store.waitForMutationIdle(remaining))
    ) {
      throw new ShareAccessUnstableError();
    }
    initialMutation = store.readMutationState();
  }
  if (initialMutation.active) throw new ShareAccessUnstableError();

  const root = await readSharedPage(
    store,
    input.rootId,
    initialMutation.generation,
  );
  assertStableMutation(store, initialMutation.generation);
  const initialAuthority = rootAuthority(
    store,
    input.rootId,
    root,
    initialMutation.generation,
  );
  if (previousAuthority) {
    assertSameAuthority(previousAuthority, initialAuthority);
  }
  if (
    initialAuthority.deleted ||
    !initialAuthority.public ||
    isShareExpired(root.meta.shareExpiresAt)
  ) {
    throw new ShareAccessNotFoundError();
  }

  const shareVersion = initialAuthority.shareVersion;
  if (
    input.requestedVersion !== undefined &&
    input.requestedVersion !== String(shareVersion)
  ) {
    throw new ShareAccessNotFoundError();
  }

  if (root.meta.sharePass) {
    const verify = input.verifyToken ?? verifyShareToken;
    const valid = await verify(
      input.token,
      input.rootId,
      shareVersion,
    );
    assertStableMutation(
      store,
      initialMutation.generation,
      initialAuthority,
    );
    if (!valid) {
      // Every target value under a locked root gets the same root-owned gate.
      // Do not touch descendant membership, deletion state, or body before a
      // valid root token, otherwise public timing reveals private structure.
      const liveRoot = await readSharedPage(
        store,
        input.rootId,
        initialMutation.generation,
        initialAuthority,
      );
      assertStableAuthority(
        store,
        input.rootId,
        initialMutation.generation,
        initialAuthority,
        liveRoot,
      );
      if (input.allowPasswordGate) {
        return { kind: "password-required", root: liveRoot, shareVersion };
      }
      throw new ShareAccessNotFoundError();
    }
  }

  if (
    !store.isWithinSubtree(input.rootId, targetId) ||
    store.isDeleted(targetId)
  ) {
    throw new ShareAccessNotFoundError();
  }
  const target =
    targetId === input.rootId
      ? root
      : await readSharedPage(
          store,
          targetId,
          initialMutation.generation,
          initialAuthority,
        );

  // This is deliberately the final await. From the checks below through the
  // return there is no yield where a Store mutation can start.
  const liveRoot = await readSharedPage(
    store,
    input.rootId,
    initialMutation.generation,
    initialAuthority,
  );
  assertStableMutation(
    store,
    initialMutation.generation,
    initialAuthority,
  );
  assertSameAuthority(
    initialAuthority,
    rootAuthority(
      store,
      input.rootId,
      liveRoot,
      initialMutation.generation,
    ),
  );
  if (
    !store.isWithinSubtree(input.rootId, targetId) ||
    store.isDeleted(targetId)
  ) {
    throw new ShareAccessNotFoundError();
  }
  const directChildren = Object.freeze(
    store.readDirectChildren(targetId).map((child) =>
      Object.freeze({
        id: child.id,
        title: child.title,
        ...(child.icon === undefined ? {} : { icon: child.icon }),
      }),
    ),
  );
  assertStableAuthority(
    store,
    input.rootId,
    initialMutation.generation,
    initialAuthority,
    liveRoot,
  );
  if (
    !store.isWithinSubtree(input.rootId, targetId) ||
    store.isDeleted(targetId)
  ) {
    throw new ShareAccessNotFoundError();
  }
  return {
    kind: "granted",
    root: liveRoot,
    target,
    shareVersion,
    directChildren,
  };
}

async function readSharedPage(
  store: ShareAccessStore,
  id: string,
  generation: number,
  authority?: RootAuthority,
): Promise<Page> {
  try {
    const page = await store.readPage(id);
    assertStableMutation(store, generation, authority);
    return page;
  } catch (error) {
    if (error instanceof ShareAccessUnstableError) throw error;
    if (isNotFound(error)) {
      const mutation = store.readMutationState();
      if (
        mutation.active ||
        mutation.generation !== generation
      ) {
        throw new ShareAccessUnstableError(authority);
      }
      throw new ShareAccessNotFoundError();
    }
    throw error;
  }
}

function rootAuthority(
  store: ShareAccessStore,
  rootId: string,
  root: Page,
  generation: number,
): RootAuthority {
  let deleted: boolean;
  try {
    deleted = store.isDeleted(rootId);
  } catch (error) {
    if (isNotFound(error)) {
      assertStableMutation(store, generation);
      throw new ShareAccessNotFoundError();
    }
    throw error;
  }
  return {
    public: root.meta.public === true,
    sharePass: root.meta.sharePass ?? null,
    shareVersion: root.meta.shareVersion ?? 0,
    shareExpiresAt: root.meta.shareExpiresAt ?? null,
    deleted,
  };
}

function assertStableAuthority(
  store: ShareAccessStore,
  rootId: string,
  generation: number,
  initial: RootAuthority,
  liveRoot: Page,
): void {
  assertStableMutation(store, generation, initial);
  assertSameAuthority(
    initial,
    rootAuthority(store, rootId, liveRoot, generation),
  );
}

function assertSameAuthority(
  initial: RootAuthority,
  live: RootAuthority,
): void {
  if (
    initial.public !== live.public ||
    initial.sharePass !== live.sharePass ||
    initial.shareVersion !== live.shareVersion ||
    initial.shareExpiresAt !== live.shareExpiresAt ||
    initial.deleted !== live.deleted ||
    !live.public ||
    live.deleted ||
    isShareExpired(live.shareExpiresAt ?? undefined)
  ) {
    throw new ShareAccessNotFoundError();
  }
}

function assertStableMutation(
  store: ShareAccessStore,
  generation: number,
  authority?: RootAuthority,
): void {
  const finalMutation = store.readMutationState();
  if (
    finalMutation.active ||
    finalMutation.generation !== generation
  ) {
    throw new ShareAccessUnstableError(authority);
  }
}
