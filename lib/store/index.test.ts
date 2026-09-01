import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  init: vi.fn<() => Promise<void>>(),
  construct: vi.fn<(root: string, options: unknown) => void>(),
}));

vi.mock("./store", () => ({
  MAX_ATTACHMENT_BYTES: 0,
  Store: class {
    constructor(root: string, options: unknown) {
      mocks.construct(root, options);
    }
    init = mocks.init;
  },
}));

import { configuredPublicOrigin, getStore } from "./index";

const g = globalThis as unknown as {
  __brainStore?: unknown;
  __brainStoreInit?: Promise<unknown>;
};

describe("getStore", () => {
  beforeEach(() => {
    delete g.__brainStore;
    delete g.__brainStoreInit;
    mocks.init.mockReset();
    mocks.construct.mockReset();
  });

  afterEach(() => {
    delete g.__brainStore;
    delete g.__brainStoreInit;
    vi.unstubAllEnvs();
  });

  it("tries the start again after one that failed closed", async () => {
    // A move journal the disk no longer matches makes `init` throw before it
    // writes. The first request sees the failure; the second must not see a
    // cached copy of it, or the site stays down until someone restarts it.
    mocks.init
      .mockRejectedValueOnce(
        new Error("move intent origin revision mismatch: page-a"),
      )
      .mockResolvedValueOnce(undefined);

    await expect(getStore()).rejects.toThrow("origin revision mismatch");
    const store = await getStore();

    expect(store).toBeDefined();
    expect(mocks.init).toHaveBeenCalledTimes(2);
    expect(g.__brainStore).toBe(store);
    await expect(getStore()).resolves.toBe(store);
    expect(mocks.init).toHaveBeenCalledTimes(2);
  });

  it("shares one start between concurrent first requests", async () => {
    mocks.init.mockResolvedValue(undefined);

    const [first, second] = await Promise.all([getStore(), getStore()]);

    expect(first).toBe(second);
    expect(mocks.init).toHaveBeenCalledTimes(1);
  });

  it("hands the Store the configured public origin, or none", async () => {
    // The browser classifies page links against window.location.origin. The
    // Store has to use the same origin, or the rows it counts in a body are
    // not the rows the editor numbered.
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example");
    expect(configuredPublicOrigin()).toBe("https://brain.example");
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "http://127.0.0.1:3170");
    expect(configuredPublicOrigin()).toBe("http://127.0.0.1:3170");
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example/");
    expect(configuredPublicOrigin()).toBe(null);
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "brain.example");
    expect(configuredPublicOrigin()).toBe(null);
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "");
    expect(configuredPublicOrigin()).toBe(null);

    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example");
    mocks.init.mockResolvedValue(undefined);
    await getStore();
    expect(mocks.construct).toHaveBeenCalledWith(expect.any(String), {
      publicOrigin: "https://brain.example",
    });
  });
});
