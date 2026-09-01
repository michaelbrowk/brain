import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getStore: vi.fn(),
  verifyMcpBearerToken: vi.fn(),
}));

vi.mock("@/lib/store", () => ({
  getStore: mocks.getStore,
  isAttachmentValidation: () => false,
  isNotFound: () => false,
  isNotionImportConflict: () => false,
  isRevConflict: () => false,
  redactPage: (value: unknown) => value,
  redactPageMeta: (value: unknown) => value,
  AttachmentValidationError: class AttachmentValidationError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
  MAX_ATTACHMENT_BYTES: 10 * 1024 * 1024,
}));
vi.mock("@/lib/search", () => ({ searchNotes: vi.fn() }));
vi.mock("@/lib/emoji-llm", () => ({ smartEmoji: vi.fn() }));
vi.mock("@/lib/oauth/server", () => ({
  verifyMcpBearerToken: mocks.verifyMcpBearerToken,
}));

import { POST } from "./route";

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

describe("Notion MCP route validation", () => {
  beforeEach(() => {
    mocks.getStore.mockReset();
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
      },
      rootPageCount: 2,
      scopes: ["brain:read"],
      changedPages: 0,
    });
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
      'scope="brain:read brain:write brain:import"',
    );
    expect(mocks.getStore).not.toHaveBeenCalled();
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
        code: "share_disclosure_required",
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
