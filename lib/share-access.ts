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
}>;

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
