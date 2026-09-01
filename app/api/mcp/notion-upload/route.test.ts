import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { acquireNotionUploadSlot } from "@/lib/notion/upload-admission";
import {
  decodeFileNameHeader,
  handleNotionUpload,
  readBoundedBody,
} from "@/lib/notion/http-upload";

const mocks = vi.hoisted(() => ({ verifyMcpBearerToken: vi.fn() }));

vi.mock("@/lib/oauth/server", () => ({
  verifyMcpBearerToken: mocks.verifyMcpBearerToken,
}));

import { POST } from "./route";

describe("Notion binary upload route", () => {
  let release: (() => void) | null = null;

  beforeEach(() => {
    mocks.verifyMcpBearerToken.mockReset();
    mocks.verifyMcpBearerToken.mockImplementation(async (token?: string) =>
      token === "read-only-token"
        ? {
            token,
            clientId: "read-only-client",
            scopes: ["brain:read"],
            resource: new URL("https://brain.example.test/api/mcp"),
          }
        : undefined,
    );
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example.test");
  });

  afterEach(() => {
    release?.();
    release = null;
    vi.unstubAllEnvs();
  });

  it("returns an import-specific HTTP challenge from the exported wrapper", async () => {
    const response = await POST(
      new Request("https://brain.example.test/api/mcp/notion-upload", {
        method: "POST",
        headers: { authorization: "Bearer read-only-token" },
      }),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'error="insufficient_scope"',
    );
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'scope="brain:import"',
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("keeps the exported binary wrapper authenticated", async () => {
    const response = await POST(
      new Request("https://brain.example.test/api/mcp/notion-upload", {
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain(
      'scope="brain:import"',
    );
  });

  it("decodes UTF-8 filenames from a strict ASCII base64 header", () => {
    const name = "Фото семьи 🦁.png";
    const encoded = Buffer.from(name, "utf8").toString("base64");

    expect(decodeFileNameHeader(encoded)).toBe(name);
    expect(decodeFileNameHeader("%%%")) .toBe("");
    expect(
      decodeFileNameHeader(Buffer.from([0xc3, 0x28]).toString("base64")),
    ).toBe("");
  });

  it("rejects a concurrent upload before reading its request body", async () => {
    release = acquireNotionUploadSlot();
    expect(release).not.toBeNull();
    let bodyReads = 0;
    const request = {
      get body() {
        bodyReads += 1;
        return null;
      },
    } as unknown as NextRequest;
    const response = await handleNotionUpload(request);

    expect(response.status).toBe(429);
    expect(bodyReads).toBe(0);
  });

  it("cancels a streaming body as soon as it crosses the byte limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const init = {
      method: "POST",
      body,
      duplex: "half",
    } as unknown as ConstructorParameters<typeof NextRequest>[1];
    const request = new NextRequest("https://brain.test/upload", init);

    await expect(readBoundedBody(request, 3)).rejects.toMatchObject({
      code: "too_large",
    });
    expect(cancelled).toBe(true);
  });

  it("requires the source descriptor hash before reading upload bytes", async () => {
    let bodyReads = 0;
    const request = {
      headers: new Headers({
        "x-notion-id": "a".repeat(32),
        "x-source-hash": "b".repeat(64),
        "x-reservation-token": "client_journal_token_1234",
        "x-file-name-b64": Buffer.from("file.txt").toString("base64"),
        "content-type": "text/plain",
      }),
      get body() {
        bodyReads += 1;
        return null;
      },
    } as unknown as NextRequest;

    const response = await handleNotionUpload(request);
    expect(response.status).toBe(400);
    expect(bodyReads).toBe(0);
  });
});
