import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GET as getAttachment } from "./attachments/[attachmentId]/route";
import { GET as getRemoteImage } from "./remote-images/[remoteImageId]/route";
import {
  GET as getContent,
  POST as requestContent,
} from "./message-content/[messageId]/route";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const OTHER_ACCOUNT_ID = "account-a22222222222222222222222222222222";
const MESSAGE_ID = "message_1";
const ATTACHMENT_ID = "attachment-a33333333333333333333333333333333";
const REMOTE_IMAGE_ID = `remote-image-a${"4".repeat(32)}`;
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

describe("Brain Mail content proxy routes", () => {
  it("bridges GET and 202 POST without changing existing message DTOs", async () => {
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer((request, response) => {
      requests.push({ method: request.method ?? "", path: request.url ?? "" });
      writeJson(response, request.method === "POST" ? 202 : 200, {
        apiVersion: 1,
        accountId: ACCOUNT_ID,
        messageId: MESSAGE_ID,
        state: request.method === "POST" ? "fetching" : "not_requested",
      });
    });
    const url = `https://brain.test/api/mail/message-content/${MESSAGE_ID}?accountId=${ACCOUNT_ID}`;
    const read = await getContent(new Request(url), messageContext());
    const queued = await requestContent(
      new Request(url, {
        method: "POST",
        headers: { Origin: "https://brain.test" },
      }),
      messageContext(),
    );

    expect(read.status).toBe(200);
    expect(queued.status).toBe(202);
    expect(await read.json()).toMatchObject({ state: "not_requested" });
    expect(await queued.json()).toMatchObject({ state: "fetching" });
    expect(requests).toEqual([
      {
        method: "GET",
        path: `/v1/message-content/${MESSAGE_ID}?accountId=${ACCOUNT_ID}`,
      },
      {
        method: "POST",
        path: `/v1/message-content/${MESSAGE_ID}?accountId=${ACCOUNT_ID}`,
      },
    ]);
  });

  it("accepts a truly empty proxied POST stream but rejects body bytes and chunked framing", async () => {
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer((request, response) => {
      requests.push({ method: request.method ?? "", path: request.url ?? "" });
      writeJson(response, 202, {
        apiVersion: 1,
        accountId: ACCOUNT_ID,
        messageId: MESSAGE_ID,
        state: "fetching",
      });
    });
    const url = `https://brain.test/api/mail/message-content/${MESSAGE_ID}?accountId=${ACCOUNT_ID}`;

    const emptyStream = await requestContent(
      streamedPost(url, [], { "Content-Length": "0" }),
      messageContext(),
    );
    const emptyStreamWithoutLength = await requestContent(
      streamedPost(url, [new Uint8Array(0)]),
      messageContext(),
    );
    const bodyWithFalseZeroLength = await requestContent(
      streamedPost(url, [Buffer.from("x")], { "Content-Length": "0" }),
      messageContext(),
    );
    const bodyWithoutLength = await requestContent(
      streamedPost(url, [Buffer.from("x")]),
      messageContext(),
    );
    const chunkedEmpty = await requestContent(
      streamedPost(url, [], { "Transfer-Encoding": "chunked" }),
      messageContext(),
    );
    const excessiveZeroChunks = await requestContent(
      streamedPost(
        url,
        Array.from({ length: 9 }, () => new Uint8Array(0)),
      ),
      messageContext(),
    );
    const abortController = new AbortController();
    let bodyCancelled = false;
    const abortedRequest = requestContent(
      new Request(url, {
        method: "POST",
        headers: { Origin: "https://brain.test" },
        body: new ReadableStream<Uint8Array>({
          cancel() {
            bodyCancelled = true;
            return new Promise<void>(() => undefined);
          },
        }),
        duplex: "half",
        signal: abortController.signal,
      } as RequestInit & { duplex: "half" }),
      messageContext(),
    );
    abortController.abort();
    const aborted = await abortedRequest;

    expect(emptyStream.status).toBe(202);
    expect(emptyStreamWithoutLength.status).toBe(202);
    expect(bodyWithFalseZeroLength.status).toBe(400);
    expect(bodyWithoutLength.status).toBe(400);
    expect(chunkedEmpty.status).toBe(400);
    expect(excessiveZeroChunks.status).toBe(400);
    expect(aborted.status).toBe(400);
    expect(bodyCancelled).toBe(true);
    expect(requests).toEqual([
      {
        method: "POST",
        path: `/v1/message-content/${MESSAGE_ID}?accountId=${ACCOUNT_ID}`,
      },
      {
        method: "POST",
        path: `/v1/message-content/${MESSAGE_ID}?accountId=${ACCOUNT_ID}`,
      },
    ]);
  });

  it("forwards only a validated private attachment response", async () => {
    const payload = Buffer.from("attachment body");
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(payload.byteLength),
        "Content-Disposition":
          `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy":
          "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
      });
      response.end(payload);
    });
    const response = await getAttachment(
      new Request(
        `https://brain.test/api/mail/attachments/${ATTACHMENT_ID}?accountId=${ACCOUNT_ID}`,
      ),
      attachmentContext(),
    );

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Cross-Origin-Resource-Policy")).toBe(
      "same-origin",
    );
    expect(response.headers.get("Content-Security-Policy")).toBe(
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(response.headers.get("Accept-Ranges")).toBeNull();
  });

  it("forwards attachment bytes before upstream EOF and propagates cancellation", async () => {
    const release = deferred<void>();
    const upstreamClosed = deferred<void>();
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer(async (_request, response) => {
      response.once("close", () => upstreamClosed.resolve());
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": "10",
        "Content-Disposition":
          `attachment; filename="file.bin"; filename*=UTF-8''file.bin`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy":
          "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
      });
      response.write("first");
      await release.promise;
      response.end("later");
    });
    const response = await getAttachment(
      new Request(
        `https://brain.test/api/mail/attachments/${ATTACHMENT_ID}?accountId=${ACCOUNT_ID}`,
      ),
      attachmentContext(),
    );
    const reader = response.body!.getReader();

    const first = await reader.read();
    expect(Buffer.from(first.value!)).toEqual(Buffer.from("first"));
    await reader.cancel();
    release.resolve();
    await expect(upstreamClosed.promise).resolves.toBeUndefined();
  });

  it("bridges an opaque remote image without exposing its origin URL", async () => {
    const payload = Buffer.from("verified remote image");
    const paths: string[] = [];
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer((request, response) => {
      paths.push(request.url ?? "");
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Content-Length": String(payload.byteLength),
        "Content-Disposition":
          `attachment; filename="attachment"; filename*=UTF-8''attachment`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy":
          "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
      });
      response.end(payload);
    });
    const response = await getRemoteImage(
      new Request(
        `https://brain.test/api/mail/remote-images/${REMOTE_IMAGE_ID}?accountId=${ACCOUNT_ID}`,
      ),
      remoteImageContext(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(payload);
    expect(paths).toEqual([
      `/v1/remote-images/${REMOTE_IMAGE_ID}?accountId=${ACCOUNT_ID}`,
    ]);
    expect(JSON.stringify([...response.headers])).not.toContain(
      "images.example.com",
    );
  });

  it("rejects Range, duplicate ownership queries, and cross-origin POST before I/O", async () => {
    process.env.BRAIN_MAIL_SOCKET_PATH = "/private/tmp/brain-mail-never-opened.sock";
    const ranged = await getAttachment(
      new Request(
        `https://brain.test/api/mail/attachments/${ATTACHMENT_ID}?accountId=${ACCOUNT_ID}`,
        { headers: { Range: "bytes=0-2" } },
      ),
      attachmentContext(),
    );
    const duplicate = await getContent(
      new Request(
        `https://brain.test/api/mail/message-content/${MESSAGE_ID}?accountId=${ACCOUNT_ID}&accountId=${ACCOUNT_ID}`,
      ),
      messageContext(),
    );
    const crossOrigin = await requestContent(
      new Request(
        `https://brain.test/api/mail/message-content/${MESSAGE_ID}?accountId=${ACCOUNT_ID}`,
        { method: "POST", headers: { Origin: "https://evil.test" } },
      ),
      messageContext(),
    );

    expect(ranged.status).toBe(416);
    expect(duplicate.status).toBe(400);
    expect(crossOrigin.status).toBe(403);
  });

  it("fails closed when the service returns content for another account", async () => {
    process.env.BRAIN_MAIL_SOCKET_PATH = await startServer((_request, response) => {
      writeJson(response, 200, {
        apiVersion: 1,
        accountId: OTHER_ACCOUNT_ID,
        messageId: MESSAGE_ID,
        state: "not_requested",
      });
    });
    const response = await getContent(
      new Request(
        `https://brain.test/api/mail/message-content/${MESSAGE_ID}?accountId=${ACCOUNT_ID}`,
      ),
      messageContext(),
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: "mail_service_invalid_response" },
    });
  });
});

function messageContext() {
  return { params: Promise.resolve({ messageId: MESSAGE_ID }) };
}

function attachmentContext() {
  return { params: Promise.resolve({ attachmentId: ATTACHMENT_ID }) };
}

function remoteImageContext() {
  return { params: Promise.resolve({ remoteImageId: REMOTE_IMAGE_ID }) };
}

function streamedPost(
  url: string,
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
): Request {
  return new Request(url, {
    method: "POST",
    headers: { Origin: "https://brain.test", ...headers },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-content-route-"));
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

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
