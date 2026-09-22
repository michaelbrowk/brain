// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/client", () => ({ apiFetch, CLIENT_ID: "test-client" }));

const { createAppWrites, createAppHandler } = await import("./app-writes");
const { createAppReads, UNHANDLED } = await import("./app-reads");

const envelope = { v: 1 as const, rid: "r1" };

function json(body: unknown, status = 200) {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

beforeEach(() => vi.clearAllMocks());

describe("the app's write side", () => {
  it("relays write.page to the app's own route", async () => {
    apiFetch.mockResolvedValue(json({ rev: "r2" }));
    const answer = await createAppWrites("app1")({
      ...envelope,
      type: "write.page",
      id: "words1",
      markdown: "x",
      rev: "r1",
    });
    expect(apiFetch).toHaveBeenCalledWith("/api/app-bridge/app1/page/words1", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "x", rev: "r1" }),
    });
    expect(answer).toEqual({ rev: "r2" });
  });

  it("hands the route's own reason back rather than inventing one", async () => {
    apiFetch.mockResolvedValue(
      json({ error: "that page is not this app's to write", reason: "not_owned" }, 403),
    );
    await expect(
      createAppWrites("app1")({ ...envelope, type: "write.page", id: "other", markdown: "x", rev: "r" }),
    ).rejects.toMatchObject({ reason: "not_owned", message: "that page is not this app's to write" });
  });

  it("relays create.page and answers the new id", async () => {
    apiFetch.mockResolvedValue(json({ id: "new1" }));
    expect(
      await createAppWrites("app1")({ ...envelope, type: "create.page", title: "Log", markdown: "" }),
    ).toEqual({ id: "new1" });
    expect(apiFetch).toHaveBeenCalledWith("/api/app-bridge/app1/page", expect.objectContaining({ method: "POST" }));
  });

  it("reads and writes state", async () => {
    apiFetch.mockResolvedValueOnce(json({ state: { seen: 1 } }));
    expect(await createAppWrites("app1")({ ...envelope, type: "state.get" })).toEqual({ state: { seen: 1 } });

    apiFetch.mockResolvedValueOnce(json({ ok: true }));
    expect(
      await createAppWrites("app1")({ ...envelope, type: "state.set", json: { seen: 2 } }),
    ).toEqual({ ok: true });
  });

  it("calls a network failure the notes folder failing, once", async () => {
    apiFetch.mockRejectedValue(new Error("offline"));
    await expect(
      createAppWrites("app1")({ ...envelope, type: "state.get" }),
    ).rejects.toMatchObject({ reason: "store_failed" });
  });

  it("leaves a read to the layer that owns it", async () => {
    expect(await createAppWrites("app1")({ ...envelope, type: "read.tree" })).toBe(UNHANDLED);
  });
});

describe("the two halves composed", () => {
  it("hands a null answer to the frame rather than calling the request unknown", async () => {
    // `??` here would read a legitimate `null` as "nobody answered" and turn
    // an app's empty memory into a refusal.
    apiFetch.mockResolvedValue(json(null));
    const handle = createAppHandler(async () => UNHANDLED, createAppWrites("app1"));
    expect(await handle({ ...envelope, type: "state.get" })).toBeNull();
  });

  it("refuses only a request neither half answered", async () => {
    const handle = createAppHandler(
      async () => UNHANDLED,
      async () => UNHANDLED,
    );
    await expect(handle({ ...envelope, type: "hello" })).rejects.toMatchObject({
      reason: "bad_request",
    });
  });

  it("lets an app read the page it has just created, before the tree catches up", async () => {
    const created = new Set<string>();
    const handle = createAppHandler(
      createAppReads(() => [], created),
      createAppWrites("app1", (id) => created.add(id)),
    );

    apiFetch.mockResolvedValueOnce(json({ id: "new1" }));
    expect(await handle({ ...envelope, type: "create.page", title: "Log", markdown: "" })).toEqual({
      id: "new1",
    });

    apiFetch.mockResolvedValueOnce(json({ meta: { id: "new1" }, markdown: "", rev: "r1" }));
    expect(await handle({ ...envelope, type: "read.page", id: "new1" })).toMatchObject({
      rev: "r1",
    });
    expect(apiFetch).toHaveBeenLastCalledWith("/api/page/new1");
  });

  it("still refuses a page that is neither in the tree nor one the app made", async () => {
    const created = new Set<string>();
    const handle = createAppHandler(
      createAppReads(() => [], created),
      createAppWrites("app1", (id) => created.add(id)),
    );
    await expect(handle({ ...envelope, type: "read.page", id: "gone" })).rejects.toMatchObject({
      reason: "not_found",
    });
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
