import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { APP_ENTRY_MAX_BYTES } from "@/lib/apps/model";

const appMayWrite = vi.fn();
const writePage = vi.fn();
const readAppMeta = vi.fn();
const readPageLabel = vi.fn();
const verifySession = vi.fn();
const appendMcpActivity = vi.fn();

vi.mock("@/lib/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/store/types")>("@/lib/store/types");
  return {
    ...actual,
    getStore: async () => ({ appMayWrite, writePage, readAppMeta, readPageLabel }),
  };
});
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "brain_session", verifySession }));
vi.mock("@/lib/mcp/activity-log", () => ({ appendMcpActivity }));

const { PUT } = await import("./route");

function put(body: unknown) {
  return new NextRequest(new URL("/api/app-bridge/app1/page/words1", "https://brain.example"), {
    method: "PUT",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const params = Promise.resolve({ id: "app1", target: "words1" });

beforeEach(() => {
  vi.clearAllMocks();
  verifySession.mockResolvedValue(true);
  appMayWrite.mockReturnValue(true);
  readAppMeta.mockReturnValue({ entry: "app/index.html", owns: ["words1"] });
  readPageLabel.mockReturnValue({ id: "app1", title: "Trainer" });
  writePage.mockResolvedValue({ meta: { id: "words1", title: "Words" }, markdown: "x", rev: "r2" });
});

describe("an app writing a page it owns", () => {
  it("writes it and answers the new rev", async () => {
    const res = await PUT(put({ markdown: "| word |", rev: "r1" }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rev: "r2" });
    expect(writePage).toHaveBeenCalledWith("words1", "| word |", "r1", "claude", undefined, undefined);
  });

  it("refuses a page that is not in owns, before the store is asked to write", async () => {
    appMayWrite.mockReturnValue(false);
    const res = await PUT(put({ markdown: "x", rev: "r1" }), { params });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ reason: "not_owned" });
    expect(writePage).not.toHaveBeenCalled();
  });

  it("answers a stale rev as a conflict, not as a write", async () => {
    const { RevConflictError } = await import("@/lib/store/types");
    writePage.mockRejectedValue(new RevConflictError("live", "r1"));
    const res = await PUT(put({ markdown: "x", rev: "r1" }), { params });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "rev_conflict", currentRev: "live" });
  });

  it("refuses a body over the page cap", async () => {
    const res = await PUT(put({ markdown: "x".repeat(APP_ENTRY_MAX_BYTES + 1), rev: "r1" }), { params });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ reason: "too_large" });
    expect(writePage).not.toHaveBeenCalled();
  });

  it("refuses a caller with no owner session", async () => {
    verifySession.mockResolvedValue(false);
    const res = await PUT(put({ markdown: "x", rev: "r1" }), { params });
    expect(res.status).toBe(401);
    expect(writePage).not.toHaveBeenCalled();
  });

  it("refuses a page id that is not an app", async () => {
    readAppMeta.mockReturnValue(null);
    const res = await PUT(put({ markdown: "x", rev: "r1" }), { params });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ reason: "not_found" });
  });

  it("writes one activity line naming the app, whatever the outcome", async () => {
    await PUT(put({ markdown: "x", rev: "r1" }), { params });
    expect(appendMcpActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        client: "Trainer (app)",
        tool: "write_page",
        page: "words1",
        change: "markdown",
        outcome: "ok",
      }),
      { label: "Words" },
    );

    appendMcpActivity.mockClear();
    appMayWrite.mockReturnValue(false);
    await PUT(put({ markdown: "x", rev: "r1" }), { params });
    expect(appendMcpActivity).toHaveBeenCalledWith(
      expect.objectContaining({ client: "Trainer (app)", outcome: "not_owned" }),
      undefined,
    );
  });

  it("reads the app's title off the index, not off its file", async () => {
    await PUT(put({ markdown: "x", rev: "r1" }), { params });
    expect(readPageLabel).toHaveBeenCalledWith("app1");
    // A page read per bridge write is a file read and a parse on the hot path
    // of an app answering a card, for a string that is already in memory.
    expect(writePage).toHaveBeenCalledTimes(1);
  });

  it("carries no em-dash in a sentence the app may show", async () => {
    appMayWrite.mockReturnValue(false);
    const res = await PUT(put({ markdown: "x", rev: "r1" }), { params });
    expect(JSON.stringify(await res.json())).not.toContain("—");
  });
});
