import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  writePage: vi.fn(),
  historicalMarkdownForRev: vi.fn(),
  updateMeta: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  getStore: mocks.getStore,
  isRevConflict: (error: unknown) =>
    error instanceof Error && error.name === "RevConflictError",
  isMetadataConflict: (error: unknown) =>
    error instanceof Error && error.name === "MetadataConflictError",
  isNotFound: (error: unknown) =>
    error instanceof Error && error.name === "NotFoundError",
  redactPage: (page: unknown) => page,
  redactPageMeta: (meta: unknown) => meta,
}));
vi.mock("@/lib/emoji-llm", () => ({ smartEmoji: vi.fn() }));

import { PATCH, PUT } from "./route";

const PAGE_ID = "page-a";
const STALE_REV = "a1b2c3d4e5f6";
const CURRENT_REV = "f6e5d4c3b2a1";

function conflict(expectedRev = STALE_REV): Error {
  return Object.assign(new Error("rev conflict"), {
    name: "RevConflictError",
    currentRev: CURRENT_REV,
    expectedRev,
  });
}

function request(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`https://brain.test/api/page/${PAGE_ID}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function put(body: Record<string, unknown>) {
  return PUT(request(body), { params: Promise.resolve({ id: PAGE_ID }) });
}

function patchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest(`https://brain.test/api/page/${PAGE_ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patch(body: Record<string, unknown>) {
  return PATCH(patchRequest(body), {
    params: Promise.resolve({ id: PAGE_ID }),
  });
}

describe("page PUT conflict recovery", () => {
  beforeEach(() => {
    mocks.writePage.mockReset().mockRejectedValue(conflict());
    mocks.historicalMarkdownForRev.mockReset().mockResolvedValue("server base");
    mocks.getStore.mockReset().mockResolvedValue({
      writePage: mocks.writePage,
      historicalMarkdownForRev: mocks.historicalMarkdownForRev,
    });
  });

  it("returns an id-bound historical base for an exact legacy revision", async () => {
    const response = await put({
      markdown: "legacy local draft",
      rev: STALE_REV,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "conflict",
      currentRev: CURRENT_REV,
      baseMarkdown: "server base",
    });
    expect(mocks.historicalMarkdownForRev).toHaveBeenCalledWith(
      PAGE_ID,
      STALE_REV,
    );
  });

  it.each([
    ["missing", undefined],
    ["short", "a".repeat(11)],
    ["uppercase", "A".repeat(12)],
    ["non-hex", "g".repeat(12)],
  ])("fails closed for a %s revision", async (_label, revision) => {
    const body: Record<string, unknown> = { markdown: "legacy local draft" };
    if (revision !== undefined) body.rev = revision;

    const response = await put(body);
    const payload = await response.json();

    expect(response.status).toBe(409);
    expect(payload).toEqual({ error: "conflict", currentRev: CURRENT_REV });
    expect(mocks.historicalMarkdownForRev).not.toHaveBeenCalled();
  });

  it("fails closed when the exact revision is absent from Git history", async () => {
    mocks.historicalMarkdownForRev.mockResolvedValueOnce(null);

    const response = await put({
      markdown: "legacy local draft",
      rev: STALE_REV,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "conflict",
      currentRev: CURRENT_REV,
    });
  });

  it("does not consult history when the client already supplied a base", async () => {
    const response = await put({
      markdown: "local edit",
      rev: STALE_REV,
      baseMarkdown: "known base",
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "conflict",
      currentRev: CURRENT_REV,
    });
    expect(mocks.historicalMarkdownForRev).not.toHaveBeenCalled();
  });
});

describe("page PATCH appearance", () => {
  beforeEach(() => {
    mocks.updateMeta.mockReset().mockResolvedValue({ id: PAGE_ID });
    mocks.getStore.mockReset().mockResolvedValue({
      updateMeta: mocks.updateMeta,
    });
  });

  it("passes validated page appearance values to the store", async () => {
    const response = await patch({
      font: "serif",
      smallText: true,
      fullWidth: false,
    });

    expect(response.status).toBe(200);
    expect(mocks.updateMeta).toHaveBeenCalledWith(
      PAGE_ID,
      expect.objectContaining({
        font: "serif",
        smallText: true,
        fullWidth: false,
        by: "me",
      }),
    );
  });

  it("passes field-level metadata preconditions to the store", async () => {
    const expected = {
      title: "Old title",
      stickers: [{ id: "sticker-1", x: 10, y: 20, text: "Old" }],
      shareLocked: false,
    };
    const response = await patch({ title: "New title", expected });

    expect(response.status).toBe(200);
    expect(mocks.updateMeta).toHaveBeenCalledWith(
      PAGE_ID,
      expect.objectContaining({ title: "New title", expected }),
    );
  });

  it("returns only conflicting field names for a stale metadata write", async () => {
    mocks.updateMeta.mockRejectedValueOnce(
      Object.assign(new Error("metadata conflict"), {
        name: "MetadataConflictError",
        fields: ["title", "shareLocked"],
      }),
    );

    const response = await patch({
      title: "New title",
      expected: { title: "Old title", shareLocked: false },
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "conflict",
      fields: ["title", "shareLocked"],
    });
  });

  it.each([
    ["unknown field", { expected: { updatedBy: "me" } }],
    ["secret hash", { expected: { sharePass: "hash" } }],
    ["wrong boolean", { expected: { pinned: "yes" } }],
    ["wrong array", { expected: { tags: ["ok", 2] } }],
    ["wrong sticker", { expected: { stickers: [{ id: "x", x: "1" }] } }],
  ])("rejects an invalid metadata precondition: %s", async (_label, body) => {
    const response = await patch(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid metadata precondition",
    });
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it.each([null, "sans", "serif", "mono"])(
    "accepts the supported font reset/enum value %s",
    async (font) => {
      const response = await patch({ font });

      expect(response.status).toBe(200);
      expect(mocks.updateMeta).toHaveBeenCalledWith(
        PAGE_ID,
        expect.objectContaining({ font }),
      );
    },
  );

  it.each([
    ["unknown font", { font: "comic" }],
    ["numeric font", { font: 42 }],
    ["string smallText", { smallText: "false" }],
    ["nullable smallText", { smallText: null }],
    ["numeric fullWidth", { fullWidth: 1 }],
    ["nullable fullWidth", { fullWidth: null }],
  ])("rejects %s without touching the store", async (_label, body) => {
    const response = await patch(body);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid page appearance",
    });
    expect(mocks.getStore).not.toHaveBeenCalled();
    expect(mocks.updateMeta).not.toHaveBeenCalled();
  });

  it.each([
    ["public enable", { title: "Must not change", public: true }],
    [
      "public enable with credentials",
      {
        public: true,
        sharePassword: "secret",
        shareExpiresAt: new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
    ],
    ["truthy string public enable", { public: "true" }],
    ["numeric public enable", { public: 1 }],
    ["nullable public value", { public: null }],
    ["password set", { sharePassword: "secret" }],
    ["password removal", { sharePassword: null }],
    ["oversize password", { sharePassword: "🙂".repeat(19) }],
    [
      "future expiry",
      {
        shareExpiresAt: new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
    ],
    ["expiry removal", { shareExpiresAt: null }],
    ["malformed expiry", { shareExpiresAt: "next Friday" }],
  ])(
    "requires the disclosed atomic endpoint for %s",
    async (_label, body) => {
      const response = await patch(body);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "use share configuration endpoint",
      });
      expect(mocks.getStore).not.toHaveBeenCalled();
      expect(mocks.updateMeta).not.toHaveBeenCalled();
    },
  );

  it("retains public false as a compatible safe revoke", async () => {
    const response = await patch({ public: false });

    expect(response.status).toBe(200);
    expect(mocks.updateMeta).toHaveBeenCalledWith(
      PAGE_ID,
      expect.objectContaining({ public: false, by: "me" }),
    );
  });
});
