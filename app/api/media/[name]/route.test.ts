import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  writeAttachmentScope,
  type AttachmentScope,
} from "@/lib/store/attachment-scope";

const NAME = "abcdef123456.png";
const SAFE_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const EXTERNAL_SECRET = new TextEncoder().encode("external attachment secret");
const roots: string[] = [];

async function loadRoute(options: {
  name?: string;
  page?: {
    meta: {
      id?: string;
      public?: boolean;
      sharePass?: string;
      shareVersion?: number;
      shareExpiresAt?: string;
    };
    markdown: string;
  };
  deleted?: boolean;
  deletedIds?: string[];
  within?: boolean;
}) {
  const name = options.name ?? NAME;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-media-test-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "_attachments"));
  await fs.writeFile(
    path.join(root, "_attachments", name),
    SAFE_BYTES,
  );
  const readPage = vi.fn().mockImplementation(async () => {
    if (!options.page) throw Object.assign(new Error("missing"), { name: "NotFoundError" });
    return options.page;
  });
  const verifySession = vi.fn(async (token?: string) => token === "owner-token");
  const verifyShareToken = vi.fn(
    async (token?: string) => token === "share-token",
  );
  const isDeleted = vi.fn(
    (id: string) =>
      Boolean(options.deleted) || Boolean(options.deletedIds?.includes(id)),
  );
  const isWithinSubtree = vi.fn(() => options.within ?? true);
  const readMutationState = vi.fn(() => ({
    generation: 0,
    active: false,
  }));
  const waitForMutationIdle = vi.fn(async () => true);
  const readDirectChildren = vi.fn(() => []);

  vi.doMock("@/lib/store", () => ({
    NOTES_ROOT: root,
    getStore: async () => ({
      readPage,
      isDeleted,
      isWithinSubtree,
      readMutationState,
      waitForMutationIdle,
      readDirectChildren,
    }),
    isNotFound: (error: unknown) =>
      error instanceof Error && error.name === "NotFoundError",
  }));
  vi.doMock("@/lib/auth", () => ({
    SESSION_COOKIE: "brain_session",
    verifySession,
    verifyShareToken,
  }));
  const { GET } = await import("./route");
  return {
    GET,
    readPage,
    verifyShareToken,
    isDeleted,
    isWithinSubtree,
    readMutationState,
    waitForMutationIdle,
    root,
  };
}

async function externalAttachment() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-media-external-"));
  roots.push(root);
  const file = path.join(root, NAME);
  await fs.writeFile(file, EXTERNAL_SECRET);
  return { root, file };
}

function request(query = "", cookie?: string, name = NAME) {
  return new NextRequest(`https://brain.test/api/media/${name}${query}`, {
    headers: cookie ? { cookie } : undefined,
  });
}

describe("attachment access", () => {
  afterEach(async () => {
    vi.doUnmock("@/lib/store");
    vi.doUnmock("@/lib/auth");
    vi.restoreAllMocks();
    vi.resetModules();
    await Promise.all(
      roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("keeps a private attachment closed without an owner session", async () => {
    const { GET, readPage } = await loadRoute({});
    const response = await GET(request(), { params: Promise.resolve({ name: NAME }) });

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(readPage).not.toHaveBeenCalled();
  });

  it("returns retryable 503 instead of 404 while shared access stays busy", async () => {
    const {
      GET,
      readMutationState,
      waitForMutationIdle,
    } = await loadRoute({
      page: {
        meta: {
          id: "shared",
          public: true,
          shareVersion: 1,
        },
        markdown: `![](/_attachments-v2/${NAME})`,
      },
    });
    readMutationState.mockReturnValue({
      generation: 1,
      active: true,
    });
    waitForMutationIdle.mockResolvedValue(false);

    const response = await GET(
      request("?page=shared&v=1"),
      { params: Promise.resolve({ name: NAME }) },
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Retry-After")).toBe("1");
  });

  it("serves the owner with private no-store caching", async () => {
    const { GET } = await loadRoute({});
    const response = await GET(request("", "brain_session=owner-token"), {
      params: Promise.resolve({ name: NAME }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      SAFE_BYTES,
    );
  });

  it("rejects a symlinked attachment file without reading its target", async () => {
    const { GET, root } = await loadRoute({});
    const external = await externalAttachment();
    const file = path.join(root, "_attachments", NAME);
    await fs.rm(file);
    await fs.symlink(external.file, file);

    const response = await GET(request("", "brain_session=owner-token"), {
      params: Promise.resolve({ name: NAME }),
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("external attachment secret");
  });

  it("rejects a symlinked attachment directory without reading its target", async () => {
    const { GET, root } = await loadRoute({});
    const external = await externalAttachment();
    const directory = path.join(root, "_attachments");
    await fs.rm(directory, { recursive: true });
    await fs.symlink(external.root, directory, "dir");

    const response = await GET(request("", "brain_session=owner-token"), {
      params: Promise.resolve({ name: NAME }),
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("external attachment secret");
  });

  it("rejects a hard-linked attachment instead of exposing another file", async () => {
    const { GET, root } = await loadRoute({});
    const external = await externalAttachment();
    const file = path.join(root, "_attachments", NAME);
    await fs.rm(file);
    await fs.link(external.file, file);

    const response = await GET(request("", "brain_session=owner-token"), {
      params: Promise.resolve({ name: NAME }),
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("external attachment secret");
  });

  it("rejects an attachment parent swapped during file open", async () => {
    const { GET, root } = await loadRoute({});
    const external = await externalAttachment();
    const directory = path.join(root, "_attachments");
    const originalDirectory = path.join(root, "_attachments-original");
    const file = path.join(directory, NAME);
    const realOpen = fs.open.bind(fs);
    let swapped = false;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (!swapped && String(args[0]) === file) {
        swapped = true;
        await fs.rename(directory, originalDirectory);
        await fs.symlink(external.root, directory, "dir");
      }
      return realOpen(...args);
    });
    try {
      const response = await GET(request("", "brain_session=owner-token"), {
        params: Promise.resolve({ name: NAME }),
      });

      expect(swapped).toBe(true);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain("external attachment secret");
    } finally {
      open.mockRestore();
    }
  });

  it("streams the opened file when its pathname is swapped after verification", async () => {
    const { GET, root } = await loadRoute({});
    const external = await externalAttachment();
    const file = path.join(root, "_attachments", NAME);
    const originalFile = file + ".original";
    const realLstat = fs.lstat.bind(fs);
    let swapped = false;
    const lstat = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await realLstat(...args);
      if (!swapped && String(args[0]) === file) {
        swapped = true;
        await fs.rename(file, originalFile);
        await fs.symlink(external.file, file);
      }
      return stat;
    });
    try {
      const response = await GET(request("", "brain_session=owner-token"), {
        params: Promise.resolve({ name: NAME }),
      });

      expect(swapped).toBe(true);
      expect(response.status).toBe(200);
      const body = new Uint8Array(await response.arrayBuffer());
      expect(body).toEqual(SAFE_BYTES);
      expect(new TextDecoder().decode(body)).not.toContain(
        "external attachment secret",
      );
    } finally {
      lstat.mockRestore();
    }
  });

  it("closes the opened file descriptor when the web stream is cancelled", async () => {
    const { GET, root } = await loadRoute({});
    const file = path.join(root, "_attachments", NAME);
    await fs.writeFile(file, new Uint8Array(2 * 1024 * 1024));
    const realOpen = fs.open.bind(fs);
    let attachmentHandle: FileHandle | undefined;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === file) attachmentHandle = handle;
      return handle;
    });
    try {
      const response = await GET(request("", "brain_session=owner-token"), {
        params: Promise.resolve({ name: NAME }),
      });
      expect(response.status).toBe(200);
      expect(attachmentHandle).toBeDefined();
      await response.body?.cancel();
      await vi.waitFor(
        async () => {
          await expect(attachmentHandle!.stat()).rejects.toMatchObject({
            code: "EBADF",
          });
        },
        { timeout: 2_000, interval: 10 },
      );
    } finally {
      open.mockRestore();
      await attachmentHandle?.close().catch(() => undefined);
    }
  });

  it("streams large files and supports a bounded byte range", async () => {
    const { GET, root } = await loadRoute({});
    const large = new Uint8Array(2 * 1024 * 1024);
    large[1_500_000] = 42;
    await fs.writeFile(path.join(root, "_attachments", NAME), large);
    const readFile = vi.spyOn(fs, "readFile");
    const response = await GET(
      new NextRequest(`https://brain.test/api/media/${NAME}`, {
        headers: {
          cookie: "brain_session=owner-token",
          range: "bytes=1500000-1500000",
        },
      }),
      { params: Promise.resolve({ name: NAME }) },
    );

    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Length")).toBe("1");
    expect(response.headers.get("Content-Range")).toBe(
      `bytes 1500000-1500000/${large.byteLength}`,
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([42]),
    );
    expect(readFile).not.toHaveBeenCalled();
  });

  it("forces a hypothetical legacy SVG to download", async () => {
    const name = "abcdef123456.svg";
    const { GET } = await loadRoute({ name });
    const response = await GET(
      request("", "brain_session=owner-token", name),
      { params: Promise.resolve({ name }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("Content-Disposition")).toBe("attachment");
  });

  it("serves an attachment only through the public page and matching share version", async () => {
    const page = {
      meta: { public: true, shareVersion: 3 },
      markdown: `![](/_attachments-v2/${NAME})`,
    };
    const { GET } = await loadRoute({ page });
    const allowed = await GET(request("?page=shared&v=3"), {
      params: Promise.resolve({ name: NAME }),
    });
    const stale = await GET(request("?page=shared&v=2"), {
      params: Promise.resolve({ name: NAME }),
    });
    page.markdown = "private body";
    const unrelated = await GET(request("?page=shared&v=3"), {
      params: Promise.resolve({ name: NAME }),
    });

    expect(allowed.status).toBe(200);
    expect(stale.status).toBe(404);
    expect(unrelated.status).toBe(404);
  });

  it("does not serve attachments after a public link expires", async () => {
    const { GET, verifyShareToken } = await loadRoute({
      page: {
        meta: {
          public: true,
          sharePass: "hash",
          shareVersion: 3,
          shareExpiresAt: "2000-01-01T00:00:00.000Z",
        },
        markdown: `![](/_attachments-v2/${NAME})`,
      },
    });
    const response = await GET(
      request("?page=shared&v=3", "brain_share_shared=share-token"),
      { params: Promise.resolve({ name: NAME }) },
    );

    expect(response.status).toBe(404);
    expect(verifyShareToken).not.toHaveBeenCalled();
  });

  it("does not publish a private attachment mentioned only in fenced code", async () => {
    const { GET } = await loadRoute({
      page: {
        meta: { public: true, shareVersion: 3 },
        markdown: `\`\`\`md\n![](/_attachments-v2/${NAME})\n\`\`\``,
      },
    });
    const response = await GET(request("?page=shared&v=3"), {
      params: Promise.resolve({ name: NAME }),
    });

    expect(response.status).toBe(404);
  });

  it("uses the same directive cleanup for shared rendering and authorization", async () => {
    const { GET } = await loadRoute({
      page: {
        meta: { public: true, shareVersion: 3 },
        markdown: `:::col\n    ![](/_attachments-v2/${NAME})\n:::`,
      },
    });
    const response = await GET(request("?page=shared&v=3"), {
      params: Promise.resolve({ name: NAME }),
    });

    expect(response.status).toBe(404);
  });

  it("keeps page-ref labels from changing attachment authorization", async () => {
    const { GET } = await loadRoute({
      page: {
        meta: { public: true, shareVersion: 3 },
        markdown: `[\`\`\`](/p/page)\n![](/_attachments-v2/${NAME})`,
      },
    });
    const response = await GET(request("?page=shared&v=3"), {
      params: Promise.resolve({ name: NAME }),
    });

    expect(response.status).toBe(200);
  });

  it("requires the page-scoped token for a locked shared page", async () => {
    const { GET, verifyShareToken } = await loadRoute({
      page: {
        meta: { public: true, sharePass: "hash", shareVersion: 4 },
        markdown: `![](/_attachments-v2/${NAME})`,
      },
    });
    const denied = await GET(request("?page=shared&v=4"), {
      params: Promise.resolve({ name: NAME }),
    });
    const allowed = await GET(
      request("?page=shared&v=4", "brain_share_shared=share-token"),
      { params: Promise.resolve({ name: NAME }) },
    );

    expect(denied.status).toBe(404);
    expect(allowed.status).toBe(200);
    expect(verifyShareToken).toHaveBeenLastCalledWith(
      "share-token",
      "shared",
      4,
    );
  });

  it("serves descendant media only with root, target, root version, and a real target reference", async () => {
    const root = {
      meta: {
        id: "root",
        public: true,
        sharePass: "hash",
        shareVersion: 4,
      },
      markdown: "[Child](/p/child)",
    };
    const child = {
      meta: {
        id: "child",
        public: false,
        sharePass: "ignored-child-hash",
        shareVersion: 99,
      },
      markdown: `![](/_attachments-v2/${NAME})`,
    };
    const { GET, readPage, verifyShareToken } = await loadRoute({ page: root });
    readPage.mockImplementation(async (id: string) =>
      id === "root" ? root : child,
    );

    const allowed = await GET(
      request(
        "?root=root&page=child&v=4",
        "brain_share_root=share-token",
      ),
      { params: Promise.resolve({ name: NAME }) },
    );
    child.markdown = "no attachment";
    const noReference = await GET(
      request(
        "?root=root&page=child&v=4",
        "brain_share_root=share-token",
      ),
      { params: Promise.resolve({ name: NAME }) },
    );

    expect(allowed.status).toBe(200);
    expect(noReference.status).toBe(404);
    expect(verifyShareToken).toHaveBeenCalledWith("share-token", "root", 4);
  });

  it("rejects descendant media from a different shared subtree", async () => {
    const rootPage = {
      meta: { id: "root", public: true, shareVersion: 4 },
      markdown: "[Child](/p/child)",
    };
    const child = {
      meta: { id: "child" },
      markdown: `![](/_attachments-v2/${NAME})`,
    };
    const { GET, readPage } = await loadRoute({
      page: rootPage,
      within: false,
    });
    readPage.mockImplementation(async (id: string) =>
      id === "root" ? rootPage : child,
    );

    const response = await GET(
      request("?root=root&page=child&v=4"),
      { params: Promise.resolve({ name: NAME }) },
    );

    expect(response.status).toBe(404);
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it("rejects descendant media moved out during access resolution", async () => {
    const rootPage = {
      meta: { id: "root", public: true, shareVersion: 4 },
      markdown: "[Child](/p/child)",
    };
    const child = {
      meta: { id: "child" },
      markdown: `![](/_attachments-v2/${NAME})`,
    };
    const { GET, readPage, isWithinSubtree } = await loadRoute({
      page: rootPage,
    });
    readPage.mockImplementation(async (id: string) =>
      id === "root" ? rootPage : child,
    );
    isWithinSubtree.mockReturnValueOnce(true).mockReturnValueOnce(false);

    const response = await GET(
      request("?root=root&page=child&v=4"),
      { params: Promise.resolve({ name: NAME }) },
    );

    expect(response.status).toBe(404);
    expect(readPage).toHaveBeenCalledTimes(3);
    expect(readPage).toHaveBeenNthCalledWith(1, "root");
    expect(readPage).toHaveBeenNthCalledWith(2, "child");
    expect(readPage).toHaveBeenNthCalledWith(3, "root");
  });

  it("rejects media for a deleted descendant", async () => {
    const rootPage = {
      meta: { id: "root", public: true, shareVersion: 4 },
      markdown: "[Child](/p/child)",
    };
    const child = {
      meta: { id: "child" },
      markdown: `![](/_attachments-v2/${NAME})`,
    };
    const { GET, readPage } = await loadRoute({
      page: rootPage,
      deletedIds: ["child"],
    });
    readPage.mockImplementation(async (id: string) =>
      id === "root" ? rootPage : child,
    );

    const response = await GET(
      request("?root=root&page=child&v=4"),
      { params: Promise.resolve({ name: NAME }) },
    );

    expect(response.status).toBe(404);
    expect(readPage).toHaveBeenCalledTimes(1);
  });

  it("requires the root cookie and current root version for descendant media", async () => {
    const rootPage = {
      meta: {
        id: "root",
        public: true,
        sharePass: "hash",
        shareVersion: 4,
      },
      markdown: "[Child](/p/child)",
    };
    const child = {
      meta: { id: "child" },
      markdown: `![](/_attachments-v2/${NAME})`,
    };
    const { GET, readPage, verifyShareToken } = await loadRoute({
      page: rootPage,
    });
    readPage.mockImplementation(async (id: string) =>
      id === "root" ? rootPage : child,
    );

    const childCookie = await GET(
      request(
        "?root=root&page=child&v=4",
        "brain_share_child=share-token",
      ),
      { params: Promise.resolve({ name: NAME }) },
    );
    const wrongRootCookie = await GET(
      request(
        "?root=root&page=child&v=4",
        "brain_share_root=wrong",
      ),
      { params: Promise.resolve({ name: NAME }) },
    );
    const staleVersion = await GET(
      request(
        "?root=root&page=child&v=3",
        "brain_share_root=share-token",
      ),
      { params: Promise.resolve({ name: NAME }) },
    );

    expect(childCookie.status).toBe(404);
    expect(wrongRootCookie.status).toBe(404);
    expect(staleVersion.status).toBe(404);
    expect(verifyShareToken).not.toHaveBeenCalledWith(
      "share-token",
      "root",
      3,
    );
  });

  it.each([
    ["valid", "child", false, true],
    ["unrelated", "outside", false, false],
    ["missing", "missing", false, false],
    ["deleted", "deleted-child", true, true],
  ])(
    "uses the same locked-root media path for a %s target without a token",
    async (_label, targetId, deleted, within) => {
      const rootPage = {
        meta: {
          id: "root",
          public: true,
          sharePass: "hash",
          shareVersion: 4,
        },
        markdown: "[Child](/p/child)",
      };
      const { GET, readPage, isDeleted, isWithinSubtree } = await loadRoute({
        page: rootPage,
        deletedIds: deleted ? [targetId] : [],
        within,
      });

      const response = await GET(
        request(`?root=root&page=${targetId}&v=4`),
        { params: Promise.resolve({ name: NAME }) },
      );

      expect(response.status).toBe(404);
      expect(readPage).toHaveBeenCalledTimes(2);
      expect(readPage).toHaveBeenNthCalledWith(1, "root");
      expect(readPage).toHaveBeenNthCalledWith(2, "root");
      expect(isWithinSubtree).not.toHaveBeenCalled();
      expect(isDeleted).not.toHaveBeenCalledWith(targetId);
    },
  );

  it("propagates an unexpected shared-page read failure", async () => {
    const ioError = Object.assign(new Error("shared page io failed"), {
      code: "EIO",
    });
    const { GET, readPage } = await loadRoute({
      page: {
        meta: { id: "root", public: true, shareVersion: 4 },
        markdown: `![](/_attachments-v2/${NAME})`,
      },
    });
    readPage.mockRejectedValueOnce(ioError);

    await expect(
      GET(request("?page=root&v=4"), {
        params: Promise.resolve({ name: NAME }),
      }),
    ).rejects.toBe(ioError);
  });
});

describe("attachment scope for editable roots", () => {
  const EMPTY_SCOPE: AttachmentScope = { roots: [], uploads: {}, baseline: {} };

  afterEach(async () => {
    vi.doUnmock("@/lib/store");
    vi.doUnmock("@/lib/auth");
    vi.doUnmock("@/lib/share-access");
    vi.resetModules();
    await Promise.all(
      roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    );
  });

  /** One attachment on disk, one granted share whose root carries the
   *  shareEdit flag as given and whose target names the attachment (or not),
   *  and the scope index as the notes folder would hold it. The owner variant
   *  has a session and nothing else. */
  async function getMedia(
    name: string,
    options:
      | { owner: true }
      | {
          root: string;
          page: string;
          v: string;
          markdown: string;
          shareEdit: boolean;
          scope: AttachmentScope;
          /** Raw bytes to leave in place of the index, for the corruption
           *  cases where a well-formed scope cannot express the state. */
          scopeRaw?: string;
        },
  ) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-media-scope-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "_attachments"));
    await fs.writeFile(path.join(root, "_attachments", name), SAFE_BYTES);
    if (!("owner" in options)) {
      await writeAttachmentScope(root, options.scope);
      if (options.scopeRaw !== undefined) {
        await fs.writeFile(
          path.join(root, "_attachments", "scope.json"),
          options.scopeRaw,
        );
      }
    }

    vi.doMock("@/lib/store", () => ({
      NOTES_ROOT: root,
      getStore: async () => ({}),
      isNotFound: (error: unknown) =>
        error instanceof Error && error.name === "NotFoundError",
    }));
    vi.doMock("@/lib/auth", () => ({
      SESSION_COOKIE: "brain_session",
      verifySession: async (token?: string) => token === "owner-token",
    }));
    vi.doMock("@/lib/share-access", async () => {
      const actual = await vi.importActual<typeof import("@/lib/share-access")>(
        "@/lib/share-access",
      );
      const resolveShareAccess = async () => {
        if ("owner" in options) throw new Error("owner never resolves a share");
        return {
          kind: "granted" as const,
          root: {
            meta: {
              id: options.root,
              public: true,
              shareEdit: options.shareEdit,
              shareVersion: Number(options.v),
            },
          },
          target: { meta: { id: options.page }, markdown: options.markdown },
          shareVersion: Number(options.v),
          directChildren: [],
        };
      };
      return { ...actual, resolveShareAccess };
    });
    const { GET } = await import("./route");
    const query =
      "owner" in options
        ? ""
        : `?root=${options.root}&page=${options.page}&v=${options.v}`;
    return GET(
      request(query, "owner" in options ? "brain_session=owner-token" : undefined, name),
      { params: Promise.resolve({ name }) },
    );
  }

  it("404s a private page's attachment named by hand-written visitor Markdown", async () => {
    // root-1 is editable; the visitor's page names an attachment that belongs
    // to no root the index knows.
    const res = await getMedia("private00001.png", {
      root: "root-1",
      page: "page-9",
      v: "2",
      markdown: "![](/_attachments-v2/private00001.png)",
      shareEdit: true,
      scope: { roots: ["root-1"], uploads: {}, baseline: {} },
    });
    expect(res.status).toBe(404);
  });

  it("serves a visitor upload through its own root and 404s it through a second editable root", async () => {
    const scope: AttachmentScope = {
      roots: ["root-1", "root-2"],
      uploads: {
        "up0000000001.png": {
          root: "root-1",
          bytes: 10,
          at: "2026-09-05T10:00:00.000Z",
        },
      },
      baseline: {},
    };
    const mine = await getMedia("up0000000001.png", {
      root: "root-1",
      page: "page-9",
      v: "2",
      markdown: "![](/_attachments-v2/up0000000001.png)",
      shareEdit: true,
      scope,
    });
    const theirs = await getMedia("up0000000001.png", {
      root: "root-2",
      page: "page-8",
      v: "2",
      markdown: "![](/_attachments-v2/up0000000001.png)",
      shareEdit: true,
      scope,
    });
    expect(mine.status).toBe(200);
    expect(theirs.status).toBe(404);
  });

  it("serves an image the shared page already shows while its root is not in the index", async () => {
    // The owner has turned editing on, and no visitor has written yet, so the
    // index has never heard of root-1. Nothing in the subtree came from a
    // visitor, so the reference check alone still decides.
    const res = await getMedia("old000000001.png", {
      root: "root-1",
      page: "page-9",
      v: "2",
      markdown: "![](/_attachments-v2/old000000001.png)",
      shareEdit: true,
      scope: EMPTY_SCOPE,
    });
    expect(res.status).toBe(200);
  });

  it("stops serving that same image once the root is in the index", async () => {
    // The first visitor write put root-1 in the index and recorded what the
    // subtree named. A name the index does not grant is a 404 from then on.
    const res = await getMedia("old000000001.png", {
      root: "root-1",
      page: "page-9",
      v: "2",
      markdown: "![](/_attachments-v2/old000000001.png)",
      shareEdit: true,
      scope: { roots: ["root-1"], uploads: {}, baseline: {} },
    });
    expect(res.status).toBe(404);
  });

  it("falls back to the reference check when the index is unreadable", async () => {
    // The ruling, asserted rather than described: an index that cannot be
    // parsed holds no root, so an editable root is judged the way a read-only
    // share has always been judged. A visitor gains nothing by it, because
    // writeSharedPage rebuilds a lost root's baseline from the live subtree
    // before it admits any reference. lib/store/store.test.ts pins that half.
    const res = await getMedia("old000000001.png", {
      root: "root-1",
      page: "page-9",
      v: "2",
      markdown: "![](/_attachments-v2/old000000001.png)",
      shareEdit: true,
      scope: { roots: ["root-1"], uploads: {}, baseline: {} },
      scopeRaw: "{ this is not the index",
    });
    expect(res.status).toBe(200);
  });

  it("serves a baseline attachment to the root that referenced it before editing began", async () => {
    const res = await getMedia("old000000001.png", {
      root: "root-1",
      page: "page-9",
      v: "2",
      markdown: "![](/_attachments-v2/old000000001.png)",
      shareEdit: true,
      scope: {
        roots: ["root-1"],
        uploads: {},
        baseline: { "old000000001.png": ["root-1"] },
      },
    });
    expect(res.status).toBe(200);
  });

  it("keeps the index rule on a root whose editing was switched off again", async () => {
    // shareEdit is off now, but root-1 is in the index: while it was on, a
    // visitor could have written any name into these pages.
    const res = await getMedia("private00001.png", {
      root: "root-1",
      page: "page-9",
      v: "3",
      markdown: "![](/_attachments-v2/private00001.png)",
      shareEdit: false,
      scope: { roots: ["root-1"], uploads: {}, baseline: {} },
    });
    expect(res.status).toBe(404);
  });

  it("still requires the page to reference an upload the index grants", async () => {
    const res = await getMedia("up0000000001.png", {
      root: "root-1",
      page: "page-9",
      v: "2",
      markdown: "no attachment here",
      shareEdit: true,
      scope: {
        roots: ["root-1"],
        uploads: {
          "up0000000001.png": {
            root: "root-1",
            bytes: 10,
            at: "2026-09-05T10:00:00.000Z",
          },
        },
        baseline: {},
      },
    });
    expect(res.status).toBe(404);
  });

  it("leaves every existing read-only share serving every image", async () => {
    const res = await getMedia("old000000001.png", {
      root: "root-9",
      page: "root-9",
      v: "1",
      markdown: "![](/_attachments-v2/old000000001.png)",
      shareEdit: false,
      scope: EMPTY_SCOPE,
    });
    expect(res.status).toBe(200);
  });

  it("leaves the owner unaffected", async () => {
    const res = await getMedia("anything0001.png", { owner: true });
    expect(res.status).toBe(200);
  });

  it("never serves the index file itself", async () => {
    const res = await getMedia("scope.json", { owner: true });
    expect(res.status).toBe(404);
  });
});
