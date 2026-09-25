import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real store against a temp state directory, with only the directory
// redirected: what these routes are is validation over that store, and a mock
// store would pin the mock rather than the answer a reader gets.
const dirHolder = { current: "" };
vi.mock("@/lib/notifications/state-dir", () => ({
  notificationStateDirectory: () => dirHolder.current,
}));

import { NOTIFICATION_CAP } from "@/lib/notifications/model";
import { appendNotification } from "@/lib/notifications/store";
import { GET } from "./route";
import { POST as readPost } from "./read/route";
import { POST as readAllPost } from "./read-all/route";

beforeEach(async () => {
  dirHolder.current = await mkdtemp(path.join(os.tmpdir(), "brain-notifications-route-"));
});

// The house pattern of lib/owner-settings.test.ts: the temp directory a test
// made is the test's to remove.
afterEach(async () => {
  await rm(dirHolder.current, { recursive: true, force: true });
});

const row = (id: string, at: string) => ({
  id,
  kind: "task-reminder" as const,
  at,
  title: "Water the plants",
  href: "/tasks",
});

function post(body: string) {
  return readPost(
    new Request("http://localhost/api/notifications/read", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  );
}

describe("GET /api/notifications", () => {
  it("answers the rows newest first with the unread count", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dirHolder.current);
    await appendNotification(row("b", "2026-09-14T11:00:00.000Z"), dirHolder.current);
    const response = await GET();
    // A bell answer is one reader's own state, so it never sits in a shared
    // cache between them and the browser.
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.notifications.map((n: { id: string }) => n.id)).toEqual(["b", "a"]);
    expect(body.unread).toBe(2);
  });

  it("answers an empty centre without failing", async () => {
    const body = await (await GET()).json();
    expect(body).toEqual({ notifications: [], unread: 0 });
  });
});

describe("POST /api/notifications/read", () => {
  it("marks the named ids read", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dirHolder.current);
    const response = await post(JSON.stringify({ ids: ["a"] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ read: 1 });
    expect((await (await GET()).json()).unread).toBe(0);
  });

  it("answers 400 bad_body for a body that is not an object", async () => {
    const response = await post("[]");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_body" });
  });

  it("answers 400 bad_body for a body that is not JSON", async () => {
    const response = await post("not json");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_body" });
  });

  it("answers 400 bad_ids for a missing, empty or oversized list", async () => {
    // One past the whole centre: no request can name more rows than the file
    // can hold.
    const tooMany = Array.from({ length: NOTIFICATION_CAP + 1 }, (_, i) => `row-${i}`);
    for (const ids of [undefined, [], tooMany, [1]]) {
      const response = await post(JSON.stringify({ ids }));
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; reason?: string };
      expect(body.error).toBe("bad_ids");
      expect(typeof body.reason).toBe("string");
    }
  });

  it("answers { read: 0 } for an id the centre does not hold, and not a 404", async () => {
    const response = await post(JSON.stringify({ ids: ["mail-new:account-a:6161"] }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ read: 0 });
  });
});

describe("POST /api/notifications/read-all", () => {
  it("clears every unread row", async () => {
    await appendNotification(row("a", "2026-09-14T09:00:00.000Z"), dirHolder.current);
    await appendNotification(row("b", "2026-09-14T11:00:00.000Z"), dirHolder.current);
    expect(await (await readAllPost()).json()).toEqual({ read: 2 });
    expect((await (await GET()).json()).unread).toBe(0);
  });

  it("answers { read: 0 } on an empty centre", async () => {
    expect(await (await readAllPost()).json()).toEqual({ read: 0 });
  });
});

describe("the route surface", () => {
  it("is not exempted in proxy.ts, so every handler needs a session", async () => {
    const proxy = await readFile(path.join(process.cwd(), "proxy.ts"), "utf8");
    expect(proxy).not.toContain("/api/notifications");
  });
});
