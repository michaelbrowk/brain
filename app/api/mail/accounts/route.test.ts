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

import { DELETE, PATCH } from "./[accountId]/route";
import { GET as GET_CAPABILITIES } from "./capabilities/route";
import { GET, POST } from "./route";
import {
  MAIL_ACCOUNT_CAPABILITIES_CONTRACT_HEADER,
  MAIL_ACCOUNT_CAPABILITIES_CONTRACT_VALUE,
} from "@/lib/mail/service/account-types";

const servers: Server[] = [];
const roots: string[] = [];
const ACCOUNT_ID = "account-a11111111111111111111111111111111";

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

describe("/api/mail/accounts", () => {
  it("bridges exact list, create, patch, and scoped delete requests", async () => {
    const requests: Array<{ method: string; path: string; body: string }> = [];
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer(
      async (request, response) => {
        const body = await readBody(request);
        requests.push({
          method: request.method ?? "",
          path: request.url ?? "",
          body,
        });
        writeJson(
          response,
          request.method === "POST" ? 201 : 200,
          request.method === "GET"
            ? { apiVersion: 2, accounts: [accountFixture()] }
            : { apiVersion: 2, account: accountFixture() },
        );
      },
    );

    const listed = await GET(new Request("https://brain.test/api/mail/accounts"));
    const created = await POST(
      jsonRequest("https://brain.test/api/mail/accounts", "POST", createInput()),
    );
    const patched = await PATCH(
      jsonRequest(
        `https://brain.test/api/mail/accounts/${ACCOUNT_ID}`,
        "PATCH",
        { displayName: "Personal" },
      ),
      context(),
    );
    const deleted = await DELETE(
      new Request(`https://brain.test/api/mail/accounts/${ACCOUNT_ID}`, {
        method: "DELETE",
        headers: { Origin: "https://brain.test" },
      }),
      context(),
    );

    expect([listed.status, created.status, patched.status, deleted.status]).toEqual([
      200, 200, 200, 200,
    ]);
    expect(await listed.json()).toEqual({
      apiVersion: 2,
      accounts: [accountFixture()],
    });
    for (const response of [created, patched, deleted]) {
      expect(await response.json()).toEqual({
        apiVersion: 2,
        account: accountFixture(),
      });
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /v2/accounts",
      "POST /v2/accounts",
      `PATCH /v2/accounts/${ACCOUNT_ID}`,
      `DELETE /v2/accounts/${ACCOUNT_ID}`,
    ]);
    expect(JSON.parse(requests[1].body)).toEqual(createInput());
    expect(JSON.parse(requests[2].body)).toEqual({ displayName: "Personal" });
    expect(requests[3].body).toBe("");
  });

  it("bridges the negotiated capability list without changing account CRUD", async () => {
    let requestedContract: string | undefined;
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer(
      (request, response) => {
        requestedContract = request.headers[
          MAIL_ACCOUNT_CAPABILITIES_CONTRACT_HEADER
        ] as string | undefined;
        writeJson(response, 200, {
          apiVersion: 3,
          accounts: [
            {
              ...accountFixture(),
              capabilities: imapCapabilitiesFixture(),
            },
          ],
        });
      },
    );

    const response = await GET_CAPABILITIES(
      new Request("https://brain.test/api/mail/accounts/capabilities"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      apiVersion: 3,
      accounts: [
        {
          ...accountFixture(),
          capabilities: imapCapabilitiesFixture(),
        },
      ],
    });
    expect(requestedContract).toBe(MAIL_ACCOUNT_CAPABILITIES_CONTRACT_VALUE);
  });

  it("rejects cross-origin mutations before opening the socket", async () => {
    process.env.BRAIN_MAIL_SOCKET_PATH = "/tmp/brain-mail-never-opened.sock";
    const created = await POST(
      new Request("https://brain.test/api/mail/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createInput()),
      }),
    );
    const deleted = await DELETE(
      new Request(`https://brain.test/api/mail/accounts/${ACCOUNT_ID}`, {
        method: "DELETE",
        headers: { Origin: "https://evil.brain.test" },
      }),
      context(),
    );
    for (const response of [created, deleted]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({
        apiVersion: 2,
        error: { code: "account_request_invalid" },
      });
    }
  });

  it("rejects malformed and oversized JSON before opening the socket", async () => {
    process.env.BRAIN_MAIL_SOCKET_PATH = "/tmp/brain-mail-never-opened.sock";
    const malformed = await POST(
      new Request("https://brain.test/api/mail/accounts", {
        method: "POST",
        headers: {
          Origin: "https://brain.test",
          "Content-Type": "application/json",
        },
        body: "{",
      }),
    );
    const oversized = await POST(
      new Request("https://brain.test/api/mail/accounts", {
        method: "POST",
        headers: {
          Origin: "https://brain.test",
          "Content-Type": "application/json",
          "Content-Length": String(16 * 1024 + 1),
        },
        body: "{}",
      }),
    );
    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(413);
  });

  it("rejects a DELETE body before opening the socket", async () => {
    process.env.BRAIN_MAIL_SOCKET_PATH = "/tmp/brain-mail-never-opened.sock";
    const response = await DELETE(
      new Request(`https://brain.test/api/mail/accounts/${ACCOUNT_ID}`, {
        method: "DELETE",
        headers: {
          Origin: "https://brain.test",
          "Content-Type": "application/json",
        },
        body: "{}",
      }),
      context(),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      apiVersion: 2,
      error: { code: "account_request_invalid" },
    });
  });
});

function context() {
  return { params: Promise.resolve({ accountId: ACCOUNT_ID }) };
}

function createInput() {
  return {
    providerKind: "imap",
    emailAddress: "person@example.test",
    displayName: null,
    imap: {
      hostname: "imap.example.test",
      port: 993,
      tls: "implicit",
      username: "person@example.test",
      password: "test-password",
    },
  };
}

function accountFixture() {
  return {
    accountId: ACCOUNT_ID,
    emailAddress: "person@example.test",
    displayName: null,
    status: "connected",
    connectedAt: 1,
    createdAt: 1,
    updatedAt: 1,
    providerKind: "imap",
    imap: {
      hostname: "imap.example.test",
      port: 993,
      tls: "implicit",
      username: "person@example.test",
    },
  };
}

function imapCapabilitiesFixture() {
  return {
    mailboxes: ["inbox"],
    listThreads: true,
    sync: true,
    headerPreview: true,
    messageBodies: true,
    threadMutations: true,
    compose: false,
    send: false,
    reply: false,
  };
}

function jsonRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: {
      Origin: "https://brain.test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function startServer(handler: RequestListener): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-accounts-route-"));
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
