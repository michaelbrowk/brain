import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const createPage = vi.fn();
const setAppMeta = vi.fn();
const readAppMeta = vi.fn();
const readPageLabel = vi.fn();
const verifySession = vi.fn();
const appendMcpActivity = vi.fn();

vi.mock("@/lib/store", () => ({
  getStore: async () => ({ createPage, setAppMeta, readAppMeta, readPageLabel }),
  isNotFound: (e: unknown) => e instanceof Error && e.name === "NotFoundError",
}));
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
  createPage.mockResolvedValue({ id: "new1", title: "Session log" });
  setAppMeta.mockResolvedValue({ app: { ...base, owns: ["words1", "new1"] } });
});

describe("an app creating a page under itself", () => {
  it("creates it under the app and adds it to owns in the same request", async () => {
    const res = await POST(post({ title: "Session log", markdown: "x" }), { params });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "new1" });
    expect(createPage).toHaveBeenCalledWith(
      "app1",
      "Session log",
      expect.objectContaining({ markdown: "x", by: "claude" }),
    );
    expect(setAppMeta).toHaveBeenCalledWith(
      "app1",
      expect.objectContaining({ owns: ["words1", "new1"] }),
      "claude",
    );
  });

  it("takes no parent from the caller, whatever it sends", async () => {
    await POST(post({ title: "Elsewhere", parentId: "somewhere-else" }), { params });
    expect(createPage).toHaveBeenCalledWith("app1", "Elsewhere", expect.anything());
  });

  it("refuses a create that would take owns past its cap", async () => {
    readAppMeta.mockReturnValue({
      ...base,
      owns: Array.from({ length: 64 }, (_, i) => `p${i}`),
    });
    const res = await POST(post({ title: "One too many" }), { params });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ reason: "too_large" });
    expect(createPage).not.toHaveBeenCalled();
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
