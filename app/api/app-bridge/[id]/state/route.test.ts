import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { APP_STATE_MAX_BYTES } from "@/lib/apps/model";

const readAppState = vi.fn();
const writeAppState = vi.fn();
const readAppMeta = vi.fn();
const setAppMeta = vi.fn();
const verifySession = vi.fn();
const appendMcpActivity = vi.fn();

vi.mock("@/lib/store", () => ({
  getStore: async () => ({ readAppState, writeAppState, readAppMeta, setAppMeta }),
}));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "brain_session", verifySession }));
vi.mock("@/lib/mcp/activity-log", () => ({ appendMcpActivity }));

const { GET, PUT } = await import("./route");

const params = Promise.resolve({ id: "app1" });
const url = new URL("/api/app-bridge/app1/state", "https://brain.example");
const base = {
  entry: "app/index.html",
  version: 1,
  builtBy: "Claude",
  builtAt: "2026-09-22T10:00:00.000Z",
  owns: [],
  state: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  verifySession.mockResolvedValue(true);
  readAppMeta.mockReturnValue(base);
});

describe("an app's own memory", () => {
  it("answers what is on disk", async () => {
    readAppState.mockResolvedValue({ seen: 3 });
    const res = await GET(new NextRequest(url), { params });
    expect(await res.json()).toEqual({ state: { seen: 3 } });
  });

  it("answers null for an app that has never written any", async () => {
    readAppState.mockResolvedValue(null);
    expect(await (await GET(new NextRequest(url), { params })).json()).toEqual({ state: null });
  });

  it("hands the payload to the store and patches no frontmatter of its own", async () => {
    const res = await PUT(
      new NextRequest(url, { method: "PUT", body: JSON.stringify({ json: { seen: 1 } }) }),
      { params },
    );
    expect(res.status).toBe(200);
    expect(writeAppState).toHaveBeenCalledWith("app1", { seen: 1 });
    // The flag rides with the file inside one store mutation, so a route that
    // patched it afterwards would be reopening the window that closed.
    // `lib/store/store.apps.test.ts` holds the two landing together.
    expect(setAppMeta).not.toHaveBeenCalled();
  });

  it("refuses a caller with no owner session, on both verbs", async () => {
    verifySession.mockResolvedValue(false);
    expect((await GET(new NextRequest(url), { params })).status).toBe(401);
    const res = await PUT(
      new NextRequest(url, { method: "PUT", body: JSON.stringify({ json: { seen: 1 } }) }),
      { params },
    );
    expect(res.status).toBe(401);
    expect(readAppState).not.toHaveBeenCalled();
    expect(writeAppState).not.toHaveBeenCalled();
  });

  it("calls state it cannot serialize a bad request rather than a crash", async () => {
    // A payload `req.json()` parses and `JSON.stringify` cannot walk. Left
    // outside a try, the RangeError reaches Next as a bare 500 carrying no
    // reason the app could branch on.
    const deep: Record<string, unknown> = {};
    let tip = deep;
    for (let i = 0; i < 60_000; i += 1) {
      const next: Record<string, unknown> = {};
      tip.n = next;
      tip = next;
    }
    const res = await PUT(
      {
        json: async () => ({ json: deep }),
        cookies: { get: () => ({ value: "session" }) },
      } as never,
      { params },
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "bad_request" });
    expect(writeAppState).not.toHaveBeenCalled();
  });

  it("refuses state over the cap", async () => {
    const big = { pad: "x".repeat(APP_STATE_MAX_BYTES) };
    const res = await PUT(
      new NextRequest(url, { method: "PUT", body: JSON.stringify({ json: big }) }),
      { params },
    );
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ reason: "too_large" });
    expect(writeAppState).not.toHaveBeenCalled();
  });

  it("logs nothing: state is the app's memory, not a change to the notebook", async () => {
    await PUT(new NextRequest(url, { method: "PUT", body: JSON.stringify({ json: { seen: 1 } }) }), { params });
    expect(appendMcpActivity).not.toHaveBeenCalled();
  });
});
