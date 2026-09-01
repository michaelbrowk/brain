import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MailDraftError, type MailDraftService } from "./drafts";
import { createMailServiceHttpServer } from "./http";

const ACCOUNT_ID = `account-a${"1".repeat(32)}`;
const DRAFT_ID = "draft-00000000-0000-4000-8000-000000000001";
const MUTATION_ID =
  "draft-mutation-00000000-0000-4000-8000-000000000001";
const OPERATION_ID = "send-00000000-0000-4000-8000-000000000001";
const running: Array<{ readonly server: Server; readonly root: string }> = [];

afterEach(async () => {
  await Promise.all(
    running.splice(0).map(async ({ server, root }) => {
      server.closeAllConnections();
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await rm(root, { recursive: true, force: true });
    }),
  );
  vi.restoreAllMocks();
});

describe("private mail draft HTTP contract", () => {
  it("dispatches exact create/list/read/patch/delete/send routes", async () => {
    const service = draftServiceFixture();
    const socketPath = await startServer(service);
    const create = createInput();
    const patch = patchInput();
    const deletion = {
      accountId: ACCOUNT_ID,
      draftId: DRAFT_ID,
      mutationId: MUTATION_ID,
      expectedRevision: 1,
    };
    const send = sendInput();

    await expect(
      requestJson(socketPath, "POST", "/v1/drafts", JSON.stringify(create)),
    ).resolves.toMatchObject({ status: 201, body: { created: true } });
    await expect(
      requestJson(socketPath, "GET", `/v1/drafts?accountId=${ACCOUNT_ID}`),
    ).resolves.toMatchObject({ status: 200, body: { drafts: [] } });
    await expect(
      requestJson(
        socketPath,
        "GET",
        `/v1/drafts/${DRAFT_ID}?accountId=${ACCOUNT_ID}`,
      ),
    ).resolves.toMatchObject({ status: 200, body: { draftId: DRAFT_ID } });
    await expect(
      requestJson(
        socketPath,
        "PATCH",
        `/v1/drafts/${DRAFT_ID}`,
        JSON.stringify(patch),
      ),
    ).resolves.toMatchObject({
      status: 200,
      body: { appliedRevision: 1, operationId: null },
    });
    await expect(
      requestJson(
        socketPath,
        "DELETE",
        `/v1/drafts/${DRAFT_ID}`,
        JSON.stringify(deletion),
      ),
    ).resolves.toMatchObject({ status: 200, body: { deleted: true } });
    await expect(
      requestJson(
        socketPath,
        "POST",
        `/v1/drafts/${DRAFT_ID}/send`,
        JSON.stringify(send),
      ),
    ).resolves.toMatchObject({
      status: 202,
      body: { operationId: OPERATION_ID, status: "queued" },
    });

    expect(service.create).toHaveBeenCalledWith(
      create,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(service.list).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(service.read).toHaveBeenCalledWith(ACCOUNT_ID, DRAFT_ID);
    expect(service.mutate).toHaveBeenCalledWith(
      patch,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(service.delete).toHaveBeenCalledWith(
      deletion,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(service.send).toHaveBeenCalledWith(
      send,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects ambiguous queries, path/body mismatches, and extended bodies", async () => {
    const service = draftServiceFixture();
    const socketPath = await startServer(service);
    const wrongDraftId = "draft-00000000-0000-4000-8000-000000000002";

    for (const response of [
      await requestJson(
        socketPath,
        "GET",
        `/v1/drafts?accountId=${ACCOUNT_ID}&accountId=${ACCOUNT_ID}`,
      ),
      await requestJson(
        socketPath,
        "PATCH",
        `/v1/drafts/${DRAFT_ID}`,
        JSON.stringify({ ...patchInput(), draftId: wrongDraftId }),
      ),
      await requestJson(
        socketPath,
        "POST",
        `/v1/drafts/${DRAFT_ID}/send`,
        JSON.stringify({ ...sendInput(), secret: "must-not-pass" }),
      ),
    ]) {
      expect(response).toEqual({
        status: 400,
        body: { apiVersion: 1, error: { code: "mail_draft_request_invalid" } },
      });
    }
    expect(service.list).not.toHaveBeenCalled();
    expect(service.mutate).not.toHaveBeenCalled();
    expect(service.send).not.toHaveBeenCalled();
  });

  it("accepts a codec-valid draft whose escaped JSON exceeds the send limit", async () => {
    const service = draftServiceFixture();
    const socketPath = await startServer(service);
    const input = { ...createInput(), text: "\u0001".repeat(201_000) };
    const body = JSON.stringify(input);
    expect(Buffer.byteLength(body)).toBeGreaterThan(1_200_000);
    expect(Buffer.byteLength(body)).toBeLessThan(8 * 1024 * 1024);

    await expect(
      requestJson(socketPath, "POST", "/v1/drafts", body),
    ).resolves.toMatchObject({ status: 201, body: { created: true } });
    expect(service.create).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects raw JSON with an unpaired surrogate before calling the service", async () => {
    const service = draftServiceFixture();
    const socketPath = await startServer(service);
    const body = JSON.stringify({ ...createInput(), text: "\ud800" });
    expect(body).toContain('"text":"\\ud800"');

    await expect(
      requestJson(socketPath, "POST", "/v1/drafts", body),
    ).resolves.toEqual({
      status: 400,
      body: { apiVersion: 1, error: { code: "mail_draft_request_invalid" } },
    });
    expect(service.create).not.toHaveBeenCalled();
  });

  it("maps draft conflicts without exposing internal details", async () => {
    const service = draftServiceFixture();
    vi.mocked(service.mutate).mockRejectedValueOnce(
      new MailDraftError("mail_draft_revision_conflict"),
    );
    vi.mocked(service.send).mockRejectedValueOnce(
      new MailDraftError("mail_draft_service_unavailable"),
    );
    const socketPath = await startServer(service);

    await expect(
      requestJson(
        socketPath,
        "PATCH",
        `/v1/drafts/${DRAFT_ID}`,
        JSON.stringify(patchInput()),
      ),
    ).resolves.toEqual({
      status: 409,
      body: { apiVersion: 1, error: { code: "mail_draft_revision_conflict" } },
    });
    await expect(
      requestJson(
        socketPath,
        "POST",
        `/v1/drafts/${DRAFT_ID}/send`,
        JSON.stringify(sendInput()),
      ),
    ).resolves.toEqual({
      status: 503,
      body: { apiVersion: 1, error: { code: "mail_draft_service_unavailable" } },
    });
  });
});

function draftServiceFixture(): MailDraftService {
  return {
    create: vi.fn(async () => ({
      apiVersion: 1,
      created: true,
      draft: draftDto(),
    } as const)),
    list: vi.fn(async () => ({ apiVersion: 1, drafts: [] } as const)),
    read: vi.fn(async () => draftDto()),
    mutate: vi.fn(async () => ({
      apiVersion: 1,
      replayed: false,
      appliedRevision: 1,
      operationId: null,
    } as const)),
    delete: vi.fn(async () => ({
      apiVersion: 1,
      deleted: true,
      replayed: false,
    } as const)),
    send: vi.fn(async () => ({
      apiVersion: 1,
      replayed: false,
      appliedRevision: 1,
      operationId: OPERATION_ID,
      created: true,
      status: "queued",
    } as const)),
  };
}

function createInput() {
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

function patchInput() {
  return {
    accountId: ACCOUNT_ID,
    draftId: DRAFT_ID,
    mutationId: MUTATION_ID,
    expectedRevision: 0,
    kind: "patch",
    patch: { subject: "Edited" },
  };
}

function sendInput() {
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

function draftDto() {
  return {
    apiVersion: 1 as const,
    accountId: ACCOUNT_ID,
    draftId: DRAFT_ID,
    revision: 0,
    state: "editing" as const,
    intent: { kind: "compose" as const },
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

async function startServer(drafts: MailDraftService): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-http-drafts-"));
  const socketPath = path.join(root, "mail.sock");
  const server = createMailServiceHttpServer({
    build: { commit: "dev", builtAt: "dev" },
    drafts,
  });
  running.push({ server, root });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return socketPath;
}

function requestJson(
  socketPath: string,
  method: string,
  requestPath: string,
  body?: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  return new Promise((resolve, reject) => {
    let responseResult:
      | { readonly status: number; readonly body: unknown }
      | undefined;
    let settled = false;
    const request = httpRequest(
      {
        socketPath,
        method,
        path: requestPath,
        headers: {
          Host: "brain-mail",
          ...(body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          responseResult = {
            status: response.statusCode ?? 0,
            body: raw ? JSON.parse(raw) : null,
          };
          maybeResolve();
        });
      },
    );
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const maybeResolve = () => {
      if (
        settled ||
        responseResult === undefined ||
        (!request.writableFinished && !request.destroyed)
      ) {
        return;
      }
      settled = true;
      resolve(responseResult);
    };
    request.once("close", maybeResolve);
    request.once("finish", maybeResolve);
    request.once("error", (error: Error & { readonly code?: string }) => {
      if (
        responseResult !== undefined &&
        (error.code === "EPIPE" || error.code === "ECONNRESET")
      ) {
        maybeResolve();
        return;
      }
      fail(error);
    });
    request.end(body);
  });
}
