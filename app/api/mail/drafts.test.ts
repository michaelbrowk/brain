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

import {
  DELETE as deleteDraft,
  GET as getDraft,
  PATCH as updateDraft,
} from "./drafts/[draftId]/route";
import { POST as sendDraft } from "./drafts/[draftId]/send/route";
import { GET as listDrafts, POST as createDraft } from "./drafts/route";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const DRAFT_ID = "draft-00000000-0000-4000-8000-000000000001";
const MUTATION_ID =
  "draft-mutation-00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "send-00000000-0000-4000-8000-000000000001";
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

describe("Brain Mail draft API routes", () => {
  it("bridges exact draft CRUD and send paths without changing payloads", async () => {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer(
      async (request, response) => {
        const raw = await readBody(request);
        requests.push({
          method: request.method ?? "",
          path: request.url ?? "",
          body: raw === "" ? null : JSON.parse(raw) as unknown,
        });
        const pathname = new URL(request.url ?? "/", "http://mail.test").pathname;
        if (pathname.endsWith("/send")) {
          writeJson(response, 202, {
            apiVersion: 1,
            replayed: false,
            appliedRevision: 1,
            operationId: OPERATION_ID,
            created: true,
            status: "queued",
          });
        } else if (request.method === "POST") {
          writeJson(response, 201, {
            apiVersion: 1,
            created: true,
            draft: draftFixture(),
          });
        } else if (request.method === "GET" && pathname === "/v1/drafts") {
          writeJson(response, 200, {
            apiVersion: 1,
            drafts: [draftSummaryFixture()],
          });
        } else if (request.method === "GET") {
          writeJson(response, 200, draftFixture());
        } else if (request.method === "PATCH") {
          writeJson(response, 200, {
            apiVersion: 1,
            replayed: false,
            appliedRevision: 1,
            operationId: null,
          });
        } else {
          writeJson(response, 200, {
            apiVersion: 1,
            deleted: true,
            replayed: false,
          });
        }
      },
    );
    const create = createFixture();
    const patch = patchFixture();
    const deletion = {
      accountId: ACCOUNT_ID,
      draftId: DRAFT_ID,
      mutationId: MUTATION_ID,
      expectedRevision: 1,
    };
    const send = sendFixture();
    const context = { params: Promise.resolve({ draftId: DRAFT_ID }) };

    const responses = [
      await createDraft(jsonRequest("/drafts", "POST", create)),
      await listDrafts(
        new Request(`https://brain.test/api/mail/drafts?accountId=${ACCOUNT_ID}`),
      ),
      await getDraft(
        new Request(
          `https://brain.test/api/mail/drafts/${DRAFT_ID}?accountId=${ACCOUNT_ID}`,
        ),
        context,
      ),
      await updateDraft(jsonRequest(`/drafts/${DRAFT_ID}`, "PATCH", patch), context),
      await deleteDraft(
        jsonRequest(`/drafts/${DRAFT_ID}`, "DELETE", deletion),
        context,
      ),
      await sendDraft(
        jsonRequest(`/drafts/${DRAFT_ID}/send`, "POST", send),
        context,
      ),
    ];

    expect(responses.map((response) => response.status)).toEqual([
      201, 200, 200, 200, 200, 202,
    ]);
    expect(requests).toEqual([
      { method: "POST", path: "/v1/drafts", body: create },
      {
        method: "GET",
        path: `/v1/drafts?accountId=${ACCOUNT_ID}`,
        body: null,
      },
      {
        method: "GET",
        path: `/v1/drafts/${DRAFT_ID}?accountId=${ACCOUNT_ID}`,
        body: null,
      },
      { method: "PATCH", path: `/v1/drafts/${DRAFT_ID}`, body: patch },
      { method: "DELETE", path: `/v1/drafts/${DRAFT_ID}`, body: deletion },
      { method: "POST", path: `/v1/drafts/${DRAFT_ID}/send`, body: send },
    ]);
  });

  it("rejects cross-origin and malformed draft requests before opening UDS", async () => {
    process.env.BRAIN_MAIL_SOCKET_PATH = "/tmp/brain-mail-never-opened.sock";
    const crossOrigin = await createDraft(
      new Request("https://brain.test/api/mail/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createFixture()),
      }),
    );
    const duplicate = await listDrafts(
      new Request(
        `https://brain.test/api/mail/drafts?accountId=${ACCOUNT_ID}&accountId=${ACCOUNT_ID}`,
      ),
    );
    expect(crossOrigin.status).toBe(403);
    expect(duplicate.status).toBe(400);
    await expect(crossOrigin.json()).resolves.toEqual({
      apiVersion: 1,
      error: { code: "mail_draft_request_invalid" },
    });
    await expect(duplicate.json()).resolves.toEqual({
      apiVersion: 1,
      error: { code: "mail_draft_request_invalid" },
    });
  });

  it("forwards codec-valid escaped draft bodies without changing payloads", async () => {
    let receivedBytes = 0;
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer(
      async (request, response) => {
        const raw = await readBody(request);
        receivedBytes = Buffer.byteLength(raw);
        writeJson(response, 201, {
          apiVersion: 1,
          created: true,
          draft: draftFixture(),
        });
      },
    );
    const input = { ...createFixture(), text: "\u0001".repeat(16_000) };
    const response = await createDraft(jsonRequest("/drafts", "POST", input));
    expect(response.status).toBe(201);
    expect(receivedBytes).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(createFixture())),
    );
    expect(receivedBytes).toBeLessThan(8 * 1024 * 1024);
  });
});

function createFixture() {
  return {
    accountId: ACCOUNT_ID,
    draftId: DRAFT_ID,
    intent: { kind: "compose" },
    to: "friend@example.test",
    cc: "",
    bcc: "",
    subject: "Hello",
    text: "Body",
  };
}

function patchFixture() {
  return {
    accountId: ACCOUNT_ID,
    draftId: DRAFT_ID,
    mutationId: MUTATION_ID,
    expectedRevision: 0,
    kind: "patch",
    patch: { subject: "Edited" },
  };
}

function sendFixture() {
  return {
    accountId: ACCOUNT_ID,
    draftId: DRAFT_ID,
    mutationId: MUTATION_ID,
    expectedRevision: 0,
    kind: "send",
    sendIdempotencyKey: "draft-send-key-0001",
    sendOperationId: OPERATION_ID,
  };
}

function draftFixture() {
  return {
    apiVersion: 1,
    accountId: ACCOUNT_ID,
    draftId: DRAFT_ID,
    revision: 0,
    state: "editing",
    intent: { kind: "compose" },
    to: "friend@example.test",
    cc: "",
    bcc: "",
    subject: "Hello",
    text: "Body",
    attachments: [],
    sendOperationId: null,
    sendErrorCode: null,
    createdAt: 100,
    updatedAt: 100,
    sentAt: null,
  };
}

function draftSummaryFixture() {
  const draft = draftFixture();
  return {
    apiVersion: draft.apiVersion,
    accountId: draft.accountId,
    draftId: draft.draftId,
    revision: draft.revision,
    state: draft.state,
    intent: draft.intent,
    subject: draft.subject,
    sendOperationId: draft.sendOperationId,
    sendErrorCode: draft.sendErrorCode,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    sentAt: draft.sentAt,
  };
}

function jsonRequest(pathname: string, method: string, body: unknown): Request {
  return new Request(`https://brain.test/api/mail${pathname}`, {
    method,
    headers: {
      Origin: "https://brain.test",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function startServer(listener: RequestListener): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-draft-route-"));
  roots.push(root);
  const socketPath = path.join(root, "mail.sock");
  const server = createServer(listener);
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
