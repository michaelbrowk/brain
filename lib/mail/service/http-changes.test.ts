import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { readMailChanges } from "../brain-mail-client";
import { MailChangeFeedLoop } from "../change-feed";
import { mailRequestPhase } from "../security";
import { MailChangeFeed } from "./change-feed-ring";
import { createMailServiceHttpServer, MAIL_SERVICE_ERROR_CODES } from "./http";
import type { MailSyncPausePort } from "./sync-pause";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const running: Array<{ server: Server; root: string }> = [];

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

describe("brain-mail change feed route", () => {
  /*
    The stop path, with Brain's own loop and client on the other end. The held
    read is an active keep-alive request, so server.close() alone waits for it
    and the process ran into its 12 s shutdown deadline on every deploy. The
    feed's close() answers it and hangs the connection up, and every read
    after that is refused on a connection that closes.
  */
  it("lets the server stop at once while Brain's loop holds a read", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const changes = new MailChangeFeed({ initialCursor: 41 });
    const { server, socketPath } = await startServerWithHandle({ changes });
    const loop = new MailChangeFeedLoop({
      readChanges: (input, signal) => readMailChanges(input, signal, { socketPath }),
      mailEnabled: async () => true,
      emit: () => undefined,
      onModulesChange: () => () => {},
    });
    loop.start();
    try {
      // The loop's first read takes the cursor; the second is held.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const startedAt = Date.now();
      changes.close();
      const closed = new Promise<number>((resolve) =>
        server.close(() => resolve(Date.now() - startedAt)),
      );
      server.closeIdleConnections();

      await expect(closed).resolves.toBeLessThan(2_000);
    } finally {
      loop.stop();
    }
  });

  it("answers the held read on close on a connection that closes", async () => {
    const changes = new MailChangeFeed({ initialCursor: 41 });
    const socketPath = await startServer({ changes });

    const answer = new Promise<{ status: number; connection: unknown; body: unknown }>(
      (resolve, reject) => {
        const request = httpRequest(
          { socketPath, method: "GET", path: "/v1/changes?cursor=41&wait=25000" },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.once("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                connection: response.headers.connection,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              }),
            );
          },
        );
        request.once("error", reject);
        request.end();
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    changes.close();

    await expect(answer).resolves.toEqual({
      status: 200,
      connection: "close",
      body: { apiVersion: 1, cursor: 41, changes: [] },
    });
  });

  it("refuses a read after close on a connection that closes", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const changes = new MailChangeFeed({ initialCursor: 41 });
    const socketPath = await startServer({ changes });
    changes.close();

    const answer = await new Promise<{ status: number; connection: unknown; body: unknown }>(
      (resolve, reject) => {
        const request = httpRequest(
          { socketPath, method: "GET", path: "/v1/changes?cursor=41&wait=25000" },
          (response) => {
            const chunks: Buffer[] = [];
            response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            response.once("end", () =>
              resolve({
                status: response.statusCode ?? 0,
                connection: response.headers.connection,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              }),
            );
          },
        );
        request.once("error", reject);
        request.end();
      },
    );

    expect(answer).toEqual({
      status: 503,
      connection: "close",
      body: { apiVersion: 1, error: { code: "mail_sync_unavailable" } },
    });
  });

  it("answers a first read with the cursor to wait from", async () => {
    const changes = new MailChangeFeed({ initialCursor: 41 });
    const socketPath = await startServer({ changes });

    await expect(requestJson(socketPath, "/v1/changes?wait=25000")).resolves.toEqual({
      status: 200,
      body: { apiVersion: 1, cursor: 41, changes: [] },
    });
  });

  it("holds a caught-up read and answers with the next change", async () => {
    const changes = new MailChangeFeed({ initialCursor: 41 });
    const socketPath = await startServer({ changes });

    const pending = requestJson(socketPath, "/v1/changes?cursor=41&wait=25000");
    await new Promise((resolve) => setTimeout(resolve, 50));
    changes.append({ accountId: ACCOUNT_ID, mailboxIds: ["inbox"], kind: "sync" });

    await expect(pending).resolves.toEqual({
      status: 200,
      body: {
        apiVersion: 1,
        cursor: 42,
        changes: [{ accountId: ACCOUNT_ID, mailboxIds: ["inbox"], kind: "sync" }],
      },
    });
  });

  it("times a quiet read out empty", async () => {
    const changes = new MailChangeFeed({ initialCursor: 41 });
    const socketPath = await startServer({ changes });

    await expect(requestJson(socketPath, "/v1/changes?cursor=41&wait=30")).resolves.toEqual({
      status: 200,
      body: { apiVersion: 1, cursor: 41, changes: [] },
    });
  });

  it("refuses a second waiting reader as busy and frees the slot when the first leaves", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const changes = new MailChangeFeed({ initialCursor: 41 });
    const socketPath = await startServer({ changes });

    const first = httpRequest({
      socketPath,
      method: "GET",
      path: "/v1/changes?cursor=41&wait=25000",
    });
    first.on("error", () => undefined);
    first.end();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await expect(requestJson(socketPath, "/v1/changes?cursor=41&wait=25000")).resolves.toEqual({
      status: 409,
      body: { apiVersion: 1, error: { code: "mail_changes_busy" } },
    });
    expect(MAIL_SERVICE_ERROR_CODES.relayed).toContain("mail_changes_busy");
    expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toContain(
      '"phase":"changes_get"',
    );

    first.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = requestJson(socketPath, "/v1/changes?cursor=41&wait=25000");
    await new Promise((resolve) => setTimeout(resolve, 50));
    changes.append({ accountId: ACCOUNT_ID, mailboxIds: ["inbox"], kind: "mutation" });
    await expect(again).resolves.toMatchObject({ status: 200, body: { cursor: 42 } });
  });

  it("keeps the cursor and answers nothing while Mail is paused", async () => {
    const changes = new MailChangeFeed({ initialCursor: 41 });
    changes.append({ accountId: ACCOUNT_ID, mailboxIds: ["inbox"], kind: "sync" });
    const syncPause: MailSyncPausePort = {
      isPaused: () => true,
      setPaused: async () => undefined,
    };
    const socketPath = await startServer({ changes, syncPause });

    await expect(requestJson(socketPath, "/v1/changes?cursor=41&wait=30")).resolves.toEqual({
      status: 200,
      body: { apiVersion: 1, cursor: 41, changes: [] },
    });
  });

  it.each([
    "/v1/changes?cursor=-1",
    "/v1/changes?cursor=1.5",
    "/v1/changes?cursor=01",
    "/v1/changes?wait=25001",
    "/v1/changes?wait=10&wait=20",
    "/v1/changes?cursor=1&extra=1",
  ])("refuses the malformed query %s", async (requestPath) => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const socketPath = await startServer({ changes: new MailChangeFeed({ initialCursor: 1 }) });

    await expect(requestJson(socketPath, requestPath)).resolves.toMatchObject({
      status: 400,
      body: { error: { code: "mail_request_invalid" } },
    });
  });

  it("names the route in the request log", () => {
    expect(mailRequestPhase("GET", "/v1/changes")).toBe("changes_get");
  });
});

async function startServer(options: {
  readonly changes: MailChangeFeed;
  readonly syncPause?: MailSyncPausePort;
}): Promise<string> {
  return (await startServerWithHandle(options)).socketPath;
}

async function startServerWithHandle(options: {
  readonly changes: MailChangeFeed;
  readonly syncPause?: MailSyncPausePort;
}): Promise<{ readonly server: Server; readonly socketPath: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-changes-"));
  const socketPath = path.join(root, "mail.sock");
  const server = createMailServiceHttpServer({
    build: { commit: "dev", builtAt: "dev" },
    changes: options.changes,
    ...(options.syncPause ? { syncPause: options.syncPause } : {}),
  });
  running.push({ server, root });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { server, socketPath };
}

function requestJson(
  socketPath: string,
  requestPath: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { socketPath, method: "GET", path: requestPath, headers: { Host: "brain-mail" } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.once("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: response.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}
