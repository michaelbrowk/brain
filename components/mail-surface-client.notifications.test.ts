import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNT_ID = "account-adeadbeefdeadbeefdeadbeefdeadbeef";
const NOTIFICATION_ID =
  "mail-new:account-adeadbeefdeadbeefdeadbeefdeadbeef:7468726561642d6f6e65";

/** What the mail route answers a mutation with. The client validates it, so a
 *  bare `{ ok: true }` would fail before the seam is ever reached. */
const mutation = {
  apiVersion: 1,
  thread: {
    accountId: ACCOUNT_ID,
    threadId: "thread-one",
    subject: "Lunch on Friday",
    participants: [{ name: "Ana Silva", address: "ana@example.test" }],
    snippet: "Cached safely",
    lastMessageAt: 1_700_000_000_000,
    messageCount: 1,
    unread: false,
    starred: false,
    hasAttachments: false,
  },
};

const posted: { url: string; body: unknown }[] = [];

beforeEach(() => {
  posted.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/notifications")) {
        posted.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
        return new Response(JSON.stringify({ read: 1 }), { status: 200 });
      }
      return new Response(JSON.stringify(mutation), { status: 200 });
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The seam collects ids and sends them a quarter second after the last one,
 *  so a test that wants the request has to close the window. The window itself
 *  is pinned in `notifications-read.test.ts`. */
async function settle() {
  const { flushMailNotificationReads } = await import("./notifications-read");
  flushMailNotificationReads();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("marking a thread read in Mail", () => {
  it("marks that thread's notification read", async () => {
    const { defaultMailSurfaceClient } = await import("./mail-surface-client");
    await defaultMailSurfaceClient.updateThread({
      accountId: ACCOUNT_ID,
      threadId: "thread-one",
      read: true,
    });
    await settle();
    expect(posted).toEqual([
      { url: "/api/notifications/read", body: { ids: [NOTIFICATION_ID] } },
    ]);
  });

  it("sends one request for a bulk run, not one per thread", async () => {
    // Bulk Done archives and then marks read, thread by thread. Forty of those
    // used to be forty POSTs, each one a read and a zod parse of the whole
    // centre file through the store's serialised queue.
    const { defaultMailSurfaceClient } = await import("./mail-surface-client");
    for (const threadId of ["thread-one", "thread-two", "thread-three"]) {
      await defaultMailSurfaceClient.updateThread({
        accountId: ACCOUNT_ID,
        threadId,
        read: true,
      });
    }
    await settle();
    expect(posted).toHaveLength(1);
    expect((posted[0].body as { ids: string[] }).ids).toHaveLength(3);
  });

  it("says nothing to the centre when a thread is marked unread", async () => {
    const { defaultMailSurfaceClient } = await import("./mail-surface-client");
    await defaultMailSurfaceClient.updateThread({
      accountId: ACCOUNT_ID,
      threadId: "thread-one",
      read: false,
    });
    await settle();
    expect(posted).toEqual([]);
  });

  it("says nothing to the centre for an archive", async () => {
    const { defaultMailSurfaceClient } = await import("./mail-surface-client");
    await defaultMailSurfaceClient.updateThread({
      accountId: ACCOUNT_ID,
      threadId: "thread-one",
      archive: true,
    });
    await settle();
    expect(posted).toEqual([]);
  });

  it("lets the mail mutation succeed when the centre cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).startsWith("/api/notifications")) throw new Error("offline");
        return new Response(JSON.stringify(mutation), { status: 200 });
      }),
    );
    const { defaultMailSurfaceClient } = await import("./mail-surface-client");
    await expect(
      defaultMailSurfaceClient.updateThread({
        accountId: ACCOUNT_ID,
        threadId: "thread-one",
        read: true,
      }),
    ).resolves.toBeUndefined();
    await settle();
  });

  it("says nothing to the centre for an account id no notification id can carry", async () => {
    const { markMailNotificationRead } = await import("./notifications-read");
    markMailNotificationRead("account a", "thread-one");
    await settle();
    expect(posted).toEqual([]);
  });
});
