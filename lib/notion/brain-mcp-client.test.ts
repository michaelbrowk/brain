import { describe, expect, it, vi } from "vitest";
import {
  BRAIN_MCP_USER_AGENT,
  BrainMcpClient,
  MAX_MCP_BASE64_ASSET_BYTES,
} from "./brain-mcp-client";
import type { ResolvedNotionAsset } from "./notion-assets";

const ENDPOINT = "https://brain.example.test/api/mcp";
const ALLOWED_ORIGIN = "https://brain.example.test";
const TOKEN = "synthetic_token_000000000000";

function clientOptions(fetchImpl: typeof fetch) {
  return { endpoint: ENDPOINT, allowedOrigin: ALLOWED_ORIGIN, token: TOKEN, fetchImpl };
}

function notionStatus(overrides: Record<string, unknown> = {}) {
  return {
    id: "brain-page",
    title: "Synthetic",
    notionId: "1".repeat(32),
    current: { parentId: null, beforeId: null },
    deleted: false,
    ...overrides,
  };
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

function initialized(session = "synthetic-session"): Response[] {
  return [
    json(
      {
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2024-11-05", capabilities: {} },
      },
      { headers: { "mcp-session-id": session } },
    ),
    new Response(null, { status: 202 }),
  ];
}

describe("Brain MCP pilot client", () => {
  it("supports JSON, browser headers, and negotiated sessions", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initialized()[0])
      .mockResolvedValueOnce(initialized()[1])
      .mockResolvedValueOnce(
        json({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [{ type: "text", text: JSON.stringify({ page: null }) }],
          },
        }),
      );
    const client = new BrainMcpClient(clientOptions(fetchImpl));
    await expect(client.findPage("1".repeat(32))).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const initializeHeaders = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    const callHeaders = new Headers(fetchImpl.mock.calls[2][1]?.headers);
    expect(initializeHeaders.get("user-agent")).toBe(BRAIN_MCP_USER_AGENT);
    expect(callHeaders.get("mcp-session-id")).toBe("synthetic-session");
    expect(callHeaders.get("accept")).toContain("text/event-stream");
  });

  it("parses SSE tool responses", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initialized()[0])
      .mockResolvedValueOnce(initialized()[1])
      .mockResolvedValueOnce(
        new Response(
          "event: message\ndata: " +
            JSON.stringify({
              jsonrpc: "2.0",
              id: 2,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ page: notionStatus() }),
                  },
                ],
              },
            }) +
            "\n\n",
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
      );
    const client = new BrainMcpClient(clientOptions(fetchImpl));
    await expect(client.findPage("1".repeat(32))).resolves.toMatchObject({
      id: "brain-page",
    });
  });

  it("inspects a least-data preserve/adopt candidate by Brain id", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initialized()[0])
      .mockResolvedValueOnce(initialized()[1])
      .mockResolvedValueOnce(
        json({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  candidate: {
                    id: "brain-candidate",
                    rev: "candidate-rev",
                    current: { parentId: "brain-root", beforeId: null },
                    deleted: false,
                    bindingState: "unbound",
                    legacyBindingUpgradeable: false,
                  },
                }),
              },
            ],
          },
        }),
      );
    const client = new BrainMcpClient(clientOptions(fetchImpl));
    await expect(client.inspectCandidate("brain-candidate")).resolves.toEqual({
      id: "brain-candidate",
      rev: "candidate-rev",
      current: { parentId: "brain-root", beforeId: null },
      deleted: false,
      bindingState: "unbound",
      legacyBindingUpgradeable: false,
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[2][1]?.body));
    expect(body.params).toEqual({
      name: "notion_inspect_candidate",
      arguments: { pageId: "brain-candidate" },
    });
  });

  it("rejects candidate responses that contain body or capability fields", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initialized()[0])
      .mockResolvedValueOnce(initialized()[1])
      .mockResolvedValueOnce(
        json({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  candidate: {
                    id: "brain-candidate",
                    rev: "candidate-rev",
                    current: { parentId: null, beforeId: null },
                    deleted: false,
                    bindingState: "unbound",
                    markdown: "must never be accepted",
                    reservationToken: "must_never_cross_boundary",
                  },
                }),
              },
            ],
          },
        }),
      );
    const client = new BrainMcpClient(clientOptions(fetchImpl));
    await expect(client.inspectCandidate("brain-candidate")).rejects.toThrow(
      /invalid strict result/,
    );
  });

  it("calls the explicit adoption and staged-byte verification tools", async () => {
    const toolResult = (id: number, value: unknown) =>
      json({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify(value) }],
        },
      });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initialized()[0])
      .mockResolvedValueOnce(initialized()[1])
      .mockResolvedValueOnce(
        toolResult(2, {
          status: "adopted",
          page: notionStatus({
            sourceHash: "b".repeat(64),
            conversionHash: "c".repeat(64),
            trackedBaseline: { parentId: null, beforeId: null, order: "a0" },
          }),
          rev: "rev-1",
        }),
      )
      .mockResolvedValueOnce(
        toolResult(3, {
          url: "/_attachments-v2/" + "a".repeat(64) + ".png",
          size: 3,
          sha256: "a".repeat(64),
        }),
      )
      .mockResolvedValueOnce(
        toolResult(4, {
          url: "/_attachments-v2/" + "a".repeat(64) + ".png",
          size: 3,
          sha256: "a".repeat(64),
        }),
      );
    const client = new BrainMcpClient(clientOptions(fetchImpl));
    await client.adoptPage({
      pageId: "brain-page",
      notionId: "1".repeat(32),
      sourceHash: "b".repeat(64),
      conversionHash: "c".repeat(64),
      expectedRev: "rev-0",
      expectedParentId: null,
      expectedBeforeId: null,
    });
    await client.verifyAttachment({
      notionId: "1".repeat(32),
      sourceHash: "b".repeat(64),
      reservationToken: "synthetic_reservation_0001",
      url: "/_attachments-v2/" + "a".repeat(64) + ".png",
    });
    await client.verifyFinalizedAttachment({
      notionId: "1".repeat(32),
      sourceHash: "b".repeat(64),
      conversionHash: "c".repeat(64),
      url: "/_attachments-v2/" + "a".repeat(64) + ".png",
    });
    const adoptBody = JSON.parse(String(fetchImpl.mock.calls[2][1]?.body));
    const verifyBody = JSON.parse(String(fetchImpl.mock.calls[3][1]?.body));
    const finalizedBody = JSON.parse(String(fetchImpl.mock.calls[4][1]?.body));
    expect(adoptBody.params.name).toBe("notion_adopt_page");
    expect(verifyBody.params.name).toBe("notion_verify_attachment");
    expect(finalizedBody.params.name).toBe(
      "notion_verify_finalized_attachment",
    );
  });

  it("strictly decodes every import tool and read-page result", async () => {
    const toolResult = (id: number, value: unknown) =>
      json({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(value) }] },
      });
    const status = notionStatus({
      sourceHash: "b".repeat(64),
      conversionHash: "c".repeat(64),
      trackedBaseline: { parentId: null, beforeId: null, order: "a0" },
      integrity: { trackedTargetIntact: true },
    });
    const saved = {
      url: "/_attachments-v2/" + "a".repeat(64) + ".png",
      name: "asset.png",
      size: 3,
      type: "image/png",
    };
    const verified = { url: saved.url, size: 3, sha256: "a".repeat(64) };
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initialized()[0])
      .mockResolvedValueOnce(initialized()[1])
      .mockResolvedValueOnce(toolResult(2, { page: status }))
      .mockResolvedValueOnce(toolResult(3, { status: "adopted", page: status, rev: "rev-1" }))
      .mockResolvedValueOnce(toolResult(4, { status: "reserved", page: status, reservationToken: "synthetic_reservation_0001", created: false }))
      .mockResolvedValueOnce(toolResult(5, saved))
      .mockResolvedValueOnce(toolResult(6, verified))
      .mockResolvedValueOnce(toolResult(7, verified))
      .mockResolvedValueOnce(toolResult(8, { status: "finalized", page: status, rev: "rev-2", cleanup: { stagingRemoved: true } }))
      .mockResolvedValueOnce(toolResult(9, { status: "aborted", pageId: "brain-page", cleanup: { stagingRemoved: true, notionBindingRemoved: false, placeholderPreserved: true } }))
      .mockResolvedValueOnce(toolResult(10, {
        meta: {
          id: "brain-page",
          title: "Synthetic",
          order: "a0",
          created: "2026-01-01T00:00:00.000Z",
          updated: "2026-01-01T00:00:00.000Z",
        },
        markdown: "body",
        rev: "rev-3",
      }));
    const client = new BrainMcpClient(clientOptions(fetchImpl));
    await client.findPage("1".repeat(32));
    await client.adoptPage(adoptInput());
    await client.reservePage(reserveInput());
    await client.uploadAttachment(uploadInput(asset(new Uint8Array([1, 2, 3]))));
    await client.verifyAttachment(verifyInput());
    await client.verifyFinalizedAttachment(finalizedVerifyInput());
    await client.finalizePage(finalizeInput());
    await client.abortPage(abortInput());
    await client.readPage("brain-page");
  });

  it("accepts legacy uppercase hyphenated Notion ids and canonicalizes them", async () => {
    const legacy = "11111111-1111-1111-1111-1111111111AA";
    const canonical = legacy.replaceAll("-", "").toLowerCase();
    const toolResult = (id: number, value: unknown) =>
      json({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: JSON.stringify(value) }] },
      });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initialized()[0])
      .mockResolvedValueOnce(initialized()[1])
      .mockResolvedValueOnce(
        toolResult(2, { page: notionStatus({ notionId: legacy }) }),
      )
      .mockResolvedValueOnce(
        toolResult(3, {
          meta: {
            id: "brain-page",
            title: "Synthetic",
            order: "a0",
            created: "2026-01-01T00:00:00.000Z",
            updated: "2026-01-01T00:00:00.000Z",
            notionId: legacy,
          },
          markdown: "body",
          rev: "rev-legacy",
        }),
      );
    const client = new BrainMcpClient(clientOptions(fetchImpl));
    await expect(client.findPage(canonical)).resolves.toMatchObject({
      notionId: canonical,
    });
    await expect(client.readPage("brain-page")).resolves.toMatchObject({
      meta: { notionId: canonical },
    });
  });

  it.each([
    ["find", { page: { ...notionStatus(), extra: true } }],
    ["adopt", { status: "adopted", page: notionStatus() }],
    ["reserve", { status: "reserved", page: notionStatus(), reservationToken: "synthetic_reservation_0001", created: "false" }],
    ["upload", { url: "/_attachments-v2/" + "a".repeat(64) + ".png", name: "a.png", size: "3", type: "image/png" }],
    ["staged verify", { url: "/_attachments-v2/" + "a".repeat(64) + ".png", size: 3 }],
    ["final verify", { url: "/_attachments-v2/" + "a".repeat(64) + ".png", size: 3, sha256: "a".repeat(64), extra: true }],
    ["finalize", { status: "finalized", page: notionStatus(), rev: "rev", cleanup: { stagingRemoved: true, extra: true } }],
    ["abort", { status: "aborted", pageId: "brain-page", cleanup: { stagingRemoved: true, notionBindingRemoved: false, placeholderPreserved: "true" } }],
    ["abort", { status: "deleted", pageId: "brain-page", cleanup: { stagingRemoved: true, notionBindingRemoved: true, placeholderPreserved: false } }],
    ["abort", { status: "detached", pageId: "brain-page", cleanup: { stagingRemoved: true, notionBindingRemoved: false, placeholderPreserved: true } }],
    ["abort", { status: "aborted", pageId: "brain-page", cleanup: { stagingRemoved: true, notionBindingRemoved: true, placeholderPreserved: true } }],
    ["read", { meta: { id: "brain-page", title: "Synthetic", order: "a0", created: "x", updated: "x", notionImportToken: TOKEN }, markdown: "", rev: "rev" }],
  ] as const)("rejects malformed strict %s results", async (name, value) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initialized()[0])
      .mockResolvedValueOnce(initialized()[1])
      .mockResolvedValueOnce(
        json({
          jsonrpc: "2.0",
          id: 2,
          result: { content: [{ type: "text", text: JSON.stringify(value) }] },
        }),
      );
    const client = new BrainMcpClient(clientOptions(fetchImpl));
    const call = malformedCall(client, name);
    await expect(call).rejects.toThrow(/invalid strict result/);
  });

  it.each([
    ["missing jsonrpc", { id: 2, result: { content: [] } }],
    ["wrong id", { jsonrpc: "2.0", id: 99, result: { content: [] } }],
    ["extra envelope field", { jsonrpc: "2.0", id: 2, result: { content: [] }, extra: true }],
    ["result and error", { jsonrpc: "2.0", id: 2, result: {}, error: { code: -1, message: "bad" } }],
  ] as const)("rejects %s", async (_name, envelope) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initialized()[0])
      .mockResolvedValueOnce(initialized()[1])
      .mockResolvedValueOnce(json(envelope));
    const client = new BrainMcpClient(clientOptions(fetchImpl));
    await expect(client.findPage("1".repeat(32))).rejects.toThrow(/envelope or id/);
  });

  it("requires exact initialize protocol negotiation", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      json({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-01-01", capabilities: {} },
      }),
    );
    const client = new BrainMcpClient(clientOptions(fetchImpl));
    await expect(client.findPage("1".repeat(32))).rejects.toThrow(
      /initialize result is invalid/,
    );
  });

  it.each([
    ["wrong", [rpcEvent(99)]],
    ["mixed", [rpcEvent(99), rpcEvent(2)]],
    ["duplicate", [rpcEvent(2), rpcEvent(2)]],
  ] as const)("rejects %s SSE response ids", async (_name, events) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initialized()[0])
      .mockResolvedValueOnce(initialized()[1])
      .mockResolvedValueOnce(
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      );
    const client = new BrainMcpClient(clientOptions(fetchImpl));
    await expect(client.findPage("1".repeat(32))).rejects.toThrow(/id|duplicate/);
  });

  it("pins production origin and requires an explicit exact staging origin", () => {
    expect(
      () => new BrainMcpClient({ endpoint: ENDPOINT, token: TOKEN, fetchImpl: vi.fn<typeof fetch>() }),
    ).toThrow(/exact HTTPS/);
    expect(
      () => new BrainMcpClient({ endpoint: ENDPOINT, token: TOKEN, allowedOrigin: "https://*.example.test" }),
    ).toThrow(/exact HTTPS origin/);
    expect(
      () => new BrainMcpClient({ endpoint: ENDPOINT, token: TOKEN, allowedOrigin: ALLOWED_ORIGIN + "/path" }),
    ).toThrow(/exact HTTPS origin/);
    expect(
      () => new BrainMcpClient({ endpoint: ENDPOINT, token: TOKEN, allowedOrigin: ALLOWED_ORIGIN }),
    ).not.toThrow();
  });

  it("rejects a typo production host without leaking host or token", () => {
    let message = "";
    try {
      new BrainMcpClient({
        endpoint: "https://braim.example.com/api/mcp",
        token: TOKEN,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain("braim.example.com");
    expect(message).toMatch(/exact HTTPS/);
  });

  it("uses MCP base64 for small assets and binary upload for larger assets", async () => {
    const smallFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(initialized()[0])
      .mockResolvedValueOnce(initialized()[1])
      .mockResolvedValueOnce(
        json({
          jsonrpc: "2.0",
          id: 2,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  url: "/_attachments-v2/" + "a".repeat(64) + ".png",
                  name: "small.png",
                  size: 3,
                  type: "image/png",
                }),
              },
            ],
          },
        }),
      );
    const smallClient = new BrainMcpClient(clientOptions(smallFetch));
    await smallClient.uploadAttachment(uploadInput(asset(new Uint8Array([1, 2, 3]))));
    const smallBody = JSON.parse(String(smallFetch.mock.calls[2][1]?.body));
    expect(smallBody.params.arguments.dataBase64).toBe("AQID");

    const largeFetch = vi.fn<typeof fetch>().mockResolvedValue(
      json({
        url: "/_attachments-v2/" + "a".repeat(64) + ".png",
        name: "large.png",
        size: MAX_MCP_BASE64_ASSET_BYTES + 1,
        type: "image/png",
      }),
    );
    const largeClient = new BrainMcpClient(clientOptions(largeFetch));
    await largeClient.uploadAttachment(
      uploadInput(
        asset(new Uint8Array(MAX_MCP_BASE64_ASSET_BYTES + 1), "large.png"),
      ),
    );
    expect(String(largeFetch.mock.calls[0][0])).toBe(
      "https://brain.example.test/api/mcp/notion-upload",
    );
    const headers = new Headers(largeFetch.mock.calls[0][1]?.headers);
    expect(headers.get("x-expected-sha256")).toBe("a".repeat(64));
    expect(headers.get("x-file-name-b64")).toBe(
      Buffer.from("large.png").toString("base64"),
    );
    expect(headers.get("user-agent")).toBe(BRAIN_MCP_USER_AGENT);
  });

  it("redacts failures and honors HTTP Retry-After", async () => {
    const input = uploadInput(
      asset(new Uint8Array(MAX_MCP_BASE64_ASSET_BYTES + 1), "large.png"),
    );
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      json(
        {
          error:
            "Bearer " + TOKEN + " token " + input.reservationToken +
            " source " + input.sourceHash + " sha " + input.asset.sha256 +
            " failed at https://brain.example.test/private",
          code: "synthetic_failure",
        },
        { status: 409, headers: { "retry-after": "2" } },
      ),
    );
    const client = new BrainMcpClient(clientOptions(fetchImpl));
    let message = "";
    let retryAfterMs: number | undefined;
    try {
      await client.uploadAttachment(input);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
      retryAfterMs =
        error && typeof error === "object" && "retryAfterMs" in error
          ? (error as { retryAfterMs?: number }).retryAfterMs
          : undefined;
    }
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(input.reservationToken);
    expect(message).not.toContain(input.sourceHash);
    expect(message).not.toContain(input.asset.sha256);
    expect(message).not.toContain("https://");
    expect(message).toContain("[redacted]");
    expect(retryAfterMs).toBe(2_000);
  });

  it.each(["tool", "rpc"] as const)(
    "redacts reservation capabilities and hashes from 200 %s errors",
    async (kind) => {
      const input = reserveInput();
      const echoed =
        input.reservationToken + " " + input.sourceHash + " " +
        input.conversionHash;
      const failure =
        kind === "tool"
          ? {
              jsonrpc: "2.0",
              id: 2,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ error: echoed, code: "busy" }),
                  },
                ],
              },
            }
          : {
              jsonrpc: "2.0",
              id: 2,
              error: { code: -32_000, message: echoed },
            };
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(initialized()[0])
        .mockResolvedValueOnce(initialized()[1])
        .mockResolvedValueOnce(json(failure));
      const client = new BrainMcpClient(clientOptions(fetchImpl));
      let message = "";
      try {
        await client.reservePage(input);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).not.toContain(input.reservationToken);
      expect(message).not.toContain(input.sourceHash);
      expect(message).not.toContain(input.conversionHash);
      expect(message).toContain("[redacted]");
    },
  );

  it.each(["tool", "http"] as const)(
    "maps an untrusted secret-shaped %s error code to a safe fallback",
    async (kind) => {
      const secretCode = TOKEN;
      const fetchImpl =
        kind === "tool"
          ? vi
              .fn<typeof fetch>()
              .mockResolvedValueOnce(initialized()[0])
              .mockResolvedValueOnce(initialized()[1])
              .mockResolvedValueOnce(
                json({
                  jsonrpc: "2.0",
                  id: 2,
                  result: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          error: "synthetic remote failure",
                          code: secretCode,
                        }),
                      },
                    ],
                  },
                }),
              )
          : vi.fn<typeof fetch>().mockResolvedValue(
              json(
                { error: "synthetic remote failure", code: secretCode },
                { status: 409 },
              ),
            );
      const client = new BrainMcpClient(clientOptions(fetchImpl));
      let caught: unknown;
      try {
        if (kind === "tool") {
          await client.findPage("1".repeat(32));
        } else {
          await client.uploadAttachment(
            uploadInput(
              asset(
                new Uint8Array(MAX_MCP_BASE64_ASSET_BYTES + 1),
                "large.png",
              ),
            ),
          );
        }
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ code: "remote_error" });
      expect(JSON.stringify(caught)).not.toContain(secretCode);
    },
  );

  it("classifies a non-JSON HTTP 429 as retryable busy", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("temporarily throttled", {
        status: 429,
        headers: { "content-type": "text/plain", "retry-after": "3" },
      }),
    );
    const client = new BrainMcpClient(clientOptions(fetchImpl));
    await expect(
      client.uploadAttachment(
        uploadInput(
          asset(new Uint8Array(MAX_MCP_BASE64_ASSET_BYTES + 1), "large.png"),
        ),
      ),
    ).rejects.toMatchObject({ code: "busy", retryAfterMs: 3_000 });
  });

  it("redacts a capability before truncating a long non-JSON failure", async () => {
    const input = uploadInput(
      asset(new Uint8Array(MAX_MCP_BASE64_ASSET_BYTES + 1), "large.png"),
    );
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        "x".repeat(290) + input.reservationToken + " " + input.sourceHash,
        { status: 500, headers: { "content-type": "text/plain" } },
      ),
    );
    const client = new BrainMcpClient(clientOptions(fetchImpl));
    let message = "";
    try {
      await client.uploadAttachment(input);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain(input.reservationToken.slice(0, 10));
    expect(message).not.toContain(input.sourceHash.slice(0, 10));
    expect(message).toContain("[redacted]");
    expect(message.length).toBeLessThanOrEqual(300);
  });
});

function asset(
  bytes: Uint8Array,
  name = "small.png",
): ResolvedNotionAsset {
  return {
    sourceId: "asset_" + "1".repeat(32),
    name,
    mimeType: "image/png",
    sha256: "a".repeat(64),
    bytes,
  };
}

function uploadInput(assetValue: ResolvedNotionAsset) {
  return {
    notionId: "1".repeat(32),
    sourceHash: "b".repeat(64),
    reservationToken: "synthetic_reservation_0001",
    asset: assetValue,
  };
}

function adoptInput() {
  return {
    pageId: "brain-page",
    notionId: "1".repeat(32),
    sourceHash: "b".repeat(64),
    conversionHash: "c".repeat(64),
    expectedRev: "rev-0",
    expectedParentId: null,
    expectedBeforeId: null,
  };
}

function reserveInput() {
  return {
    notionId: "1".repeat(32),
    sourceHash: "b".repeat(64),
    conversionHash: "c".repeat(64),
    parentId: null,
    beforeId: null,
    title: "Synthetic",
    reservationToken: "synthetic_reservation_0001",
  };
}

function verifyInput() {
  return {
    notionId: "1".repeat(32),
    sourceHash: "b".repeat(64),
    reservationToken: "synthetic_reservation_0001",
    url: "/_attachments-v2/" + "a".repeat(64) + ".png",
  };
}

function finalizedVerifyInput() {
  return {
    notionId: "1".repeat(32),
    sourceHash: "b".repeat(64),
    conversionHash: "c".repeat(64),
    url: "/_attachments-v2/" + "a".repeat(64) + ".png",
  };
}

function finalizeInput() {
  return {
    notionId: "1".repeat(32),
    sourceHash: "b".repeat(64),
    conversionHash: "c".repeat(64),
    reservationToken: "synthetic_reservation_0001",
    markdown: "body",
  };
}

function abortInput() {
  return {
    notionId: "1".repeat(32),
    sourceHash: "b".repeat(64),
    reservationToken: "synthetic_reservation_0001",
  };
}

function malformedCall(client: BrainMcpClient, name: string): Promise<unknown> {
  switch (name) {
    case "find":
      return client.findPage("1".repeat(32));
    case "adopt":
      return client.adoptPage(adoptInput());
    case "reserve":
      return client.reservePage(reserveInput());
    case "upload":
      return client.uploadAttachment(uploadInput(asset(new Uint8Array([1, 2, 3]))));
    case "staged verify":
      return client.verifyAttachment(verifyInput());
    case "final verify":
      return client.verifyFinalizedAttachment(finalizedVerifyInput());
    case "finalize":
      return client.finalizePage(finalizeInput());
    case "abort":
      return client.abortPage(abortInput());
    case "read":
      return client.readPage("brain-page");
    default:
      throw new Error("unknown malformed tool probe");
  }
}

function rpcEvent(id: number) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      content: [{ type: "text", text: JSON.stringify({ page: null }) }],
    },
  };
}
