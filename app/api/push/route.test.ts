import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real store against a temp state directory, with only the directory
// redirected: what these routes are is validation over that store, and a mock
// store would pin the mock rather than the answer a reader gets.
const dirHolder = { current: "" };
vi.mock("@/lib/push/state-dir", () => ({ pushStateDirectory: () => dirHolder.current }));

import { GET as keyGet } from "./key/route";
import { GET as stateGet, PATCH as statePatch } from "./state/route";
import { DELETE as subsDelete, POST as subsPost } from "./subscriptions/route";
import { POST as testPost } from "./test/route";

beforeEach(async () => {
  dirHolder.current = await mkdtemp(path.join(os.tmpdir(), "brain-push-route-"));
});

// The house pattern of app/api/notifications/route.test.ts: the temp directory
// a test made is the test's to remove.
afterEach(async () => {
  await rm(dirHolder.current, { recursive: true, force: true });
});

const ENDPOINT = "https://web.push.apple.com/brain-route-endpoint-not-for-production";
/** 65 bytes, first byte 0x04: the shape a browser produces, filled with one
 *  repeated byte so it is obviously not a key anyone holds. */
const P256DH = `BH${"p".repeat(85)}`;
const AUTH = "a".repeat(22);

/** Device labels and the instance's public key are per-owner state. A shared
 *  cache is the one place they must never land. */
const expectPrivate = (response: Response) => {
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
};

const body = (value: unknown) =>
  new Request("http://localhost/api/push/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });

describe("GET /api/push/key", () => {
  it("serves the public half and never the private one", async () => {
    const payload = await (await keyGet()).json();
    expect(payload.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
    expect(Object.keys(payload)).toEqual(["publicKey"]);
  });

  it("serves the same key on a second request", async () => {
    const first = await (await keyGet()).json();
    expect((await (await keyGet()).json()).publicKey).toBe(first.publicKey);
  });
});

describe("POST /api/push/subscriptions", () => {
  it("registers a device and answers 201 with the view, not the endpoint", async () => {
    const response = await subsPost(
      body({
        subscription: { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } },
        deviceLabel: "iPhone",
      }),
    );
    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(Object.keys(payload.device).sort()).toEqual([
      "createdAt",
      "deviceLabel",
      "id",
      "lastSeenAt",
    ]);
    expect(JSON.stringify(payload)).not.toContain("web.push.apple.com");
  });

  it("answers 400 bad_subscription for a body it cannot read", async () => {
    for (const value of [
      {},
      {
        subscription: { endpoint: "http://example.com/x", keys: { p256dh: "p", auth: "a" } },
        deviceLabel: "iPhone",
      },
      { subscription: { endpoint: ENDPOINT }, deviceLabel: "iPhone" },
      {
        subscription: { endpoint: ENDPOINT, keys: { p256dh: "p", auth: "a" } },
        deviceLabel: "",
      },
    ]) {
      const response = await subsPost(body(value));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_subscription" });
    }
  });
});

describe("DELETE /api/push/subscriptions", () => {
  it("removes a device by its id", async () => {
    const created = await (
      await subsPost(
        body({
          subscription: {
            endpoint: ENDPOINT,
            keys: { p256dh: P256DH, auth: AUTH },
          },
          deviceLabel: "iPhone",
        }),
      )
    ).json();
    const response = await subsDelete(
      new Request("http://localhost/api/push/subscriptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: created.device.id }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ removed: true });
  });

  it("answers 400 bad_id for an id that is not sixteen hex characters", async () => {
    const response = await subsDelete(
      new Request("http://localhost/api/push/subscriptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "../../etc/passwd" }),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_id" });
  });
});

describe("/api/push/state", () => {
  it("lists the devices and the toggles", async () => {
    const payload = await (await stateGet()).json();
    expect(payload).toEqual({ devices: [], kinds: { "task-reminder": true, "mail-new": true } });
  });

  it("patches one toggle and leaves the other", async () => {
    const response = await statePatch(
      new Request("http://localhost/api/push/state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kinds: { "mail-new": false } }),
      }),
    );
    expect(await response.json()).toEqual({
      kinds: { "task-reminder": true, "mail-new": false },
    });
  });

  it("answers 400 bad_kinds for a value that is not a boolean or a key nothing pushes", async () => {
    for (const kinds of [{ "mail-new": "no" }, { "task-missed": true }, null, "on"]) {
      const response = await statePatch(
        new Request("http://localhost/api/push/state", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kinds }),
        }),
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "bad_kinds" });
    }
  });
});

describe("POST /api/push/test", () => {
  it("answers what the send did, and reaches no push service with nothing registered", async () => {
    const response = await testPost();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sent: 0, removed: 0, skipped: "no-devices" });
  });

  it("obeys the task-reminder toggle rather than proving the wrong thing", async () => {
    await subsPost(
      body({
        subscription: { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } },
        deviceLabel: "iPhone",
      }),
    );
    await statePatch(
      new Request("http://localhost/api/push/state", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kinds: { "task-reminder": false } }),
      }),
    );
    expect(await (await testPost()).json()).toEqual({
      sent: 0,
      removed: 0,
      skipped: "kind-off",
    });
  });
});

describe("the private-route preamble", () => {
  it("keeps every answer, errors included, out of a shared cache", async () => {
    expectPrivate(await keyGet());
    expectPrivate(await stateGet());
    expectPrivate(await testPost());
    expectPrivate(
      await subsPost(
        body({
          subscription: { endpoint: ENDPOINT, keys: { p256dh: P256DH, auth: AUTH } },
          deviceLabel: "iPhone",
        }),
      ),
    );
    expectPrivate(await subsPost(body({})));
    expectPrivate(
      await statePatch(
        new Request("http://localhost/api/push/state", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kinds: { "mail-new": false } }),
        }),
      ),
    );
    expectPrivate(
      await statePatch(
        new Request("http://localhost/api/push/state", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: "{ not json",
        }),
      ),
    );
    expectPrivate(
      await subsDelete(
        new Request("http://localhost/api/push/subscriptions", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: "nope" }),
        }),
      ),
    );
  });

  // These stores read files. The declaration says so out loud, the way
  // app/api/notifications/route.ts does.
  it("runs on the node runtime, in all four routes", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const route of ["key", "state", "subscriptions", "test"]) {
      const source = await readFile(
        path.join(process.cwd(), "app/api/push", route, "route.ts"),
        "utf8",
      );
      expect(source).toContain('export const runtime = "nodejs";');
      expect(source).toContain('export const dynamic = "force-dynamic";');
    }
  });
});

describe("the push route surface", () => {
  it("is not exempted in proxy.ts, so every handler needs a session", async () => {
    const proxy = await readFile(path.join(process.cwd(), "proxy.ts"), "utf8");
    expect(proxy).not.toContain("/api/push");
  });
});
