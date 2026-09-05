import { mkdtemp, rm } from "node:fs/promises";
import {
  IncomingMessage,
  ServerResponse,
  request as httpRequest,
  type Server,
} from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MailSystemAdmissionPort } from "../ports";
import { EMPTY_MAIL_SYSTEM_USAGE } from "./admission";
import {
  type MailContentService,
  MailContentServiceError,
} from "./content-coordinator";
import { createMailServiceHttpServer } from "./http";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const MESSAGE_ID = "message_1";
const ATTACHMENT_ID = "attachment-a22222222222222222222222222222222";
const REMOTE_IMAGE_ID = `remote-image-a${"3".repeat(32)}`;
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
});

describe("brain-mail content HTTP API", () => {
  it("exposes exact message states and returns 202 without waiting for content work", async () => {
    const release = deferred<void>();
    const content: MailContentService = {
      getContent: vi.fn(async ({ accountId, messageId }) => ({
        apiVersion: 1 as const,
        accountId,
        messageId,
        state: "not_requested" as const,
      })),
      requestContent: vi.fn(async ({ accountId, messageId }) => {
        void release.promise;
        return {
          apiVersion: 1 as const,
          accountId,
          messageId,
          state: "fetching" as const,
        };
      }),
      downloadAttachment: vi.fn(),
    };
    const socketPath = await startServer(content);
    const query = `accountId=${ACCOUNT_ID}`;

    const read = await request(socketPath, "GET", `/v1/message-content/${MESSAGE_ID}?${query}`);
    const queued = await request(
      socketPath,
      "POST",
      `/v1/message-content/${MESSAGE_ID}?${query}`,
    );
    expect(read.status).toBe(200);
    expect(JSON.parse(read.body.toString("utf8"))).toMatchObject({
      state: "not_requested",
    });
    expect(queued.status).toBe(202);
    expect(JSON.parse(queued.body.toString("utf8"))).toMatchObject({
      state: "fetching",
    });
    expect(content.getContent).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      messageId: MESSAGE_ID,
    });
    expect(content.requestContent).toHaveBeenCalledTimes(1);
    release.resolve();
  });

  it("forces a private nosniff same-origin download with a safe RFC5987 filename", async () => {
    const payload = Buffer.from("download bytes");
    const dispose = vi.fn(async () => undefined);
    const content: MailContentService = {
      getContent: vi.fn(),
      requestContent: vi.fn(),
      downloadAttachment: vi.fn(async () => ({
        accountId: ACCOUNT_ID,
        messageId: MESSAGE_ID,
        attachmentId: ATTACHMENT_ID,
        filename: "re\r\nport\u202e.pdf",
        mimeType: "application/pdf",
        bytes: payload.byteLength,
        body: chunks(payload, 4),
        dispose,
      })),
    };
    const socketPath = await startServer(content);
    const result = await request(
      socketPath,
      "GET",
      `/v1/attachments/${ATTACHMENT_ID}?accountId=${ACCOUNT_ID}`,
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual(payload);
    expect(result.headers["content-type"]).toBe("application/pdf");
    expect(result.headers["content-disposition"]).toBe(
      `attachment; filename="report.pdf"; filename*=UTF-8''report.pdf`,
    );
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(result.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(result.headers["content-security-policy"]).toBe(
      "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'",
    );
    expect(result.headers["accept-ranges"]).toBeUndefined();
    expect(String(result.headers["content-disposition"])).not.toMatch(
      /[\r\n\u202e]/,
    );
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("streams a remote image only through its opaque same-origin route", async () => {
    const payload = Buffer.from("verified image bytes");
    const dispose = vi.fn(async () => undefined);
    const downloadRemoteImage = vi.fn(async () => ({
      accountId: ACCOUNT_ID,
      messageId: MESSAGE_ID,
      attachmentId: REMOTE_IMAGE_ID,
      filename: null,
      mimeType: "image/png",
      bytes: payload.byteLength,
      body: chunks(payload, 5),
      dispose,
    }));
    const content: MailContentService = {
      getContent: vi.fn(),
      requestContent: vi.fn(),
      downloadAttachment: vi.fn(),
      downloadRemoteImage,
    };
    const socketPath = await startServer(content);
    const result = await request(
      socketPath,
      "GET",
      `/v1/remote-images/${REMOTE_IMAGE_ID}?accountId=${ACCOUNT_ID}`,
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual(payload);
    expect(result.headers["content-type"]).toBe("image/png");
    expect(result.headers["cache-control"]).toBe("private, no-store");
    expect(result.headers["x-content-type-options"]).toBe("nosniff");
    expect(result.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(downloadRemoteImage).toHaveBeenCalledWith({
      accountId: ACCOUNT_ID,
      remoteImageId: REMOTE_IMAGE_ID,
      signal: expect.any(AbortSignal),
    });
    expect(JSON.stringify(result.headers)).not.toContain("images.example.com");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("answers 410 for an image the cache has refused for good", async () => {
    const content: MailContentService = {
      getContent: vi.fn(),
      requestContent: vi.fn(),
      downloadAttachment: vi.fn(),
      downloadRemoteImage: vi.fn(async () => {
        throw new MailContentServiceError("mail_content_remote_image_refused");
      }),
    };
    const socketPath = await startServer(content);
    const refused = await request(
      socketPath,
      "GET",
      `/v1/remote-images/${REMOTE_IMAGE_ID}?accountId=${ACCOUNT_ID}`,
    );

    expect(refused.status).toBe(410);
    expect(JSON.parse(refused.body.toString("utf8"))).toEqual({
      apiVersion: 1,
      error: { code: "mail_content_remote_image_refused" },
    });
  });

  it("holds one download permit until the streamed response finishes", async () => {
    const started = deferred<void>();
    const finish = deferred<void>();
    const dispose = vi.fn(async () => undefined);
    const admission = trackingAdmission();
    const content: MailContentService = {
      getContent: vi.fn(),
      requestContent: vi.fn(),
      downloadAttachment: vi.fn(async () => ({
        accountId: ACCOUNT_ID,
        messageId: MESSAGE_ID,
        attachmentId: ATTACHMENT_ID,
        filename: "stream.bin",
        mimeType: "application/octet-stream",
        bytes: 8,
        body: (async function* () {
          yield Buffer.from("four");
          started.resolve();
          await finish.promise;
          yield Buffer.from("more");
        })(),
        dispose,
      })),
    };
    const socketPath = await startServer(content, admission.port);
    const pending = request(
      socketPath,
      "GET",
      `/v1/attachments/${ATTACHMENT_ID}?accountId=${ACCOUNT_ID}`,
    );

    await started.promise;
    expect(admission.release).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    finish.resolve();
    await expect(pending).resolves.toMatchObject({ status: 200, body: Buffer.from("fourmore") });
    expect(admission.release).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("contains a midstream failure and keeps serving requests", async () => {
    const dispose = vi.fn(async () => undefined);
    const admission = trackingAdmission();
    const unhandled: unknown[] = [];
    const observeUnhandled = (reason: unknown) => unhandled.push(reason);
    const content: MailContentService = {
      getContent: vi.fn(),
      requestContent: vi.fn(),
      downloadAttachment: vi.fn(async () => ({
        accountId: ACCOUNT_ID,
        messageId: MESSAGE_ID,
        attachmentId: ATTACHMENT_ID,
        filename: "broken.bin",
        mimeType: "application/octet-stream",
        bytes: 8,
        body: (async function* () {
          yield Buffer.from("four");
          throw new Error("injected stream failure");
        })(),
        dispose,
      })),
    };
    const socketPath = await startServer(content, admission.port);
    process.on("unhandledRejection", observeUnhandled);
    try {
      await expect(
        requestUntilDisconnect(
          socketPath,
          `/v1/attachments/${ATTACHMENT_ID}?accountId=${ACCOUNT_ID}`,
        ),
      ).resolves.toEqual(Buffer.from("four"));
      await vi.waitFor(() => {
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(admission.release).toHaveBeenCalledTimes(1);
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      await expect(request(socketPath, "GET", "/v1/health")).resolves.toMatchObject({
        status: 200,
      });
    } finally {
      process.off("unhandledRejection", observeUnhandled);
    }
  });

  it("aborts and releases a response closed after end but before finish", async () => {
    const dispose = vi.fn(async () => undefined);
    const admission = trackingAdmission();
    let observedSignal: AbortSignal | undefined;
    const content: MailContentService = {
      getContent: vi.fn(),
      requestContent: vi.fn(),
      downloadAttachment: vi.fn(async ({ signal }) => {
        observedSignal = signal;
        return {
          accountId: ACCOUNT_ID,
          messageId: MESSAGE_ID,
          attachmentId: ATTACHMENT_ID,
          filename: "empty.bin",
          mimeType: "application/octet-stream",
          bytes: 0,
          body: chunks(Buffer.alloc(0), 1),
          dispose,
        };
      }),
    };
    const server = createMailServiceHttpServer({
      build: { commit: "dev", builtAt: "dev" },
      content,
      admission: admission.port,
    });
    const socket = new HeldWriteSocket();
    const requestMessage = new IncomingMessage(socket as unknown as Socket);
    requestMessage.method = "GET";
    requestMessage.url =
      `/v1/attachments/${ATTACHMENT_ID}?accountId=${ACCOUNT_ID}`;
    requestMessage.headers = { host: "brain-mail" };
    requestMessage.rawHeaders.push("Host", "brain-mail");
    const response = new ServerResponse(requestMessage);
    response.assignSocket(socket as unknown as Socket);
    socket.on("error", () => undefined);
    response.on("error", () => undefined);

    try {
      server.emit("request", requestMessage, response);
      await vi.waitFor(() => {
        expect(response.headersSent).toBe(true);
        expect(response.writableEnded).toBe(true);
        expect(response.writableFinished).toBe(false);
      });

      response.emit("close");

      await vi.waitFor(() => {
        expect(observedSignal?.aborted).toBe(true);
        expect(dispose).toHaveBeenCalledTimes(1);
        expect(admission.release).toHaveBeenCalledTimes(1);
      });
    } finally {
      response.destroy();
      socket.destroy();
      server.removeAllListeners();
    }
  });

  it("releases a reservation that resolves after the client has gone away", async () => {
    const reserveStarted = deferred<void>();
    const lateReservation = deferred<{ readonly reservationId: string }>();
    const release = vi.fn(async () => undefined);
    const admission: MailSystemAdmissionPort = {
      readUsage: async () => EMPTY_MAIL_SYSTEM_USAGE,
      reserve: vi.fn(async () => {
        reserveStarted.resolve();
        return lateReservation.promise;
      }),
      release,
    };
    const content: MailContentService = {
      getContent: vi.fn(),
      requestContent: vi.fn(),
      downloadAttachment: vi.fn(),
    };
    const socketPath = await startServer(content, admission);
    const call = httpRequest({
      socketPath,
      method: "GET",
      path: `/v1/attachments/${ATTACHMENT_ID}?accountId=${ACCOUNT_ID}`,
    });
    call.on("error", () => undefined);
    call.end();
    await reserveStarted.promise;
    call.destroy();
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    lateReservation.resolve({ reservationId: `reservation-r${"1".repeat(32)}` });

    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledWith(`reservation-r${"1".repeat(32)}`);
    });
  });

  it("disposes a download that resolves after the client has gone away", async () => {
    const downloadStarted = deferred<void>();
    const lateDownload = deferred<Awaited<ReturnType<MailContentService["downloadAttachment"]>>>();
    const dispose = vi.fn(async () => undefined);
    const admission = trackingAdmission();
    const content: MailContentService = {
      getContent: vi.fn(),
      requestContent: vi.fn(),
      downloadAttachment: vi.fn(async () => {
        downloadStarted.resolve();
        return lateDownload.promise;
      }),
    };
    const socketPath = await startServer(content, admission.port);
    const call = httpRequest({
      socketPath,
      method: "GET",
      path: `/v1/attachments/${ATTACHMENT_ID}?accountId=${ACCOUNT_ID}`,
    });
    call.on("error", () => undefined);
    call.end();
    await downloadStarted.promise;
    call.destroy();
    lateDownload.resolve({
      accountId: ACCOUNT_ID,
      messageId: MESSAGE_ID,
      attachmentId: ATTACHMENT_ID,
      filename: null,
      mimeType: "application/octet-stream",
      bytes: 0,
      body: chunks(Buffer.alloc(0), 1),
      dispose,
    });

    await vi.waitFor(() => {
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(admission.release).toHaveBeenCalledTimes(1);
    });
  });

  it("destroys an attachment stream that exceeds its declared Content-Length", async () => {
    const dispose = vi.fn(async () => undefined);
    const admission = trackingAdmission();
    const content: MailContentService = {
      getContent: vi.fn(),
      requestContent: vi.fn(),
      downloadAttachment: vi.fn(async () => ({
        accountId: ACCOUNT_ID,
        messageId: MESSAGE_ID,
        attachmentId: ATTACHMENT_ID,
        filename: "overflow.bin",
        mimeType: "application/octet-stream",
        bytes: 4,
        body: chunks(Buffer.from("extra"), 5),
        dispose,
      })),
    };
    const socketPath = await startServer(content, admission.port);

    await expect(
      request(
        socketPath,
        "GET",
        `/v1/attachments/${ATTACHMENT_ID}?accountId=${ACCOUNT_ID}`,
      ),
    ).rejects.toBeInstanceOf(Error);
    await vi.waitFor(() => {
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(admission.release).toHaveBeenCalledTimes(1);
    });
  });

  it("rejects Range and non-internal attachment ids before reading bytes", async () => {
    const content: MailContentService = {
      getContent: vi.fn(),
      requestContent: vi.fn(),
      downloadAttachment: vi.fn(),
    };
    const socketPath = await startServer(content);
    const ranged = await request(
      socketPath,
      "GET",
      `/v1/attachments/${ATTACHMENT_ID}?accountId=${ACCOUNT_ID}`,
      undefined,
      { Range: "bytes=0-3" },
    );
    const providerId = await request(
      socketPath,
      "GET",
      `/v1/attachments/provider_attachment?accountId=${ACCOUNT_ID}`,
    );

    expect(ranged.status).toBe(416);
    expect(JSON.parse(ranged.body.toString("utf8"))).toEqual({
      apiVersion: 1,
      error: { code: "mail_attachment_range_unsupported" },
    });
    expect(ranged.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(providerId.status).toBe(404);
    expect(content.downloadAttachment).not.toHaveBeenCalled();
  });

  it("requires one exact account query and forbids a POST body", async () => {
    const content: MailContentService = {
      getContent: vi.fn(),
      requestContent: vi.fn(),
      downloadAttachment: vi.fn(),
    };
    const socketPath = await startServer(content);
    const duplicate = await request(
      socketPath,
      "GET",
      `/v1/message-content/${MESSAGE_ID}?accountId=${ACCOUNT_ID}&accountId=${ACCOUNT_ID}`,
    );
    const body = await request(
      socketPath,
      "POST",
      `/v1/message-content/${MESSAGE_ID}?accountId=${ACCOUNT_ID}`,
      "{}",
    );
    expect(duplicate.status).toBe(400);
    expect(body.status).toBe(400);
    expect(content.getContent).not.toHaveBeenCalled();
    expect(content.requestContent).not.toHaveBeenCalled();
  });
});

async function startServer(
  content: MailContentService,
  admission?: MailSystemAdmissionPort,
): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-content-http-"));
  const socketPath = path.join(root, "mail.sock");
  const server = createMailServiceHttpServer({
    build: { commit: "dev", builtAt: "dev" },
    content,
    admission,
  });
  running.push({ server, root });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return socketPath;
}

function request(
  socketPath: string,
  method: string,
  requestPath: string,
  body?: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    const call = httpRequest(
      {
        socketPath,
        method,
        path: requestPath,
        headers: {
          ...extraHeaders,
          ...(body === undefined
            ? {}
            : { "Content-Length": String(Buffer.byteLength(body)) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    call.once("error", reject);
    call.end(body);
  });
}

function requestUntilDisconnect(socketPath: string, requestPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const call = httpRequest(
      { socketPath, method: "GET", path: requestPath },
      (response) => {
        const chunks: Buffer[] = [];
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          const body = Buffer.concat(chunks);
          if (body.byteLength > 0) resolve(body);
          else reject(error ?? new Error("response closed before sending bytes"));
        };
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("aborted", () => finish());
        response.once("error", finish);
        response.once("end", () => {
          if (settled) return;
          settled = true;
          reject(new Error("response unexpectedly completed"));
        });
      },
    );
    call.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    call.end();
  });
}

async function* chunks(
  value: Buffer,
  size: number,
): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < value.byteLength; offset += size) {
    yield value.subarray(offset, Math.min(value.byteLength, offset + size));
  }
}

function trackingAdmission(): {
  readonly port: MailSystemAdmissionPort;
  readonly reserve: ReturnType<typeof vi.fn>;
  readonly release: ReturnType<typeof vi.fn>;
} {
  const reserve = vi.fn(async () => ({
    reservationId: `reservation-r${"2".repeat(32)}`,
  }));
  const release = vi.fn(async () => undefined);
  return {
    port: {
      readUsage: async () => EMPTY_MAIL_SYSTEM_USAGE,
      reserve,
      release,
    },
    reserve,
    release,
  };
}

class HeldWriteSocket extends Duplex {
  private pendingWrite: ((error?: Error | null) => void) | null = null;

  override _read(): void {}

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.pendingWrite = callback;
  }

  override _destroy(
    _error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    const pendingWrite = this.pendingWrite;
    this.pendingWrite = null;
    pendingWrite?.(new Error("socket closed before write completed"));
    callback(null);
  }
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
