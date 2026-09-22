import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { APP_ENTRY_MAX_BYTES } from "@/lib/apps/model";

const createOwnedPage = vi.fn();
const readAppMeta = vi.fn();
const readPageLabel = vi.fn();
const verifySession = vi.fn();
const appendMcpActivity = vi.fn();

vi.mock("@/lib/store", () => ({
  getStore: async () => ({ createOwnedPage, readAppMeta, readPageLabel }),
  isNotFound: (e: unknown) => e instanceof Error && e.name === "NotFoundError",
  isAppOwnsFull: (e: unknown) => e instanceof Error && e.name === "AppOwnsFullError",
}));

/** A store refusal as the route meets it: matched by name, the way every
 *  handler here matches one across Next's module layers. */
function storeError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "brain_session", verifySession }));
vi.mock("@/lib/mcp/activity-log", () => ({ appendMcpActivity }));

const { POST } = await import("./route");

const params = Promise.resolve({ id: "app1" });
const base = {
  entry: "app/index.html",
  version: 1,
  builtBy: "Claude",
  builtAt: "2026-09-22T10:00:00.000Z",
  owns: ["words1"],
  state: false,
};

function post(body: unknown) {
  return new NextRequest(new URL("/api/app-bridge/app1/page", "https://brain.example"), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifySession.mockResolvedValue(true);
  readAppMeta.mockReturnValue(base);
  readPageLabel.mockReturnValue({ id: "app1", title: "Trainer" });
  createOwnedPage.mockResolvedValue({
    page: { id: "new1", title: "Session log" },
    app: { ...base, owns: ["words1", "new1"] },
  });
});

describe("an app creating a page under itself", () => {
  it("creates it under the app and owns it in one store call", async () => {
    const res = await POST(post({ title: "Session log", markdown: "x" }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "new1" });
    // One call, not a create and then a patch of a map read before it: the
    // store re-reads `owns` inside its own lock.
    expect(createOwnedPage).toHaveBeenCalledWith(
      "app1",
      expect.objectContaining({ title: "Session log", markdown: "x" }),
      "claude",
    );
  });

  it("takes no parent from the caller, whatever it sends", async () => {
    await POST(post({ title: "Elsewhere", parentId: "somewhere-else" }), { params });
    expect(createOwnedPage).toHaveBeenCalledWith(
      "app1",
      expect.objectContaining({ title: "Elsewhere" }),
      "claude",
    );
    expect(JSON.stringify(createOwnedPage.mock.calls[0])).not.toContain("somewhere-else");
  });

  it("refuses a create the store says would take owns past its cap", async () => {
    createOwnedPage.mockRejectedValue(storeError("AppOwnsFullError"));
    const res = await POST(post({ title: "One too many" }), { params });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ reason: "too_large" });
  });

  it("refuses markdown over the same cap a page write takes", async () => {
    const res = await POST(
      post({ title: "Runaway", markdown: "x".repeat(APP_ENTRY_MAX_BYTES + 1) }),
      { params },
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ reason: "too_large" });
    expect(createOwnedPage).not.toHaveBeenCalled();
  });

  it("refuses a title that is not a title", async () => {
    const res = await POST(post({ title: "   " }), { params });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "bad_request" });
  });

  it("writes one activity line naming the app and the page it made", async () => {
    await POST(post({ title: "Session log" }), { params });
    expect(appendMcpActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        client: "Trainer (app)",
        tool: "create_page",
        page: "new1",
        change: "create",
        outcome: "ok",
      }),
      { label: "Session log" },
    );
  });
});
