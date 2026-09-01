import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELETE, GET, POST } from "./route";

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
  vi.restoreAllMocks();
});

describe("/api/mail/account", () => {
  it("bridges GET and DELETE without exposing credential fields", async () => {
    const methods: string[] = [];
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer((request, response) => {
      methods.push(request.method ?? "");
      writeJson(
        response,
        200,
        request.method === "DELETE"
          ? { apiVersion: 1, configured: false, account: null }
          : {
              apiVersion: 1,
              configured: true,
              account: {
                accountId: "account-a0123456789abcdef0123456789abcdef",
                emailAddress: "person@example.test",
                imap: {
                  hostname: "imap.example.test",
                  port: 993,
                  tls: "implicit",
                  username: "person@example.test",
                },
                connectedAt: Date.now(),
              },
            },
      );
    });

    const status = await GET(new Request("https://brain.test/api/mail/account"));
    const disconnected = await DELETE(
      new Request("https://brain.test/api/mail/account", {
        method: "DELETE",
        headers: { Origin: "https://brain.test" },
      }),
    );

    expect(status.status).toBe(200);
    expect(status.headers.get("Cache-Control")).toBe("no-store");
    expect(JSON.stringify(await status.json())).not.toContain("password");
    expect(await disconnected.json()).toEqual({
      apiVersion: 1,
      configured: false,
      account: null,
    });
    expect(methods).toEqual(["GET", "DELETE"]);
  });

  it("rejects malformed input before opening the socket", async () => {
    process.env.BRAIN_MAIL_SOCKET_PATH = "/tmp/brain-mail-never-opened.sock";
    const response = await POST(
      new Request("http://127.0.0.1:3020/api/mail/account", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://brain.test",
        },
        body: JSON.stringify({ emailAddress: "person@example.test", password: "SECRET" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "account_request_invalid" },
    });
  });

  it("returns only a stable service error code", async () => {
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer((_request, response) => {
      writeJson(response, 422, {
        apiVersion: 1,
        error: { code: "imap_authentication_failed" },
      });
    });
    const response = await POST(
      new Request("http://127.0.0.1:3020/api/mail/account", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://brain.test",
        },
        body: JSON.stringify({
          emailAddress: "person@example.test",
          imap: {
            hostname: "imap.example.test",
            port: 993,
            tls: "implicit",
            username: "person@example.test",
            password: "SECRET only in request",
          },
        }),
      }),
    );

    expect(response.status).toBe(422);
    const raw = await response.text();
    expect(raw).toBe(
      JSON.stringify({
        apiVersion: 1,
        error: { code: "imap_authentication_failed" },
      }),
    );
    expect(raw).not.toContain("SECRET");
  });

  it("fails closed when the trusted public origin is not configured", async () => {
    delete process.env.BRAIN_PUBLIC_ORIGIN;
    process.env.BRAIN_MAIL_SOCKET_PATH = "/tmp/brain-mail-never-opened.sock";
    const response = await POST(
      new Request("http://127.0.0.1:3020/api/mail/account", {
        method: "POST",
        headers: {
          Origin: "https://brain.test",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "account_request_invalid" },
    });
  });

  it.each([
    {
      label: "a sibling origin on POST",
      method: "POST",
      headers: {
        Origin: "https://evil.brain.test",
        "Content-Type": "application/json",
      },
      expectedStatus: 403,
    },
    {
      label: "a missing origin on POST",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      expectedStatus: 403,
    },
    {
      label: "a wrong-scheme origin on POST",
      method: "POST",
      headers: {
        Origin: "http://brain.test",
        "Content-Type": "application/json",
      },
      expectedStatus: 403,
    },
    {
      label: "text/plain JSON on POST",
      method: "POST",
      headers: {
        Origin: "https://brain.test",
        "Content-Type": "text/plain",
      },
      expectedStatus: 415,
    },
    {
      label: "a non-UTF-8 JSON parameter on POST",
      method: "POST",
      headers: {
        Origin: "https://brain.test",
        "Content-Type": "application/json; charset=iso-8859-1",
      },
      expectedStatus: 415,
    },
    {
      label: "a sibling origin on DELETE",
      method: "DELETE",
      headers: { Origin: "https://evil.brain.test" },
      expectedStatus: 403,
    },
    {
      label: "a missing origin on DELETE",
      method: "DELETE",
      headers: {},
      expectedStatus: 403,
    },
    {
      label: "a wrong-scheme origin on DELETE",
      method: "DELETE",
      headers: { Origin: "http://brain.test" },
      expectedStatus: 403,
    },
  ])("rejects $label before opening the mail socket", async ({
    method,
    headers,
    expectedStatus,
  }) => {
    process.env.BRAIN_MAIL_SOCKET_PATH = "/tmp/brain-mail-never-opened.sock";
    const request = new Request("https://brain.test/api/mail/account", {
      method,
      headers: new Headers(
        Object.entries(headers).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      body:
        method === "POST"
          ? JSON.stringify({
              emailAddress: "person@example.test",
              imap: {
                hostname: "attacker.example.test",
                port: 993,
                tls: "implicit",
                username: "person@example.test",
                password: "",
              },
            })
          : undefined,
    });
    const response = method === "POST" ? await POST(request) : await DELETE(request);

    expect(response.status).toBe(expectedStatus);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "account_request_invalid" },
    });
  });

  it("rejects an oversized declared body before opening the mail socket", async () => {
    process.env.BRAIN_MAIL_SOCKET_PATH = "/tmp/brain-mail-never-opened.sock";
    const response = await POST(
      new Request("https://brain.test/api/mail/account", {
        method: "POST",
        headers: {
          Origin: "https://brain.test",
          "Content-Type": "application/json",
          "Content-Length": String(16 * 1024 + 1),
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "account_request_invalid" },
    });
  });

  it("rejects an oversized streamed body by observed bytes", async () => {
    process.env.BRAIN_MAIL_SOCKET_PATH = "/tmp/brain-mail-never-opened.sock";
    const oversized = new TextEncoder().encode("x".repeat(16 * 1024 + 1));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(oversized.subarray(0, 8 * 1024));
        controller.enqueue(oversized.subarray(8 * 1024));
        controller.close();
      },
    });
    const response = await POST(
      new Request("https://brain.test/api/mail/account", {
        method: "POST",
        headers: {
          Origin: "https://brain.test",
          "Content-Type": "application/json; charset=utf-8",
        },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "account_request_invalid" },
    });
    expect(oversized.every((byte) => byte === 0)).toBe(true);
  });
});

async function startServer(
  handler: RequestListener,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-route-"));
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

function writeJson(response: ServerResponse, status: number, value: unknown) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}
