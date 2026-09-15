import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  verifyMcpBearerToken: vi.fn(),
  createBrainMailClient: vi.fn(),
  readTimeZone: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  getStore: mocks.getStore,
  // The four predicates the tools branch on read the error's own name, the way
  // the real ones do. A stand-in that always answered false would turn every
  // refusal the store decided on into a transport error.
  isAttachmentValidation: (e: unknown) =>
    e instanceof Error && e.name === "AttachmentValidationError",
  isNotFound: (e: unknown) => e instanceof Error && e.name === "NotFoundError",
  isNotionImportConflict: () => false,
  isRevConflict: (e: unknown) =>
    e instanceof Error && e.name === "RevConflictError",
  isTaskConflict: (e: unknown) =>
    e instanceof Error && e.name === "TaskConflictError",
  isTaskValidation: (e: unknown) =>
    e instanceof Error && e.name === "TaskValidationError",
  redactPage: (value: unknown) => value,
  redactPageMeta: (value: unknown) => value,
  AttachmentValidationError: class AttachmentValidationError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  NotFoundError: class NotFoundError extends Error {
    constructor(public id: string) {
      super(`page not found: ${id}`);
      this.name = "NotFoundError";
    }
  },
  TaskValidationError: class TaskValidationError extends Error {
    constructor(public reason: string) {
      super(reason);
      this.name = "TaskValidationError";
    }
  },
  RevConflictError: class RevConflictError extends Error {
    constructor(
      public currentRev: string,
      public expectedRev: string,
    ) {
      super("rev conflict");
      this.name = "RevConflictError";
    }
  },
  TaskConflictError: class TaskConflictError extends Error {
    constructor(
      public reason: string,
      public currentWhen: string | undefined,
    ) {
      super(reason);
      this.name = "TaskConflictError";
    }
  },
  // The note store's own number, not a smaller stand-in: `save_mail_attachment`
  // bounds its drain by it and names it in the refusal, and a mock that
  // disagreed would pin a cap this repo does not have.
  MAX_ATTACHMENT_BYTES: 25 * 1024 * 1024,
}));
// The one owner setting a task tool reads. Mocked rather than written to a
// state directory so a test says what zone is captured in its own body, and so
// a machine with a zone already captured cannot change what a test means.
vi.mock("@/lib/owner-settings", () => ({ readTimeZone: mocks.readTimeZone }));
vi.mock("@/lib/search", () => ({ searchNotes: vi.fn() }));
vi.mock("@/lib/emoji-llm", () => ({ smartEmoji: vi.fn() }));
vi.mock("@/lib/oauth/server", () => ({
  verifyMcpBearerToken: mocks.verifyMcpBearerToken,
}));
// Only the factory is replaced. `BrainMailClientError` stays the real class,
// because the tools branch on `instanceof` and a stand-in would make every
// service refusal read as an outage.
vi.mock("@/lib/mail/brain-mail-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mail/brain-mail-client")>()),
  createBrainMailClient: mocks.createBrainMailClient,
}));

import { POST } from "./route";
import {
  FAKE_ACCOUNT_ID,
  FAKE_ACCOUNT_ID_TWO,
  createMailClientFake,
  fakeAccountV2,
  fakeAccountV3,
  fakeMessage,
  fakeThread,
} from "./mail-client-fake";
import { BrainMailClientError } from "@/lib/mail/brain-mail-client";
import {
  MAX_ATTACHMENT_BYTES,
  NotFoundError,
  TaskConflictError,
  TaskValidationError,
} from "@/lib/store";
import { LEGACY_BEARER_SCOPES } from "@/lib/oauth/config";
import { hashTaskText, parseTaskLines } from "@/lib/tasks/task-lines";
import { toolScopeOf } from "./tool-kit";
import { dayInZone, flushTaskActivityForTests } from "./task-tools";
import { readMcpActivity } from "@/lib/mcp/activity-log";
import { readAgentSends, recordAgentSend } from "@/lib/mcp/agent-sends";
import {
  MCP_AGENT_SETTINGS_FILE,
  writeAgentSettings,
} from "@/lib/mcp/agent-settings";
import type { MailSendInput } from "@/lib/mail/message-types";
import { mailNotificationId } from "@/lib/notifications/ids";
import {
  appendNotification,
  listNotifications,
} from "@/lib/notifications/store";
import { searchNotes } from "@/lib/search";

const notionId = "a".repeat(32);
const sourceHash = "b".repeat(64);
const conversionHash = "c".repeat(64);
const reservationToken = "client_journal_token_1234";

async function callTool(name: string, args: Record<string, unknown>, id: number) {
  return POST(
    new Request("https://brain.example.test/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-machine-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
}

async function toolPayload(response: Response) {
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const envelope = JSON.parse(dataLine?.slice(6) ?? body) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
  };
  return {
    payload: JSON.parse(envelope.result?.content?.[0]?.text ?? "null"),
    isError: envelope.result?.isError ?? false,
  };
}

/** A rethrow, unlike every refusal above, is not `text()`'s JSON: the SDK
 *  hands a thrown error's own `.message` to the agent verbatim, so
 *  `toolPayload`'s `JSON.parse` has nothing to parse. This reads the same
 *  envelope without it, for the one place a test wants the raw sentence. */
async function rawToolText(response: Response) {
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const envelope = JSON.parse(dataLine?.slice(6) ?? body) as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
  };
  return {
    text: envelope.result?.content?.[0]?.text ?? "",
    isError: envelope.result?.isError ?? false,
  };
}

/** The whole tool table as the server advertises it. A test that asserts a
 *  tool is absent has to ask the server rather than read the source, because
 *  the source is where a forgotten registration still looks right. */
function toolsListRequest(id: number) {
  return new Request("https://brain.example.test/api/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: "Bearer test-machine-token",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" }),
  });
}

describe("Notion MCP route validation", () => {
  beforeEach(() => {
    mocks.getStore.mockReset();
    mocks.createBrainMailClient.mockReset();
    mocks.verifyMcpBearerToken.mockReset();
    mocks.verifyMcpBearerToken.mockImplementation(async (token?: string) => {
      if (token === "read-only-token") {
        return {
          token,
          clientId: "read-only-client",
          scopes: ["brain:read"],
          resource: new URL("https://brain.example.test/api/mcp"),
        };
      }
      if (token === "test-machine-token") {
        return {
          token,
          clientId: "legacy-client",
          scopes: ["brain:read", "brain:write", "brain:import"],
          resource: new URL("https://brain.example.test/api/mcp"),
        };
      }
      return undefined;
    });
    vi.stubEnv("MCP_TOKEN", "test-machine-token");
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-with-at-least-32-bytes");
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example.test");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("blocks write tools for a read-only OAuth connection before Store access", async () => {
    const response = await POST(
      new Request("https://brain.example.test/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer read-only-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 42,
          method: "tools/call",
          params: {
            name: "create_page",
            arguments: { title: "Must not be created" },
          },
        }),
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "insufficient_scope",
    });
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'scope="brain:write"',
    );
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'resource_metadata="https://brain.example.test/.well-known/oauth-protected-resource/api/mcp"',
    );
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("checks read access without mutating notes or overstating write access", async () => {
    const getTree = vi.fn().mockReturnValue([
      { id: "root-a", title: "Root A", children: [] },
      { id: "root-b", title: "Root B", children: [] },
    ]);
    mocks.getStore.mockResolvedValue({ getTree });

    const response = await POST(
      new Request("https://brain.example.test/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer read-only-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 46,
          method: "tools/call",
          params: {
            name: "connection_check",
            arguments: {},
          },
        }),
      }),
    );

    const body = await response.text();
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    const envelope = JSON.parse(dataLine?.slice(6) ?? body) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const payload = JSON.parse(envelope.result?.content?.[0]?.text ?? "null");

    expect(response.status).toBe(200);
    expect(getTree).toHaveBeenCalledOnce();
    expect(payload).toEqual({
      status: "connected",
      checks: {
        authentication: "ok",
        notes: "ok",
      },
      access: {
        read: "ready",
        write: "not_authorized",
        import: "not_authorized",
        mail: "not_authorized",
        mailSend: "not_authorized",
      },
      rootPageCount: 2,
      scopes: ["brain:read"],
      changedPages: 0,
    });
  });

  it("reports mail and send access the same way it reports write and import", async () => {
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "mail-only-token",
      clientId: "mail-only-client",
      scopes: ["brain:read", "brain:mail", "brain:mail:send"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    mocks.getStore.mockResolvedValue({ getTree: vi.fn().mockReturnValue([]) });

    const { payload } = await toolPayload(
      await callTool("connection_check", {}, 47),
    );

    expect(payload.access).toEqual({
      read: "ready",
      write: "not_authorized",
      import: "not_authorized",
      mail: "authorized",
      mailSend: "authorized",
    });
  });

  /** THE TWO BEARERS, SIDE BY SIDE, THROUGH THE ONE GATE.
   *
   *  The scope set comes from `LEGACY_BEARER_SCOPES` rather than from words
   *  typed here, so a mail name appended to that list breaks this pin instead
   *  of quietly opening the mailbox to an env var. The owner grant beneath it
   *  is the path that is meant to reach mail: a consent screen was shown, a
   *  row stands under Connected apps, and Revoke ends it. */
  it("refuses a mail tool to the legacy bearer and allows it to an owner grant", async () => {
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "test-machine-token",
      clientId: "brain-legacy-bearer",
      scopes: [...LEGACY_BEARER_SCOPES],
      resource: new URL("https://brain.example.test/api/mcp"),
      extra: { legacy: true },
    });
    const refused = await callTool("list_mail_accounts", {}, 470);
    expect(refused.status).toBe(403);
    expect(refused.headers.get("WWW-Authenticate")).toContain(
      'scope="brain:mail"',
    );
    expect(mocks.createBrainMailClient).not.toHaveBeenCalled();

    // And the same bearer's own connection report says so rather than
    // advertising a mailbox it cannot open.
    mocks.getStore.mockResolvedValue({ getTree: vi.fn().mockReturnValue([]) });
    const { payload } = await toolPayload(
      await callTool("connection_check", {}, 471),
    );
    expect(payload.access).toMatchObject({
      write: "authorized",
      import: "authorized",
      mail: "not_authorized",
      mailSend: "not_authorized",
    });
    expect(payload.scopes).toEqual([...LEGACY_BEARER_SCOPES]);

    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "owner-grant-token",
      clientId: "owner-grant-client",
      scopes: ["brain:read", "brain:write", "brain:import", "brain:mail", "brain:mail:send"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    mocks.createBrainMailClient.mockReturnValue(createMailClientFake().client);
    const allowed = await toolPayload(await callTool("list_mail_accounts", {}, 472));
    expect(allowed.isError).toBe(false);
    expect(allowed.payload.accounts).toBeInstanceOf(Array);
  });

  it("returns an import-specific HTTP challenge before a Notion tool runs", async () => {
    const response = await POST(
      new Request("https://brain.example.test/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer read-only-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 43,
          method: "tools/call",
          params: {
            name: "notion_find_page",
            arguments: { notionId },
          },
        }),
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'error="insufficient_scope"',
    );
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'scope="brain:import"',
    );
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("keeps import in the bootstrap challenge after tool-specific reauthorization", async () => {
    const response = await POST(
      new Request("https://brain.example.test/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 44,
          method: "tools/list",
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'scope="brain:read brain:write brain:import brain:mail brain:mail:send"',
    );
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("refuses a batch that mixes a permitted tool with one the grant lacks", async () => {
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "mail-only-token",
      clientId: "mail-only-client",
      scopes: ["brain:read", "brain:mail"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });

    const response = await POST(
      new Request("https://brain.example.test/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer mail-only-token",
          "content-type": "application/json",
        },
        body: JSON.stringify([
          {
            jsonrpc: "2.0",
            id: 500,
            method: "tools/call",
            params: { name: "send_mail", arguments: {} },
          },
          {
            jsonrpc: "2.0",
            id: 501,
            method: "tools/call",
            params: {
              name: "list_mail_threads",
              arguments: { accountId: FAKE_ACCOUNT_ID },
            },
          },
        ]),
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'scope="brain:mail:send"',
    );
    expect(mocks.createBrainMailClient).not.toHaveBeenCalled();
  });

  // The one shape the pre-gate used to let through: an import tool returned
  // early as the widest scope in play, so a batch mixing it with a mail call
  // was pre-gated on brain:import alone and the mail call reached its handler
  // to refuse itself in-body. The gate is a set over every tool in the batch
  // with no early return, so a batch this grant cannot run is refused whole.
  it("refuses a batch mixing an import tool with a mail tool on an import-only grant", async () => {
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "import-only-token",
      clientId: "import-only-client",
      scopes: ["brain:read", "brain:write", "brain:import"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });

    const response = await POST(
      new Request("https://brain.example.test/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer import-only-token",
          "content-type": "application/json",
        },
        body: JSON.stringify([
          {
            jsonrpc: "2.0",
            id: 502,
            method: "tools/call",
            params: { name: "notion_find_page", arguments: {} },
          },
          {
            jsonrpc: "2.0",
            id: 503,
            method: "tools/call",
            params: {
              name: "list_mail_threads",
              arguments: { accountId: FAKE_ACCOUNT_ID },
            },
          },
        ]),
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'scope="brain:mail"',
    );
    expect(mocks.createBrainMailClient).not.toHaveBeenCalled();
  });

  it("passes a single call from a grant holding only the scope that tool needs", async () => {
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "mail-only-token",
      clientId: "mail-only-client",
      scopes: ["brain:read", "brain:mail"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const response = await callTool(
      "list_mail_threads",
      { accountId: FAKE_ACCOUNT_ID },
      502,
    );

    expect(response.status).toBe(200);
  });

  it("refuses send_mail alone with its own scope, not mail's", async () => {
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "mail-only-token",
      clientId: "mail-only-client",
      scopes: ["brain:read", "brain:mail"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });

    const response = await callTool("send_mail", {}, 503);

    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'scope="brain:mail:send"',
    );
    expect(mocks.createBrainMailClient).not.toHaveBeenCalled();
  });

  it("rejects a valid bearer followed by extra authorization data", async () => {
    const response = await POST(
      new Request("https://brain.example.test/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer test-machine-token trailing-data",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 45,
          method: "tools/list",
        }),
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.verifyMcpBearerToken).toHaveBeenCalledWith(undefined);
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("refuses public enable through update_meta before Store access", async () => {
    const response = await callTool(
      "update_meta",
      {
        id: "page-a",
        title: "Must not change",
        public: true,
      },
      47,
    );

    expect(response.status).toBe(200);
    await expect(toolPayload(response)).resolves.toEqual({
      payload: {
        error:
          "public sharing must be enabled by the owner after scope disclosure",
        reason: "share_disclosure_required",
      },
      isError: true,
    });
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("retains public false in update_meta as a compatible safe revoke", async () => {
    const updateMeta = vi.fn().mockResolvedValue({ id: "page-a" });
    mocks.getStore.mockResolvedValue({ updateMeta });

    const response = await callTool(
      "update_meta",
      {
        id: "page-a",
        title: "Renamed safely",
        public: false,
      },
      48,
    );

    expect(response.status).toBe(200);
    await expect(toolPayload(response)).resolves.toEqual({
      payload: { id: "page-a" },
      isError: false,
    });
    expect(updateMeta).toHaveBeenCalledWith("page-a", {
      title: "Renamed safely",
      public: false,
      by: "claude",
    });
  });

  it("drops shareEdit from update_meta before it reaches the Store", async () => {
    const updateMeta = vi.fn().mockResolvedValue({ id: "page-a" });
    mocks.getStore.mockResolvedValue({ updateMeta });

    const response = await callTool(
      "update_meta",
      {
        id: "page-a",
        title: "Renamed with a smuggled grant",
        shareEdit: true,
      },
      49,
    );

    expect(response.status).toBe(200);
    // Consume the stream first: the handler runs while the body is produced.
    await expect(toolPayload(response)).resolves.toEqual({
      payload: { id: "page-a" },
      isError: false,
    });
    expect(updateMeta).toHaveBeenCalledTimes(1);
    expect(updateMeta).toHaveBeenCalledWith("page-a", {
      title: "Renamed with a smuggled grant",
      by: "claude",
    });
    expect(updateMeta.mock.calls[0][1]).not.toHaveProperty("shareEdit");
  });

  it("moves as claude and reports the body the move unlinked", async () => {
    const movePageWithBodyReport = vi.fn().mockResolvedValue({
      meta: { id: "page-a", parentId: "page-c", updatedBy: "claude" },
      unlinkedFrom: "page-b",
    });
    mocks.getStore.mockResolvedValue({ movePageWithBodyReport });

    const response = await callTool(
      "move_page",
      { id: "page-a", newParentId: "page-c", beforeId: null },
      49,
    );

    expect(response.status).toBe(200);
    // The same shape a human's move gets from /api/move: the moved page plus
    // the old parent whose body stopped listing it.
    await expect(toolPayload(response)).resolves.toEqual({
      payload: {
        id: "page-a",
        parentId: "page-c",
        updatedBy: "claude",
        unlinkedFrom: "page-b",
      },
      isError: false,
    });
    expect(movePageWithBodyReport).toHaveBeenCalledWith(
      "page-a",
      "page-c",
      null,
      undefined,
      "claude",
    );
  });

  it("marks write_page's rev conflict as the refusal it is", async () => {
    // The one refusal on this endpoint that used to answer as a success: an
    // agent reading `isError` saw none and took the conflict for a write.
    const { RevConflictError } = (await import("@/lib/store")) as unknown as {
      RevConflictError: new (currentRev: string, expectedRev: string) => Error;
    };
    const writePage = vi
      .fn()
      .mockRejectedValue(new RevConflictError("rev-2", "rev-1"));
    mocks.getStore.mockResolvedValue({ writePage });

    const { payload, isError } = await toolPayload(
      await callTool(
        "write_page",
        { id: "write-target", markdown: "# one", rev: "rev-1" },
        104,
      ),
    );

    expect(payload).toEqual({
      error: "rev conflict — re-read the page",
      reason: "rev_conflict",
      currentRev: "rev-2",
    });
    expect(isError).toBe(true);
  });

  /** THE PAGE TOOLS ANSWER A STORE FAILURE TOO.
   *
   *  `read_page` handed the agent the Node message verbatim, which names the
   *  absolute path of the notes folder. A page id that is not a page still
   *  surfaces the way `docs/mcp-tools.md` says it does. */
  it("answers a store failure on the page tools with a code and no path", async () => {
    const full = Object.assign(
      new Error("EIO: i/o error, read '/notes/page-one.md'"),
      { code: "EIO" },
    );
    mocks.getStore.mockResolvedValue({
      readPage: vi.fn().mockRejectedValue(full),
      appendPage: vi.fn().mockRejectedValue(full),
      getTree: vi.fn(() => {
        throw full;
      }),
    });

    for (const [name, args, id] of [
      ["read_page", { id: "page-one" }, 104],
      ["append_page", { id: "page-one", markdown: "a line" }, 105],
      ["list_tree", {}, 106],
    ] as const) {
      const { payload, isError } = await toolPayload(await callTool(name, args, id));
      expect(isError, name).toBe(true);
      expect(payload, name).toEqual({
        error: "the notes folder could not answer",
        reason: "store_failed",
      });
      expect(JSON.stringify(payload)).not.toContain("/notes/");
    }
  });

  /** `search` WAS THE ONE PAGE TOOL NOT WRAPPED IN `pageTool`.
   *
   *  `searchNotes` reads the store the same way the other page tools do, so
   *  a notes-folder failure inside it used to reach the agent as the SDK's
   *  verbatim transport error rather than the `store_failed` shape above. */
  it("answers a store failure on search the same way", async () => {
    vi.mocked(searchNotes).mockRejectedValue(
      new Error("EACCES: permission denied, scandir '/notes/pages'"),
    );

    const { payload, isError } = await toolPayload(
      await callTool("search", { query: "anything" }, 107),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "the notes folder could not answer",
      reason: "store_failed",
    });
    expect(JSON.stringify(payload)).not.toContain("/notes/");
  });

  /** THE NOTION_* CARVE-OUT KEEPS THE THROW, NOT THE PATH.
   *
   *  The nine `notion_*` tools rethrow a store failure so the import driver's
   *  abort-and-retry still fires, and used to rethrow the store's own Node
   *  `fs` message, naming the notes folder's absolute path. Pinned on one of
   *  the nine: the driver only needs the throw, never the path. */
  it("rethrows a notion store failure worded in Brain's own sentence, never the path", async () => {
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "import-token",
      clientId: "import-client",
      scopes: ["brain:read", "brain:import"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    mocks.getStore.mockResolvedValue({
      inspectNotionPage: vi
        .fn()
        .mockRejectedValue(
          new Error("ENOSPC: no space left on device, write '/notes/.brain/lock'"),
        ),
    });

    const response = await POST(
      new Request("https://brain.example.test/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer import-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 108,
          method: "tools/call",
          params: { name: "notion_find_page", arguments: { notionId } },
        }),
      }),
    );

    const { text: message, isError } = await rawToolText(response);
    expect(isError).toBe(true);
    expect(message).toBe("Brain could not read the notes folder");
    expect(message).not.toContain("/notes/");
  });

  it("canonicalizes exact same-origin page links at all normal MCP write boundaries", async () => {
    const writePage = vi.fn().mockResolvedValue({ id: "write-target" });
    const appendPage = vi.fn().mockResolvedValue({ id: "append-target" });
    const createPage = vi.fn().mockResolvedValue({ id: "created-page" });
    mocks.getStore.mockResolvedValue({ writePage, appendPage, createPage });

    const markdown = [
      "* [Exact](https://brain.example.test/p/exact-id)  ",
      "  [Foreign](https://foreign.example/p/foreign-id)",
      "  [Query](https://brain.example.test/p/query-id?view=full)",
    ].join("\n");
    const canonical = markdown.replace(
      "https://brain.example.test/p/exact-id",
      "/p/exact-id",
    );

    const writeResponse = await callTool(
      "write_page",
      { id: "write-target", markdown, rev: "rev-1" },
      101,
    );
    expect(writeResponse.status, await writeResponse.clone().text()).toBe(200);
    expect(
      writePage.mock.calls,
      await writeResponse.clone().text(),
    ).toContainEqual(["write-target", canonical, "rev-1", "claude"]);

    await expect(
      callTool(
        "append_page",
        { id: "append-target", markdown },
        102,
      ),
    ).resolves.toMatchObject({ status: 200 });
    expect(appendPage).toHaveBeenCalledWith(
      "append-target",
      canonical,
      "claude",
    );

    const createResponse = await callTool(
      "create_page",
      {
        title: "Created through MCP",
        parentId: null,
        markdown,
        icon: "🧠",
      },
      103,
    );
    expect(createResponse.status).toBe(200);
    expect(
      createPage.mock.calls,
      await createResponse.clone().text(),
    ).toContainEqual([
      null,
      "Created through MCP",
      {
        markdown: canonical,
        icon: "🧠",
        status: undefined,
        by: "claude",
      },
    ]);
  });

  it("returns only the metadata-only candidate inspection contract", async () => {
    const inspectNotionCandidate = vi.fn().mockResolvedValue({
      id: "brain-page",
      rev: "rev-1",
      current: { parentId: null, beforeId: "next-page" },
      deleted: false,
      bindingState: "tracked",
      notionId,
      sourceHash,
      conversionHash,
      trackedTargetIntact: true,
      trackedAttachmentIntact: true,
      legacyBindingUpgradeable: false,
    });
    mocks.getStore.mockResolvedValue({ inspectNotionCandidate });

    const response = await POST(
      new Request("https://brain.example.test/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer test-machine-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "notion_inspect_candidate",
            arguments: { pageId: "brain-page" },
          },
        }),
      }),
    );
    const body = await response.text();
    const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
    const envelope = JSON.parse(dataLine?.slice(6) ?? "null") as {
      result?: { content?: Array<{ text?: string }> };
    };
    const payload = JSON.parse(envelope.result?.content?.[0]?.text ?? "null");
    expect(response.status).toBe(200);
    expect(inspectNotionCandidate).toHaveBeenCalledWith("brain-page");
    expect(payload).toMatchObject({
      candidate: { id: "brain-page", bindingState: "tracked" },
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /markdown|reservationToken|notionImportToken/,
    );
  });

  it.each([
    ["notion_find_page", { notionId }],
    ["notion_inspect_candidate", { pageId: "brain-page" }],
    [
      "notion_adopt_page",
      {
        pageId: "brain-page",
        notionId,
        sourceHash,
        conversionHash,
        expectedRev: "rev-1",
        expectedParentId: null,
        expectedBeforeId: null,
      },
    ],
    [
      "notion_reserve_page",
      {
        notionId,
        sourceHash,
        parentId: null,
        beforeId: null,
        title: "Page",
        reservationToken,
      },
    ],
    [
      "notion_upload_attachment",
      {
        notionId,
        sourceHash,
        expectedSha256: conversionHash,
        reservationToken,
        originalName: "asset.png",
        mimeType: "image/png",
        dataBase64: "AQID",
      },
    ],
    [
      "notion_verify_attachment",
      {
        notionId,
        sourceHash,
        reservationToken,
        url: "/_attachments-v2/" + conversionHash + ".png",
      },
    ],
    [
      "notion_verify_finalized_attachment",
      {
        notionId,
        sourceHash,
        conversionHash,
        url: "/_attachments-v2/" + conversionHash + ".png",
      },
    ],
    [
      "notion_finalize_page",
      {
        notionId,
        sourceHash,
        conversionHash,
        reservationToken,
        markdown: "body",
      },
    ],
    ["notion_abort_page", { notionId, sourceHash, reservationToken }],
  ] as const)("rejects an extra key for %s before Store access", async (name, input) => {
    const response = await POST(
      new Request("https://brain.example.test/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          authorization: "Bearer test-machine-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { ...input, extra: true } },
        }),
      }),
    );
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("Invalid arguments");
    expect(mocks.getStore).not.toHaveBeenCalled();
  });
});

/** The six names `WRITE_TOOLS` already carried before any of them existed. */
const TASK_WRITE_TOOLS = [
  "create_task",
  "promote_task_line",
  "update_task",
  "complete_task",
  "reopen_task",
  "delete_task",
] as const;

describe("the task read tools", () => {
  const TODAY = "2026-09-13";
  const TASK_ID = "task-alpha";
  const PAGE_ID = "page-one";

  const view = (overrides: Record<string, unknown> = {}) => ({
    id: TASK_ID,
    title: "Water the plants",
    done: false,
    created: "2026-09-13T09:00:00.000Z",
    updated: "2026-09-13T09:00:00.000Z",
    ...overrides,
  });

  beforeEach(() => {
    mocks.getStore.mockReset();
    mocks.readTimeZone.mockReset();
    // Nothing captured, which is what a fresh instance has until a browser
    // opens Settings, Account.
    mocks.readTimeZone.mockResolvedValue(null);
    mocks.verifyMcpBearerToken.mockReset();
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "test-machine-token",
      clientId: "legacy-client",
      scopes: ["brain:read"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    vi.stubEnv("MCP_TOKEN", "test-machine-token");
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-with-at-least-32-bytes");
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example.test");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("refuses every derived list with no date and no zone to derive one", async () => {
    for (const list of ["today", "upcoming", "someday", "logbook"]) {
      const { payload } = await toolPayload(
        await callTool("list_tasks", { list }, 1),
      );
      expect(payload).toEqual({
        error: "this list needs a day and no time zone is captured yet",
        reason: "pass today as YYYY-MM-DD, or set the zone in Settings, Account",
      });
      expect(mocks.getStore).not.toHaveBeenCalled();
    }
  });

  it("derives the day and the offset from the owner's own zone", async () => {
    // An agent has no browser and no zone of its own. Brain has one now, so a
    // caller that leaves `today` out gets the owner's day rather than UTC's,
    // which is a different day for four hours of every one in Asia/Dubai.
    mocks.readTimeZone.mockResolvedValue("Asia/Dubai");
    const listTasks = vi.fn().mockReturnValue([]);
    mocks.getStore.mockResolvedValue({ listTasks });

    await toolPayload(await callTool("list_tasks", { list: "today" }, 13));

    const [day, filter] = listTasks.mock.calls[0] as [string, unknown];
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Dubai keeps one offset all year, so the derived one is the same number
    // whatever day this test runs on.
    expect(filter).toEqual({ list: "today", offsetMinutes: 240 });
  });

  it("keeps the caller's own date ahead of the zone's", async () => {
    mocks.readTimeZone.mockResolvedValue("Asia/Dubai");
    const listTasks = vi.fn().mockReturnValue([]);
    mocks.getStore.mockResolvedValue({ listTasks });

    await toolPayload(
      await callTool("list_tasks", { list: "today", today: TODAY }, 14),
    );

    expect(listTasks.mock.calls[0][0]).toBe(TODAY);
  });

  it("refuses the logbook without the caller's own offset", async () => {
    const { payload } = await toolPayload(
      await callTool("list_tasks", { list: "logbook", today: TODAY }, 10),
    );
    expect(payload).toEqual({
      error: "the logbook needs the caller's own UTC offset",
      reason: "bad_offset",
    });
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("answers the logbook with keyed entries, repeat completions included", async () => {
    // A repeating record is never done, so a filter over records would tell an
    // agent that nothing repeating was ever finished. The store derives the
    // rows from `log`, and this is the caller that cannot derive its own.
    //
    // And an agent needs to tell two of them apart. Both rows below carry the
    // record id `task-words`, so the id cannot be the key; the entry's own
    // `key` is.
    const completion = (scheduled: string, completedAt: string) => ({
      key: `task-words:${completedAt}`,
      task: {
        ...view(),
        id: "task-words",
        title: "Learn words",
        repeat: { freq: "daily" },
        done: true,
        when: scheduled,
        doneAt: completedAt,
      },
      untickable: scheduled === "2026-09-13",
    });
    const rows = [
      completion("2026-09-13", "2026-09-13T09:00:00.000Z"),
      completion("2026-09-12", "2026-09-12T09:00:00.000Z"),
    ];
    const listLogbook = vi.fn().mockReturnValue(rows);
    const listTasks = vi.fn();
    mocks.getStore.mockResolvedValue({ listTasks, listLogbook });

    const { payload } = await toolPayload(
      await callTool(
        "list_tasks",
        { list: "logbook", today: TODAY, offsetMinutes: 0 },
        12,
      ),
    );

    expect(payload.entries).toEqual(rows);
    expect(payload.tasks).toBeUndefined();
    expect(new Set(rows.map((row) => row.task.id)).size).toBe(1);
    expect(new Set(rows.map((row) => row.key)).size).toBe(2);
    expect(listLogbook).toHaveBeenCalledWith(TODAY, { offsetMinutes: 0 });
    expect(listTasks).not.toHaveBeenCalled();
  });

  it("passes the caller's offset through to the logbook read", async () => {
    const listLogbook = vi.fn().mockReturnValue([]);
    mocks.getStore.mockResolvedValue({ listLogbook });

    await toolPayload(
      await callTool(
        "list_tasks",
        { list: "logbook", today: TODAY, offsetMinutes: 240 },
        11,
      ),
    );

    expect(listLogbook).toHaveBeenCalledWith(TODAY, { offsetMinutes: 240 });
  });

  it("refuses a malformed today", async () => {
    const { payload } = await toolPayload(
      await callTool("list_tasks", { list: "today", today: "2026-9-1" }, 2),
    );
    expect(payload).toEqual({
      error: "that day is not written as YYYY-MM-DD",
      reason: "bad_today",
    });
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("answers the inbox without a date, because inbox needs none", async () => {
    const listTasks = vi.fn().mockReturnValue([view()]);
    mocks.getStore.mockResolvedValue({ listTasks });

    const { payload } = await toolPayload(
      await callTool("list_tasks", { list: "inbox" }, 3),
    );

    expect(payload.tasks).toEqual([view()]);
    expect(listTasks.mock.calls[0][1]).toEqual({ list: "inbox" });
  });

  it("passes the caller's date and category to the store", async () => {
    const listTasks = vi.fn().mockReturnValue([]);
    mocks.getStore.mockResolvedValue({ listTasks });

    await toolPayload(
      await callTool(
        "list_tasks",
        { list: "today", today: TODAY, category: "home" },
        4,
      ),
    );

    expect(listTasks).toHaveBeenCalledWith(TODAY, {
      list: "today",
      category: "home",
    });
  });

  /** `taskRead` ANSWERS A STORE FAILURE THE SAME WAY THE PAGE TOOLS DO.
   *
   *  A store that cannot start throws before `listTasks` or `getTask` is
   *  ever called, and the wrapper is the one place that catches it for every
   *  read this file registers through it. */
  it("answers a store failure on a task read with a code and no path", async () => {
    mocks.getStore.mockRejectedValue(
      Object.assign(
        new Error("EACCES: permission denied, scandir '/notes/_tasks'"),
        { code: "EACCES" },
      ),
    );

    const { payload, isError } = await toolPayload(
      await callTool("list_tasks", { list: "inbox" }, 45),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "the notes folder could not answer",
      reason: "store_failed",
    });
    expect(JSON.stringify(payload)).not.toContain("/notes/");
  });

  it("reads one task and says which page it is linked to", async () => {
    const linked = view({ page: PAGE_ID });
    mocks.getStore.mockResolvedValue({
      getTask: vi.fn().mockReturnValue(linked),
      taskPageTrashed: vi.fn().mockReturnValue(false),
    });

    const { payload } = await toolPayload(
      await callTool("get_task", { id: TASK_ID }, 5),
    );

    expect(payload.task).toEqual(linked);
  });

  it("answers page_trashed for a task whose page is in the trash", async () => {
    mocks.getStore.mockResolvedValue({
      getTask: vi.fn().mockReturnValue(view({ page: PAGE_ID })),
      taskPageTrashed: vi.fn().mockReturnValue(true),
    });

    const { payload } = await toolPayload(
      await callTool("get_task", { id: TASK_ID }, 6),
    );

    expect(payload).toEqual({
      error: "that task's page is in the trash",
      reason: "page_trashed",
    });
  });

  it("answers not_found for an unknown id and bad_id for one that is not a task id", async () => {
    mocks.getStore.mockResolvedValue({
      getTask: vi.fn().mockReturnValue(null),
      taskPageTrashed: vi.fn().mockReturnValue(false),
    });

    const missing = await toolPayload(
      await callTool("get_task", { id: "task-missing" }, 7),
    );
    expect(missing.payload).toEqual({
      error: "no task with that id",
      reason: "not_found",
    });

    const bad = await toolPayload(
      await callTool("get_task", { id: "../escape" }, 8),
    );
    expect(bad.payload).toEqual({
      error: "that task id is not valid",
      reason: "bad_id",
    });
  });

  it("registers the task write tools under brain:write", async () => {
    const response = await POST(toolsListRequest(9));
    const body = await response.text();

    expect(body).toContain("list_tasks");
    expect(body).toContain("get_task");
    // Reversed in 0.11.0. An agent that wants a task makes one. The promote
    // gesture is still how a person turns a line into a record, and
    // promote_task_line is that same gesture, with the same anchor.
    for (const name of TASK_WRITE_TOOLS) {
      expect(body).toContain(name);
      expect(toolScopeOf(name)).toBe("brain:write");
    }
  });
});

describe("the task write tools", () => {
  const TODAY = "2026-09-14";
  const TASK_ID = "task-alpha";
  const PAGE_ID = "page-one";
  // A fresh directory per test, the way `save_mail_attachment` below takes
  // one: a fixed path collides across concurrent vitest processes, which is
  // what made `lib/mcp/activity-log.test.ts` flaky under parallel load.
  let stateRoot: string;

  const view = (overrides: Record<string, unknown> = {}) => ({
    id: TASK_ID,
    title: "Water the plants",
    done: false,
    created: "2026-09-14T09:00:00.000Z",
    updated: "2026-09-14T09:00:00.000Z",
    ...overrides,
  });

  const argsFor = (name: string): Record<string, unknown> => {
    if (name === "create_task") return { title: "Water the plants" };
    if (name === "promote_task_line") return { page: PAGE_ID, line: 0 };
    if (name === "update_task") return { id: TASK_ID, title: "Water them" };
    if (name === "delete_task") return { id: TASK_ID };
    return { id: TASK_ID, today: TODAY };
  };

  beforeEach(async () => {
    stateRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "brain-mcp-task-tools-"),
    );
    mocks.getStore.mockReset();
    mocks.readTimeZone.mockReset();
    mocks.readTimeZone.mockResolvedValue(null);
    mocks.verifyMcpBearerToken.mockReset();
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "test-machine-token",
      clientId: "legacy-client",
      scopes: ["brain:read", "brain:write"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    vi.stubEnv("MCP_TOKEN", "test-machine-token");
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-with-at-least-32-bytes");
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example.test");
    vi.stubEnv("BRAIN_MCP_STATE_DIR", stateRoot);
    vi.stubEnv("BRAIN_OAUTH_STATE_DIR", path.join(stateRoot, "oauth"));
  });

  afterEach(async () => {
    // The activity line is fire and forget, so a write a test triggered can
    // still be in flight when the next test's beforeEach points the state
    // directory somewhere else. Wait for it to land in this test's own
    // directory before that directory goes away.
    await flushTaskActivityForTests();
    vi.unstubAllEnvs();
    await fs.rm(stateRoot, { recursive: true, force: true });
  });

  it("creates an unlinked task and never a linked one", async () => {
    const createTask = vi.fn().mockResolvedValue(view());
    mocks.getStore.mockResolvedValue({ createTask });

    await toolPayload(
      await callTool(
        "create_task",
        { title: "Water the plants", when: TODAY, category: "home" },
        700,
      ),
    );

    expect(createTask).toHaveBeenCalledWith({
      title: "Water the plants",
      when: TODAY,
      category: "home",
      src: "claude",
    });
    // A linked task is made by promote_task_line and by nothing else.
    expect(createTask.mock.calls[0][0]).not.toHaveProperty("page");
    expect(createTask.mock.calls[0][0]).not.toHaveProperty("anchor");
  });

  it("passes time and evening through to the store", async () => {
    const createTask = vi.fn().mockResolvedValue(view());
    mocks.getStore.mockResolvedValue({ createTask });

    await toolPayload(
      await callTool(
        "create_task",
        { title: "Call the bank", when: TODAY, time: "14:30", evening: true },
        701,
      ),
    );

    expect(createTask).toHaveBeenCalledWith({
      title: "Call the bank",
      when: TODAY,
      time: "14:30",
      evening: true,
      src: "claude",
    });
  });

  it("takes a clock as HH:MM and never as the YAML integer", async () => {
    // `time: 905` is read back as 15:05 by the record's own preprocessor, and
    // that ambiguity is there to rescue a hand-edited file, not to be a value
    // an agent may send.
    const createTask = vi.fn();
    mocks.getStore.mockResolvedValue({ createTask });

    const response = await callTool(
      "create_task",
      { title: "Call the bank", when: TODAY, time: 905 },
      702,
    );

    expect(await response.text()).toContain("Invalid arguments");
    expect(createTask).not.toHaveBeenCalled();
  });

  it("hands back the store's own words when a clock has no day", async () => {
    const createTask = vi
      .fn()
      .mockRejectedValue(
        new TaskValidationError("time needs a day to be a time on"),
      );
    mocks.getStore.mockResolvedValue({ createTask });

    const { payload, isError } = await toolPayload(
      await callTool(
        "create_task",
        { title: "Call the bank", when: "someday", time: "14:30" },
        703,
      ),
    );

    expect(payload).toEqual({
      error: "that task change was refused",
      reason: "time needs a day to be a time on",
    });
    expect(isError).toBe(true);
  });

  it("keeps remindedAt and expectedWhen off update_task", async () => {
    // `remindedAt` is written by `markTaskReminded` alone, because a patch
    // clears it whenever the day or the clock moves. The way to stop a
    // reminder is to clear `time`. `expectedWhen` is a completion's check and
    // update_task carries no completion, so it would be inert here.
    const updateTask = vi.fn();
    mocks.getStore.mockResolvedValue({ updateTask });

    for (const [index, field] of [
      { remindedAt: "2026-09-14T09:00:00.000Z" },
      { expectedWhen: TODAY },
    ].entries()) {
      const response = await callTool(
        "update_task",
        { id: TASK_ID, ...field },
        704 + index,
      );
      expect(await response.text()).toContain("Invalid arguments");
    }
    expect(updateTask).not.toHaveBeenCalled();
  });

  it("clears a field with null, leaves an unnamed one alone, and refuses a false evening", async () => {
    const updateTask = vi.fn().mockResolvedValue(view());
    mocks.getStore.mockResolvedValue({ updateTask });

    await toolPayload(
      await callTool(
        "update_task",
        { id: TASK_ID, when: TODAY, time: null, evening: null },
        705,
      ),
    );
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, {
      when: TODAY,
      time: null,
      evening: null,
      src: "claude",
    });

    // `false` is a second spelling of the absence, and the record holds
    // `true` or nothing.
    const response = await callTool(
      "update_task",
      { id: TASK_ID, when: TODAY, evening: false },
      706,
    );
    expect(await response.text()).toContain("Invalid arguments");
    expect(updateTask).toHaveBeenCalledTimes(1);
  });

  it("builds the editor's anchor for a line number", async () => {
    const markdown = "# Notes\n\n- [ ] water the plants\n- [x] call the bank\n";
    const createTask = vi.fn().mockResolvedValue(view());
    mocks.getStore.mockResolvedValue({
      readPage: vi
        .fn()
        .mockResolvedValue({ meta: { id: PAGE_ID }, markdown, rev: "rev-1" }),
      pageTasks: vi.fn().mockReturnValue([]),
      createTask,
    });

    await toolPayload(
      await callTool("promote_task_line", { page: PAGE_ID, line: 2 }, 706),
    );

    // The exact object `components/editor/task-checkbox.ts:1217-1234` builds.
    const lines = parseTaskLines(markdown);
    expect(createTask).toHaveBeenCalledWith({
      title: lines[0].normalized,
      page: PAGE_ID,
      anchor: {
        text: lines[0].normalized,
        hash: lines[0].hash,
        ordinal: lines[0].ordinal,
        line: lines[0].index,
      },
      src: "claude",
    });
  });

  it("inherits the note's category, and yields to one the caller names", async () => {
    const markdown = "- [ ] water the plants\n";
    const createTask = vi.fn().mockResolvedValue(view());
    mocks.getStore.mockResolvedValue({
      readPage: vi.fn().mockResolvedValue({
        meta: { id: PAGE_ID, category: "home" },
        markdown,
        rev: "rev-1",
      }),
      pageTasks: vi.fn().mockReturnValue([]),
      createTask,
    });

    await toolPayload(
      await callTool("promote_task_line", { page: PAGE_ID, line: 0 }, 707),
    );
    expect(createTask.mock.calls[0][0].category).toBe("home");

    await toolPayload(
      await callTool(
        "promote_task_line",
        { page: PAGE_ID, line: 0, category: "errands", when: TODAY },
        708,
      ),
    );
    expect(createTask.mock.calls[1][0]).toMatchObject({
      category: "errands",
      when: TODAY,
    });
  });

  it("finds the same line by its text, whitespace collapsed", async () => {
    const markdown = "- [ ] water  the   plants\n";
    const createTask = vi.fn().mockResolvedValue(view());
    mocks.getStore.mockResolvedValue({
      readPage: vi
        .fn()
        .mockResolvedValue({ meta: { id: PAGE_ID }, markdown, rev: "rev-1" }),
      pageTasks: vi.fn().mockReturnValue([]),
      createTask,
    });

    await toolPayload(
      await callTool(
        "promote_task_line",
        { page: PAGE_ID, line: "water the plants" },
        709,
      ),
    );

    const lines = parseTaskLines(markdown);
    expect(createTask.mock.calls[0][0].anchor).toEqual({
      text: lines[0].normalized,
      hash: lines[0].hash,
      ordinal: 0,
      line: 0,
    });
  });

  it("refuses a line that is not a checkbox", async () => {
    const createTask = vi.fn();
    mocks.getStore.mockResolvedValue({
      readPage: vi.fn().mockResolvedValue({
        meta: { id: PAGE_ID },
        markdown: "only a paragraph\n",
        rev: "rev-1",
      }),
      pageTasks: vi.fn().mockReturnValue([]),
      createTask,
    });

    const { payload } = await toolPayload(
      await callTool("promote_task_line", { page: PAGE_ID, line: 0 }, 710),
    );

    expect(payload).toEqual({
      error: "that line is not a checkbox",
      reason: "line 0",
    });
    expect(createTask).not.toHaveBeenCalled();

    // The line's own text is a line of somebody's note, so it is bounded on
    // the way in and bounded again on the way back out: the refusal used to
    // echo whatever string arrived, whole.
    const long = await toolPayload(
      await callTool(
        "promote_task_line",
        { page: PAGE_ID, line: "n".repeat(400) },
        711,
      ),
    );
    expect(long.payload.reason).toHaveLength(80);

    const enormous = await callTool(
      "promote_task_line",
      { page: PAGE_ID, line: "n".repeat(5000) },
      712,
    );
    expect(await enormous.text()).toContain("Invalid arguments");
  });

  it("refuses a line that already has a record", async () => {
    const createTask = vi.fn();
    mocks.getStore.mockResolvedValue({
      readPage: vi.fn().mockResolvedValue({
        meta: { id: PAGE_ID },
        markdown: "- [ ] water the plants\n",
        rev: "rev-1",
      }),
      pageTasks: vi.fn().mockReturnValue([
        view({
          id: "task-beta",
          page: PAGE_ID,
          anchor: {
            text: "water the plants",
            hash: hashTaskText("water the plants"),
            ordinal: 0,
            line: 0,
          },
        }),
      ]),
      createTask,
    });

    const { payload } = await toolPayload(
      await callTool("promote_task_line", { page: PAGE_ID, line: 0 }, 711),
    );

    expect(payload).toEqual({
      error: "that line already has a task",
      reason: "task-beta",
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("refuses a text that names two lines rather than guessing", async () => {
    const createTask = vi.fn();
    mocks.getStore.mockResolvedValue({
      readPage: vi.fn().mockResolvedValue({
        meta: { id: PAGE_ID },
        markdown: "- [ ] water the plants\n- [ ] water the plants\n",
        rev: "rev-1",
      }),
      pageTasks: vi.fn().mockReturnValue([]),
      createTask,
    });

    const { payload } = await toolPayload(
      await callTool(
        "promote_task_line",
        { page: PAGE_ID, line: "water the plants" },
        712,
      ),
    );

    expect(payload).toEqual({
      error: "that line appears more than once, pass its line number",
      reason: "lines 0, 1",
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("refuses an empty line", async () => {
    const createTask = vi.fn();
    mocks.getStore.mockResolvedValue({
      readPage: vi.fn().mockResolvedValue({
        meta: { id: PAGE_ID },
        markdown: "- [ ] <br />\n",
        rev: "rev-1",
      }),
      pageTasks: vi.fn().mockReturnValue([]),
      createTask,
    });

    const { payload } = await toolPayload(
      await callTool("promote_task_line", { page: PAGE_ID, line: 0 }, 713),
    );

    expect(payload).toEqual({
      error: "that line is empty",
      reason: "write the line first",
    });
    expect(createTask).not.toHaveBeenCalled();
  });

  it("maps the store's three error classes", async () => {
    mocks.getStore.mockResolvedValue({
      updateTask: vi
        .fn()
        .mockRejectedValue(new TaskValidationError("a repeat cannot be linked")),
    });
    const refused = await toolPayload(
      await callTool(
        "update_task",
        { id: TASK_ID, repeat: { freq: "daily" } },
        714,
      ),
    );
    expect(refused.payload).toEqual({
      error: "that task change was refused",
      reason: "a repeat cannot be linked",
    });
    expect(refused.isError).toBe(true);

    mocks.getStore.mockResolvedValue({
      getTask: vi.fn().mockReturnValue(view({ repeat: { freq: "daily" } })),
      updateTask: vi
        .fn()
        .mockRejectedValue(
          new TaskConflictError("the task has moved", "2026-09-20"),
        ),
    });
    const moved = await toolPayload(
      await callTool(
        "complete_task",
        { id: TASK_ID, today: TODAY, expectedWhen: TODAY },
        715,
      ),
    );
    expect(moved.payload).toEqual({
      error: "the task has moved",
      reason: "conflict",
      currentWhen: "2026-09-20",
    });
    expect(moved.isError).toBe(true);

    mocks.getStore.mockResolvedValue({
      deleteTask: vi.fn().mockRejectedValue(new NotFoundError("task-missing")),
    });
    const missing = await toolPayload(
      await callTool("delete_task", { id: "task-missing" }, 716),
    );
    expect(missing.payload).toEqual({
      error: "no task with that id",
      reason: "not_found",
    });
    expect(missing.isError).toBe(true);
  });

  /** THE DAY IS THE ANSWER'S, AND THE STORE'S ONLY WHERE THE STORE USES ONE.
   *
   *  `assertTodayUsage` takes `today` only on a repeating task's completion,
   *  because that is the one write computing the next occurrence off it, and
   *  refuses it everywhere else as a caller mistake. Both tools forwarded it
   *  always, so an ordinary task could not be completed through MCP at all and
   *  `reopen_task`, which never completes anything, could never succeed. */
  it("completes an ordinary task without handing the store a day it refuses", async () => {
    const updateTask = vi.fn().mockResolvedValue(view({ done: true }));
    mocks.getStore.mockResolvedValue({
      getTask: vi.fn().mockReturnValue(view()),
      updateTask,
    });

    const { payload, isError } = await toolPayload(
      await callTool(
        "complete_task",
        { id: TASK_ID, today: TODAY, offsetMinutes: 240 },
        717,
      ),
    );
    expect(isError).toBe(false);
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, {
      done: true,
      src: "claude",
    });
    // A COMPLETION STAYS WHERE IT WAS until the day changes, so the answer
    // says which list the record is in rather than leaving an agent to assume
    // it left one. That is what the caller's day is still taken for.
    expect(payload.list).toBe("logbook");

    const response = await callTool("complete_task", { id: TASK_ID }, 718);
    expect(await response.text()).toContain("Invalid arguments");
  });

  /** And the one write that does use it still gets it, with the `when` the
   *  caller was looking at beside it. */
  it("carries today and expectedWhen on a repeating task's completion", async () => {
    const repeating = view({ when: TODAY, repeat: { freq: "daily" } });
    const updateTask = vi.fn().mockResolvedValue(view({ when: "2026-09-15" }));
    mocks.getStore.mockResolvedValue({
      getTask: vi.fn().mockReturnValue(repeating),
      updateTask,
    });

    const { isError } = await toolPayload(
      await callTool(
        "complete_task",
        { id: TASK_ID, today: TODAY, expectedWhen: TODAY },
        721,
      ),
    );

    expect(isError).toBe(false);
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, {
      done: true,
      today: TODAY,
      expectedWhen: TODAY,
      src: "claude",
    });
  });

  it("reopens a task, repeating or not, without forwarding the day", async () => {
    const updateTask = vi.fn().mockResolvedValue(view({ when: TODAY }));
    const getTask = vi.fn().mockReturnValue(view());
    mocks.getStore.mockResolvedValue({ getTask, updateTask });

    const { payload, isError } = await toolPayload(
      await callTool("reopen_task", { id: TASK_ID, today: TODAY }, 719),
    );

    expect(isError).toBe(false);
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, {
      done: false,
      src: "claude",
    });
    expect(payload.list).toBe("today");

    // An untick never completes anything, so a repeating record makes no
    // difference to what the store is handed.
    getTask.mockReturnValue(view({ when: TODAY, repeat: { freq: "daily" } }));
    await toolPayload(
      await callTool("reopen_task", { id: TASK_ID, today: TODAY }, 722),
    );
    expect(updateTask).toHaveBeenLastCalledWith(TASK_ID, {
      done: false,
      src: "claude",
    });
  });

  /** A TIME THAT IS NOT A TIME IS A REFUSAL, NOT A TRANSPORT ERROR.
   *
   *  The `HH:MM` rule used to live in the tool's own zod schema, so `25:99`
   *  came back as JSON-RPC `-32602` with zod's words: an error with no
   *  `reason` to branch on, from an endpoint whose whole contract is that a
   *  refusal is an answer. The rule is the same rule, checked a step earlier. */
  it("refuses a time that is not HH:MM in the shape every refusal uses", async () => {
    const createTask = vi.fn();
    const updateTask = vi.fn();
    mocks.getStore.mockResolvedValue({
      getTask: vi.fn().mockReturnValue(view()),
      createTask,
      updateTask,
      readPage: vi.fn(),
      pageTasks: vi.fn().mockReturnValue([]),
    });

    for (const [name, args, id] of [
      ["create_task", { title: "Water the plants", when: TODAY, time: "25:99" }, 723],
      ["update_task", { id: TASK_ID, time: "1:00" }, 724],
      ["promote_task_line", { page: PAGE_ID, line: 0, time: "13:60" }, 725],
    ] as const) {
      const { payload, isError } = await toolPayload(await callTool(name, args, id));
      expect(isError, name).toBe(true);
      expect(payload, name).toEqual({
        error: "that time is not written as HH:MM",
        reason: "bad_time",
      });
    }
    expect(createTask).not.toHaveBeenCalled();
    expect(updateTask).not.toHaveBeenCalled();
    await flushTaskActivityForTests();
    const [entry] = await readMcpActivity(1);
    expect(entry).toMatchObject({ outcome: "bad_time" });

    // Clearing a time is still `null`, and a real one still goes through.
    await toolPayload(
      await callTool("update_task", { id: TASK_ID, time: null }, 726),
    );
    expect(updateTask).toHaveBeenCalledWith(TASK_ID, {
      time: null,
      src: "claude",
    });
  });

  it("deletes one task and answers ok", async () => {
    const deleteTask = vi.fn().mockResolvedValue(undefined);
    mocks.getStore.mockResolvedValue({ deleteTask });

    const { payload } = await toolPayload(
      await callTool("delete_task", { id: TASK_ID }, 720),
    );

    expect(payload).toEqual({ ok: true });
    expect(deleteTask).toHaveBeenCalledWith(TASK_ID, "claude");
  });

  it("answers every record on one page and takes none of the four beside it", async () => {
    const pageTasks = vi.fn().mockReturnValue([view({ page: PAGE_ID })]);
    const listTasks = vi.fn();
    mocks.getStore.mockResolvedValue({ pageTasks, listTasks });

    const { payload } = await toolPayload(
      await callTool("list_tasks", { page: PAGE_ID }, 721),
    );
    expect(payload.tasks).toHaveLength(1);
    expect(pageTasks).toHaveBeenCalledWith(PAGE_ID);
    expect(listTasks).not.toHaveBeenCalled();

    // The same four the HTTP route refuses beside `?page=`, with its own
    // reasons: a page lookup has to be complete, because the editor draws a
    // word on every task line whatever state its record is in.
    const beside: Array<[Record<string, unknown>, string]> = [
      [{ list: "today" }, "unexpected_list"],
      [{ today: TODAY }, "unexpected_today"],
      [{ offsetMinutes: 240 }, "unexpected_offset"],
      [{ category: "home" }, "unexpected_category"],
    ];
    for (const [index, [extra, reason]] of beside.entries()) {
      const both = await toolPayload(
        await callTool("list_tasks", { page: PAGE_ID, ...extra }, 722 + index),
      );
      expect(both.payload.reason).toBe(reason);
      expect(both.isError).toBe(true);
    }
  });

  it("refuses a bad id before the store", async () => {
    mocks.getStore.mockReset();

    const { payload } = await toolPayload(
      await callTool("delete_task", { id: "../escape" }, 726),
    );

    expect(payload).toEqual({
      error: "that task id is not valid",
      reason: "bad_id",
    });
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("refuses a bad page before the store, named the way list_tasks names it", async () => {
    // list_tasks answers `bad_page` for the same malformed id, and
    // promote_task_line used to answer `bad_id` for it: one mistake, one name.
    mocks.getStore.mockReset();

    const { payload } = await toolPayload(
      await callTool(
        "promote_task_line",
        { page: "../escape", line: 0 },
        740,
      ),
    );

    expect(payload).toEqual({
      error: "that page id is not valid",
      reason: "bad_page",
    });
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("writes one activity line per write, carrying ids and no title", async () => {
    const createTask = vi.fn().mockResolvedValue(view());
    mocks.getStore.mockResolvedValue({
      readPage: vi.fn().mockResolvedValue({
        meta: { id: PAGE_ID },
        markdown: "- [ ] water the plants\n",
        rev: "rev-1",
      }),
      pageTasks: vi.fn().mockReturnValue([]),
      createTask,
      deleteTask: vi.fn().mockRejectedValue(new NotFoundError("task-missing")),
    });

    // The append is fire and forget, and two calls' lines race unless a test
    // waits for the first to land before firing the second.
    await toolPayload(
      await callTool("promote_task_line", { page: PAGE_ID, line: 0 }, 727),
    );
    await flushTaskActivityForTests();
    await toolPayload(await callTool("delete_task", { id: "task-missing" }, 728));
    await flushTaskActivityForTests();

    const entries = await readMcpActivity(10);
    expect(entries).toHaveLength(2);
    // Newest first.
    expect(entries[0]).toMatchObject({
      tool: "delete_task",
      task: "task-missing",
      outcome: "not_found",
    });
    expect(entries[1]).toMatchObject({
      tool: "promote_task_line",
      task: TASK_ID,
      page: PAGE_ID,
      outcome: "ok",
    });
    expect(JSON.stringify(entries)).not.toContain("Water the plants");
    expect(JSON.stringify(entries)).not.toContain("water the plants");
  });

  /** A STORE FAILURE IS AN ANSWER, NOT A THROW.
   *
   *  A raw `fs` error left the tool as a transport error carrying its own
   *  message, which is a Node one naming the absolute path of the notes
   *  folder, and it escaped the catch that writes the line, so the owner's
   *  Connections log showed that the call had never happened. */
  it("answers a store failure with a code, no path, and one line", async () => {
    const full = Object.assign(
      new Error("ENOSPC: no space left on device, write '/notes/_tasks/task-alpha.md'"),
      { code: "ENOSPC" },
    );
    mocks.getStore.mockResolvedValue({
      createTask: vi.fn().mockRejectedValue(full),
    });

    const { payload, isError } = await toolPayload(
      await callTool("create_task", { title: "Water the plants" }, 745),
    );
    await flushTaskActivityForTests();

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "the notes folder could not answer",
      reason: "store_failed",
    });
    expect(JSON.stringify(payload)).not.toContain("/notes/");
    const [entry] = await readMcpActivity(1);
    expect(entry).toMatchObject({ tool: "create_task", outcome: "store_failed" });
  });

  it("carries the changed fields on update_task's activity line, joined when several", async () => {
    const updateTask = vi.fn().mockResolvedValue(view());
    mocks.getStore.mockResolvedValue({ updateTask });

    // Each write's line is fire and forget, so the two calls' lines race
    // unless a test waits for the first to land before firing the second.
    await toolPayload(
      await callTool("update_task", { id: TASK_ID, title: "Water them" }, 741),
    );
    await flushTaskActivityForTests();
    await toolPayload(
      await callTool(
        "update_task",
        { id: TASK_ID, when: TODAY, time: "14:30" },
        742,
      ),
    );
    await flushTaskActivityForTests();

    const entries = await readMcpActivity(2);
    expect(entries).toHaveLength(2);
    // Newest first: the second call's two fields, in the schema's own order.
    expect(entries[0]).toMatchObject({
      tool: "update_task",
      change: "when+time",
    });
    expect(entries[1]).toMatchObject({ tool: "update_task", change: "title" });
  });

  it("answers complete_task's list from the owner's zone, never a bare UTC 0", async () => {
    // A Dubai completion at 01:30 local is 21:30Z the day before. A bare UTC
    // 0 would read that instant as the day before and answer logbook for a
    // task the owner's own screen still shows in Today.
    mocks.readTimeZone.mockResolvedValue("Asia/Dubai");
    const updateTask = vi.fn().mockResolvedValue(
      view({ when: TODAY, done: true, doneAt: "2026-09-13T21:30:00.000Z" }),
    );
    mocks.getStore.mockResolvedValue({
      getTask: vi.fn().mockReturnValue(view({ when: TODAY })),
      updateTask,
    });

    const { payload } = await toolPayload(
      await callTool("complete_task", { id: TASK_ID, today: TODAY }, 743),
    );

    expect(payload.list).toBe("today");
  });

  it("answers the moved read refusals with isError, as the doc row promises", async () => {
    const badToday = await toolPayload(
      await callTool("list_tasks", { list: "today", today: "2026-9-1" }, 744),
    );
    expect(badToday.payload).toEqual({
      error: "that day is not written as YYYY-MM-DD",
      reason: "bad_today",
    });
    expect(badToday.isError).toBe(true);

    const badOffset = await toolPayload(
      await callTool("list_tasks", { list: "logbook", today: TODAY }, 745),
    );
    expect(badOffset.payload).toEqual({
      error: "the logbook needs the caller's own UTC offset",
      reason: "bad_offset",
    });
    expect(badOffset.isError).toBe(true);

    const badId = await toolPayload(
      await callTool("get_task", { id: "../escape" }, 746),
    );
    expect(badId.payload).toEqual({
      error: "that task id is not valid",
      reason: "bad_id",
    });
    expect(badId.isError).toBe(true);

    mocks.getStore.mockResolvedValue({
      getTask: vi.fn().mockReturnValue(null),
    });
    const notFound = await toolPayload(
      await callTool("get_task", { id: "task-missing" }, 747),
    );
    expect(notFound.payload).toEqual({
      error: "no task with that id",
      reason: "not_found",
    });
    expect(notFound.isError).toBe(true);

    mocks.getStore.mockResolvedValue({
      getTask: vi.fn().mockReturnValue(view({ page: PAGE_ID })),
      taskPageTrashed: vi.fn().mockReturnValue(true),
    });
    const trashed = await toolPayload(
      await callTool("get_task", { id: TASK_ID }, 748),
    );
    expect(trashed.payload).toEqual({
      error: "that task's page is in the trash",
      reason: "page_trashed",
    });
    expect(trashed.isError).toBe(true);
  });

  it("computes dayInZone's day and offset across DST, a half-hour zone and the antimeridian", () => {
    const cases: Array<[string, string, string, number]> = [
      // Berlin's spring-forward: the hour that does not exist splits one
      // instant from the next into two offsets a minute apart.
      ["Europe/Berlin", "2026-03-29T00:30:00.000Z", "2026-03-29", 60],
      ["Europe/Berlin", "2026-03-29T01:30:00.000Z", "2026-03-29", 120],
      // Berlin's fall-back: two different instants both read as local 02:30,
      // told apart only by their offset.
      ["Europe/Berlin", "2026-10-25T00:30:00.000Z", "2026-10-25", 120],
      ["Europe/Berlin", "2026-10-25T01:30:00.000Z", "2026-10-25", 60],
      // The Los Angeles local-midnight boundary, in both seasons.
      ["America/Los_Angeles", "2026-06-15T06:59:59.000Z", "2026-06-14", -420],
      ["America/Los_Angeles", "2026-06-15T07:00:00.000Z", "2026-06-15", -420],
      ["America/Los_Angeles", "2026-01-15T07:59:00.000Z", "2026-01-14", -480],
      ["America/Los_Angeles", "2026-01-15T08:00:00.000Z", "2026-01-15", -480],
      // A half-hour zone, and the far side of the date line at exactly
      // MAX_OFFSET_MINUTES.
      ["Asia/Kolkata", "2026-06-15T18:35:00.000Z", "2026-06-16", 330],
      ["Pacific/Kiritimati", "2026-06-15T10:00:00.000Z", "2026-06-16", 840],
    ];
    for (const [zone, instant, today, offsetMinutes] of cases) {
      expect(dayInZone(zone, new Date(instant))).toEqual({
        today,
        offsetMinutes,
      });
    }
  });

  it("answers null for a zone the platform cannot read", () => {
    expect(
      dayInZone("Not/AZone", new Date("2026-06-15T10:00:00.000Z")),
    ).toBeNull();
  });

  it.each(TASK_WRITE_TOOLS)(
    "refuses %s on a brain:read grant before the store",
    async (name) => {
      mocks.verifyMcpBearerToken.mockResolvedValue({
        token: "test-machine-token",
        clientId: "legacy-client",
        scopes: ["brain:read"],
        resource: new URL("https://brain.example.test/api/mcp"),
      });
      mocks.getStore.mockReset();

      const response = await callTool(name, argsFor(name), 729);

      expect(response.status).toBe(403);
      expect(response.headers.get("WWW-Authenticate")).toContain(
        'scope="brain:write"',
      );
      expect(mocks.getStore).not.toHaveBeenCalled();
    },
  );
});

/** Two accounts, one page each. Account A has a second page and account B does
 *  not, which is what makes a per-account `null` inside the combined cursor
 *  mean something: the exhausted account is not asked again. */
function twoAccountSearchFake() {
  const older = fakeThread({
    accountId: FAKE_ACCOUNT_ID,
    threadId: "thread-older",
    lastMessageAt: 1_000,
  });
  const newer = fakeThread({
    accountId: FAKE_ACCOUNT_ID_TWO,
    threadId: "thread-newer",
    lastMessageAt: 2_000,
  });
  return createMailClientFake({
    listAccounts: async () => ({
      apiVersion: 2,
      accounts: [
        fakeAccountV2(FAKE_ACCOUNT_ID),
        fakeAccountV2(FAKE_ACCOUNT_ID_TWO),
      ],
    }),
    searchThreads: async (input) => ({
      apiVersion: 1,
      mailboxId: input.mailboxId,
      scope: "headers_and_previews",
      items: input.accountId === FAKE_ACCOUNT_ID ? [older] : [newer],
      nextCursor: input.accountId === FAKE_ACCOUNT_ID ? "cursor-one" : null,
      availability: {
        status: "available",
        lastSuccessfulAt: 1,
        windowTruncated: false,
      },
      indexStatus: "ready",
      resultsTruncated: false,
    }),
  });
}

describe("the mail read tools", () => {
  beforeEach(() => {
    mocks.getStore.mockReset();
    mocks.createBrainMailClient.mockReset();
    mocks.verifyMcpBearerToken.mockReset();
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "test-machine-token",
      clientId: "legacy-client",
      scopes: ["brain:read", "brain:mail"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    vi.stubEnv("MCP_TOKEN", "test-machine-token");
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-with-at-least-32-bytes");
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example.test");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("reports canSend with a reason when the account cannot send from this host", async () => {
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        listAccountCapabilities: async () => ({
          apiVersion: 3,
          accounts: [
            fakeAccountV3(FAKE_ACCOUNT_ID, {
              providerKind: "imap",
              smtp: {
                hostname: "smtp.example.test",
                port: 587,
                tls: "starttls",
                username: "me",
              },
              capabilities: { send: false },
            }),
          ],
        }),
      }).client,
    );

    const { payload } = await toolPayload(
      await callTool("list_mail_accounts", {}, 200),
    );

    expect(payload.accounts).toEqual([
      {
        accountId: FAKE_ACCOUNT_ID,
        address: "me@example.test",
        displayName: "Me",
        provider: "imap",
        canSend: false,
        sendBlockedReason: "smtp_relay_unavailable",
      },
    ]);
  });

  it("names the two other reasons an account cannot send", async () => {
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        listAccountCapabilities: async () => ({
          apiVersion: 3,
          accounts: [
            fakeAccountV3(FAKE_ACCOUNT_ID, {
              providerKind: "imap",
              capabilities: { send: false },
            }),
            fakeAccountV3(FAKE_ACCOUNT_ID_TWO, {
              status: "reauth_required",
              capabilities: { send: false },
            }),
          ],
        }),
      }).client,
    );

    const { payload } = await toolPayload(
      await callTool("list_mail_accounts", {}, 209),
    );

    expect(
      payload.accounts.map(
        (account: { sendBlockedReason?: string }) => account.sendBlockedReason,
      ),
    ).toEqual(["smtp_not_configured", "account_reauth_required"]);
  });

  it("leaves sendBlockedReason off an account that can send", async () => {
    mocks.createBrainMailClient.mockReturnValue(createMailClientFake().client);

    const { payload } = await toolPayload(
      await callTool("list_mail_accounts", {}, 210),
    );

    expect(payload.accounts).toEqual([
      {
        accountId: FAKE_ACCOUNT_ID,
        address: "me@example.test",
        displayName: "Me",
        provider: "gmail",
        canSend: true,
      },
    ]);
  });

  it("names reconnection before a missing SMTP endpoint for an IMAP account that needs both", async () => {
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        listAccountCapabilities: async () => ({
          apiVersion: 3,
          accounts: [
            fakeAccountV3(FAKE_ACCOUNT_ID, {
              providerKind: "imap",
              status: "reauth_required",
              capabilities: { send: false },
            }),
          ],
        }),
      }).client,
    );

    const { payload } = await toolPayload(
      await callTool("list_mail_accounts", {}, 230),
    );

    expect(payload.accounts[0].sendBlockedReason).toBe(
      "account_reauth_required",
    );
  });

  it("caps limit at 50 and passes the mailbox through", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    await toolPayload(
      await callTool(
        "list_mail_threads",
        { accountId: FAKE_ACCOUNT_ID, mailbox: "sent", limit: 50 },
        201,
      ),
    );

    expect(fake.calls[0]).toEqual({
      method: "listMailboxThreads",
      args: [FAKE_ACCOUNT_ID, "sent", { cursor: null, limit: 50, view: null }],
    });
  });

  it("defaults the mailbox to inbox and the limit to 25", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    await toolPayload(
      await callTool("list_mail_threads", { accountId: FAKE_ACCOUNT_ID }, 211),
    );

    expect(fake.calls[0]).toEqual({
      method: "listMailboxThreads",
      args: [FAKE_ACCOUNT_ID, "inbox", { cursor: null, limit: 25, view: null }],
    });
  });

  it("refuses a limit above 50 before the client is touched", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const response = await callTool(
      "list_mail_threads",
      { accountId: FAKE_ACCOUNT_ID, limit: 51 },
      202,
    );

    expect(await response.text()).toContain("Invalid arguments");
    expect(fake.calls).toEqual([]);
  });

  it("refuses a malformed account id before the client is touched", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "list_mail_threads",
        { accountId: "../../etc/passwd" },
        231,
      ),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that account id is not valid",
      reason: "invalid_account_id",
    });
    expect(fake.calls).toEqual([]);
  });

  it("answers availability so an agent can tell an empty mailbox from one it cannot reach", async () => {
    const unavailable = {
      status: "unavailable" as const,
      reason: "mailbox_reauth_required" as const,
      lastSuccessfulAt: null,
      windowTruncated: null,
    };
    const fake = createMailClientFake({
      listMailboxThreads: async (_accountId, mailboxId) => ({
        apiVersion: 1,
        mailboxId,
        items: [],
        nextCursor: null,
        availability: unavailable,
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool("list_mail_threads", { accountId: FAKE_ACCOUNT_ID }, 232),
    );

    expect(payload.threads).toEqual([]);
    expect(payload.availability).toEqual(unavailable);
  });

  it("searches every account and merges by date behind one cursor", async () => {
    const fake = twoAccountSearchFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool("search_mail", { query: "invoice" }, 203),
    );

    expect(
      payload.threads.map((thread: { threadId: string }) => thread.threadId),
    ).toEqual(["thread-newer", "thread-older"]);
    expect(typeof payload.nextCursor).toBe("string");
    expect(payload.nextCursor).not.toContain("cursor-one");
  });

  it("hands a merged cursor back as the per-account cursors it came from", async () => {
    const fake = twoAccountSearchFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const first = await toolPayload(
      await callTool("search_mail", { query: "invoice" }, 204),
    );
    fake.calls.length = 0;
    await toolPayload(
      await callTool(
        "search_mail",
        { query: "invoice", cursor: first.payload.nextCursor },
        205,
      ),
    );

    expect(
      fake.calls
        .filter((call) => call.method === "searchThreads")
        .map((call) => call.args[0]),
    ).toEqual([
      {
        accountId: FAKE_ACCOUNT_ID,
        mailboxId: "inbox",
        query: "invoice",
        cursor: "cursor-one",
        limit: 25,
      },
    ]);
  });

  it("refuses a cursor that names an account the caller no longer has", async () => {
    const fake = twoAccountSearchFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);
    const stale = Buffer.from(
      JSON.stringify({ v: 1, per: { "account-gone": "cursor-one" } }),
    ).toString("base64url");

    const { payload, isError } = await toolPayload(
      await callTool("search_mail", { query: "invoice", cursor: stale }, 212),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that cursor is not usable any more",
      reason: "stale_cursor",
    });
  });

  it("passes the service's own cursor through when one account is named", async () => {
    const fake = twoAccountSearchFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "search_mail",
        { query: "invoice", accountId: FAKE_ACCOUNT_ID, mailbox: "all" },
        213,
      ),
    );

    expect(payload.nextCursor).toBe("cursor-one");
    expect(fake.calls).toEqual([
      {
        method: "searchThreads",
        args: [
          {
            accountId: FAKE_ACCOUNT_ID,
            mailboxId: "all",
            query: "invoice",
            cursor: null,
            limit: 25,
          },
        ],
      },
    ]);
  });

  it("answers indexStatus so an agent can tell an empty search from one still indexing", async () => {
    const fake = createMailClientFake({
      searchThreads: async (input) => ({
        apiVersion: 1,
        mailboxId: input.mailboxId,
        scope: "headers_and_previews",
        items: [],
        nextCursor: null,
        availability: {
          status: "available",
          lastSuccessfulAt: 1,
          windowTruncated: false,
        },
        indexStatus: "building",
        resultsTruncated: false,
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "search_mail",
        { query: "invoice", accountId: FAKE_ACCOUNT_ID },
        233,
      ),
    );

    expect(payload.threads).toEqual([]);
    expect(payload.indexStatus).toBe("building");
  });

  it("keeps the other accounts' results when one account fails during a merged search", async () => {
    const alive = fakeThread({
      accountId: FAKE_ACCOUNT_ID_TWO,
      threadId: "thread-alive",
      lastMessageAt: 2_000,
    });
    const alivePage = {
      apiVersion: 1 as const,
      mailboxId: "inbox" as const,
      scope: "headers_and_previews" as const,
      items: [alive],
      nextCursor: null,
      availability: {
        status: "available" as const,
        lastSuccessfulAt: 1,
        windowTruncated: false,
      },
      indexStatus: "ready" as const,
      resultsTruncated: false,
    };
    const fake = createMailClientFake({
      listAccounts: async () => ({
        apiVersion: 2,
        accounts: [
          fakeAccountV2(FAKE_ACCOUNT_ID),
          fakeAccountV2(FAKE_ACCOUNT_ID_TWO),
        ],
      }),
      searchThreads: async (input) => {
        if (input.accountId === FAKE_ACCOUNT_ID) {
          throw new BrainMailClientError(409, "mail_account_reauth_required");
        }
        return alivePage;
      },
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool("search_mail", { query: "invoice" }, 234),
    );

    expect(
      payload.threads.map((thread: { threadId: string }) => thread.threadId),
    ).toEqual(["thread-alive"]);
    expect(payload.accounts).toEqual([
      {
        accountId: FAKE_ACCOUNT_ID,
        error: "this account needs to be reconnected",
        reason: "mail_account_reauth_required",
      },
      {
        accountId: FAKE_ACCOUNT_ID_TWO,
        availability: alivePage.availability,
        indexStatus: "ready",
        resultsTruncated: false,
      },
    ]);
    expect(
      fake.calls.filter((call) => call.method === "searchThreads"),
    ).toHaveLength(2);
  });

  it("refuses a malformed account id before the client is touched", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "search_mail",
        { query: "invoice", accountId: "../../etc/passwd" },
        235,
      ),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that account id is not valid",
      reason: "invalid_account_id",
    });
    expect(fake.calls).toEqual([]);
  });

  it("refuses a search query that is empty or too long before the client is touched", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool("search_mail", { query: "a".repeat(300) }, 236),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that search query is empty or too long",
      reason: "invalid_query",
    });
    expect(fake.calls).toEqual([]);
  });

  it("answers a thread's messages without their html", async () => {
    const fake = createMailClientFake({
      getThread: async () => ({
        apiVersion: 1,
        thread: fakeThread(),
        messages: [
          fakeMessage({
            textBody: "the plain words",
            htmlBody: "<b>the marked up words</b>",
            hasAttachments: true,
          }),
          fakeMessage({ messageId: "message-beta", textBody: null }),
        ],
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "get_mail_thread",
        { accountId: FAKE_ACCOUNT_ID, threadId: "thread-alpha" },
        214,
      ),
    );

    expect(JSON.stringify(payload)).not.toContain("marked up");
    expect(payload.messages).toEqual([
      {
        messageId: "message-alpha",
        from: { name: "Me", address: "me@example.test" },
        to: [],
        cc: [],
        subject: "the subject",
        sentAt: 0,
        unread: false,
        snippet: "the snippet",
        hasAttachments: true,
        bodyCached: true,
      },
      {
        messageId: "message-beta",
        from: { name: "Me", address: "me@example.test" },
        to: [],
        cc: [],
        subject: "the subject",
        sentAt: 0,
        unread: false,
        snippet: "the snippet",
        hasAttachments: false,
        bodyCached: false,
      },
    ]);
    expect(payload.thread.threadId).toBe("thread-alpha");
  });

  it("refuses a malformed thread id before the client is touched", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "get_mail_thread",
        { accountId: FAKE_ACCOUNT_ID, threadId: "../../etc/passwd" },
        237,
      ),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that thread id is not valid",
      reason: "invalid_thread_id",
    });
    expect(fake.calls).toEqual([]);
  });

  it("demands the body, polls, and never answers HTML", async () => {
    let polls = 0;
    const fake = createMailClientFake({
      requestMessageContent: async () => ({
        apiVersion: 1,
        accountId: FAKE_ACCOUNT_ID,
        messageId: "message-alpha",
        state: "fetching",
      }),
      getMessageContent: async () => {
        polls += 1;
        if (polls < 2) {
          return {
            apiVersion: 1,
            accountId: FAKE_ACCOUNT_ID,
            messageId: "message-alpha",
            state: "fetching",
          };
        }
        return {
          apiVersion: 1,
          accountId: FAKE_ACCOUNT_ID,
          messageId: "message-alpha",
          state: "ready",
          textBody: "the plain words",
          htmlBody: "<b>the marked up words</b>",
          attachments: [
            {
              attachmentId: "attachment-alpha",
              filename: "invoice.pdf",
              mimeType: "application/pdf",
              disposition: "attachment",
              contentId: null,
              bytes: 1024,
            },
          ],
        };
      },
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "read_mail_message",
        { accountId: FAKE_ACCOUNT_ID, messageId: "message-alpha", wait: 2000 },
        206,
      ),
    );

    expect(payload.state).toBe("ready");
    expect(payload.text).toBe("the plain words");
    expect(payload).not.toHaveProperty("html");
    expect(JSON.stringify(payload)).not.toContain("marked up");
    expect(payload.attachments).toEqual([
      {
        attachmentId: "attachment-alpha",
        filename: "invoice.pdf",
        mimeType: "application/pdf",
        bytes: 1024,
      },
    ]);
    expect(fake.calls[0].method).toBe("requestMessageContent");
  });

  it("answers state fetching rather than hanging when the wait runs out", async () => {
    const fake = createMailClientFake({
      requestMessageContent: async () => ({
        apiVersion: 1,
        accountId: FAKE_ACCOUNT_ID,
        messageId: "message-alpha",
        state: "fetching",
      }),
      getMessageContent: async () => ({
        apiVersion: 1,
        accountId: FAKE_ACCOUNT_ID,
        messageId: "message-alpha",
        state: "fetching",
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "read_mail_message",
        { accountId: FAKE_ACCOUNT_ID, messageId: "message-alpha", wait: 0 },
        207,
      ),
    );

    expect(payload).toEqual({ state: "fetching", attachments: [] });
  });

  it("derives text from the sanitized HTML when a message has no plain part", async () => {
    const fake = createMailClientFake({
      requestMessageContent: async () => ({
        apiVersion: 1,
        accountId: FAKE_ACCOUNT_ID,
        messageId: "message-alpha",
        state: "ready",
        textBody: null,
        htmlBody: "<p>Hello there</p><p>Second line</p>",
        attachments: [],
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "read_mail_message",
        { accountId: FAKE_ACCOUNT_ID, messageId: "message-alpha" },
        238,
      ),
    );

    expect(payload.state).toBe("ready");
    expect(payload.text).toBe("Hello there\nSecond line");
    expect(JSON.stringify(payload)).not.toContain("<p>");
  });

  it("refuses a malformed message id before the client is touched", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "read_mail_message",
        { accountId: FAKE_ACCOUNT_ID, messageId: "../../etc/passwd" },
        239,
      ),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that message id is not valid",
      reason: "invalid_message_id",
    });
    expect(fake.calls).toEqual([]);
  });

  it("refuses a wait above the cap before the client is touched", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const response = await callTool(
      "read_mail_message",
      { accountId: FAKE_ACCOUNT_ID, messageId: "message-alpha", wait: 20001 },
      240,
    );

    expect(await response.text()).toContain("Invalid arguments");
    expect(fake.calls).toEqual([]);
  });

  it("hands the service's own code over as a reason, and never its wording", async () => {
    const fake = createMailClientFake({
      getThread: async () => {
        throw new BrainMailClientError(404, "mail_thread_not_found");
      },
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "get_mail_thread",
        { accountId: FAKE_ACCOUNT_ID, threadId: "thread-alpha" },
        215,
      ),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "thread not found",
      reason: "mail_thread_not_found",
    });
  });

  it("answers one refusal when the service is down, leaking nothing of the failure", async () => {
    mocks.createBrainMailClient.mockImplementation(() => {
      throw new Error("connect ENOENT /run/brain-mail/brain-mail.sock");
    });

    const { payload, isError } = await toolPayload(
      await callTool("list_mail_accounts", {}, 216),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "the mail service is unavailable",
      reason: "mail_service_unavailable",
    });
    expect(JSON.stringify(payload)).not.toContain("ENOENT");
  });

  it.each([
    ["list_mail_accounts", {}],
    ["list_mail_threads", { accountId: FAKE_ACCOUNT_ID }],
    ["search_mail", { query: "invoice" }],
    [
      "get_mail_thread",
      { accountId: FAKE_ACCOUNT_ID, threadId: "thread-alpha" },
    ],
    [
      "read_mail_message",
      { accountId: FAKE_ACCOUNT_ID, messageId: "message-alpha" },
    ],
  ] as const)(
    "refuses %s on a brain:read grant before the client is touched",
    async (name, args) => {
      mocks.verifyMcpBearerToken.mockResolvedValue({
        token: "read-only-token",
        clientId: "read-only-client",
        scopes: ["brain:read"],
        resource: new URL("https://brain.example.test/api/mcp"),
      });
      const fake = createMailClientFake();
      mocks.createBrainMailClient.mockReturnValue(fake.client);

      const response = await callTool(name, args, 208);

      expect(response.status).toBe(403);
      expect(response.headers.get("WWW-Authenticate")).toContain(
        'scope="brain:mail"',
      );
      expect(fake.calls).toEqual([]);
    },
  );
});

describe("save_mail_attachment", () => {
  let stateRoot: string;

  /** Nine bytes a PDF reader would accept, because the note store checks the
   *  first bytes against the type they claim and a fixture of letters would
   *  be refused for a reason this suite is not about. */
  const PDF_BYTES = new Uint8Array([
    0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a,
  ]);

  /** The page the line is going on. The tool reads it before it asks the mail
   *  service for a byte, so every store stand-in here answers one. */
  const readsPageOne = () =>
    vi.fn().mockResolvedValue({
      meta: { id: "page-one" },
      markdown: "a page",
      rev: "rev-1",
    });

  function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  /** A stream that keeps going past whatever the service declared, and counts
   *  what it handed over, so a test can say where the drain stopped. The
   *  chunks are views on one buffer: the point is the count, not the bytes. */
  function streamOfChunks(total: number) {
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const served = { bytes: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (served.bytes >= total) {
          controller.close();
          return;
        }
        const size = Math.min(chunk.byteLength, total - served.bytes);
        served.bytes += size;
        controller.enqueue(chunk.subarray(0, size));
      },
    });
    return { body, served };
  }

  beforeEach(async () => {
    stateRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "brain-mcp-attachment-"),
    );
    mocks.getStore.mockReset();
    mocks.createBrainMailClient.mockReset();
    mocks.verifyMcpBearerToken.mockReset();
    // The legacy bearer's own client id, so `clientNameOf` answers without
    // reaching the OAuth state store for a name no test wrote there. The
    // grant holds both scopes the tool needs: saving a file into a note is a
    // mail read and a note write in one call.
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "test-machine-token",
      clientId: "brain-legacy-bearer",
      scopes: ["brain:read", "brain:mail", "brain:write"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    vi.stubEnv("MCP_TOKEN", "test-machine-token");
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-with-at-least-32-bytes");
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example.test");
    vi.stubEnv("BRAIN_MCP_STATE_DIR", stateRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(stateRoot, { recursive: true, force: true });
  });

  it("streams the attachment into the store and appends a link for a document", async () => {
    const saveAttachment = vi.fn().mockResolvedValue({
      url: "/_attachments-v2/aaaa.pdf",
      name: "invoice.pdf",
      size: 9,
      type: "application/pdf",
    });
    const appendPage = vi.fn().mockResolvedValue({ meta: { id: "page-one" } });
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment,
      appendPage,
    });
    const fake = createMailClientFake({
      downloadAttachment: async () => ({
        contentType: "application/pdf",
        contentDisposition: 'attachment; filename="invoice.pdf"',
        bytes: PDF_BYTES.byteLength,
        body: streamOf(PDF_BYTES),
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          page: "page-one",
        },
        500,
      ),
    );

    expect(payload).toEqual({
      url: "/_attachments-v2/aaaa.pdf",
      name: "invoice.pdf",
      size: 9,
      type: "application/pdf",
    });
    expect(fake.calls).toEqual([
      {
        method: "downloadAttachment",
        args: [FAKE_ACCOUNT_ID, "attachment-alpha"],
      },
    ]);
    expect(saveAttachment).toHaveBeenCalledWith(
      {
        data: PDF_BYTES,
        originalName: "invoice.pdf",
        mimeType: "application/pdf",
      },
      "claude",
    );
    expect(appendPage).toHaveBeenCalledWith(
      "page-one",
      "[invoice.pdf](/_attachments-v2/aaaa.pdf)",
      "claude",
    );
  });

  it("appends an image embed for an image", async () => {
    const appendPage = vi.fn().mockResolvedValue({ meta: { id: "page-one" } });
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment: vi.fn().mockResolvedValue({
        url: "/_attachments-v2/bbbb.png",
        name: "shot.png",
        size: 8,
        type: "image/png",
      }),
      appendPage,
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => ({
          contentType: "image/png",
          contentDisposition: 'attachment; filename="shot.png"',
          bytes: 8,
          body: streamOf(
            new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
          ),
        }),
      }).client,
    );

    await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-beta",
          page: "page-one",
        },
        501,
      ),
    );

    expect(appendPage).toHaveBeenCalledWith(
      "page-one",
      "![shot.png](/_attachments-v2/bbbb.png)",
      "claude",
    );
  });

  it("escapes a filename that would otherwise close the link early", async () => {
    const appendPage = vi.fn().mockResolvedValue({ meta: { id: "page-one" } });
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment: vi.fn().mockResolvedValue({
        url: "/_attachments-v2/cccc.pdf",
        // The sender names the file, so the label is somebody else's prose.
        name: "note](https://example.net/phish) bill.pdf",
        size: 9,
        type: "application/pdf",
      }),
      appendPage,
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => ({
          contentType: "application/pdf",
          contentDisposition: "attachment",
          bytes: PDF_BYTES.byteLength,
          body: streamOf(PDF_BYTES),
        }),
      }).client,
    );

    await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-gamma",
          page: "page-one",
        },
        502,
      ),
    );

    expect(appendPage).toHaveBeenCalledWith(
      "page-one",
      "[note\\](https://example.net/phish) bill.pdf](/_attachments-v2/cccc.pdf)",
      "claude",
    );
  });

  it("writes no line when append is false", async () => {
    const saveAttachment = vi.fn().mockResolvedValue({
      url: "/_attachments-v2/dddd.pdf",
      name: "invoice.pdf",
      size: 9,
      type: "application/pdf",
    });
    const appendPage = vi.fn();
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment,
      appendPage,
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => ({
          contentType: "application/pdf",
          contentDisposition: 'attachment; filename="invoice.pdf"',
          bytes: PDF_BYTES.byteLength,
          body: streamOf(PDF_BYTES),
        }),
      }).client,
    );

    const { payload } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          page: "page-one",
          append: false,
        },
        503,
      ),
    );

    expect(appendPage).not.toHaveBeenCalled();
    expect(saveAttachment).toHaveBeenCalledOnce();
    expect(payload.url).toBe("/_attachments-v2/dddd.pdf");
  });

  it("hands back the note store's own reason when it refuses the file", async () => {
    // The shape the store throws: its own name, its own code, its own
    // sentence. Built here rather than imported because the class the module
    // mock exports is a stand-in, and the predicate reads the name.
    const blocked = Object.assign(
      new Error("active attachment MIME type is blocked: text/html"),
      { name: "AttachmentValidationError", code: "blocked_mime" },
    );
    const appendPage = vi.fn();
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment: vi.fn().mockRejectedValue(blocked),
      appendPage,
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => ({
          contentType: "text/html",
          contentDisposition: 'attachment; filename="page.html"',
          bytes: 6,
          body: streamOf(new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e])),
        }),
      }).client,
    );

    const { payload, isError } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-delta",
          page: "page-one",
        },
        504,
      ),
    );

    expect(payload).toEqual({
      error: "active attachment MIME type is blocked: text/html",
      reason: "blocked_mime",
    });
    expect(isError).toBe(true);
    expect(appendPage).not.toHaveBeenCalled();
    const [entry] = await readMcpActivity(1);
    expect(entry).toMatchObject({ outcome: "blocked_mime" });
  });

  /** `getStore()` ITSELF CAN FAIL, BEFORE ANY PAGE OR ATTACHMENT WORK STARTS.
   *
   *  It sat outside every try, so a store that would not even start answered
   *  the agent the raw Node message and wrote no line at all, the exact pair
   *  of defects the store failures above are guarded against. */
  it("answers a failed getStore() with a code, no path, and one line", async () => {
    mocks.getStore.mockRejectedValue(
      Object.assign(
        new Error("EACCES: permission denied, open '/notes/.brain/journal'"),
        { code: "EACCES" },
      ),
    );

    const { payload, isError } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-eta",
          page: "page-one",
        },
        506,
      ),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "the notes folder could not answer",
      reason: "store_failed",
    });
    expect(JSON.stringify(payload)).not.toContain("/notes/");
    const [entry] = await readMcpActivity(1);
    expect(entry).toMatchObject({ outcome: "store_failed" });
  });

  /** The store's own refusals are answered in the store's words. Everything
   *  else it can throw is a Node `fs` error carrying the absolute path of the
   *  notes folder, and it used to leave as a transport error with that message
   *  and no line behind it. */
  it("answers a failed save with a code, no path, and one line", async () => {
    const full = Object.assign(
      new Error("ENOSPC: no space left on device, write '/notes/_attachments-v2/aaaa.pdf'"),
      { code: "ENOSPC" },
    );
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment: vi.fn().mockRejectedValue(full),
      appendPage: vi.fn(),
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => ({
          contentType: "application/pdf",
          contentDisposition: 'attachment; filename="invoice.pdf"',
          bytes: PDF_BYTES.byteLength,
          body: streamOf(PDF_BYTES),
        }),
      }).client,
    );

    const { payload, isError } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-epsilon",
          page: "page-one",
        },
        505,
      ),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that file could not be saved",
      reason: "store_failed",
    });
    expect(JSON.stringify(payload)).not.toContain("/notes/");
    const [entry] = await readMcpActivity(1);
    expect(entry).toMatchObject({ outcome: "store_failed" });
  });

  /** The same for the line: the file is already in the notes folder by then,
   *  so the answer says that much and names no path. */
  it("answers a failed append with a code, no path, and one line", async () => {
    const full = Object.assign(
      new Error("EIO: i/o error, write '/notes/page-one.md'"),
      { code: "EIO" },
    );
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment: vi.fn().mockResolvedValue({
        url: "/_attachments-v2/aaaa.pdf",
        name: "invoice.pdf",
        size: PDF_BYTES.byteLength,
        type: "application/pdf",
      }),
      appendPage: vi.fn().mockRejectedValue(full),
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => ({
          contentType: "application/pdf",
          contentDisposition: 'attachment; filename="invoice.pdf"',
          bytes: PDF_BYTES.byteLength,
          body: streamOf(PDF_BYTES),
        }),
      }).client,
    );

    const { payload, isError } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-zeta",
          page: "page-one",
        },
        506,
      ),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that file was saved and no line could be added",
      reason: "store_failed",
    });
    expect(JSON.stringify(payload)).not.toContain("/notes/");
    const [entry] = await readMcpActivity(1);
    expect(entry).toMatchObject({ outcome: "store_failed" });
  });

  it("refuses a declared size over the note cap without reading a byte", async () => {
    const saveAttachment = vi.fn();
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment,
      appendPage: vi.fn(),
    });
    let cancelled = false;
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => ({
          contentType: "application/octet-stream",
          contentDisposition: 'attachment; filename="big.bin"',
          bytes: MAX_ATTACHMENT_BYTES + 1,
          // Nothing may read this one. The declared size is over the cap and
          // the pre-check answers off that number alone, so a read is a
          // failure: with `highWaterMark` 0 the stream pulls only when asked,
          // and a pull that throws makes the drain answer the service's own
          // outage code instead of this refusal.
          body: new ReadableStream<Uint8Array>(
            {
              pull() {
                throw new Error("the declared size should have refused this");
              },
              cancel() {
                cancelled = true;
              },
            },
            { highWaterMark: 0 },
          ),
        }),
      }).client,
    );

    const { payload } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-big",
          page: "page-one",
        },
        505,
      ),
    );

    expect(payload).toEqual({
      error: "that file is too large for a note",
      reason: "25 MiB is the limit",
    });
    // The service's stream is let go rather than left hanging on a socket.
    expect(cancelled).toBe(true);
    expect(saveAttachment).not.toHaveBeenCalled();
  });

  it("stops draining at the note cap when the stream outruns what it declared", async () => {
    const saveAttachment = vi.fn();
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment,
      appendPage: vi.fn(),
    });
    const long = streamOfChunks(MAX_ATTACHMENT_BYTES * 2);
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => ({
          contentType: "application/octet-stream",
          contentDisposition: 'attachment; filename="big.bin"',
          bytes: 9,
          body: long.body,
        }),
      }).client,
    );

    const { payload } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-big",
          page: "page-one",
        },
        506,
      ),
    );

    expect(payload).toEqual({
      error: "that file is too large for a note",
      reason: "25 MiB is the limit",
    });
    // One chunk past the cap is what it takes to know the cap was passed, and
    // one more is the stream's own read-ahead: it fills its queue before the
    // drain asks for anything.
    expect(long.served.bytes).toBeLessThanOrEqual(
      MAX_ATTACHMENT_BYTES + 2 * 64 * 1024,
    );
    expect(saveAttachment).not.toHaveBeenCalled();
  });

  it("names the file from the disposition, and falls back when there is none", async () => {
    const saveAttachment = vi.fn().mockResolvedValue({
      url: "/_attachments-v2/eeee.pdf",
      name: "facade.pdf",
      size: 9,
      type: "application/pdf",
    });
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment,
      appendPage: vi.fn().mockResolvedValue({ meta: { id: "page-one" } }),
    });
    const download = (contentDisposition: string) => ({
      contentType: "application/pdf",
      contentDisposition,
      bytes: PDF_BYTES.byteLength,
      body: streamOf(PDF_BYTES),
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        // The download path emits both forms, the extended one last, for a
        // name that does not fit in a quoted ASCII string.
        downloadAttachment: async () =>
          download(
            "attachment; filename=\"facade.pdf\"; filename*=UTF-8''fa%C3%A7ade.pdf",
          ),
      }).client,
    );

    // The answer is read every time: the handler finishes the call while the
    // body is consumed, so a test that ignores it asserts on a tool that has
    // not run yet.
    await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          page: "page-one",
        },
        507,
      ),
    );

    expect(saveAttachment.mock.calls[0][0].originalName).toBe("façade.pdf");

    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => download("attachment"),
      }).client,
    );

    await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          page: "page-one",
        },
        508,
      ),
    );

    expect(saveAttachment.mock.calls[1][0].originalName).toBe("attachment");
  });

  it("logs one line naming the page and the attachment, and no filename", async () => {
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment: vi.fn().mockResolvedValue({
        url: "/_attachments-v2/aaaa.pdf",
        name: "invoice.pdf",
        size: 9,
        type: "application/pdf",
      }),
      appendPage: vi.fn().mockResolvedValue({ meta: { id: "page-one" } }),
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => ({
          contentType: "application/pdf",
          contentDisposition: 'attachment; filename="invoice.pdf"',
          bytes: PDF_BYTES.byteLength,
          body: streamOf(PDF_BYTES),
        }),
      }).client,
    );

    await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          page: "page-one",
        },
        509,
      ),
    );

    const entries = await readMcpActivity(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tool: "save_mail_attachment",
      client: "Legacy token",
      accountId: FAKE_ACCOUNT_ID,
      attachmentId: "attachment-alpha",
      page: "page-one",
      outcome: "ok",
    });
    expect(JSON.stringify(entries[0])).not.toContain("invoice");
  });

  it("says the file landed and the line did not when the page is gone", async () => {
    const appendPage = vi
      .fn()
      .mockRejectedValue(new NotFoundError("page-gone"));
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment: vi.fn().mockResolvedValue({
        url: "/_attachments-v2/ffff.pdf",
        name: "invoice.pdf",
        size: 9,
        type: "application/pdf",
      }),
      appendPage,
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => ({
          contentType: "application/pdf",
          contentDisposition: 'attachment; filename="invoice.pdf"',
          bytes: PDF_BYTES.byteLength,
          body: streamOf(PDF_BYTES),
        }),
      }).client,
    );

    const { payload, isError } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          page: "page-gone",
        },
        510,
      ),
    );

    expect(payload).toEqual({
      error:
        "page not found, the file is saved at /_attachments-v2/ffff.pdf and no line was added",
      reason: "page_not_found",
    });
    expect(isError).toBe(true);
    const [entry] = await readMcpActivity(1);
    expect(entry).toMatchObject({ page: "page-gone", outcome: "not_found" });
  });

  it("hands back the service's own reason when the download fails", async () => {
    const saveAttachment = vi.fn();
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment,
      appendPage: vi.fn(),
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => {
          throw new BrainMailClientError(503, "mail_service_unavailable");
        },
      }).client,
    );

    const { payload, isError } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          page: "page-one",
        },
        511,
      ),
    );

    expect(payload).toEqual({
      error: "the mail service is unavailable",
      reason: "mail_service_unavailable",
    });
    expect(isError).toBe(true);
    expect(saveAttachment).not.toHaveBeenCalled();
    const [entry] = await readMcpActivity(1);
    expect(entry).toMatchObject({ outcome: "mail_service_unavailable" });
  });

  it("refuses a page it cannot read before a byte is downloaded", async () => {
    const readPage = vi.fn().mockRejectedValue(new NotFoundError("page-gone"));
    const saveAttachment = vi.fn();
    mocks.getStore.mockResolvedValue({
      readPage,
      saveAttachment,
      appendPage: vi.fn(),
    });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          page: "page-gone",
        },
        516,
      ),
    );

    // A mistyped page id is the common case and costs nothing to answer, so
    // it must not cost a whole download and leave a file nothing links. The
    // reason is the code an agent branches on, the same one the append
    // branch below answers with, never the page id.
    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "page not found",
      reason: "page_not_found",
    });
    expect(readPage).toHaveBeenCalledWith("page-gone");
    expect(fake.calls).toEqual([]);
    expect(saveAttachment).not.toHaveBeenCalled();
    const [entry] = await readMcpActivity(1);
    expect(entry).toMatchObject({ page: "page-gone", outcome: "page_not_found" });
  });

  it("answers a notes-folder failure in Brain's words, with a line", async () => {
    // The store's own message is a Node `fs` error and carries the absolute
    // path of the notes folder. It used to be rethrown, so it reached the
    // agent as a transport error with the path in it and nothing in the
    // owner's log to say the call had happened.
    const readPage = vi
      .fn()
      .mockRejectedValue(new Error("EIO: /srv/brain/notes/page-one.md"));
    const saveAttachment = vi.fn();
    mocks.getStore.mockResolvedValue({
      readPage,
      saveAttachment,
      appendPage: vi.fn(),
    });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          page: "page-one",
        },
        517,
      ),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that page could not be read",
      reason: "page_read_failed",
    });
    expect(JSON.stringify(payload)).not.toContain("/srv/brain/notes");
    expect(fake.calls).toEqual([]);
    expect(saveAttachment).not.toHaveBeenCalled();
    const [entry] = await readMcpActivity(1);
    expect(entry).toMatchObject({ page: "page-one", outcome: "page_read_failed" });
  });

  it("bounds the name a message gave the file at 255 bytes", async () => {
    const saveAttachment = vi
      .fn()
      .mockResolvedValue({ url: "/_attachments-v2/hhhh.pdf", name: "hhhh.pdf", size: 9, type: "application/pdf" });
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment,
      appendPage: vi.fn(),
    });
    // The client already refuses a Content-Disposition over 180 bytes, so
    // this cap is this module's own and nothing else holds it.
    const long = "n".repeat(300);
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => ({
          contentType: "application/pdf",
          contentDisposition: `attachment; filename*=UTF-8''${long}.pdf`,
          bytes: PDF_BYTES.byteLength,
          body: streamOf(PDF_BYTES),
        }),
      }).client,
    );

    await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          page: "page-one",
        },
        519,
      ),
    );

    const [[file]] = saveAttachment.mock.calls;
    expect(Buffer.byteLength(file.originalName)).toBeLessThanOrEqual(255);
    expect(file.originalName.startsWith("nnn")).toBe(true);
  });

  it("reads no page when the caller asks for no line", async () => {
    const readPage = readsPageOne();
    mocks.getStore.mockResolvedValue({
      readPage,
      saveAttachment: vi.fn().mockResolvedValue({
        url: "/_attachments-v2/gggg.pdf",
        name: "invoice.pdf",
        size: 9,
        type: "application/pdf",
      }),
      appendPage: vi.fn(),
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => ({
          contentType: "application/pdf",
          contentDisposition: 'attachment; filename="invoice.pdf"',
          bytes: PDF_BYTES.byteLength,
          body: streamOf(PDF_BYTES),
        }),
      }).client,
    );

    const { payload } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          page: "page-one",
          append: false,
        },
        517,
      ),
    );

    // With no line to write, the page is not the tool's business and a page
    // that is gone is not a reason to turn the save down.
    expect(payload).toMatchObject({ url: "/_attachments-v2/gggg.pdf" });
    expect(readPage).not.toHaveBeenCalled();
  });

  it("refuses an executable whatever type the message claims it is", async () => {
    const saveAttachment = vi.fn();
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment,
      appendPage: vi.fn(),
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => ({
          contentType: "application/octet-stream",
          contentDisposition: 'attachment; filename="setup.EXE"',
          bytes: 4,
          body: streamOf(new Uint8Array([0x4d, 0x5a, 0x90, 0x00])),
        }),
      }).client,
    );

    const { payload, isError } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          page: "page-one",
        },
        518,
      ),
    );

    // A person dragging a file into a note chose both the bytes and the name.
    // Here a remote sender chose both and an agent decided to keep them, so
    // the extension the store would mint is refused on its own.
    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that file cannot be saved into a note",
      reason: "a message may not hand an agent a .exe",
    });
    expect(saveAttachment).not.toHaveBeenCalled();
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).toBe("blocked_extension");
  });

  it("tells the agent to reconnect the account in the words every mail tool uses", async () => {
    const saveAttachment = vi.fn();
    mocks.getStore.mockResolvedValue({
      readPage: readsPageOne(),
      saveAttachment,
      appendPage: vi.fn(),
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        downloadAttachment: async () => {
          throw new BrainMailClientError(401, "mail_account_reauth_required");
        },
      }).client,
    );

    const { payload, isError } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          page: "page-one",
        },
        515,
      ),
    );

    // One code, one sentence, whichever mail tool met it: an agent that can
    // act on a reconnection in `get_mail_thread` has to be told the same
    // thing here.
    expect(payload).toEqual({
      error: "this account needs to be reconnected",
      reason: "mail_account_reauth_required",
    });
    expect(isError).toBe(true);
    expect(saveAttachment).not.toHaveBeenCalled();
  });

  it("refuses an account id Brain never minted before the client is touched", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: "account-a" + "z".repeat(32),
          attachmentId: "attachment-alpha",
          page: "page-one",
        },
        512,
      ),
    );

    expect(payload).toEqual({
      error: "that account id is not valid",
      reason: "invalid_account_id",
    });
    expect(fake.calls).toEqual([]);
    // Nothing happened and the id is not one Brain ever issued, so there is
    // nothing worth a line and nothing unbounded may reach one.
    await expect(readMcpActivity(1)).resolves.toEqual([]);
  });

  it("names its other two bad ids with a code, the way its siblings do", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const badAttachment = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment alpha",
          page: "page-one",
        },
        513,
      ),
    );
    expect(badAttachment.payload).toEqual({
      error: "that attachment id is not valid",
      reason: "invalid_attachment_id",
    });
    expect(badAttachment.isError).toBe(true);

    const badPage = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          // A control character, which is the one thing a page id may not hold.
          page: "page\u0001one",
        },
        514,
      ),
    );
    expect(badPage.payload).toEqual({
      error: "that page id is not valid",
      reason: "invalid_page_id",
    });
    expect(badPage.isError).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it("refuses a grant that reads mail but cannot write a note", async () => {
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "test-machine-token",
      clientId: "brain-legacy-bearer",
      scopes: ["brain:read", "brain:mail"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "save_mail_attachment",
        {
          accountId: FAKE_ACCOUNT_ID,
          attachmentId: "attachment-alpha",
          page: "page-one",
        },
        513,
      ),
    );

    expect(payload).toMatchObject({
      reason: "insufficient_scope",
      requiredScope: "brain:write",
    });
    expect(isError).toBe(true);
    expect(fake.calls).toEqual([]);
    expect(mocks.getStore).not.toHaveBeenCalled();
    const [entry] = await readMcpActivity(1);
    expect(entry).toMatchObject({ outcome: "insufficient_scope" });
  });

  it("refuses a brain:read grant before the client or the log is touched", async () => {
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "read-only-token",
      clientId: "read-only-client",
      scopes: ["brain:read"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const response = await callTool(
      "save_mail_attachment",
      {
        accountId: FAKE_ACCOUNT_ID,
        attachmentId: "attachment-alpha",
        page: "page-one",
      },
      514,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'scope="brain:mail"',
    );
    expect(fake.calls).toEqual([]);
    expect(mocks.getStore).not.toHaveBeenCalled();
    await expect(readMcpActivity(1)).resolves.toEqual([]);
  });
});

describe("update_mail_thread", () => {
  let stateRoot: string;
  let centreRoot: string;

  beforeEach(async () => {
    // A private directory per test, the way the rest of this file and
    // `lib/mcp` make theirs: a fixed path is one worker away from reading a
    // sibling's leftovers as its own data.
    stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brain-mcp-triage-state-"));
    centreRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brain-mcp-triage-centre-"));
    mocks.getStore.mockReset();
    mocks.createBrainMailClient.mockReset();
    mocks.verifyMcpBearerToken.mockReset();
    // The legacy bearer's own client id, so `clientNameOf` answers without
    // reaching the OAuth state store for a name no test wrote there.
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "test-machine-token",
      clientId: "brain-legacy-bearer",
      scopes: ["brain:read", "brain:mail"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    vi.stubEnv("MCP_TOKEN", "test-machine-token");
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-with-at-least-32-bytes");
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example.test");
    vi.stubEnv("BRAIN_MCP_STATE_DIR", stateRoot);
    vi.stubEnv("BRAIN_NOTIFICATIONS_STATE_DIR", centreRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(stateRoot, { recursive: true, force: true });
    await fs.rm(centreRoot, { recursive: true, force: true });
  });

  it("sends exactly the service's own mutation shape", async () => {
    const fake = createMailClientFake({
      updateThread: async () => ({
        apiVersion: 1,
        thread: fakeThread({ starred: true }),
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "update_mail_thread",
        {
          accountId: FAKE_ACCOUNT_ID,
          threadId: "thread-alpha",
          starred: true,
        },
        300,
      ),
    );

    expect(fake.calls).toEqual([
      { method: "listAccountCapabilities", args: [] },
      {
        method: "updateThread",
        args: ["thread-alpha", { accountId: FAKE_ACCOUNT_ID, starred: true }],
      },
    ]);
    expect(payload.thread.starred).toBe(true);
  });

  it("refuses two changes in one call before the client is touched", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "update_mail_thread",
        {
          accountId: FAKE_ACCOUNT_ID,
          threadId: "thread-alpha",
          read: true,
          starred: true,
        },
        301,
      ),
    );

    expect(payload).toEqual({
      error: "one change per call",
      reason: "read, starred",
    });
    expect(isError).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it("refuses no change at all", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "update_mail_thread",
        { accountId: FAKE_ACCOUNT_ID, threadId: "thread-alpha" },
        302,
      ),
    );

    expect(payload).toEqual({
      error: "one change per call",
      reason: "pass one of read, starred, archive, trash, restore, spam",
    });
    expect(fake.calls).toEqual([]);
  });

  it("offers no way to purge a thread", async () => {
    const response = await POST(toolsListRequest(303));
    const body = await response.text();

    expect(body).toContain("update_mail_thread");
    // Trash yes, purge no. A thread in the trash stays there until the person
    // empties it themselves.
    expect(body).not.toContain("purge_mail");
    expect(body).not.toContain("empty_trash");
  });

  it("logs one activity line naming the thread and no subject", async () => {
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        updateThread: async () => ({
          apiVersion: 1,
          thread: fakeThread({ subject: "Quarterly invoice" }),
        }),
      }).client,
    );

    await toolPayload(
      await callTool(
        "update_mail_thread",
        { accountId: FAKE_ACCOUNT_ID, threadId: "thread-alpha", trash: true },
        304,
      ),
    );

    const [entry] = await readMcpActivity(1);
    expect(entry).toMatchObject({
      client: "Legacy token",
      tool: "update_mail_thread",
      accountId: FAKE_ACCOUNT_ID,
      threadId: "thread-alpha",
      change: "trash",
      outcome: "ok",
    });
    expect(JSON.stringify(entry)).not.toContain("Quarterly");
  });

  it("logs the refusal reason when the service refuses", async () => {
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        updateThread: async () => {
          throw new BrainMailClientError(409, "mail_thread_stale");
        },
      }).client,
    );

    const { payload } = await toolPayload(
      await callTool(
        "update_mail_thread",
        { accountId: FAKE_ACCOUNT_ID, threadId: "thread-alpha", read: true },
        305,
      ),
    );

    expect(payload.reason).toBe("mail_thread_stale");
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).toBe("mail_thread_stale");
  });

  it("refuses an account whose service withholds thread mutations", async () => {
    const fake = createMailClientFake({
      listAccountCapabilities: async () => ({
        apiVersion: 3,
        accounts: [
          fakeAccountV3(FAKE_ACCOUNT_ID, {
            capabilities: { threadMutations: false },
          }),
        ],
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "update_mail_thread",
        { accountId: FAKE_ACCOUNT_ID, threadId: "thread-alpha", archive: true },
        306,
      ),
    );

    expect(payload).toEqual({
      error: "the mail service does not sort threads for this account",
      // The same code the wire uses for the folderless-server case
      // (`lib/mail/service/http.ts`'s `mail_thread_mutation_unsupported`), so
      // an agent branches on one string whether this pre-check catches it or
      // the service does.
      reason: "mail_thread_mutation_unsupported",
    });
    expect(isError).toBe(true);
    expect(fake.calls.map((call) => call.method)).toEqual([
      "listAccountCapabilities",
    ]);
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).toBe("mail_thread_mutation_unsupported");
    expect(entry.change).toBe("archive");
  });

  it("marks the centre's mail row read when the agent marks the thread read", async () => {
    await appendNotification({
      id: mailNotificationId(FAKE_ACCOUNT_ID, "thread-alpha"),
      kind: "mail-new",
      at: "2026-09-14T09:00:00.000Z",
      title: "One new letter",
      href: "/mail",
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        updateThread: async () => ({
          apiVersion: 1,
          thread: fakeThread({ unread: false }),
        }),
      }).client,
    );

    await toolPayload(
      await callTool(
        "update_mail_thread",
        { accountId: FAKE_ACCOUNT_ID, threadId: "thread-alpha", read: true },
        307,
      ),
    );

    await vi.waitFor(async () => {
      const [row] = await listNotifications();
      expect(row?.readAt).toBeDefined();
    });
  });

  it("leaves the centre's row alone when the change is not a read", async () => {
    await appendNotification({
      id: mailNotificationId(FAKE_ACCOUNT_ID, "thread-alpha"),
      kind: "mail-new",
      at: "2026-09-14T09:00:00.000Z",
      title: "One new letter",
      href: "/mail",
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        updateThread: async () => ({
          apiVersion: 1,
          thread: fakeThread({ starred: true }),
        }),
      }).client,
    );

    await toolPayload(
      await callTool(
        "update_mail_thread",
        {
          accountId: FAKE_ACCOUNT_ID,
          threadId: "thread-alpha",
          starred: true,
        },
        308,
      ),
    );

    const [row] = await listNotifications();
    expect(row?.readAt).toBeUndefined();
  });

  it("refuses a brain:read grant before the client or the log is touched", async () => {
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "read-only-token",
      clientId: "read-only-client",
      scopes: ["brain:read"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const response = await callTool(
      "update_mail_thread",
      { accountId: FAKE_ACCOUNT_ID, threadId: "thread-alpha", read: true },
      309,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'scope="brain:mail"',
    );
    expect(fake.calls).toEqual([]);
    await expect(readMcpActivity(1)).resolves.toEqual([]);
  });

  it("refuses a 200 KB account id before the client or the log is touched", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "update_mail_thread",
        {
          accountId: "a".repeat(200_000),
          threadId: "thread-alpha",
          read: true,
        },
        310,
      ),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that account id is not valid",
      reason: "invalid_account_id",
    });
    // An id Brain never issued names no target, so nothing happened worth a
    // line, and nothing this size may reach a log that counts lines.
    expect(fake.calls).toEqual([]);
    await expect(readMcpActivity(1)).resolves.toEqual([]);
  });

  it("refuses a 200 KB thread id before the client or the log is touched", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "update_mail_thread",
        {
          accountId: FAKE_ACCOUNT_ID,
          threadId: "b".repeat(200_000),
          read: true,
        },
        311,
      ),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that thread id is not valid",
      reason: "invalid_thread_id",
    });
    expect(fake.calls).toEqual([]);
    await expect(readMcpActivity(1)).resolves.toEqual([]);
  });

  it("names the field that changed on a read as well as on a trash", async () => {
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        updateThread: async () => ({
          apiVersion: 1,
          thread: fakeThread({ unread: false }),
        }),
      }).client,
    );

    await toolPayload(
      await callTool(
        "update_mail_thread",
        { accountId: FAKE_ACCOUNT_ID, threadId: "thread-alpha", read: true },
        312,
      ),
    );

    const [entry] = await readMcpActivity(1);
    expect(entry).toMatchObject({ change: "read", outcome: "ok" });
  });
});

describe("the mail send tools", () => {
  const KEY = "mcp-key-alpha-0001";
  let stateRoot: string;

  beforeEach(async () => {
    stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brain-mcp-send-state-"));
    mocks.getStore.mockReset();
    mocks.createBrainMailClient.mockReset();
    mocks.verifyMcpBearerToken.mockReset();
    // The legacy bearer's own client id, so `clientNameOf` answers "Legacy
    // token" without reaching the OAuth state store for a name no test wrote.
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "test-machine-token",
      clientId: "brain-legacy-bearer",
      scopes: ["brain:read", "brain:mail", "brain:mail:send"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    vi.stubEnv("MCP_TOKEN", "test-machine-token");
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-with-at-least-32-bytes");
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example.test");
    vi.stubEnv("BRAIN_MCP_STATE_DIR", stateRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(stateRoot, { recursive: true, force: true });
  });

  it("sends with origin mcp, no agent line, and no attachments yet", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        400,
      ),
    );

    expect(payload).toEqual({
      operationId: "send-alpha",
      created: true,
      status: "queued",
    });
    expect(fake.calls[1]).toEqual({
      method: "sendMessage",
      args: [
        {
          accountId: FAKE_ACCOUNT_ID,
          idempotencyKey: KEY,
          mode: "compose",
          to: ["friend@example.net"],
          cc: [],
          bcc: [],
          subject: "Hello",
          text: "one line",
          replyToMessageId: null,
          attachments: [],
          origin: "mcp",
          agentLine: false,
        },
      ],
    });
  });

  it("appends the recipient line only when the toggle is on", async () => {
    await writeAgentSettings({ tellRecipients: true, allowSending: true });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        401,
      ),
    );

    expect((fake.calls[1].args[0] as MailSendInput).agentLine).toBe(true);
  });

  it("refuses every send while agent sending is off, before the client is touched", async () => {
    await writeAgentSettings({ tellRecipients: false, allowSending: false });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        402,
      ),
    );

    expect(payload).toEqual({
      error: "agent sending is off, turn it on in Settings, Connections",
      reason: "agent_sending_off",
    });
    expect(isError).toBe(true);
    expect(fake.calls).toEqual([]);
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).toBe("agent_sending_off");
  });

  it("refuses a reply while agent sending is off, before the client is touched", async () => {
    await writeAgentSettings({ tellRecipients: false, allowSending: false });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "reply_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          threadId: "thread-alpha",
          messageId: "message-alpha",
          text: "thanks",
          idempotencyKey: KEY,
        },
        403,
      ),
    );

    expect(payload).toEqual({
      error: "agent sending is off, turn it on in Settings, Connections",
      reason: "agent_sending_off",
    });
    expect(fake.calls).toEqual([]);
  });

  it("refuses an account that cannot send, naming the reason, without touching the service", async () => {
    const fake = createMailClientFake({
      listAccountCapabilities: async () => ({
        apiVersion: 3,
        accounts: [
          fakeAccountV3(FAKE_ACCOUNT_ID, { capabilities: { send: false } }),
        ],
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        404,
      ),
    );

    expect(payload).toEqual({
      error: "cannot send from this account",
      reason: "smtp_relay_unavailable",
    });
    expect(isError).toBe(true);
    expect(fake.calls.map((call) => call.method)).toEqual([
      "listAccountCapabilities",
    ]);
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).toBe("smtp_relay_unavailable");
  });

  it("refuses an account this host does not hold", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID_TWO,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        405,
      ),
    );

    expect(payload).toEqual({
      error: "account not found",
      reason: FAKE_ACCOUNT_ID_TWO,
    });
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
  });

  it("refuses an empty to and a malformed address", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const empty = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: [],
          subject: "Hello",
          text: "x",
          idempotencyKey: KEY,
        },
        406,
      ),
    );
    expect(empty.payload).toEqual({
      error: "to is empty",
      reason: "name at least one recipient",
    });

    const bad = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["not an address"],
          subject: "Hello",
          text: "x",
          idempotencyKey: KEY,
        },
        407,
      ),
    );
    expect(bad.payload).toEqual({
      error: "that is not an address",
      reason: "to[0]",
    });

    // The client's own rule wants a dotted domain, so a bare host is named
    // here rather than coming back as an opaque request refusal.
    const bareHost = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          cc: ["friend@localhost"],
          subject: "Hello",
          text: "x",
          idempotencyKey: KEY,
        },
        408,
      ),
    );
    expect(bareHost.payload).toEqual({
      error: "that is not an address",
      reason: "cc[0]",
    });

    // THREE RULES, ONE ANSWER. The codec bans every control character and the
    // service caps an address at 254 bytes; this gate used to admit both and
    // let them come back three layers down as a generic service refusal.
    for (const [address, id] of [
      ["friend\u0007@example.net", 409],
      [`${"a".repeat(250)}@example.net`, 410],
    ] as const) {
      const admitted = await toolPayload(
        await callTool(
          "send_mail",
          {
            accountId: FAKE_ACCOUNT_ID,
            to: [address],
            subject: "Hello",
            text: "x",
            idempotencyKey: KEY,
          },
          id,
        ),
      );
      expect(admitted.payload).toEqual({
        error: "that is not an address",
        reason: "to[0]",
      });
    }
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
  });

  it("names a repeated recipient and a body over the text cap", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const repeated = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          cc: ["Friend@Example.net"],
          subject: "Hello",
          text: "x",
          idempotencyKey: KEY,
        },
        409,
      ),
    );
    expect(repeated.payload).toEqual({
      error: "that address is listed twice",
      reason: "cc[0]",
    });

    const long = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "x".repeat(1024 * 1024 + 1),
          idempotencyKey: KEY,
        },
        410,
      ),
    );
    expect(long.payload).toEqual({
      error: "that message is too long",
      reason: "text is at most 1048576 bytes",
    });
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
  });

  it("replies to the derived recipients and takes no recipients from the agent", async () => {
    const target = fakeMessage({
      messageId: "message-alpha",
      threadId: "thread-alpha",
      from: { name: "Mary", address: "mary@example.net" },
      replyTo: [{ name: null, address: "list@example.net" }],
      to: [{ name: null, address: "me@example.test" }],
      cc: [{ name: null, address: "team@example.org" }],
      subject: "Quarterly",
    });
    const fake = createMailClientFake({
      getThread: async () => ({
        apiVersion: 1,
        thread: fakeThread({ threadId: "thread-alpha" }),
        messages: [target],
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "reply_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          threadId: "thread-alpha",
          messageId: "message-alpha",
          text: "thanks",
          idempotencyKey: KEY,
        },
        411,
      ),
    );

    expect(payload).toEqual({
      operationId: "send-alpha",
      created: true,
      status: "queued",
    });
    const sent = fake.calls.find((call) => call.method === "sendMessage")!
      .args[0] as MailSendInput;
    // Reply-To wins over From, and the account's own address is never copied
    // back onto the message it is answering.
    expect(sent.to).toEqual(["list@example.net"]);
    expect(sent.cc).toEqual([]);
    expect(sent.bcc).toEqual([]);
    expect(sent.mode).toBe("reply");
    expect(sent.replyToMessageId).toBe("message-alpha");
    expect(sent.subject).toBe("Re: Quarterly");
    expect(sent.origin).toBe("mcp");
    expect(sent.attachments).toEqual([]);
  });

  it("keeps To and Cc roles on replyAll and still drops the account itself", async () => {
    const target = fakeMessage({
      messageId: "message-alpha",
      threadId: "thread-alpha",
      from: { name: "Mary", address: "mary@example.net" },
      replyTo: [{ name: null, address: "list@example.net" }],
      to: [{ name: null, address: "me@example.test" }],
      cc: [{ name: null, address: "team@example.org" }],
      subject: "Re: Quarterly",
    });
    const fake = createMailClientFake({
      getThread: async () => ({
        apiVersion: 1,
        thread: fakeThread({ threadId: "thread-alpha" }),
        messages: [target],
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    await toolPayload(
      await callTool(
        "reply_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          threadId: "thread-alpha",
          messageId: "message-alpha",
          replyAll: true,
          text: "thanks",
          idempotencyKey: KEY,
        },
        412,
      ),
    );

    const sent = fake.calls.find((call) => call.method === "sendMessage")!
      .args[0] as MailSendInput;
    expect(sent.to).toEqual(["list@example.net"]);
    expect(sent.cc).toEqual(["team@example.org"]);
    // A subject that already answers is not prefixed a second time.
    expect(sent.subject).toBe("Re: Quarterly");
  });

  it("rejects a to on reply_mail as an unknown argument", async () => {
    const response = await callTool(
      "reply_mail",
      {
        accountId: FAKE_ACCOUNT_ID,
        threadId: "thread-alpha",
        messageId: "message-alpha",
        to: ["someone@example.net"],
        text: "x",
        idempotencyKey: KEY,
      },
      413,
    );

    expect(await response.text()).toContain("Invalid arguments");
  });

  it("refuses a reply to a message that is not in that thread", async () => {
    const fake = createMailClientFake({
      getThread: async () => ({
        apiVersion: 1,
        thread: fakeThread({ threadId: "thread-alpha" }),
        messages: [fakeMessage({ messageId: "message-beta" })],
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "reply_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          threadId: "thread-alpha",
          messageId: "message-alpha",
          text: "thanks",
          idempotencyKey: KEY,
        },
        414,
      ),
    );

    expect(payload).toEqual({
      error: "that message is not in that thread",
      reason: "message-alpha",
    });
    expect(isError).toBe(true);
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
  });

  it("replays the same result for a repeated idempotency key", async () => {
    const fake = createMailClientFake({
      sendMessage: async () => ({
        apiVersion: 1,
        operationId: "send-alpha",
        created: false,
        status: "sent",
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        415,
      ),
    );

    expect(payload).toEqual({
      operationId: "send-alpha",
      created: false,
      status: "sent",
    });
  });

  it("names the key a different message already used, and the rate limit", async () => {
    const conflicted = createMailClientFake({
      sendMessage: async () => {
        throw new BrainMailClientError(409, "mail_send_idempotency_conflict");
      },
    });
    mocks.createBrainMailClient.mockReturnValue(conflicted.client);

    const conflict = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        416,
      ),
    );
    expect(conflict.payload).toEqual({
      error: "that idempotency key was used for a different message",
      reason: "mail_send_idempotency_conflict",
    });
    expect(conflict.isError).toBe(true);
    const [conflictEntry] = await readMcpActivity(1);
    expect(conflictEntry.outcome).toBe("mail_send_idempotency_conflict");

    const limited = createMailClientFake({
      sendMessage: async () => {
        throw new BrainMailClientError(429, "mail_send_rate_limited");
      },
    });
    mocks.createBrainMailClient.mockReturnValue(limited.client);

    const rateLimited = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: "mcp-key-alpha-0002",
        },
        417,
      ),
    );
    expect(rateLimited.payload).toEqual({
      error: "the mail service is rate limiting sends",
      reason: "mail_send_rate_limited",
    });
  });

  it("says the mail service is unavailable without a word about the socket", async () => {
    const fake = createMailClientFake({
      listAccountCapabilities: async () => {
        throw new BrainMailClientError(503, "mail_service_unavailable");
      },
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        418,
      ),
    );

    expect(payload).toEqual({
      error: "the mail service is unavailable",
      reason: "mail_service_unavailable",
    });
    expect(isError).toBe(true);
  });

  it("answers unknown when the service answered with a body it could not read", async () => {
    // Raised only after the request was written in full, so it is no less
    // ambiguous than a timeout. It used to come back in the one sentence an
    // agent reads as "nothing happened, send it again".
    const fake = createMailClientFake({
      sendMessage: async () => {
        throw new BrainMailClientError(502, "mail_service_invalid_response");
      },
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["reader@example.net"],
          subject: "Invalid",
          text: "one line",
          idempotencyKey: "mcp-key-invalid-001",
        },
        430,
      ),
    );

    expect(isError).toBe(false);
    expect(payload).toMatchObject({
      state: "unknown",
      retry: "same-key",
      reason: "mail_service_invalid_response",
    });
  });

  it("splits a socket that died after the write from one that never connected", async () => {
    const died = createMailClientFake({
      sendMessage: async () => {
        throw new BrainMailClientError(503, "mail_service_unavailable", {
          requestSent: true,
        });
      },
    });
    mocks.createBrainMailClient.mockReturnValue(died.client);

    const after = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["reader@example.net"],
          subject: "Died",
          text: "one line",
          idempotencyKey: "mcp-key-died-00001",
        },
        431,
      ),
    );
    expect(after.isError).toBe(false);
    expect(after.payload).toMatchObject({
      state: "unknown",
      retry: "same-key",
      reason: "mail_service_unavailable",
    });

    const never = createMailClientFake({
      sendMessage: async () => {
        throw new BrainMailClientError(503, "mail_service_unavailable");
      },
    });
    mocks.createBrainMailClient.mockReturnValue(never.client);

    const before = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["reader@example.net"],
          subject: "Never",
          text: "one line",
          idempotencyKey: "mcp-key-never-0001",
        },
        432,
      ),
    );
    // Nothing reached the service, so this is a refusal and a fresh key is
    // the right retry.
    expect(before.isError).toBe(true);
    expect(before.payload).toEqual({
      error: "the mail service is unavailable",
      reason: "mail_service_unavailable",
    });
  });

  /** THE SERVICE SAYS WHICH SIDE OF THE ENQUEUE IT FAILED ON.
   *
   *  `/v1/send` makes the message durable before it delivers, so a failure
   *  after that point is not "nothing happened": the outbox holds the message.
   *  The socket was fine, so `requestSent` alone could not tell this apart
   *  from a refusal, and a refusal is the one answer that sends the agent back
   *  with a fresh key. */
  it("answers unknown when the service failed after it made the message durable", async () => {
    const enqueued = createMailClientFake({
      sendMessage: async () => {
        throw new BrainMailClientError(503, "mail_send_service_unavailable", {
          enqueued: true,
        });
      },
    });
    mocks.createBrainMailClient.mockReturnValue(enqueued.client);

    const message = {
      accountId: FAKE_ACCOUNT_ID,
      to: ["durable@example.net"],
      subject: "Held",
      text: "one line",
    };
    const held = await toolPayload(
      await callTool(
        "send_mail",
        { ...message, idempotencyKey: "mcp-key-held-00001" },
        437,
      ),
    );

    expect(held.isError).toBe(false);
    expect(held.payload).toMatchObject({
      state: "unknown",
      retry: "same-key",
      idempotencyKey: "mcp-key-held-00001",
      reason: "mail_send_service_unavailable",
    });

    // And the memo is armed, so a fresh key for the same message is held.
    const second = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(second.client);
    const fresh = await toolPayload(
      await callTool(
        "send_mail",
        { ...message, idempotencyKey: "mcp-key-fresh-0001" },
        438,
      ),
    );
    expect(fresh.isError).toBe(true);
    expect(fresh.payload.reason).toBe("possible_duplicate");
    expect(fresh.payload.error).toContain("mcp-key-held-00001");
    expect(second.calls.map((call) => call.method)).not.toContain("sendMessage");
  });

  it("refuses a fresh key on a message an unknown send may already have sent", async () => {
    const timedOut = createMailClientFake({
      sendMessage: async () => {
        throw new BrainMailClientError(504, "mail_service_timeout");
      },
    });
    mocks.createBrainMailClient.mockReturnValue(timedOut.client);

    const message = {
      accountId: FAKE_ACCOUNT_ID,
      to: ["twice@example.net"],
      subject: "Only once",
      text: "one line",
    };
    await toolPayload(
      await callTool(
        "send_mail",
        { ...message, idempotencyKey: "mcp-key-first-0001" },
        433,
      ),
    );

    const second = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(second.client);
    const duplicate = await toolPayload(
      await callTool(
        "send_mail",
        { ...message, idempotencyKey: "mcp-key-second-001" },
        434,
      ),
    );

    expect(duplicate.isError).toBe(true);
    expect(duplicate.payload).toEqual({
      error:
        "that message may already be on its way under idempotencyKey mcp-key-first-0001, so ask again with that key or read get_mail_send_status rather than sending a second copy",
      reason: "possible_duplicate",
    });
    expect(second.calls.map((call) => call.method)).not.toContain("sendMessage");
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).toBe("possible_duplicate");

    // The key the answer named is the retry the answer asked for, so it goes
    // through, and a message that is not the same one is never held up.
    const replay = await toolPayload(
      await callTool(
        "send_mail",
        { ...message, idempotencyKey: "mcp-key-first-0001" },
        435,
      ),
    );
    expect(replay.isError).toBe(false);
    expect(replay.payload).toMatchObject({ operationId: "send-alpha" });

    const other = await toolPayload(
      await callTool(
        "send_mail",
        { ...message, text: "another line", idempotencyKey: "mcp-key-other-0001" },
        436,
      ),
    );
    expect(other.isError).toBe(false);
  });

  it("forgets an unknown send once ten minutes have passed", async () => {
    const timedOut = createMailClientFake({
      sendMessage: async () => {
        throw new BrainMailClientError(504, "mail_service_timeout");
      },
    });
    mocks.createBrainMailClient.mockReturnValue(timedOut.client);

    const message = {
      accountId: FAKE_ACCOUNT_ID,
      to: ["later@example.net"],
      subject: "Later",
      text: "one line",
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-14T09:00:00.000Z"));
      await toolPayload(
        await callTool(
          "send_mail",
          { ...message, idempotencyKey: "mcp-key-early-0001" },
          437,
        ),
      );

      vi.setSystemTime(new Date("2026-09-14T09:10:01.000Z"));
      mocks.createBrainMailClient.mockReturnValue(createMailClientFake().client);
      const later = await toolPayload(
        await callTool(
          "send_mail",
          { ...message, idempotencyKey: "mcp-key-late-00001" },
          438,
        ),
      );
      expect(later.isError).toBe(false);
      expect(later.payload).toMatchObject({ operationId: "send-alpha" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records the send mark and one activity line, with no subject or address", async () => {
    mocks.createBrainMailClient.mockReturnValue(createMailClientFake().client);

    await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["mary@example.net"],
          subject: "Quarterly invoice",
          text: "x",
          idempotencyKey: KEY,
        },
        419,
      ),
    );

    expect(await readAgentSends()).toEqual([
      {
        operationId: "send-alpha",
        accountId: FAKE_ACCOUNT_ID,
        clientName: "Legacy token",
        threadId: null,
      },
    ]);
    const entries = await readMcpActivity(10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      tool: "send_mail",
      operationId: "send-alpha",
      accountId: FAKE_ACCOUNT_ID,
      client: "Legacy token",
      outcome: "ok",
    });
    const serialized = JSON.stringify(entries[0]);
    expect(serialized).not.toContain("Quarterly");
    expect(serialized).not.toContain("mary");
  });

  it("reports the send state machine and resolves the mark's thread", async () => {
    await recordAgentSend({
      operationId: "send-alpha",
      accountId: FAKE_ACCOUNT_ID,
      clientName: "Claude",
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        getSendOperation: async () => ({
          apiVersion: 1,
          operationId: "send-alpha",
          status: "sent",
          threadId: "thread-sent",
        }),
      }).client,
    );

    const { payload } = await toolPayload(
      await callTool("get_mail_send_status", { operationId: "send-alpha" }, 420),
    );

    expect(payload).toEqual({
      operationId: "send-alpha",
      status: "sent",
      threadId: "thread-sent",
    });
    expect((await readAgentSends())[0].threadId).toBe("thread-sent");
    // A status read is a read: it changes no mail and writes no line.
    await expect(readMcpActivity(1)).resolves.toEqual([]);
  });

  it("leaves the mark unresolved while the provider has no Sent copy yet", async () => {
    await recordAgentSend({
      operationId: "send-alpha",
      accountId: FAKE_ACCOUNT_ID,
      clientName: "Claude",
    });
    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        getSendOperation: async () => ({
          apiVersion: 1,
          operationId: "send-alpha",
          status: "queued",
          threadId: null,
        }),
      }).client,
    );

    const { payload } = await toolPayload(
      await callTool("get_mail_send_status", { operationId: "send-alpha" }, 421),
    );

    expect(payload).toEqual({
      operationId: "send-alpha",
      status: "queued",
      threadId: null,
    });
    expect((await readAgentSends())[0].threadId).toBeNull();
  });

  it.each([
    [
      "send_mail",
      {
        accountId: FAKE_ACCOUNT_ID,
        to: ["friend@example.net"],
        subject: "s",
        text: "t",
        idempotencyKey: "mcp-key-alpha-0001",
      },
    ],
    [
      "reply_mail",
      {
        accountId: FAKE_ACCOUNT_ID,
        threadId: "thread-alpha",
        messageId: "message-alpha",
        text: "t",
        idempotencyKey: "mcp-key-alpha-0001",
      },
    ],
    ["get_mail_send_status", { operationId: "send-alpha" }],
  ] as const)("refuses %s on a brain:mail grant", async (name, args) => {
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "test-machine-token",
      clientId: "brain-legacy-bearer",
      scopes: ["brain:read", "brain:mail"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const response = await callTool(name, args, 422);

    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'scope="brain:mail:send"',
    );
    expect(fake.calls).toEqual([]);
    await expect(readMcpActivity(1)).resolves.toEqual([]);
  });

  it("answers unknown, not refused, when the send itself times out", async () => {
    const fake = createMailClientFake({
      sendMessage: async () => {
        throw new BrainMailClientError(504, "mail_service_timeout");
      },
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        423,
      ),
    );

    // The service enqueues the message durably before it delivers, so a
    // client that gave up waiting cannot say nothing happened. "Refused" is
    // the one word an agent reads as "send it again with a fresh key".
    expect(isError).toBe(false);
    expect(payload).toMatchObject({
      state: "unknown",
      idempotencyKey: KEY,
      operationId: null,
      retry: "same-key",
      reason: "mail_service_timeout",
    });
    expect(JSON.stringify(payload)).not.toContain("refused");
    expect(String(payload.detail)).toContain("idempotencyKey");
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).toBe("unknown");
  });

  it("writes the mark when a status resolves it, and replays on the same key", async () => {
    const timedOut = createMailClientFake({
      sendMessage: async () => {
        throw new BrainMailClientError(504, "mail_service_timeout");
      },
    });
    mocks.createBrainMailClient.mockReturnValue(timedOut.client);

    await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        424,
      ),
    );
    // Nothing to mark yet: the tool never learned an operation id.
    expect(await readAgentSends()).toEqual([]);

    mocks.createBrainMailClient.mockReturnValue(
      createMailClientFake({
        getSendOperation: async () => ({
          apiVersion: 1,
          operationId: "send-alpha",
          status: "sent",
          threadId: "thread-sent",
        }),
      }).client,
    );

    await toolPayload(
      await callTool(
        "get_mail_send_status",
        { operationId: "send-alpha", accountId: FAKE_ACCOUNT_ID },
        425,
      ),
    );

    expect(await readAgentSends()).toEqual([
      {
        operationId: "send-alpha",
        accountId: FAKE_ACCOUNT_ID,
        clientName: "Legacy token",
        threadId: "thread-sent",
      },
    ]);

    const replay = createMailClientFake({
      sendMessage: async () => ({
        apiVersion: 1,
        operationId: "send-alpha",
        created: false,
        status: "sent",
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(replay.client);

    const { payload } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        426,
      ),
    );

    // The same key answers the first operation rather than sending twice.
    expect(payload).toEqual({
      operationId: "send-alpha",
      created: false,
      status: "sent",
    });
    // And the replay's own mark keeps the thread the status call resolved, so
    // the Sent row's caption does not go out and come back.
    expect(await readAgentSends()).toEqual([
      {
        operationId: "send-alpha",
        accountId: FAKE_ACCOUNT_ID,
        clientName: "Legacy token",
        threadId: "thread-sent",
      },
    ]);
  });

  it("still refuses when the account list times out, because nothing was sent", async () => {
    const fake = createMailClientFake({
      listAccountCapabilities: async () => {
        throw new BrainMailClientError(504, "mail_service_timeout");
      },
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        427,
      ),
    );

    // A read that timed out told the service nothing to send, so the honest
    // answer is a refusal and the agent may use a fresh key next time.
    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "the mail service did not answer in time",
      reason: "mail_service_timeout",
    });
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
  });

  it("refuses a subject carrying a carriage return before the client is built", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello\r\nBcc: attacker@example.net",
          text: "one line",
          idempotencyKey: KEY,
        },
        428,
      ),
    );

    // A header the agent writes is the one input where a miss is
    // catastrophic, so Brain holds its own lock rather than leaving the
    // builder three layers down as the only one.
    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that subject holds a control character",
      reason: "a subject is one line of plain text",
    });
    expect(fake.calls).toEqual([]);
    // The owner's log names the rule that refused, not the last one in the
    // function: a header injection and a long body read the same otherwise.
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).toBe("subject_control_character");
  });

  it("names a malformed account id, an oversized subject and a null byte", async () => {
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const badAccount = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: "account-a" + "z".repeat(32),
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        429,
      ),
    );
    expect(badAccount.payload).toEqual({
      error: "that account id is not valid",
      reason: "invalid_account_id",
    });

    const longSubject = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "s".repeat(999),
          text: "one line",
          idempotencyKey: KEY,
        },
        430,
      ),
    );
    expect(longSubject.payload).toEqual({
      error: "that subject is too long",
      reason: "subject is at most 998 bytes",
    });

    const nullByte = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one\u0000line",
          idempotencyKey: KEY,
        },
        431,
      ),
    );
    expect(nullByte.payload).toEqual({
      error: "that message holds a null byte",
      reason: "subject and text are plain text",
    });
    expect(fake.calls).toEqual([]);
  });

  it("refuses a reply to a message that names nobody but this account", async () => {
    const target = fakeMessage({
      messageId: "message-alpha",
      threadId: "thread-alpha",
      from: { name: "Me", address: "me@example.test" },
      replyTo: [],
      to: [{ name: null, address: "me@example.test" }],
      cc: [],
    });
    const fake = createMailClientFake({
      getThread: async () => ({
        apiVersion: 1,
        thread: fakeThread({ threadId: "thread-alpha" }),
        messages: [target],
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "reply_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          threadId: "thread-alpha",
          messageId: "message-alpha",
          text: "thanks",
          idempotencyKey: KEY,
        },
        432,
      ),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "there is no one to reply to",
      reason: "that message names only this account",
    });
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
  });

  it("refuses to send at all when the kill switch cannot be read", async () => {
    await fs.mkdir(stateRoot, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      path.join(stateRoot, MCP_AGENT_SETTINGS_FILE),
      "{not json",
      { mode: 0o600 },
    );
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        433,
      ),
    );

    // A switch whose whole purpose is to stop an agent must not be one
    // unreadable file away from being on again.
    expect(isError).toBe(true);
    expect(payload).toEqual({
      error:
        "agent sending is off, the switch could not be read, so set it again in Settings, Connections",
      reason: "agent_settings_unreadable",
    });
    expect(fake.calls).toEqual([]);
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).toBe("agent_settings_unreadable");
  });

  it("checks the account id before the kill switch, so no line carries a stray id", async () => {
    await writeAgentSettings({ tellRecipients: false, allowSending: false });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: "a".repeat(200_000),
          to: ["friend@example.net"],
          subject: "Hello",
          text: "one line",
          idempotencyKey: KEY,
        },
        434,
      ),
    );

    expect(payload).toEqual({
      error: "that account id is not valid",
      reason: "invalid_account_id",
    });
    const entries = await readMcpActivity(10);
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("invalid_account_id");
    expect(fake.calls).toEqual([]);
  });
});

describe("outgoing attachments", () => {
  const KEY = "mcp-key-alpha-0001";
  /** The shape the store mints for an ordinary upload: twelve characters and
   *  the extension it chose itself. A Notion import is named by its own
   *  sha256 instead, and the name-shape cases below carry one of those. */
  const NAME = "file-alpha-1.pdf";
  const SECOND = "file-alpha-2.pdf";
  const TOTAL_CAP = 5 * 1024 * 1024;
  const RELAY_CAP = 1024 * 1024;
  let stateRoot: string;

  function pageHolding(...names: string[]) {
    return {
      meta: { id: "page-one" },
      markdown: names
        .map((name) => `[a file](/_attachments-v2/${name})`)
        .join("\n\n"),
      rev: "rev-1",
    };
  }

  function storeHolding(
    page: ReturnType<typeof pageHolding>,
    files: Record<string, { data: Uint8Array; mimeType: string }>,
  ) {
    const readPage = vi.fn().mockResolvedValue(page);
    const readAttachment = vi.fn(async (name: string) => {
      const file = files[name];
      return file
        ? { kind: "file", name, mimeType: file.mimeType, data: file.data }
        : { kind: "missing" };
    });
    mocks.getStore.mockResolvedValue({ readPage, readAttachment });
    return { readPage, readAttachment };
  }

  beforeEach(async () => {
    stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "brain-mcp-outgoing-"));
    mocks.getStore.mockReset();
    mocks.createBrainMailClient.mockReset();
    mocks.verifyMcpBearerToken.mockReset();
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "test-machine-token",
      clientId: "brain-legacy-bearer",
      scopes: ["brain:read", "brain:mail", "brain:mail:send"],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    vi.stubEnv("MCP_TOKEN", "test-machine-token");
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-with-at-least-32-bytes");
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example.test");
    vi.stubEnv("BRAIN_MCP_STATE_DIR", stateRoot);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(stateRoot, { recursive: true, force: true });
  });

  it("resolves a page's own file and sends it as base64", async () => {
    const { readAttachment } = storeHolding(pageHolding(NAME), {
      [NAME]: { data: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" },
    });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Here it is",
          text: "attached",
          idempotencyKey: KEY,
          attachments: [{ page: "page-one", name: NAME }],
        },
        600,
      ),
    );

    expect(payload).toEqual({
      operationId: "send-alpha",
      created: true,
      status: "queued",
    });
    const sent = fake.calls.find((call) => call.method === "sendMessage")!
      .args[0] as MailSendInput;
    expect(sent.attachments).toEqual([
      { filename: NAME, mimeType: "application/pdf", dataBase64: "AQID" },
    ]);
    // The whole message cap is the budget the first file is read against, so
    // a file above it never lands in this process at all.
    expect(readAttachment).toHaveBeenCalledWith(NAME, TOTAL_CAP);
  });

  it("reads one page once for two of its files, and keeps their order", async () => {
    const { readPage } = storeHolding(pageHolding(NAME, SECOND), {
      [NAME]: { data: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" },
      [SECOND]: { data: new Uint8Array([4]), mimeType: "application/pdf" },
    });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Here they are",
          text: "attached",
          idempotencyKey: KEY,
          attachments: [
            { page: "page-one", name: NAME },
            { page: "page-one", name: SECOND },
          ],
        },
        601,
      ),
    );

    const sent = fake.calls.find((call) => call.method === "sendMessage")!
      .args[0] as MailSendInput;
    expect(sent.attachments.map((file) => file.filename)).toEqual([NAME, SECOND]);
    expect(readPage).toHaveBeenCalledOnce();
  });

  it("refuses a file the page does not reference", async () => {
    const { readAttachment } = storeHolding(
      { meta: { id: "page-one" }, markdown: "no files here", rev: "rev-1" },
      {},
    );
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "s",
          text: "t",
          idempotencyKey: KEY,
          attachments: [{ page: "page-one", name: NAME }],
        },
        602,
      ),
    );

    expect(payload).toEqual({
      error: "that page does not hold that file",
      reason: `page-one has no ${NAME}`,
    });
    expect(isError).toBe(true);
    expect(readAttachment).not.toHaveBeenCalled();
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
  });

  it.each([
    ["../../etc/passwd"],
    [`/_attachments-v2/${"a".repeat(64)}.pdf`],
    ["a".repeat(64)],
    ["file alpha.pdf"],
  ])("refuses %s as a name, before the store or the service", async (name) => {
    const { payload, isError } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "s",
          text: "t",
          idempotencyKey: KEY,
          attachments: [{ page: "page-one", name }],
        },
        603,
      ),
    );

    expect(payload.error).toBe("that is not an attachment name");
    expect(isError).toBe(true);
    expect(mocks.getStore).not.toHaveBeenCalled();
    expect(mocks.createBrainMailClient).not.toHaveBeenCalled();
  });

  it("takes a sha256 name, which is what an imported file is called", async () => {
    const imported = `${"a".repeat(64)}.pdf`;
    storeHolding(pageHolding(imported), {
      [imported]: {
        data: new Uint8Array([1, 2, 3]),
        mimeType: "application/pdf",
      },
    });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "s",
          text: "t",
          idempotencyKey: KEY,
          attachments: [{ page: "page-one", name: imported }],
        },
        604,
      ),
    );

    const sent = fake.calls.find((call) => call.method === "sendMessage")!
      .args[0] as MailSendInput;
    expect(sent.attachments.map((file) => file.filename)).toEqual([imported]);
  });

  it("refuses more than ten files", async () => {
    const { payload } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "s",
          text: "t",
          idempotencyKey: KEY,
          attachments: Array.from({ length: 11 }, () => ({
            page: "page-one",
            name: NAME,
          })),
        },
        605,
      ),
    );

    expect(payload).toEqual({
      error: "too many attachments",
      reason: "10 files is the limit for one message",
    });
    expect(mocks.getStore).not.toHaveBeenCalled();
  });

  it("refuses when the total crosses 5 MiB, before the service sees anything", async () => {
    const readPage = vi.fn().mockResolvedValue(pageHolding(NAME, SECOND));
    // The store is the one that measures: it is handed what is left of the
    // message's budget and answers `too_large` off the file's own size,
    // before a buffer that size is ever allocated.
    const readAttachment = vi.fn(async (name: string, maxBytes: number) =>
      name === NAME
        ? { kind: "file", name, mimeType: "application/pdf", data: new Uint8Array(4) }
        : maxBytes < TOTAL_CAP
          ? { kind: "too_large" }
          : { kind: "file", name, mimeType: "application/pdf", data: new Uint8Array(4) },
    );
    mocks.getStore.mockResolvedValue({ readPage, readAttachment });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "s",
          text: "t",
          idempotencyKey: KEY,
          attachments: [
            { page: "page-one", name: NAME },
            { page: "page-one", name: SECOND },
          ],
        },
        606,
      ),
    );

    expect(payload).toEqual({
      error: "those attachments are too large",
      reason: "5 MiB is the limit for one message",
    });
    expect(isError).toBe(true);
    expect(readAttachment).toHaveBeenLastCalledWith(SECOND, TOTAL_CAP - 4);
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
  });

  /** An IMAP account's SMTP session leaves through the Cloudflare relay,
   *  whose tunnel carries 2 MiB of finished message against what a Gmail
   *  account's provider API takes. The budget the files are read against is
   *  the account's, so the difference is a refusal naming the account and
   *  both figures rather than a relay failure after the message has been
   *  built and written into the outbox. */
  function imapSendingAccount() {
    return createMailClientFake({
      listAccountCapabilities: async () => ({
        apiVersion: 3,
        accounts: [
          fakeAccountV3(FAKE_ACCOUNT_ID, {
            providerKind: "imap",
            smtp: {
              hostname: "smtp.example.test",
              port: 587,
              tls: "starttls",
              username: "me",
            },
            capabilities: { send: true },
          }),
        ],
      }),
    });
  }

  it("reads an IMAP account's files against the relay's budget, not the message cap", async () => {
    const { readAttachment } = storeHolding(pageHolding(NAME), {
      [NAME]: { data: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" },
    });
    const fake = imapSendingAccount();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "s",
          text: "t",
          idempotencyKey: KEY,
          attachments: [{ page: "page-one", name: NAME }],
        },
        622,
      ),
    );

    expect(payload).toEqual({
      operationId: "send-alpha",
      created: true,
      status: "queued",
    });
    expect(RELAY_CAP).toBeLessThan(TOTAL_CAP);
    expect(readAttachment).toHaveBeenCalledWith(NAME, RELAY_CAP);
  });

  it("refuses an IMAP account's oversized set before the service sees anything", async () => {
    const readPage = vi.fn().mockResolvedValue(pageHolding(NAME));
    // The store measures: handed the account's budget, it answers `too_large`
    // off the file's own size without allocating a buffer that size. This
    // file would have gone out from a Gmail account.
    const readAttachment = vi.fn(async (name: string, maxBytes: number) =>
      maxBytes < TOTAL_CAP
        ? { kind: "too_large" }
        : {
            kind: "file",
            name,
            mimeType: "application/pdf",
            data: new Uint8Array(4),
          },
    );
    mocks.getStore.mockResolvedValue({ readPage, readAttachment });
    const fake = imapSendingAccount();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "s",
          text: "t",
          idempotencyKey: KEY,
          attachments: [{ page: "page-one", name: NAME }],
        },
        623,
      ),
    );

    expect(payload).toEqual({
      error: "those attachments are too large for this account",
      reason:
        "1 MiB is the limit for one message from an IMAP account, whose relay carries 2 MiB of finished message, against 5 MiB from a Gmail account",
    });
    expect(isError).toBe(true);
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
  });

  it("refuses a page it cannot read and a file that is gone", async () => {
    const readPage = vi.fn().mockRejectedValue(new NotFoundError("page-gone"));
    mocks.getStore.mockResolvedValue({ readPage, readAttachment: vi.fn() });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const missingPage = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "s",
          text: "t",
          idempotencyKey: KEY,
          attachments: [{ page: "page-gone", name: NAME }],
        },
        607,
      ),
    );
    expect(missingPage.payload).toEqual({
      error: "page not found",
      reason: "page-gone",
    });

    storeHolding(pageHolding(NAME), {});
    const missingFile = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "s",
          text: "t",
          idempotencyKey: KEY,
          attachments: [{ page: "page-one", name: NAME }],
        },
        608,
      ),
    );
    expect(missingFile.payload).toEqual({
      error: "that file is gone",
      reason: NAME,
    });
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
  });

  /** `getStore()` ITSELF CAN FAIL, INSIDE `resolveOutgoingAttachments`, BEFORE
   *  A PAGE OR A FILE IS READ.
   *
   *  The account check still costs one round trip (`admitAccount`'s own,
   *  before the resolver runs), but it sat outside every try in the resolver
   *  itself, so a store that would not even start answered
   *  `mail_service_unavailable`, naming a subsystem that had nothing to do
   *  with the failure. `sendMessage` never fires either way. */
  it("answers a failed getStore() as a store failure, not a mail-service outage", async () => {
    mocks.getStore.mockRejectedValue(
      Object.assign(
        new Error("EACCES: permission denied, open '/notes/.brain/journal'"),
        { code: "EACCES" },
      ),
    );
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "s",
          text: "t",
          idempotencyKey: KEY,
          attachments: [{ page: "page-one", name: NAME }],
        },
        606,
      ),
    );

    expect(payload).toEqual({
      error: "the notes folder could not answer",
      reason: "store_failed",
    });
    expect(JSON.stringify(payload)).not.toContain("/notes/");
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
  });

  it("refuses a type that cannot travel in a MIME header", async () => {
    storeHolding(pageHolding(NAME), {
      [NAME]: {
        data: new Uint8Array([1, 2, 3]),
        mimeType: "application/pdf; charset=utf-8",
      },
    });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "s",
          text: "t",
          idempotencyKey: KEY,
          attachments: [{ page: "page-one", name: NAME }],
        },
        609,
      ),
    );

    expect(payload).toEqual({
      error: "that file cannot be sent",
      reason: "its type is not one a message can carry",
    });
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
  });

  it("carries attachments on a reply too, and logs the count and the names", async () => {
    storeHolding(pageHolding(NAME), {
      [NAME]: { data: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" },
    });
    const target = fakeMessage({
      messageId: "message-alpha",
      threadId: "thread-alpha",
      from: { name: "Mary", address: "mary@example.net" },
      subject: "Quarterly",
    });
    const fake = createMailClientFake({
      getThread: async () => ({
        apiVersion: 1,
        thread: fakeThread({ threadId: "thread-alpha" }),
        messages: [target],
      }),
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    await toolPayload(
      await callTool(
        "reply_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          threadId: "thread-alpha",
          messageId: "message-alpha",
          text: "thanks",
          idempotencyKey: KEY,
          attachments: [{ page: "page-one", name: NAME }],
        },
        610,
      ),
    );

    const sent = fake.calls.find((call) => call.method === "sendMessage")!
      .args[0] as MailSendInput;
    expect(sent.attachments).toEqual([
      { filename: NAME, mimeType: "application/pdf", dataBase64: "AQID" },
    ]);
    const [entry] = await readMcpActivity(1);
    // The names are the store's own, minted for the file on disk, so naming
    // them in the log tells the owner which file left without carrying a
    // title, a subject or a word anybody wrote.
    expect(entry).toMatchObject({
      tool: "reply_mail",
      outcome: "ok",
      change: "attachments 1",
      attachmentId: NAME,
    });
    expect(JSON.stringify(entry)).not.toContain("Quarterly");
    expect(JSON.stringify(entry)).not.toContain("thanks");
  });

  it("logs the count on a refusal the names never got past", async () => {
    await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "s",
          text: "t",
          idempotencyKey: KEY,
          attachments: [{ page: "page-one", name: "../../etc/passwd" }],
        },
        611,
      ),
    );

    const [entry] = await readMcpActivity(1);
    expect(entry).toMatchObject({
      tool: "send_mail",
      outcome: "invalid_attachment_name",
      change: "attachments 1",
    });
    expect(entry.attachmentId).toBeUndefined();
  });

  /** `sendFingerprint` FOLDS THE ATTACHMENT REFS IN, NOT JUST THE WORDS.
   *
   *  Two sends of the same words with different files attached are different
   *  messages. An "unknown" outcome for the first must not read a fresh key
   *  sending the second, different-attachment message as the same duplicate
   *  the memo is holding. */
  it("does not read an unknown send with a different attachment as the same duplicate", async () => {
    storeHolding(pageHolding(NAME, SECOND), {
      [NAME]: { data: new Uint8Array([1, 2, 3]), mimeType: "application/pdf" },
      [SECOND]: { data: new Uint8Array([4, 5, 6]), mimeType: "application/pdf" },
    });
    const stuck = createMailClientFake({
      sendMessage: async () => {
        throw new BrainMailClientError(503, "mail_send_service_unavailable", {
          enqueued: true,
        });
      },
    });
    mocks.createBrainMailClient.mockReturnValue(stuck.client);

    const held = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["reader@example.net"],
          subject: "Same words",
          text: "one line",
          idempotencyKey: "mcp-key-refs-first01",
          attachments: [{ page: "page-one", name: NAME }],
        },
        620,
      ),
    );
    expect(held.isError).toBe(false);
    expect(held.payload).toMatchObject({ state: "unknown", retry: "same-key" });

    const second = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(second.client);
    const fresh = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["reader@example.net"],
          subject: "Same words",
          text: "one line",
          idempotencyKey: "mcp-key-refs-fresh01",
          attachments: [{ page: "page-one", name: SECOND }],
        },
        621,
      ),
    );

    expect(fresh.isError).toBe(false);
    expect(second.calls.some((call) => call.method === "sendMessage")).toBe(true);
  });

  it("sends one attachment-carrying message at a time", async () => {
    const events: string[] = [];
    let releaseFirst = () => {};
    const firstOnTheWire = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const readAttachment = vi.fn(async (name: string) => {
      events.push(`read ${name}`);
      return {
        kind: "file",
        name,
        mimeType: "application/pdf",
        data: new Uint8Array([1, 2, 3]),
      };
    });
    mocks.getStore.mockResolvedValue({
      readPage: vi.fn().mockResolvedValue(pageHolding(NAME, SECOND)),
      readAttachment,
    });

    let sends = 0;
    const fake = createMailClientFake({
      sendMessage: async () => {
        sends += 1;
        const mine = sends;
        events.push(`send ${mine}`);
        if (mine === 1) await firstOnTheWire;
        return {
          apiVersion: 1,
          operationId: `send-${mine}`,
          created: true,
          status: "queued",
        };
      },
    });
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const call = (name: string, key: string, id: number) =>
      callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Here it is",
          text: "attached",
          idempotencyKey: key,
          attachments: [{ page: "page-one", name }],
        },
        id,
      );

    // The handler runs while its answer is read, so both bodies are put in
    // flight before either is awaited.
    const first = toolPayload(await call(NAME, "mcp-key-alpha-0001", 620));
    const second = toolPayload(await call(SECOND, "mcp-key-alpha-0002", 621));

    await vi.waitFor(() => expect(events).toContain("send 1"));
    // A 5 MiB attachment costs about 30 MiB resident while it is on its way,
    // and the service builds one message at a time, so a second caller that
    // read its bytes now would hold them for the whole of the first send.
    expect(events).toEqual([`read ${NAME}`, "send 1"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual([
      `read ${NAME}`,
      "send 1",
      `read ${SECOND}`,
      "send 2",
    ]);
  });

  it("names the notes folder, not the mail service, when a page cannot be read", async () => {
    const readAttachment = vi.fn();
    mocks.getStore.mockResolvedValue({
      readPage: vi.fn().mockRejectedValue(new Error("EIO on the notes disk")),
      readAttachment,
    });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Here it is",
          text: "attached",
          idempotencyKey: KEY,
          attachments: [{ page: "page-one", name: NAME }],
        },
        622,
      ),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that page could not be read",
      reason: "page_read_failed",
    });
    // The mail service was never asked to send anything, so neither the
    // answer nor the owner's log may name it.
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
    expect(readAttachment).not.toHaveBeenCalled();
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).toBe("page_read_failed");
  });

  it("names the notes folder when a file changes while it is being read", async () => {
    mocks.getStore.mockResolvedValue({
      readPage: vi.fn().mockResolvedValue(pageHolding(NAME)),
      readAttachment: vi
        .fn()
        .mockRejectedValue(
          new Error(`attachment changed while reading: ${NAME}`),
        ),
    });
    const fake = createMailClientFake();
    mocks.createBrainMailClient.mockReturnValue(fake.client);

    const { payload, isError } = await toolPayload(
      await callTool(
        "send_mail",
        {
          accountId: FAKE_ACCOUNT_ID,
          to: ["friend@example.net"],
          subject: "Here it is",
          text: "attached",
          idempotencyKey: KEY,
          attachments: [{ page: "page-one", name: NAME }],
        },
        623,
      ),
    );

    expect(isError).toBe(true);
    expect(payload).toEqual({
      error: "that file could not be read from the notes folder",
      reason: "attachment_read_failed",
    });
    expect(fake.calls.some((call) => call.method === "sendMessage")).toBe(false);
    const [entry] = await readMcpActivity(1);
    expect(entry.outcome).toBe("attachment_read_failed");
  });
});
