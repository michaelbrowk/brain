import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ATTACHMENT_BYTES } from "@/lib/store";
import {
  mockShareEditModules,
  restoreShareEditModules,
  ROOT_ID,
  SHARE_VERSION,
  SRC,
  TARGET_ID,
  visitorRequest,
} from "@/test/share-edit-request";

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const PATH = `/api/share-edit/upload?page=${TARGET_ID}`;

function png(name = "shot.png", bytes: Uint8Array<ArrayBuffer> = PNG) {
  return new File([bytes], name, { type: "image/png" });
}

async function upload(
  store: Record<string, unknown>,
  options: {
    file?: File;
    path?: string;
    contentLength?: number;
    formData?: () => Promise<FormData>;
  } = {},
) {
  mockShareEditModules(store);
  const { POST } = await import("./route");
  const form = new FormData();
  if (options.file) form.set("file", options.file);
  const req = await visitorRequest(options.path ?? PATH, {
    method: "POST",
    body: form,
    headers:
      options.contentLength === undefined
        ? {}
        : { "Content-Length": String(options.contentLength) },
  });
  if (options.formData) {
    Object.defineProperty(req, "formData", { value: options.formData });
  }
  return POST(req);
}

describe("POST /api/share-edit/upload", () => {
  afterEach(restoreShareEditModules);

  it("returns the bare attachment path, not an access triple", async () => {
    const saveSharedAttachment = vi.fn().mockResolvedValue({
      url: "/_attachments-v2/abc123456789.png",
      name: "shot.png",
      size: PNG.byteLength,
      type: "image/png",
    });
    const res = await upload({ saveSharedAttachment }, { file: png() });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      name: "shot.png",
      url: "/_attachments-v2/abc123456789.png",
    });
    expect(saveSharedAttachment).toHaveBeenCalledWith({
      rootId: ROOT_ID,
      targetId: TARGET_ID,
      shareVersion: SHARE_VERSION,
      file: { data: PNG, originalName: "shot.png", mimeType: "image/png" },
      src: SRC,
    });
  });

  it("refuses an SVG with 415 and an oversize file with 413, exactly as the owner route does", async () => {
    const saveSharedAttachment = vi.fn();
    const svg = await upload(
      { saveSharedAttachment },
      {
        file: new File(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], "misleading.png", {
          type: "image/x-svg+xml",
        }),
      },
    );
    expect(svg.status).toBe(415);
    await expect(svg.json()).resolves.toEqual({ error: "unsafe_type" });

    restoreShareEditModules();
    const byName = await upload(
      { saveSharedAttachment },
      { file: new File([PNG], "vector.svgz", { type: "image/png" }) },
    );
    expect(byName.status).toBe(415);

    // No Content-Length on this one, so the size is only known after the
    // parse: the post-parse check must still hold.
    restoreShareEditModules();
    const big = await upload(
      { saveSharedAttachment },
      { file: png("big.png", new Uint8Array(MAX_ATTACHMENT_BYTES + 1)) },
    );
    expect(big.status).toBe(413);
    await expect(big.json()).resolves.toEqual({ error: "too_large" });
    expect(saveSharedAttachment).not.toHaveBeenCalled();
  }, 30_000);

  it("refuses on Content-Length before req.formData() is ever awaited", async () => {
    const formData = vi.fn();
    const saveSharedAttachment = vi.fn();
    const res = await upload(
      { saveSharedAttachment },
      { contentLength: MAX_ATTACHMENT_BYTES + 1, formData },
    );
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: "too_large" });
    expect(formData).not.toHaveBeenCalled();
    expect(saveSharedAttachment).not.toHaveBeenCalled();
  });

  it("answers ShareUploadQuotaError with 413 root_quota", async () => {
    const { ShareUploadQuotaError } = await import("@/lib/store");
    const res = await upload(
      {
        saveSharedAttachment: vi
          .fn()
          .mockRejectedValue(new ShareUploadQuotaError()),
      },
      { file: png() },
    );
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({ error: "root_quota" });
  });

  it("maps a validation refusal from the leaf by its code", async () => {
    const { AttachmentValidationError } = await import("@/lib/store");
    const cases: Array<[string, number, string]> = [
      ["too_large", 413, "too_large"],
      ["blocked_mime", 415, "unsafe_type"],
      ["mime_mismatch", 415, "unsafe_type"],
      ["invalid_mime", 415, "unsafe_type"],
    ];
    for (const [code, status, error] of cases) {
      const res = await upload(
        {
          saveSharedAttachment: vi.fn().mockRejectedValue(
            new AttachmentValidationError(
              code as ConstructorParameters<typeof AttachmentValidationError>[0],
              code,
            ),
          ),
        },
        { file: png() },
      );
      expect(res.status, code).toBe(status);
      await expect(res.json()).resolves.toEqual({ error });
      restoreShareEditModules();
    }
  });

  it("answers an unavailable attachment store with 503, not a stack trace", async () => {
    const { AttachmentStoreUnavailableError } = await import("@/lib/store");
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const res = await upload(
        {
          saveSharedAttachment: vi
            .fn()
            .mockRejectedValue(new AttachmentStoreUnavailableError()),
        },
        { file: png() },
      );
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("1");
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      error.mockRestore();
    }
  });

  it("refuses a request without a page id or without a file", async () => {
    const saveSharedAttachment = vi.fn();
    const noPage = await upload(
      { saveSharedAttachment },
      { file: png(), path: "/api/share-edit/upload" },
    );
    expect(noPage.status).toBe(400);
    await expect(noPage.json()).resolves.toEqual({
      error: "missing_share_context",
    });

    restoreShareEditModules();
    const noFile = await upload({ saveSharedAttachment });
    expect(noFile.status).toBe(400);
    await expect(noFile.json()).resolves.toEqual({ error: "no file" });
    expect(saveSharedAttachment).not.toHaveBeenCalled();
  });

  it("exports no DELETE and no PATCH", async () => {
    const handlers = await import("./route");
    expect("DELETE" in handlers).toBe(false);
    expect("PATCH" in handlers).toBe(false);
    expect("GET" in handlers).toBe(false);
    expect(typeof handlers.POST).toBe("function");
  });
});
