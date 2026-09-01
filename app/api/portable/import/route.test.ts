import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  validatePortableArchive: vi.fn(),
  applyPortableBundle: vi.fn(),
}));

vi.mock("@/lib/store", () => ({ getStore: mocks.getStore }));
vi.mock("@/lib/portable/model", () => ({
  validatePortableArchive: mocks.validatePortableArchive,
  applyPortableBundle: mocks.applyPortableBundle,
}));

import { POST } from "./route";

describe("portable import route", () => {
  beforeEach(() => {
    mocks.getStore.mockReset().mockResolvedValue({ id: "store" });
    mocks.validatePortableArchive.mockReset().mockReturnValue({
      bundle: { manifest: { pages: [] } },
      summary: {
        title: "Project",
        pages: 2,
        rootPages: 1,
        attachments: 1,
        attachmentBytes: 12,
        collections: 0,
      },
    });
    mocks.applyPortableBundle.mockReset().mockResolvedValue({
      rootIds: ["new-root"],
      created: 2,
    });
  });

  function request(mode: "dry-run" | "apply"): Request {
    const form = new FormData();
    form.set(
      "file",
      new File([new Uint8Array([31, 139, 8, 0])], "project.brain.tar.gz", {
        type: "application/gzip",
      }),
    );
    form.set("mode", mode);
    return new Request("https://brain.test/api/portable/import", {
      method: "POST",
      body: form,
    });
  }

  it("preflights without creating pages", async () => {
    const response = await POST(request("dry-run") as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: "dry-run",
      summary: { pages: 2, attachments: 1 },
    });
    expect(mocks.applyPortableBundle).not.toHaveBeenCalled();
  });

  it("applies only after the explicit apply mode", async () => {
    const response = await POST(request("apply") as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      mode: "apply",
      result: { rootIds: ["new-root"], created: 2 },
    });
    expect(mocks.applyPortableBundle).toHaveBeenCalledOnce();
  });

  it("rejects invalid packages without applying them", async () => {
    mocks.validatePortableArchive.mockImplementation(() => {
      throw new Error("portable manifest is invalid");
    });
    const response = await POST(request("apply") as never);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "portable manifest is invalid",
    });
    expect(mocks.applyPortableBundle).not.toHaveBeenCalled();
  });
});
