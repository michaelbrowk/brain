import { describe, expect, it, vi } from "vitest";
import { resolveShareAccess, ShareAccessNotFoundError } from "./share-access";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(options: {
  root?: Record<string, unknown>;
  target?: Record<string, unknown>;
  within?: boolean;
  deleted?: string[];
}) {
  const timestamps = {
    order: "a0",
    created: "2026-07-28T00:00:00.000Z",
    updated: "2026-07-28T00:00:00.000Z",
  };
  const root = {
    meta: {
      id: "root",
      title: "Root",
      ...timestamps,
      public: true,
      shareVersion: 4,
      sharePass: undefined as string | undefined,
      shareExpiresAt: undefined as string | undefined,
      ...options.root,
    },
    markdown: "[Child](/p/child)",
    rev: "root-rev",
  };
  const target = {
    meta: {
      id: "child",
      title: "Child",
      ...timestamps,
      ...options.target,
    },
    markdown: "child body",
    rev: "child-rev",
  };
  const readPage = vi.fn(async (id: string) => {
    if (id === "root") return root;
    if (id === "child") return target;
    throw Object.assign(new Error("missing"), { name: "NotFoundError" });
  });
  const isDeleted = vi.fn(
    (id: string) => options.deleted?.includes(id) ?? false,
  );
  const isWithinSubtree = vi.fn(() => options.within ?? true);
  const mutationState = { generation: 0, active: false };
  const readMutationState = vi.fn(() => ({ ...mutationState }));
  const waitForMutationIdle = vi.fn(async () => !mutationState.active);
  const readDirectChildren = vi.fn(
    (): Array<{ id: string; title: string; icon?: string }> => [
      { id: "derived", title: "Derived child", icon: "🧭" },
    ],
  );
  return {
    store: {
      readPage,
      isDeleted,
      isWithinSubtree,
      readMutationState,
      waitForMutationIdle,
      readDirectChildren,
    },
    readPage,
    isDeleted,
    isWithinSubtree,
    root,
    target,
    mutationState,
    readMutationState,
    waitForMutationIdle,
    readDirectChildren,
  };
}

describe("shared subtree access", () => {
  it("waits for an active unrelated mutation before reading a shared page", async () => {
    const gate = deferred<boolean>();
    const {
      store,
      readPage,
      mutationState,
      waitForMutationIdle,
    } = fixture({});
    mutationState.active = true;
    mutationState.generation = 1;
    waitForMutationIdle.mockImplementation(() => gate.promise);

    const resolving = resolveShareAccess(store, {
      rootId: "root",
      targetId: "child",
    });
    await vi.waitFor(() =>
      expect(waitForMutationIdle).toHaveBeenCalledTimes(1),
    );
    expect(readPage).not.toHaveBeenCalled();

    mutationState.active = false;
    mutationState.generation = 2;
    gate.resolve(true);

    await expect(resolving).resolves.toMatchObject({
      kind: "granted",
      root: { meta: { id: "root" } },
      target: { meta: { id: "child" } },
    });
  });

  it("restarts authorization after a generation change during a root read", async () => {
    const { store, root, readPage, mutationState } = fixture({});
    readPage.mockImplementationOnce(async () => {
      mutationState.generation += 2;
      return root;
    });

    await expect(
      resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
      }),
    ).resolves.toMatchObject({
      kind: "granted",
      target: { meta: { id: "child" } },
    });
    expect(readPage).toHaveBeenCalledTimes(4);
  });

  it("retries a not-found root read only when the generation changed", async () => {
    const { store, readPage, mutationState } = fixture({});
    readPage.mockImplementationOnce(async () => {
      mutationState.generation += 2;
      throw Object.assign(new Error("transient missing"), {
        name: "NotFoundError",
      });
    });

    await expect(
      resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
      }),
    ).resolves.toMatchObject({ kind: "granted" });
  });

  it("returns busy instead of not-found after bounded unstable attempts", async () => {
    const {
      store,
      readPage,
      mutationState,
      waitForMutationIdle,
    } = fixture({});
    mutationState.active = true;
    waitForMutationIdle.mockResolvedValue(false);

    await expect(
      resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
      }),
    ).rejects.toMatchObject({ name: "ShareAccessBusyError" });
    expect(waitForMutationIdle).toHaveBeenCalledTimes(3);
    expect(readPage).not.toHaveBeenCalled();
  });

  it("keeps the locked-root gate target-blind after an unstable retry", async () => {
    const {
      store,
      root,
      readPage,
      isDeleted,
      isWithinSubtree,
      mutationState,
    } = fixture({
      root: { sharePass: "root-hash" },
      within: false,
    });
    readPage.mockImplementationOnce(async () => {
      mutationState.generation += 2;
      return root;
    });

    await expect(
      resolveShareAccess(store, {
        rootId: "root",
        targetId: "outside",
        verifyToken: async () => false,
        allowPasswordGate: true,
      }),
    ).resolves.toMatchObject({ kind: "password-required" });
    expect(isWithinSubtree).not.toHaveBeenCalled();
    expect(isDeleted).not.toHaveBeenCalledWith("outside");
  });

  it("inherits access from the live root and ignores child sharing metadata", async () => {
    const { store } = fixture({
      target: {
        public: false,
        sharePass: "unrelated-child-hash",
        shareExpiresAt: "2000-01-01T00:00:00.000Z",
        shareVersion: 99,
      },
    });

    await expect(
      resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
      }),
    ).resolves.toMatchObject({
      kind: "granted",
      root: { meta: { id: "root", shareVersion: 4 } },
      target: { meta: { id: "child" } },
      shareVersion: 4,
      directChildren: [
        { id: "derived", title: "Derived child", icon: "🧭" },
      ],
    });
  });

  it.each([
    ["valid", "child", false, true],
    ["unrelated", "outside", false, false],
    ["missing", "missing", false, false],
    ["deleted", "deleted-child", true, true],
  ])(
    "returns the same root password gate for a %s target without target calls",
    async (_label, targetId, deleted, within) => {
      const {
        store,
        readPage,
        isDeleted,
        isWithinSubtree,
        readDirectChildren,
      } = fixture({
        root: { sharePass: "root-hash" },
        deleted: deleted ? [targetId] : [],
        within,
      });

      const access = await resolveShareAccess(store, {
        rootId: "root",
        targetId,
        verifyToken: async () => false,
        allowPasswordGate: true,
      });

      expect(access).toMatchObject({
        kind: "password-required",
        root: { meta: { id: "root" } },
        shareVersion: 4,
      });
      expect(readPage).toHaveBeenCalledTimes(2);
      expect(readPage).toHaveBeenNthCalledWith(1, "root");
      expect(readPage).toHaveBeenNthCalledWith(2, "root");
      expect(isWithinSubtree).not.toHaveBeenCalled();
      expect(isDeleted).not.toHaveBeenCalledWith(targetId);
      expect(readDirectChildren).not.toHaveBeenCalled();
    },
  );

  it("fails closed when the target moves while direct children are read", async () => {
    const {
      store,
      mutationState,
      isWithinSubtree,
      readDirectChildren,
    } = fixture({ within: true });
    readDirectChildren.mockImplementationOnce(() => {
      mutationState.generation += 2;
      isWithinSubtree.mockReturnValue(false);
      return [{ id: "stale", title: "Stale child" }];
    });

    await expect(
      resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
      }),
    ).rejects.toBeInstanceOf(ShareAccessNotFoundError);
  });

  it("does not return children captured during concurrent share revocation", async () => {
    const { store, root, mutationState, readDirectChildren } = fixture({});
    readDirectChildren.mockImplementationOnce(() => {
      mutationState.generation += 2;
      root.meta.public = false;
      return [{ id: "stale", title: "Stale child" }];
    });

    await expect(
      resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
      }),
    ).rejects.toBeInstanceOf(ShareAccessNotFoundError);
  });

  it("enforces target membership after a valid root token", async () => {
    const { store, readPage, isWithinSubtree } = fixture({
      root: { sharePass: "root-hash" },
      within: false,
    });

    await expect(
      resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
        token: "valid",
        verifyToken: async () => true,
        allowPasswordGate: true,
      }),
    ).rejects.toBeInstanceOf(ShareAccessNotFoundError);
    expect(readPage).toHaveBeenCalledTimes(1);
    expect(isWithinSubtree).toHaveBeenCalledWith("root", "child");
  });

  it.each([
    ["private root", { root: { public: false } }],
    [
      "expired root",
      { root: { shareExpiresAt: "2000-01-01T00:00:00.000Z" } },
    ],
    ["deleted root", { deleted: ["root"] }],
    ["outside target", { within: false }],
    ["deleted target", { deleted: ["child"] }],
  ])("fails closed for %s", async (_label, options) => {
    const { store } = fixture(options);
    await expect(
      resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
      }),
    ).rejects.toBeInstanceOf(ShareAccessNotFoundError);
  });

  it("requires the current root version and root-scoped cookie", async () => {
    const verifyToken = vi.fn(async () => true);
    const { store } = fixture({ root: { sharePass: "root-hash" } });

    await expect(
      resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
        requestedVersion: "3",
        token: "share-token",
        verifyToken,
      }),
    ).rejects.toBeInstanceOf(ShareAccessNotFoundError);
    expect(verifyToken).not.toHaveBeenCalled();

    await expect(
      resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
        requestedVersion: "4",
        token: "share-token",
        verifyToken,
      }),
    ).resolves.toMatchObject({ kind: "granted", shareVersion: 4 });
    expect(verifyToken).toHaveBeenCalledWith("share-token", "root", 4);
  });

  it("propagates an unexpected root read error", async () => {
    const ioError = Object.assign(new Error("root io failed"), { code: "EIO" });
    const { store, readPage } = fixture({});
    readPage.mockRejectedValueOnce(ioError);

    await expect(
      resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
      }),
    ).rejects.toBe(ioError);
  });

  it("fails closed before reading store indexes after a concurrent root purge", async () => {
    const { store, root, readPage, isDeleted, mutationState } = fixture({});
    readPage.mockImplementationOnce(async () => {
      mutationState.generation += 2;
      return root;
    });
    isDeleted.mockImplementation(() => {
      throw Object.assign(new Error("root purged"), {
        name: "NotFoundError",
      });
    });

    await expect(
      resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
      }),
    ).rejects.toBeInstanceOf(ShareAccessNotFoundError);
    expect(isDeleted).toHaveBeenCalledTimes(1);
    expect(isDeleted).toHaveBeenCalledWith("root");
  });

  it("propagates an unexpected target read error", async () => {
    const ioError = Object.assign(new Error("target io failed"), {
      code: "EIO",
    });
    const { store, readPage, root } = fixture({});
    readPage
      .mockImplementationOnce(async () => root)
      .mockRejectedValueOnce(ioError);

    await expect(
      resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
      }),
    ).rejects.toBe(ioError);
    expect(readPage).toHaveBeenNthCalledWith(1, "root");
    expect(readPage).toHaveBeenNthCalledWith(2, "child");
  });

  it.each([
    ["token", "revoke", (root: FixtureRoot) => {
      root.meta.public = false;
    }],
    ["token", "version rotation", (root: FixtureRoot) => {
      root.meta.shareVersion = 5;
    }],
    ["token", "password rotation", (root: FixtureRoot) => {
      root.meta.sharePass = "rotated-hash";
    }],
    ["token", "expiry", (root: FixtureRoot) => {
      root.meta.shareExpiresAt = "2000-01-01T00:00:00.000Z";
    }],
    ["target", "revoke", (root: FixtureRoot) => {
      root.meta.public = false;
    }],
    ["target", "version rotation", (root: FixtureRoot) => {
      root.meta.shareVersion = 5;
    }],
    ["target", "password enablement", (root: FixtureRoot) => {
      root.meta.sharePass = "new-hash";
    }],
    ["target", "expiry", (root: FixtureRoot) => {
      root.meta.shareExpiresAt = "2000-01-01T00:00:00.000Z";
    }],
  ])(
    "does not grant after concurrent %s-phase %s",
    async (phase, _change, mutateAuthority) => {
      const tokenGate = deferred<boolean>();
      const targetGate = deferred<FixtureTarget>();
      const { store, root, target, readPage, mutationState } = fixture({
        root: phase === "token" ? { sharePass: "root-hash" } : {},
      });
      readPage.mockImplementation(async (id: string) => {
        if (id === "root") return root;
        if (id === "child") return targetGate.promise;
        throw Object.assign(new Error("missing"), { name: "NotFoundError" });
      });
      const verifyToken = vi.fn(() => tokenGate.promise);

      const resolving = resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
        token: phase === "token" ? "token" : undefined,
        verifyToken,
      });
      if (phase === "token") {
        await vi.waitFor(() => expect(verifyToken).toHaveBeenCalled());
      } else {
        await vi.waitFor(() =>
          expect(readPage).toHaveBeenCalledWith("child"),
        );
      }

      mutationState.active = true;
      mutationState.generation += 1;
      mutateAuthority(root);
      mutationState.generation += 1;
      mutationState.active = false;
      tokenGate.resolve(true);
      targetGate.resolve(target);

      await expect(resolving).rejects.toBeInstanceOf(
        ShareAccessNotFoundError,
      );
    },
  );

  it("rejects a target observed during a transient move-in and rollback", async () => {
    const targetGate = deferred<FixtureTarget>();
    const {
      store,
      root,
      target,
      readPage,
      isWithinSubtree,
      mutationState,
    } = fixture({ within: true });
    readPage.mockImplementation(async (id: string) => {
      if (id === "root") return root;
      if (id === "child") return targetGate.promise;
      throw Object.assign(new Error("missing"), { name: "NotFoundError" });
    });

    const resolving = resolveShareAccess(store, {
      rootId: "root",
      targetId: "child",
    });
    await vi.waitFor(() => expect(readPage).toHaveBeenCalledWith("child"));
    mutationState.active = true;
    mutationState.generation += 1;
    isWithinSubtree.mockReturnValue(false);
    mutationState.generation += 1;
    mutationState.active = false;
    targetGate.resolve(target);

    await expect(resolving).rejects.toBeInstanceOf(
      ShareAccessNotFoundError,
    );
  });

  it("returns busy while a mutation remains active after target read", async () => {
    const targetGate = deferred<FixtureTarget>();
    const { store, root, target, readPage, mutationState } = fixture({});
    readPage.mockImplementation(async (id: string) => {
      if (id === "root") return root;
      if (id === "child") return targetGate.promise;
      throw Object.assign(new Error("missing"), { name: "NotFoundError" });
    });

    const resolving = resolveShareAccess(store, {
      rootId: "root",
      targetId: "child",
    });
    await vi.waitFor(() => expect(readPage).toHaveBeenCalledWith("child"));
    mutationState.active = true;
    mutationState.generation += 1;
    targetGate.resolve(target);

    await expect(resolving).rejects.toMatchObject({
      name: "ShareAccessBusyError",
    });
  });

  it("rejects when an unchanged expiry crosses while token verification is pending", async () => {
    const tokenGate = deferred<boolean>();
    const beforeExpiry = Date.parse("2026-07-28T00:00:00.000Z");
    const afterExpiry = Date.parse("2026-07-28T00:02:00.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(beforeExpiry);
    const { store } = fixture({
      root: {
        sharePass: "root-hash",
        shareExpiresAt: "2026-07-28T00:01:00.000Z",
      },
    });
    const verifyToken = vi.fn(() => tokenGate.promise);

    try {
      const resolving = resolveShareAccess(store, {
        rootId: "root",
        targetId: "child",
        token: "invalid-token",
        verifyToken,
        allowPasswordGate: true,
      });
      await vi.waitFor(() => expect(verifyToken).toHaveBeenCalled());

      clock.mockReturnValue(afterExpiry);
      tokenGate.resolve(false);

      await expect(resolving).rejects.toBeInstanceOf(
        ShareAccessNotFoundError,
      );
    } finally {
      clock.mockRestore();
    }
  });
});

type FixtureResult = ReturnType<typeof fixture>;
type FixtureRoot = FixtureResult["root"];
type FixtureTarget = FixtureResult["target"];
