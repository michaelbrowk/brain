import { describe, expect, it, vi } from "vitest";

import { GmailApiClient } from "./api-client";
import {
  GMAIL_API_LIMITS,
  GmailAccessTokenError,
  GmailApiError,
  type GmailAccessTokenPort,
  type GmailSystemMailbox,
} from "./api-types";

describe("Gmail API read slice", () => {
  it("lists inbox threads through bounded pagination and wipes every token", async () => {
    const tokens: Buffer[] = [];
    const tokenPort = tokenPortFixture(tokens);
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://gmail.googleapis.com");
      expect(url.pathname).toBe("/gmail/v1/users/me/threads");
      expect(url.searchParams.getAll("labelIds")).toEqual(["INBOX"]);
      expect(url.searchParams.get("includeSpamTrash")).toBe("false");
      expect(url.searchParams.get("maxResults")).toBe(
        url.searchParams.has("pageToken") ? "1" : "3",
      );
      if (!url.searchParams.has("pageToken")) {
        return jsonResponse({
          threads: [
            { id: "thread-a", snippet: "First", historyId: "101" },
            { id: "thread-b", snippet: "Second", historyId: "102" },
          ],
          nextPageToken: "page-two",
          resultSizeEstimate: 3,
        });
      }
      expect(url.searchParams.get("pageToken")).toBe("page-two");
      return jsonResponse({
        threads: [{ id: "thread-c", snippet: "Third", historyId: "103" }],
        resultSizeEstimate: 3,
      });
    });
    const client = new GmailApiClient({ tokenPort, request });

    const result = await client.listInboxThreads({ maxItems: 3, maxPages: 2 });

    expect(result).toEqual({
      items: [
        { id: "thread-a", snippet: "First", historyId: "101" },
        { id: "thread-b", snippet: "Second", historyId: "102" },
        { id: "thread-c", snippet: "Third", historyId: "103" },
      ],
      nextPageToken: null,
      resultSizeEstimate: 3,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(tokens).toHaveLength(2);
    expect(tokens.every((token) => token.every((byte) => byte === 0))).toBe(true);
    expect(tokenPort.getAccessToken).toHaveBeenNthCalledWith(
      1,
      { forceRefresh: false },
      expect.any(AbortSignal),
    );
  });

  it("returns the continuation token when the caller's item bound is reached", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        messages: [
          { id: "message-a", threadId: "thread-a" },
          { id: "message-b", threadId: "thread-b" },
        ],
        nextPageToken: "more-messages",
        resultSizeEstimate: 10,
      }),
    );
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });

    const result = await client.listInboxMessages({ maxItems: 2, maxPages: 1 });

    expect(result).toEqual({
      items: [
        { id: "message-a", threadId: "thread-a" },
        { id: "message-b", threadId: "thread-b" },
      ],
      nextPageToken: "more-messages",
      resultSizeEstimate: 10,
    });
    const url = new URL(String(request.mock.calls[0][0]));
    expect(url.searchParams.get("maxResults")).toBe("2");
  });

  it.each<{
    readonly mailbox: GmailSystemMailbox;
    readonly labelIds: readonly string[];
    readonly includeSpamTrash: string;
  }>([
    { mailbox: "all", labelIds: [], includeSpamTrash: "false" },
    { mailbox: "inbox", labelIds: ["INBOX"], includeSpamTrash: "false" },
    { mailbox: "sent", labelIds: ["SENT"], includeSpamTrash: "false" },
    { mailbox: "spam", labelIds: ["SPAM"], includeSpamTrash: "true" },
    { mailbox: "starred", labelIds: ["STARRED"], includeSpamTrash: "false" },
    { mailbox: "trash", labelIds: ["TRASH"], includeSpamTrash: "true" },
  ])(
    "maps the $mailbox mailbox to a bounded Gmail list request",
    async ({ mailbox, labelIds, includeSpamTrash }) => {
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ threads: [], resultSizeEstimate: 0 }),
      );
      const client = new GmailApiClient({
        tokenPort: tokenPortFixture(),
        request,
      });

      await client.listThreads(mailbox, { maxItems: 1, maxPages: 1 });

      const url = new URL(String(request.mock.calls[0][0]));
      expect(url.pathname).toBe("/gmail/v1/users/me/threads");
      expect(url.searchParams.getAll("labelIds")).toEqual(labelIds);
      expect(url.searchParams.get("includeSpamTrash")).toBe(
        includeSpamTrash,
      );
    },
  );

  it("lists Spam messages through the messages resource", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        messages: [{ id: "message-a", threadId: "thread-a" }],
        resultSizeEstimate: 1,
      }),
    );
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });

    const result = await client.listMessages("spam", {
      maxItems: 1,
      maxPages: 1,
    });

    const url = new URL(String(request.mock.calls[0][0]));
    expect(url.pathname).toBe("/gmail/v1/users/me/messages");
    expect(url.searchParams.getAll("labelIds")).toEqual(["SPAM"]);
    expect(url.searchParams.get("includeSpamTrash")).toBe("true");
    expect(result.items).toEqual([
      { id: "message-a", threadId: "thread-a" },
    ]);
  });

  it("reads a full message with a strictly validated MIME tree", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(messageFixture("message-a", "thread-a")),
    );
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });

    const message = await client.getMessage("message-a");

    expect(message.id).toBe("message-a");
    expect(message.threadId).toBe("thread-a");
    expect(message.payload?.mimeType).toBe("multipart/alternative");
    expect(message.payload?.headers).toEqual([
      { name: "Subject", value: "Hello" },
    ]);
    expect(message.payload?.parts[0].body).toEqual({
      attachmentId: null,
      size: 5,
      data: "SGVsbG8",
    });
    const url = new URL(String(request.mock.calls[0][0]));
    expect(url.pathname).toBe("/gmail/v1/users/me/messages/message-a");
    expect(url.searchParams.get("format")).toBe("full");
  });

  it("accepts Gmail's canonical padded base64url and normalizes it", async () => {
    const message = messageFixture("message-a", "thread-a");
    message.payload.parts[0].body.data = "SGVsbG8=";
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(message)),
    });

    await expect(client.getMessage("message-a")).resolves.toMatchObject({
      payload: {
        parts: [{ body: { size: 5, data: "SGVsbG8" } }],
      },
    });
  });

  it("reads a thread and requires every message to belong to it", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "thread-a",
        snippet: "Conversation",
        historyId: "200",
        messages: [
          messageFixture("message-a", "thread-a"),
          messageFixture("message-b", "thread-a"),
        ],
      }),
    );
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });

    const thread = await client.getThread("thread-a");

    expect(thread.id).toBe("thread-a");
    expect(thread.messages.map((message) => message.id)).toEqual([
      "message-a",
      "message-b",
    ]);
  });

  it("keeps validation budgets per message in a long Gmail thread", async () => {
    const messages = Array.from({ length: 8 }, (_, messageIndex) => {
      const message = messageFixture(`message-${messageIndex}`, "thread-long");
      message.payload.headers = Array.from({ length: 71 }, (_, headerIndex) => ({
        name: `X-Test-${headerIndex}`,
        value: "bounded",
      }));
      return message;
    });
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({
          id: "thread-long",
          snippet: "Conversation",
          historyId: "200",
          messages,
        }),
      ),
    });

    await expect(client.getThread("thread-long")).resolves.toMatchObject({
      id: "thread-long",
      messages: expect.arrayContaining([
        expect.objectContaining({ id: "message-0" }),
        expect.objectContaining({ id: "message-7" }),
      ]),
    });
  });

  it("still rejects a single message that exceeds its header budget", async () => {
    const message = messageFixture("message-a", "thread-a");
    message.payload.headers = Array.from({ length: 513 }, (_, index) => ({
      name: `X-Test-${index}`,
      value: "bounded",
    }));
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ id: "thread-a", messages: [message] }),
      ),
    });

    await expect(client.getThread("thread-a")).rejects.toEqual(
      new GmailApiError("gmail_response_invalid"),
    );
  });

  it.each([
    {
      name: "mark thread read",
      run: (client: GmailApiClient) => client.markThreadRead("thread-a", true),
      path: "/gmail/v1/users/me/threads/thread-a/modify",
      body: { addLabelIds: [], removeLabelIds: ["UNREAD"] },
      response: { id: "thread-a" },
    },
    {
      name: "mark thread unread",
      run: (client: GmailApiClient) => client.markThreadRead("thread-a", false),
      path: "/gmail/v1/users/me/threads/thread-a/modify",
      body: { addLabelIds: ["UNREAD"], removeLabelIds: [] },
      response: { id: "thread-a" },
    },
    {
      name: "archive thread",
      run: (client: GmailApiClient) => client.archiveThread("thread-a"),
      path: "/gmail/v1/users/me/threads/thread-a/modify",
      body: { addLabelIds: [], removeLabelIds: ["INBOX"] },
      response: { id: "thread-a" },
    },
    {
      name: "mark message unread",
      run: (client: GmailApiClient) => client.markMessageRead("message-a", false),
      path: "/gmail/v1/users/me/messages/message-a/modify",
      body: { addLabelIds: ["UNREAD"], removeLabelIds: [] },
      response: {
        id: "message-a",
        threadId: "thread-a",
        labelIds: ["INBOX", "UNREAD"],
      },
    },
    {
      name: "archive message",
      run: (client: GmailApiClient) => client.archiveMessage("message-a"),
      path: "/gmail/v1/users/me/messages/message-a/modify",
      body: { addLabelIds: [], removeLabelIds: ["INBOX"] },
      response: { id: "message-a", threadId: "thread-a", labelIds: [] },
    },
  ])("uses Gmail labels to $name", async ({ run, path, body, response }) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(response));
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });

    const result = await run(client);

    const [input, init] = request.mock.calls[0];
    expect(new URL(String(input)).pathname).toBe(path);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual(body);
    expect(result.id).toBe(response.id);
  });

  it.each([
    {
      name: "trash",
      run: (client: GmailApiClient) => client.trashThread("thread-a"),
      initialLabels: ["INBOX"],
      settledLabels: ["TRASH"],
      path: "/gmail/v1/users/me/messages/message-a/trash",
    },
    {
      name: "untrash",
      run: (client: GmailApiClient) => client.untrashThread("thread-a"),
      initialLabels: ["TRASH"],
      settledLabels: ["INBOX"],
      path: "/gmail/v1/users/me/messages/message-a/untrash",
    },
  ])("uses Gmail's Draft-safe message $name endpoint", async ({
    run,
    initialLabels,
    settledLabels,
    path,
  }) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "thread-a",
          messages: [{ id: "message-a", labelIds: initialLabels }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "message-a",
          threadId: "thread-a",
          labelIds: settledLabels,
        }),
      );
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });

    const result = await run(client);

    expect(request).toHaveBeenCalledTimes(2);
    const preflight = new URL(String(request.mock.calls[0][0]));
    expect(preflight.pathname).toBe("/gmail/v1/users/me/threads/thread-a");
    expect(preflight.searchParams.get("format")).toBe("minimal");
    expect(preflight.searchParams.get("fields")).toBe(
      "id,messages(id,labelIds)",
    );
    const [input, init] = request.mock.calls[1];
    const url = new URL(String(input));
    expect(url.pathname).toBe(path);
    expect(url.searchParams.get("fields")).toBe("id,threadId,labelIds");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
    expect(result.id).toBe("thread-a");
  });

  it("never moves a Draft when trashing a mixed thread", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "thread-a",
          messages: [
            { id: "message-draft", labelIds: ["DRAFT"] },
            { id: "message-settled", labelIds: ["TRASH"] },
            { id: "message-pending", labelIds: ["INBOX"] },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "message-pending",
          threadId: "thread-a",
          labelIds: ["TRASH"],
        }),
      );
    const client = new GmailApiClient({ tokenPort: tokenPortFixture(), request });

    await client.trashThread("thread-a");

    const paths = request.mock.calls.map(([value]) => new URL(String(value)).pathname);
    expect(paths).toEqual([
      "/gmail/v1/users/me/threads/thread-a",
      "/gmail/v1/users/me/messages/message-pending/trash",
    ]);
    expect(paths.join(" ")).not.toMatch(/message-draft|threads\/thread-a\/trash/);
  });

  it.each([
    ["trash", (client: GmailApiClient) => client.trashThread("thread-a")],
    ["untrash", (client: GmailApiClient) => client.untrashThread("thread-a")],
    ["spam", (client: GmailApiClient) => client.markThreadSpam("thread-a")],
    ["not-spam", (client: GmailApiClient) => client.markThreadNotSpam("thread-a")],
    ["star", (client: GmailApiClient) => client.starThread("thread-a")],
    ["unstar", (client: GmailApiClient) => client.unstarThread("thread-a")],
  ])("treats an all-Draft thread as a safe no-op for %s", async (_name, run) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "thread-a",
        messages: [{ id: "message-draft", labelIds: ["DRAFT", "TRASH"] }],
      }),
    );
    const client = new GmailApiClient({ tokenPort: tokenPortFixture(), request });

    await expect(run(client)).resolves.toMatchObject({ id: "thread-a" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(new URL(String(request.mock.calls[0][0])).pathname).toBe(
      "/gmail/v1/users/me/threads/thread-a",
    );
  });

  it.each([
    {
      name: "star",
      run: (client: GmailApiClient) => client.starThread("thread-a"),
      labels: ["INBOX"],
      body: { addLabelIds: ["STARRED"], removeLabelIds: [] },
    },
    {
      name: "unstar",
      run: (client: GmailApiClient) => client.unstarThread("thread-a"),
      labels: ["INBOX", "STARRED"],
      body: { addLabelIds: [], removeLabelIds: ["STARRED"] },
    },
  ])("uses an idempotent thread-label request to $name", async ({
    run,
    labels,
    body,
  }) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "thread-a",
          messages: [{ id: "message-a", labelIds: labels }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "thread-a" }));
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });

    await expect(run(client)).resolves.toMatchObject({ id: "thread-a" });

    expect(request).toHaveBeenCalledTimes(2);
    const [input, init] = request.mock.calls[1];
    expect(new URL(String(input)).pathname).toBe(
      "/gmail/v1/users/me/threads/thread-a/modify",
    );
    expect(JSON.parse(String(init?.body))).toEqual(body);
  });

  it("does not repeat an already-satisfied star mutation", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "thread-a",
        messages: [{ id: "message-a", labelIds: ["INBOX", "STARRED"] }],
      }),
    );
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });

    await expect(client.starThread("thread-a")).resolves.toEqual({
      id: "thread-a",
      threadId: null,
      labelIds: [],
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "spam",
      run: (client: GmailApiClient) => client.markThreadSpam("thread-a"),
      settledLabels: ["SPAM"],
      pendingLabels: ["INBOX"],
      body: { addLabelIds: ["SPAM"], removeLabelIds: [] },
    },
    {
      name: "not spam",
      run: (client: GmailApiClient) => client.markThreadNotSpam("thread-a"),
      settledLabels: ["INBOX"],
      pendingLabels: ["SPAM"],
      body: { addLabelIds: [], removeLabelIds: ["SPAM"] },
    },
  ])("changes only non-Draft messages when marking a mixed thread $name", async ({
    run,
    settledLabels,
    pendingLabels,
    body,
  }) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "thread-a",
          messages: [
            { id: "message-draft", labelIds: ["DRAFT"] },
            { id: "message-settled", labelIds: settledLabels },
            { id: "message-pending", labelIds: pendingLabels },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "message-pending",
          threadId: "thread-a",
          labelIds: settledLabels,
        }),
      );
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });

    await expect(run(client)).resolves.toMatchObject({ id: "thread-a" });

    expect(request).toHaveBeenCalledTimes(2);
    const [input, init] = request.mock.calls[1];
    expect(new URL(String(input)).pathname).toBe(
      "/gmail/v1/users/me/messages/message-pending/modify",
    );
    expect(JSON.parse(String(init?.body))).toEqual(body);
    expect(request.mock.calls.map(([value]) => String(value)).join(" ")).not.toContain(
      "message-draft/modify",
    );
  });

  it("falls back to non-Draft message requests when starring a mixed thread", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "thread-a",
          messages: [
            { id: "message-draft", labelIds: ["DRAFT"] },
            { id: "message-a", labelIds: ["INBOX"] },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "message-a",
          threadId: "thread-a",
          labelIds: ["INBOX", "STARRED"],
        }),
      );
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });

    await client.starThread("thread-a");

    expect(new URL(String(request.mock.calls[1][0])).pathname).toBe(
      "/gmail/v1/users/me/messages/message-a/modify",
    );
  });

  it.each([
    {
      name: "spam",
      run: (client: GmailApiClient) => client.markThreadSpam("thread-a"),
      labelId: "SPAM",
    },
    {
      name: "star with a Draft present",
      run: (client: GmailApiClient) => client.starThread("thread-a"),
      labelId: "STARRED",
    },
  ])("resumes only the unfinished message after a partial $name failure", async ({
    run,
    labelId,
  }) => {
    const before = {
      id: "thread-a",
      messages: [
        { id: "message-draft", labelIds: ["DRAFT"] },
        { id: "message-a", labelIds: ["INBOX"] },
        { id: "message-b", labelIds: ["INBOX"] },
      ],
    };
    const afterPartial = {
      ...before,
      messages: [
        before.messages[0],
        { id: "message-a", labelIds: ["INBOX", labelId] },
        before.messages[2],
      ],
    };
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(before))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "message-a",
          threadId: "thread-a",
          labelIds: ["INBOX", labelId],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { errors: [{ reason: "userRateLimitExceeded" }] } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse(afterPartial))
      .mockResolvedValueOnce(
        jsonResponse({
          id: "message-b",
          threadId: "thread-a",
          labelIds: ["INBOX", labelId],
        }),
      );
    const client = new GmailApiClient({ tokenPort: tokenPortFixture(), request });

    await expect(run(client)).rejects.toEqual(
      new GmailApiError("gmail_rate_limited"),
    );
    await expect(run(client)).resolves.toMatchObject({ id: "thread-a" });

    const mutationPaths = request.mock.calls
      .map(([value]) => new URL(String(value)).pathname)
      .filter((path) => path.includes("/messages/"));
    expect(mutationPaths).toEqual([
      "/gmail/v1/users/me/messages/message-a/modify",
      "/gmail/v1/users/me/messages/message-b/modify",
      "/gmail/v1/users/me/messages/message-b/modify",
    ]);
  });
});

describe("Gmail API authentication and safe errors", () => {
  it("retries one 401 with a forced refresh and never exposes either token", async () => {
    const tokens: Buffer[] = [];
    const tokenPort = tokenPortFixture(tokens);
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { errors: [{ reason: "authError" }] } },
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({ messages: [], resultSizeEstimate: 0 }),
      );
    const client = new GmailApiClient({ tokenPort, request });

    await expect(client.listInboxMessages()).resolves.toEqual({
      items: [],
      nextPageToken: null,
      resultSizeEstimate: 0,
    });
    expect(tokenPort.getAccessToken).toHaveBeenNthCalledWith(
      2,
      { forceRefresh: true },
      expect.any(AbortSignal),
    );
    expect(tokens.every((token) => token.every((byte) => byte === 0))).toBe(true);
    const headers = request.mock.calls.map((call) => new Headers(call[1]?.headers));
    expect(headers[0].get("Authorization")).toBe("Bearer access-token-cached");
    expect(headers[1].get("Authorization")).toBe("Bearer access-token-fresh");
  });

  it("maps a failed refresh and a second 401 to reauth_required", async () => {
    const invalidGrantPort: GmailAccessTokenPort = {
      getAccessToken: vi.fn(async () => {
        throw new GmailAccessTokenError("invalid_grant");
      }),
    };
    const noNetwork = vi.fn<typeof fetch>();
    const invalidGrantClient = new GmailApiClient({
      tokenPort: invalidGrantPort,
      request: noNetwork,
    });
    await expect(invalidGrantClient.listInboxThreads()).rejects.toEqual(
      new GmailApiError("gmail_reauth_required"),
    );
    expect(noNetwork).not.toHaveBeenCalled();

    const unavailableClient = new GmailApiClient({
      tokenPort: {
        getAccessToken: vi.fn(async () => {
          throw new GmailAccessTokenError("refresh_unavailable", 120_000);
        }),
      },
      request: noNetwork,
    });
    await expect(unavailableClient.listInboxThreads()).rejects.toEqual(
      new GmailApiError("gmail_service_unavailable", 120_000),
    );

    const two401 = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ error: {} }, { status: 401 }),
      ),
    });
    await expect(two401.listInboxThreads()).rejects.toEqual(
      new GmailApiError("gmail_reauth_required"),
    );
  });

  it.each([
    [403, "rateLimitExceeded", "gmail_rate_limited"],
    [403, "domainPolicy", "gmail_permission_denied"],
    [404, "notFound", "gmail_not_found"],
    [409, "conflict", "gmail_conflict"],
    [429, "userRateLimitExceeded", "gmail_rate_limited"],
    [500, "backendError", "gmail_service_unavailable"],
  ])("maps HTTP %i/%s to %s", async (status, reason, code) => {
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: {
              code: status,
              message: "provider detail that must not escape",
              errors: [{ reason }],
            },
          },
          { status },
        ),
      ),
    });
    let caught: unknown;
    try {
      await client.listInboxThreads();
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(new GmailApiError(code as never));
    expect(String(caught)).not.toContain("provider detail");
  });

  it.each([
    [429, "120", 120_000],
    [503, "999999999999999999999", 30 * 60_000],
    [429, "-1", null],
    [429, "not-a-retry-date", null],
  ] as const)(
    "bounds HTTP %i Retry-After %s as %s",
    async (status, retryAfter, expectedRetryAfterMs) => {
      const client = new GmailApiClient({
        tokenPort: tokenPortFixture(),
        request: vi.fn<typeof fetch>().mockResolvedValue(
          jsonResponse(
            {
              error: {
                code: status,
                message: "provider detail that must not escape",
                errors: [{ reason: "userRateLimitExceeded" }],
              },
            },
            { status, headers: { "Retry-After": retryAfter } },
          ),
        ),
      });

      await expect(client.listInboxThreads()).rejects.toMatchObject({
        retryAfterMs: expectedRetryAfterMs,
      });
    },
  );

  it("parses a future HTTP-date and rejects a past one", async () => {
    const now = Date.UTC(2026, 6, 19, 12, 0, 0);
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse(
            { error: { errors: [{ reason: "userRateLimitExceeded" }] } },
            {
              status: 429,
              headers: {
                "Retry-After": new Date(now + 90_000).toUTCString(),
              },
            },
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            { error: { errors: [{ reason: "userRateLimitExceeded" }] } },
            {
              status: 429,
              headers: {
                "Retry-After": new Date(now - 1_000).toUTCString(),
              },
            },
          ),
        );
      const client = new GmailApiClient({ tokenPort: tokenPortFixture(), request });

      await expect(client.listInboxThreads()).rejects.toMatchObject({
        code: "gmail_rate_limited",
        retryAfterMs: 90_000,
      });
      await expect(client.listInboxThreads()).rejects.toMatchObject({
        code: "gmail_rate_limited",
        retryAfterMs: null,
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("does not expose a malformed Retry-After header or provider body", async () => {
    const rawRetryAfter = "private retry detail";
    const providerDetail = "private provider body";
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse(
          {
            error: {
              message: providerDetail,
              errors: [{ reason: "userRateLimitExceeded" }],
            },
          },
          { status: 429, headers: { "Retry-After": rawRetryAfter } },
        ),
      ),
    });

    let caught: unknown;
    try {
      await client.listInboxThreads();
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(new GmailApiError("gmail_rate_limited"));
    expect(String(caught)).not.toContain(rawRetryAfter);
    expect(String(caught)).not.toContain(providerDetail);
  });

  it("maps the refresh timeout without making a request", async () => {
    const request = vi.fn<typeof fetch>();
    const client = new GmailApiClient({
      tokenPort: {
        getAccessToken: vi.fn(async () => {
          throw new GmailAccessTokenError("refresh_timeout");
        }),
      },
      request,
    });
    await expect(client.getMessage("message-a")).rejects.toEqual(
      new GmailApiError("gmail_request_timeout"),
    );
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [404, "notFound", "gmail_not_found"],
    [429, "userRateLimitExceeded", "gmail_rate_limited"],
  ])("maps a message mutation HTTP %i/%s to %s", async (status, reason, code) => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "thread-a",
          messages: [{ id: "message-a", labelIds: ["INBOX"] }],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { errors: [{ reason }] } },
          { status },
        ),
      );
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });

    await expect(client.markThreadSpam("thread-a")).rejects.toEqual(
      new GmailApiError(code as never),
    );
  });

  it("maps two mutation 401 responses to reauth_required", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: "thread-a",
          messages: [{ id: "message-a", labelIds: ["INBOX"] }],
        }),
      )
      .mockResolvedValue(
        jsonResponse({ error: { errors: [{ reason: "authError" }] } }, { status: 401 }),
      );
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });

    await expect(client.markThreadSpam("thread-a")).rejects.toEqual(
      new GmailApiError("gmail_reauth_required"),
    );
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("maps an aborted system-folder mutation to request_cancelled", async () => {
    const controller = new AbortController();
    const request = vi.fn<typeof fetch>(async (_input, init) => {
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(init.signal.reason);
          return;
        }
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      });
    });
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });
    const mutation = client.markThreadSpam("thread-a", controller.signal);

    controller.abort(new Error("stop"));

    await expect(mutation).rejects.toEqual(
      new GmailApiError("gmail_request_cancelled"),
    );
  });
});

describe("Gmail API incremental sync", () => {
  it("reads the bounded profile anchor and one strict history page", async () => {
    const request = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/profile")) {
        return jsonResponse({
          emailAddress: "reader@example.test",
          messagesTotal: 12,
          threadsTotal: 8,
          historyId: "900",
        });
      }
      expect(url.pathname).toBe("/gmail/v1/users/me/history");
      expect(url.searchParams.get("startHistoryId")).toBe("800");
      expect(url.searchParams.get("maxResults")).toBe("2");
      return jsonResponse({
        history: [
          {
            id: "850",
            messagesAdded: [
              {
                message: {
                  id: "message-a",
                  threadId: "thread-a",
                  labelIds: ["INBOX", "UNREAD"],
                },
              },
            ],
            labelsRemoved: [
              {
                message: {
                  id: "message-b",
                  threadId: "thread-b",
                  labelIds: [],
                },
                labelIds: ["INBOX"],
              },
            ],
          },
        ],
        nextPageToken: "history-two",
        historyId: "900",
      });
    });
    const client = new GmailApiClient({ tokenPort: tokenPortFixture(), request });

    await expect(client.getProfile()).resolves.toMatchObject({ historyId: "900" });
    await expect(
      client.listHistory({ startHistoryId: "800", maxItems: 2 }),
    ).resolves.toEqual({
      items: [
        {
          id: "850",
          messagesAdded: [
            {
              id: "message-a",
              threadId: "thread-a",
              labelIds: ["INBOX", "UNREAD"],
            },
          ],
          messagesDeleted: [],
          labelsAdded: [],
          labelsRemoved: [
            {
              message: {
                id: "message-b",
                threadId: "thread-b",
                labelIds: [],
              },
              labelIds: ["INBOX"],
            },
          ],
        },
      ],
      nextPageToken: "history-two",
      historyId: "900",
    });
  });

  it("rejects duplicate history ids and malformed caller anchors", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        history: [{ id: "2" }, { id: "2" }],
        historyId: "3",
      }),
    );
    const client = new GmailApiClient({ tokenPort: tokenPortFixture(), request });
    await expect(
      client.listHistory({ startHistoryId: "1", maxItems: 2 }),
    ).rejects.toEqual(new GmailApiError("gmail_response_invalid"));
    await expect(
      client.listHistory({ startHistoryId: "not-a-number" }),
    ).rejects.toEqual(new GmailApiError("gmail_request_invalid"));
  });
});

describe("Gmail API adversarial response validation", () => {
  it.each([
    ["unknown list field", { messages: [], unexpected: true }],
    ["invalid message id", { messages: [{ id: "bad/id", threadId: "t" }] }],
    [
      "duplicate list id",
      {
        messages: [
          { id: "same", threadId: "thread-a" },
          { id: "same", threadId: "thread-a" },
        ],
      },
    ],
    ["wrong list shape", { messages: {} }],
  ])("rejects %s", async (_label, payload) => {
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload)),
    });
    await expect(client.listInboxMessages({ maxItems: 2 })).rejects.toEqual(
      new GmailApiError("gmail_response_invalid"),
    );
  });

  it("rejects a page-token cycle and duplicate ids across pages", async () => {
    for (const secondPage of [
      {
        threads: [{ id: "thread-b" }],
        nextPageToken: "page-two",
      },
      {
        threads: [{ id: "thread-a" }],
      },
    ]) {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          jsonResponse({
            threads: [{ id: "thread-a" }],
            nextPageToken: "page-two",
          }),
        )
        .mockResolvedValueOnce(jsonResponse(secondPage));
      const client = new GmailApiClient({
        tokenPort: tokenPortFixture(),
        request,
      });
      await expect(
        client.listInboxThreads({ maxItems: 2, maxPages: 2 }),
      ).rejects.toEqual(new GmailApiError("gmail_response_invalid"));
    }
  });

  it("rejects a message from another thread and malformed MIME content", async () => {
    const invalidPayloads = [
      {
        id: "thread-a",
        messages: [messageFixture("message-a", "thread-b")],
      },
      {
        ...messageFixture("message-a", "thread-a"),
        payload: {
          mimeType: "text/plain",
          headers: [{ name: "Subject", value: "x".repeat(300 * 1024) }],
          body: { size: 1, data: "QQ" },
        },
      },
      {
        ...messageFixture("message-a", "thread-a"),
        payload: {
          mimeType: "text/plain",
          body: { size: 1, data: "not+base64url" },
        },
      },
      {
        ...messageFixture("message-a", "thread-a"),
        payload: {
          mimeType: "text/plain",
          body: { size: 1, data: "Zh==" },
        },
      },
      {
        ...messageFixture("message-a", "thread-a"),
        payload: {
          mimeType: "text/plain",
          body: { size: 5, data: "SGVsbG8==" },
        },
      },
    ];
    for (const payload of invalidPayloads) {
      const client = new GmailApiClient({
        tokenPort: tokenPortFixture(),
        request: vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(payload)),
      });
      const action = "messages" in payload
        ? client.getThread("thread-a")
        : client.getMessage("message-a");
      await expect(action).rejects.toEqual(
        new GmailApiError("gmail_response_invalid"),
      );
    }
  });

  it("rejects a resource or mutation response for a different id", async () => {
    const read = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse(messageFixture("message-b", "thread-a"))),
    });
    await expect(read.getMessage("message-a")).rejects.toEqual(
      new GmailApiError("gmail_response_invalid"),
    );

    const mutation = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ id: "thread-b" })),
    });
    await expect(mutation.archiveThread("thread-a")).rejects.toEqual(
      new GmailApiError("gmail_response_invalid"),
    );

    const trash = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ id: "thread-b" })),
    });
    await expect(trash.trashThread("thread-a")).rejects.toEqual(
      new GmailApiError("gmail_response_invalid"),
    );
  });

  it("rejects oversized declared and streamed responses", async () => {
    const declared = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi.fn<typeof fetch>().mockResolvedValue(
        new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(GMAIL_API_LIMITS.listResponseBytes + 1),
          },
        }),
      ),
    });
    await expect(declared.listInboxThreads()).rejects.toEqual(
      new GmailApiError("gmail_response_invalid"),
    );

    const chunk = new Uint8Array(GMAIL_API_LIMITS.listResponseBytes / 2 + 1);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk.slice());
        controller.enqueue(chunk.slice());
        controller.close();
      },
    });
    const streamed = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    });
    await expect(streamed.listInboxThreads()).rejects.toEqual(
      new GmailApiError("gmail_response_invalid"),
    );
    chunk.fill(0);
  });

  it("rejects invalid caller bounds and resource ids before network access", async () => {
    const request = vi.fn<typeof fetch>();
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });
    await expect(
      client.listInboxThreads({ maxPages: 21 }),
    ).rejects.toEqual(new GmailApiError("gmail_request_invalid"));
    await expect(client.getMessage("../escape")).rejects.toEqual(
      new GmailApiError("gmail_request_invalid"),
    );
    await expect(client.trashThread("../escape")).rejects.toEqual(
      new GmailApiError("gmail_request_invalid"),
    );
    await expect(
      client.markThreadRead("thread-a", "yes" as never),
    ).rejects.toEqual(new GmailApiError("gmail_request_invalid"));
    await expect(
      client.listThreads("unknown" as GmailSystemMailbox),
    ).rejects.toEqual(new GmailApiError("gmail_request_invalid"));
    expect(request).not.toHaveBeenCalled();
  });
});

function tokenPortFixture(observed: Buffer[] = []): GmailAccessTokenPort {
  return {
    getAccessToken: vi.fn(async ({ forceRefresh }) => {
      const token = Buffer.from(
        forceRefresh ? "access-token-fresh" : "access-token-cached",
      );
      observed.push(token);
      return token;
    }),
  };
}

function jsonResponse(
  value: unknown,
  init: { readonly status?: number; readonly headers?: HeadersInit } = {},
): Response {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });
}

function messageFixture(id: string, threadId: string) {
  return {
    id,
    threadId,
    labelIds: ["INBOX", "UNREAD"],
    snippet: "Hello",
    historyId: "123",
    internalDate: "1800000000000",
    sizeEstimate: 120,
    payload: {
      partId: "",
      mimeType: "multipart/alternative",
      filename: "",
      headers: [{ name: "Subject", value: "Hello" }],
      body: { size: 0 },
      parts: [
        {
          partId: "0",
          mimeType: "text/plain",
          filename: "",
          headers: [],
          body: { size: 5, data: "SGVsbG8" },
        },
      ],
    },
  };
}
