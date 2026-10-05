import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getSendOperation } from "./send/[operationId]/route";
import { POST as sendMessage } from "./send/route";
import { POST as syncAccount } from "./sync/route";
import { POST as searchThreads } from "./search/route";
import { GET as listMailboxThreads } from "./mailboxes/[mailboxId]/threads/route";
import { GET as getMailboxThread } from "./mailboxes/[mailboxId]/threads/[threadId]/route";
import {
  GET as getThread,
  PATCH as updateThread,
} from "./threads/[threadId]/route";
import { GET as listThreads } from "./threads/route";
import { POST as archiveThreads } from "./threads/batch/route";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const THREAD_ID = "thread_1";
const OPERATION_ID = "send_o11111111111111111111111111111111";
const servers: Server[] = [];
const roots: string[] = [];

beforeEach(() => {
  process.env.BRAIN_PUBLIC_ORIGIN = "https://brain.test";
});

afterEach(async () => {
  delete process.env.BRAIN_MAIL_SOCKET_PATH;
  delete process.env.BRAIN_PUBLIC_ORIGIN;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Brain Mail message API routes", () => {
  it("bridges list, detail, sync, mutation, send, and send status", async () => {
    const requests: Array<{ method: string; path: string; body: string }> = [];
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer(
      async (request, response) => {
        requests.push({
          method: request.method ?? "",
          path: request.url ?? "",
          body: await readBody(request),
        });
        const pathname = new URL(request.url ?? "/", "http://mail.test").pathname;
        if (pathname === "/v1/threads" && request.method === "GET") {
          writeJson(response, 200, threadPageFixture());
        } else if (pathname === "/v1/mailboxes/sent/threads") {
          writeJson(response, 200, mailboxThreadPageFixture());
        } else if (pathname === "/v1/search") {
          writeJson(response, 200, searchThreadPageFixture());
        } else if (
          pathname === `/v1/mailboxes/sent/threads/${THREAD_ID}`
        ) {
          writeJson(response, 200, threadDetailFixture());
        } else if (pathname === `/v1/threads/${THREAD_ID}` && request.method === "GET") {
          writeJson(response, 200, threadDetailFixture());
        } else if (pathname === "/v1/sync") {
          writeJson(response, 200, {
            apiVersion: 1,
            status: "idle",
            changedCount: 1,
            hasMore: false,
          });
        } else if (pathname === `/v1/threads/${THREAD_ID}`) {
          writeJson(response, 200, {
            apiVersion: 1,
            thread: { ...threadFixture(), unread: false },
          });
        } else if (pathname === "/v1/send") {
          writeJson(response, 202, {
            apiVersion: 1,
            operationId: OPERATION_ID,
            created: true,
            status: "queued",
          });
        } else if (pathname === `/v1/send/${OPERATION_ID}`) {
          writeJson(response, 200, {
            apiVersion: 1,
            operationId: OPERATION_ID,
            accountId: ACCOUNT_ID,
            status: "sent",
            threadId: null,
          });
        } else {
          writeJson(response, 404, { apiVersion: 1, error: { code: "mail_thread_not_found" } });
        }
      },
    );

    const listed = await listThreads(
      threadStateRequest(
        `https://brain.test/api/mail/threads?accountId=${ACCOUNT_ID}&limit=25`,
      ),
    );
    const detail = await getThread(
      threadStateRequest(
        `https://brain.test/api/mail/threads/${THREAD_ID}?accountId=${ACCOUNT_ID}`,
      ),
      threadContext(),
    );
    const mailboxListed = await listMailboxThreads(
      threadStateRequest(
        `https://brain.test/api/mail/mailboxes/sent/threads?accountId=${ACCOUNT_ID}&limit=25`,
      ),
      { params: Promise.resolve({ mailboxId: "sent" }) },
    );
    const mailboxDetail = await getMailboxThread(
      threadStateRequest(
        `https://brain.test/api/mail/mailboxes/sent/threads/${THREAD_ID}?accountId=${ACCOUNT_ID}`,
      ),
      {
        params: Promise.resolve({ mailboxId: "sent", threadId: THREAD_ID }),
      },
    );
    const searched = await searchThreads(
      jsonRequest(
        "https://brain.test/api/mail/search",
        "POST",
        {
          accountId: ACCOUNT_ID,
          mailboxId: "inbox",
          query: "Quarterly launch",
          limit: 25,
        },
        true,
      ),
    );
    const synced = await syncAccount(
      jsonRequest("https://brain.test/api/mail/sync", "POST", {
        accountId: ACCOUNT_ID,
        maxItems: 20,
      }),
    );
    const updated = await updateThread(
      jsonRequest(
        `https://brain.test/api/mail/threads/${THREAD_ID}`,
        "PATCH",
        { accountId: ACCOUNT_ID, read: true },
        true,
      ),
      threadContext(),
    );
    const sent = await sendMessage(
      jsonRequest("https://brain.test/api/mail/send", "POST", sendFixture()),
    );
    const status = await getSendOperation(
      new Request(`https://brain.test/api/mail/send/${OPERATION_ID}`),
      { params: Promise.resolve({ operationId: OPERATION_ID }) },
    );

    expect(
      [
        listed,
        detail,
        mailboxListed,
        mailboxDetail,
        searched,
        synced,
        updated,
        sent,
        status,
      ].map(
        (response) => response.status,
      ),
    ).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200]);
    expect(await listed.json()).toEqual(threadPageFixture());
    expect(await detail.json()).toEqual(threadDetailFixture());
    expect(await mailboxListed.json()).toEqual(mailboxThreadPageFixture());
    expect(await mailboxDetail.json()).toEqual(threadDetailFixture());
    expect(await searched.json()).toEqual(searchThreadPageFixture());
    expect(searched.headers.get("Cache-Control")).toBe("no-store");
    expect(await sent.json()).toMatchObject({ operationId: OPERATION_ID, status: "queued" });
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `GET /v1/threads?accountId=${ACCOUNT_ID}&limit=25`,
      `GET /v1/threads/${THREAD_ID}?accountId=${ACCOUNT_ID}`,
      `GET /v1/mailboxes/sent/threads?accountId=${ACCOUNT_ID}&limit=25`,
      `GET /v1/mailboxes/sent/threads/${THREAD_ID}?accountId=${ACCOUNT_ID}`,
      "POST /v1/search",
      "POST /v1/sync",
      `PATCH /v1/threads/${THREAD_ID}`,
      "POST /v1/send",
      `GET /v1/send/${OPERATION_ID}`,
    ]);
    expect(JSON.parse(requests[4].body)).toEqual({
      accountId: ACCOUNT_ID,
      mailboxId: "inbox",
      query: "quarterly launch",
      cursor: null,
      limit: 25,
    });
    expect(JSON.parse(requests[7].body)).toEqual(sendFixture());
  });

  it("keeps legacy v1 thread responses exact unless the client opts into star state", async () => {
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer(
      (_request, response) => writeJson(response, 200, threadPageFixture()),
    );
    const url =
      `https://brain.test/api/mail/threads?accountId=${ACCOUNT_ID}&limit=25`;

    const legacy = await listThreads(new Request(url));
    const current = await listThreads(threadStateRequest(url));
    const legacyBody = (await legacy.json()) as { items: Record<string, unknown>[] };
    const currentBody = (await current.json()) as { items: Record<string, unknown>[] };

    expect(legacyBody.items[0]).not.toHaveProperty("starred");
    expect(currentBody.items[0]).toHaveProperty("starred", false);
  });

  it("bridges every system action without adding a second mutation route", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer(
      async (request, response) => {
        requests.push({
          method: request.method ?? "",
          path: request.url ?? "",
          body: JSON.parse(await readBody(request)) as unknown,
        });
        writeJson(response, 200, {
          apiVersion: 1,
          thread: threadFixture(),
        });
      },
    );
    const mutations = [
      { accountId: ACCOUNT_ID, trash: true },
      { accountId: ACCOUNT_ID, restore: true },
      { accountId: ACCOUNT_ID, spam: true },
      { accountId: ACCOUNT_ID, spam: false },
      { accountId: ACCOUNT_ID, starred: true },
      { accountId: ACCOUNT_ID, starred: false },
    ] as const;

    for (const mutation of mutations) {
      const response = await updateThread(
        jsonRequest(
          `https://brain.test/api/mail/threads/${THREAD_ID}`,
          "PATCH",
          mutation,
        ),
        threadContext(),
      );
      expect(response.status).toBe(200);
    }

    expect(requests).toEqual(
      mutations.map((mutation) => ({
        method: "PATCH",
        path: `/v1/threads/${THREAD_ID}`,
        body: mutation,
      })),
    );
  });

  it("carries a section's batch to the service in one POST and its answer back", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer(async (request, response) => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        body: JSON.parse(await readBody(request)) as unknown,
      });
      writeJson(response, 200, {
        apiVersion: 1,
        results: [
          {
            threadId: THREAD_ID,
            status: "done",
            thread: { ...threadFixture(), unread: false },
            markedRead: true,
          },
          { threadId: "thread_2", status: "failed", errorCode: "mail_sync_unavailable" },
        ],
      });
    });
    const input = {
      accountId: ACCOUNT_ID,
      threads: presses([THREAD_ID, "thread_2"]),
      archive: true,
      read: true,
    };

    const response = await archiveThreads(
      jsonRequest("https://brain.test/api/mail/threads/batch", "POST", input, true),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      results: [
        {
          threadId: THREAD_ID,
          status: "done",
          thread: { ...threadFixture(), unread: false },
          markedRead: true,
        },
        { threadId: "thread_2", status: "failed", errorCode: "mail_sync_unavailable" },
      ],
    });
    expect(requests).toEqual([{ method: "POST", path: "/v1/threads/batch", body: input }]);
  });

  it("refuses a batch from another origin, in another type, too large, or of another shape before the socket", async () => {
    process.env.BRAIN_MAIL_SOCKET_PATH = "/tmp/brain-mail-never-opened.sock";
    const input = { accountId: ACCOUNT_ID, threads: presses([THREAD_ID]), archive: true };
    const crossOrigin = await archiveThreads(
      new Request("https://brain.test/api/mail/threads/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
    const notJson = await archiveThreads(
      new Request("https://brain.test/api/mail/threads/batch", {
        method: "POST",
        headers: { Origin: "https://brain.test", "Content-Type": "text/plain" },
        body: JSON.stringify(input),
      }),
    );
    const tooLarge = await archiveThreads(
      jsonRequest("https://brain.test/api/mail/threads/batch", "POST", {
        ...input,
        threads: presses(
          Array.from({ length: 80 }, (_value, index) => `t${index}`.padEnd(255, "x")),
        ),
      }),
    );
    // Fifty of the longest ids, each with its press, pass the route's bound
    // and are refused, if at all, by the service: here no socket answers.
    const fiftyLongest = await archiveThreads(
      jsonRequest("https://brain.test/api/mail/threads/batch", "POST", {
        ...input,
        threads: presses(
          Array.from({ length: 50 }, (_value, index) => `t${index}`.padEnd(255, "x")),
        ),
      }),
    );
    expect(fiftyLongest.status).not.toBe(413);
    const unarchive = await archiveThreads(
      jsonRequest("https://brain.test/api/mail/threads/batch", "POST", {
        ...input,
        archive: false,
      }),
    );

    expect([crossOrigin, notJson, tooLarge, unarchive].map((answer) => answer.status)).toEqual([
      403, 415, 413, 400,
    ]);
    expect(await unarchive.json()).toEqual({
      apiVersion: 1,
      error: { code: "mail_request_invalid" },
    });
  });

  it("rejects duplicate query values and cross-origin writes before the socket", async () => {
    process.env.BRAIN_MAIL_SOCKET_PATH = "/tmp/brain-mail-never-opened.sock";
    const duplicate = await listThreads(
      new Request(
        `https://brain.test/api/mail/threads?accountId=${ACCOUNT_ID}&accountId=${ACCOUNT_ID}`,
      ),
    );
    const crossOrigin = await sendMessage(
      new Request("https://brain.test/api/mail/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(sendFixture()),
      }),
    );
    const ambiguous = await updateThread(
      jsonRequest(
        `https://brain.test/api/mail/threads/${THREAD_ID}`,
        "PATCH",
        { accountId: ACCOUNT_ID, trash: true, restore: true },
      ),
      threadContext(),
    );
    const crossOriginSearch = await searchThreads(
      new Request("https://brain.test/api/mail/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountId: ACCOUNT_ID,
          mailboxId: "inbox",
          query: "private",
        }),
      }),
    );
    const nonJsonSearch = await searchThreads(
      new Request("https://brain.test/api/mail/search", {
        method: "POST",
        headers: { Origin: "https://brain.test", "Content-Type": "text/plain" },
        body: "{}",
      }),
    );

    expect(duplicate.status).toBe(400);
    expect(crossOrigin.status).toBe(403);
    expect(ambiguous.status).toBe(400);
    expect(crossOriginSearch.status).toBe(403);
    expect(nonJsonSearch.status).toBe(415);
    expect(await duplicate.json()).toEqual({
      apiVersion: 1,
      error: { code: "mail_request_invalid" },
    });
    expect(await crossOrigin.json()).toEqual({
      apiVersion: 1,
      error: { code: "mail_send_request_invalid" },
    });
    expect(await ambiguous.json()).toEqual({
      apiVersion: 1,
      error: { code: "mail_request_invalid" },
    });
  });
});

function presses(ids: readonly string[]) {
  return ids.map((threadId) => ({
    threadId,
    messageCount: 1,
    lastMessageAt: 100,
    unread: true,
  }));
}

function threadContext() {
  return { params: Promise.resolve({ threadId: THREAD_ID }) };
}

function threadPageFixture() {
  return {
    apiVersion: 1,
    items: [threadFixture()],
    nextCursor: null,
    sync: { status: "idle", lastSuccessfulAt: 100 },
  };
}

function threadDetailFixture() {
  return {
    apiVersion: 1,
    thread: threadFixture(),
    messages: [
      {
        accountId: ACCOUNT_ID,
        messageId: "message_1",
        threadId: THREAD_ID,
        from: { name: "Person", address: "person@example.test" },
        replyTo: [{ name: "Replies", address: "reply@example.test" }],
        to: [{ name: null, address: "me@example.test" }],
        cc: [],
        subject: "Hello",
        sentAt: 100,
        unread: true,
        inInbox: true,
        snippet: "Preview",
        textBody: "Body",
        htmlBody: null,
        hasAttachments: false,
      },
    ],
  };
}

function mailboxThreadPageFixture() {
  return {
    apiVersion: 1,
    mailboxId: "sent",
    items: [threadFixture()],
    nextCursor: null,
    availability: {
      status: "available",
      lastSuccessfulAt: 100,
      windowTruncated: false,
    },
  };
}

function searchThreadPageFixture() {
  return {
    apiVersion: 1,
    mailboxId: "inbox",
    scope: "headers_and_previews",
    items: [threadFixture()],
    nextCursor: null,
    availability: {
      status: "available",
      lastSuccessfulAt: 100,
      windowTruncated: false,
    },
    indexStatus: "ready",
    resultsTruncated: false,
  };
}

function threadFixture() {
  return {
    accountId: ACCOUNT_ID,
    threadId: THREAD_ID,
    subject: "Hello",
    participants: [{ name: "Person", address: "person@example.test" }],
    snippet: "Preview",
    lastMessageAt: 100,
    messageCount: 1,
    unread: true,
    starred: false,
    hasAttachments: false,
  };
}

function sendFixture() {
  return {
    accountId: ACCOUNT_ID,
    idempotencyKey: "12345678-1234-4123-8123-123456789abc",
    mode: "compose",
    to: ["person@example.test"],
    cc: [],
    bcc: [],
    subject: "Hello",
    text: "Body",
    replyToMessageId: null,
    attachments: [],
    origin: "app",
    agentLine: false,
  };
}

function jsonRequest(
  url: string,
  method: string,
  body: unknown,
  includeThreadState = false,
): Request {
  return new Request(url, {
    method,
    headers: {
      Origin: "https://brain.test",
      "Content-Type": "application/json",
      ...(includeThreadState ? { "x-brain-mail-thread-state": "2" } : {}),
    },
    body: JSON.stringify(body),
  });
}

function threadStateRequest(url: string): Request {
  return new Request(url, {
    headers: { "x-brain-mail-thread-state": "2" },
  });
}

async function startServer(handler: RequestListener): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-message-route-"));
  roots.push(root);
  const socketPath = path.join(root, "mail.sock");
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return socketPath;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}
