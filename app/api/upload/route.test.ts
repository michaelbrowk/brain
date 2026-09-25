import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);

/** The store the mocked `getStore` hands the route. A module-scope holder
 *  because the mock factory has to be registered before the route is imported,
 *  and the store is built after that, inside the fresh module graph. */
let routeStore: unknown = null;

describe("generic upload route dedupes by content", () => {
  const roots: string[] = [];

  afterEach(async () => {
    routeStore = null;
    vi.doUnmock("@/lib/store");
    vi.resetModules();
    await Promise.all(
      roots
        .splice(0)
        .map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  /** The real Store on a temporary notes folder, so what the route answers is
   *  what the store decided rather than what a stand-in was told to say. The
   *  registry is reset after the mock is registered and before anything is
   *  imported: this file already imported the route at the top, and a cached
   *  route would reach the real notes folder instead. */
  async function routeOnRealStore() {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "brain-upload-route-"),
    );
    roots.push(root);
    vi.doMock("@/lib/store", async () => {
      const actual =
        await vi.importActual<typeof import("@/lib/store")>("@/lib/store");
      return { ...actual, getStore: async () => routeStore };
    });
    vi.resetModules();
    const { Store } = await import("@/lib/store/store");
    const store = new Store(root);
    await store.init();
    routeStore = store;
    const route = await import("./route");
    return { post: route.POST, root };
  }

  const upload = (handler: typeof POST, name: string): Promise<Response> => {
    const form = new FormData();
    form.set("file", new File([PNG_BYTES], name, { type: "image/png" }));
    return handler(
      new NextRequest("https://brain.test/api/upload", {
        method: "POST",
        body: form,
      }),
    );
  };

  it("answers one url for two uploads of the same image", async () => {
    const { post: handler, root } = await routeOnRealStore();

    const first = await (await upload(handler, "shot.png")).json();
    const second = await (await upload(handler, "shot-copy.png")).json();

    const digest = createHash("sha256").update(PNG_BYTES).digest("hex");
    expect(first.url).toBe(`/_attachments-v2/${digest}.png`);
    // The display name is the one each upload sent. The file under it is one.
    expect(second.url).toBe(first.url);
    expect(first.name).toBe("shot.png");
    expect(second.name).toBe("shot-copy.png");
    expect(await fs.readdir(path.join(root, "_attachments"))).toEqual([
      `${digest}.png`,
    ]);
  });
});

describe("generic upload route active MIME policy", () => {
  it.each(["image/x-svg+xml", "application/svg+xml"])(
    "rejects SVG alias %s before Store upload",
    async (mimeType) => {
      const form = new FormData();
      form.set(
        "file",
        new File(
          ['<svg xmlns="http://www.w3.org/2000/svg"></svg>'],
          "misleading.png",
          { type: mimeType },
        ),
      );
      const response = await POST(
        new NextRequest("https://brain.test/api/upload", {
          method: "POST",
          body: form,
        }),
      );

      expect(response.status).toBe(415);
      await expect(response.json()).resolves.toEqual({
        error: "unsafe file type",
      });
    },
  );
});
