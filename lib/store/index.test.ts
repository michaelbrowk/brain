import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

import {
  OWNER_SETTINGS_FILE,
  peekModules,
  resetOwnerSettingsCache,
  type ModuleSwitches,
} from "@/lib/owner-settings";
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
    // `tasksEnabled` is the memoised peek at the Tasks switch, handed over as
    // a getter rather than a value because this singleton outlives every flip
    // of it (`lib/owner-settings.ts`).
    expect(mocks.construct).toHaveBeenCalledWith(expect.any(String), {
      publicOrigin: "https://brain.example",
      tasksEnabled: expect.any(Function),
    });
  });

  // THE WARM IS THE WHOLE POINT OF THE PEEK, and it reads as redundant.
  //
  // `tasksEnabled` answers from the memoised read and never from the disk,
  // because it runs on the page-save path inside a synchronous signature. A
  // process that has read nothing yet peeks `null`, which the getter treats
  // as on. So without this one `readModules()` ahead of `init()`, the first
  // save after a cold boot reconciles a note whose tasks the owner switched
  // off, and writes the record the switch forbids. `init()` itself walks the
  // whole tree and reconciles every page it finds, which is why the answer
  // has to be in the cache before it runs and not merely before the first
  // request.
  describe("the module-switch warm", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-store-warm-"));
      vi.stubEnv("BRAIN_SETTINGS_STATE_DIR", dir);
      resetOwnerSettingsCache(dir);
    });

    afterEach(async () => {
      resetOwnerSettingsCache(dir);
      await fs.rm(dir, { recursive: true, force: true });
    });

    it("has read the switches before init walks the tree", async () => {
      expect(peekModules(dir)).toBeNull();
      let peekedInsideInit: ModuleSwitches | null | "never ran" = "never ran";
      mocks.init.mockImplementation(async () => {
        peekedInsideInit = peekModules(dir);
      });

      await getStore();

      expect(peekedInsideInit).toEqual({ mail: true, tasks: true });
      expect(peekModules(dir)).toEqual({ mail: true, tasks: true });
    });

    it("hands the Store a getter that answers the switch on disk", async () => {
      await fs.writeFile(
        path.join(dir, OWNER_SETTINGS_FILE),
        `${JSON.stringify({ schema: 2, timeZone: null, modules: { mail: true, tasks: false } })}\n`,
        "utf8",
      );
      resetOwnerSettingsCache(dir);
      mocks.init.mockResolvedValue(undefined);

      await getStore();

      const options = mocks.construct.mock.calls[0]![1] as {
        tasksEnabled: () => boolean;
      };
      expect(options.tasksEnabled()).toBe(false);
    });

    // A settings file nobody can read must not take the notes down with it:
    // the warm is best effort, and the getter's `null` peek reads as on.
    it("starts anyway when the settings file cannot be read", async () => {
      await fs.writeFile(path.join(dir, OWNER_SETTINGS_FILE), "{not json", "utf8");
      resetOwnerSettingsCache(dir);
      mocks.init.mockResolvedValue(undefined);

      await expect(getStore()).resolves.toBeDefined();

      const options = mocks.construct.mock.calls[0]![1] as {
        tasksEnabled: () => boolean;
      };
      expect(options.tasksEnabled()).toBe(true);
    });
  });
});
