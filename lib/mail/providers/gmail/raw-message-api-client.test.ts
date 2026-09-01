import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AtomicMailBlobStore } from "../../service/content-blob-store";
import { GmailApiClient } from "./api-client";
import {
  GMAIL_API_LIMITS,
  GmailApiError,
  type GmailAccessTokenPort,
} from "./api-types";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const MESSAGE_ID = "message-a";
const roots: string[] = [];
const stores: AtomicMailBlobStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Gmail raw message stream", () => {
  it("decodes split base64url with raw first and publishes only after the suffix", async () => {
    const store = await createStore();
    const raw = Buffer.from([0xfb, 0xff, 0x00, 0x41, 0x42, 0x43, 0x0d, 0x0a]);
    const encoded = raw.toString("base64url");
    const body = ` { "raw" : "${encoded}", "sizeEstimate" : ${raw.byteLength}, "id" : "${MESSAGE_ID}" } `;
    const request = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe(`/gmail/v1/users/me/messages/${MESSAGE_ID}`);
      expect([...url.searchParams.entries()]).toEqual([
        ["format", "raw"],
        ["fields", "id,sizeEstimate,raw"],
        ["prettyPrint", "false"],
      ]);
      expect(init?.method).toBe("GET");
      return streamedJsonResponse(body, 1, String(Buffer.byteLength(body)));
    });
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request,
    });

    const result = await client.getRawMessage(MESSAGE_ID, store);

    expect(result).toEqual({
      id: MESSAGE_ID,
      sizeEstimate: raw.byteLength,
      descriptor: descriptorFor(raw),
    });
    expect(await collect(store.read(result.descriptor))).toEqual(raw);
  });

  it.each([
    ["id,sizeEstimate,raw", `{"id":"${MESSAGE_ID}","sizeEstimate":3,"raw":"YWJj"}`],
    ["id,raw,sizeEstimate", `{"id":"${MESSAGE_ID}","raw":"YWJj","sizeEstimate":3}`],
    ["sizeEstimate,id,raw", `{"sizeEstimate":3,"id":"${MESSAGE_ID}","raw":"YWJj"}`],
    ["sizeEstimate,raw,id", `{"sizeEstimate":3,"raw":"YWJj","id":"${MESSAGE_ID}"}`],
    ["raw,id,sizeEstimate", `{"raw":"YWJj","id":"${MESSAGE_ID}","sizeEstimate":3}`],
    ["raw,sizeEstimate,id", `{"raw":"YWJj","sizeEstimate":3,"id":"${MESSAGE_ID}"}`],
  ])("accepts the strict field order %s", async (_order, body) => {
    const store = await createStore();
    const client = clientForResponse(streamedJsonResponse(body, 5));

    await expect(client.getRawMessage(MESSAGE_ID, store)).resolves.toMatchObject({
      descriptor: descriptorFor(Buffer.from("abc")),
    });
  });

  it("accepts the exact 40 MiB raw, padded-base64, and envelope limits", async () => {
    const store = await createStore();
    const rawBytes = GMAIL_API_LIMITS.rawMessageBytes;
    const response = repeatedZeroRawResponse(rawBytes, {
      padded: true,
      envelopeBytes: GMAIL_API_LIMITS.rawResponseBytes,
    });
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi.fn<typeof fetch>().mockResolvedValue(response),
    });

    const result = await client.getRawMessage(MESSAGE_ID, store);

    expect(result.descriptor).toEqual({
      sha256: sha256Zeros(rawBytes),
      bytes: rawBytes,
    });
    expect(
      (
        await stat(
          path.join(store.directoryPath, result.descriptor.sha256),
        )
      ).size,
    ).toBe(rawBytes);
  }, 30_000);

  it("rejects one decoded byte above 40 MiB and removes the temporary file", async () => {
    const store = await createStore();
    const response = repeatedZeroRawResponse(
      GMAIL_API_LIMITS.rawMessageBytes + 1,
      { padded: false },
    );
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi.fn<typeof fetch>().mockResolvedValue(response),
    });

    await expect(client.getRawMessage(MESSAGE_ID, store)).rejects.toEqual(
      new GmailApiError("gmail_response_invalid"),
    );
    expect(await readdir(store.directoryPath)).toEqual([]);
  }, 30_000);

  it.each([
    ["truncated object", `{"raw":"YWJj","id":"${MESSAGE_ID}","sizeEstimate":3`],
    ["escaped raw", `{"raw":"Y\\u0057Jj","id":"${MESSAGE_ID}","sizeEstimate":3}`],
    ["non-canonical base64", `{"raw":"AB","id":"${MESSAGE_ID}","sizeEstimate":1}`],
    ["missing field", `{"raw":"YWJj","id":"${MESSAGE_ID}"}`],
    ["unknown field", `{"raw":"YWJj","id":"${MESSAGE_ID}","sizeEstimate":3,"x":1}`],
    ["trailing value", `{"raw":"YWJj","id":"${MESSAGE_ID}","sizeEstimate":3}[]`],
  ])("rejects malformed JSON: %s", async (_label, body) => {
    const store = await createStore();
    const client = clientForResponse(streamedJsonResponse(body, 2));

    await expect(client.getRawMessage(MESSAGE_ID, store)).rejects.toEqual(
      new GmailApiError("gmail_response_invalid"),
    );
    expect(await readdir(store.directoryPath)).toEqual([]);
  });

  it.each([
    ["id", `{"raw":"YWJj","sizeEstimate":3,"id":"${MESSAGE_ID}","id":"${MESSAGE_ID}"}`],
    ["raw", `{"raw":"YWJj","sizeEstimate":3,"id":"${MESSAGE_ID}","raw":"YWJj"}`],
    ["sizeEstimate", `{"raw":"YWJj","sizeEstimate":3,"id":"${MESSAGE_ID}","sizeEstimate":3}`],
  ])("rejects duplicate %s after raw bytes and does not publish", async (_field, body) => {
    const store = await createStore();
    const client = clientForResponse(streamedJsonResponse(body, 3));

    await expect(client.getRawMessage(MESSAGE_ID, store)).rejects.toEqual(
      new GmailApiError("gmail_response_invalid"),
    );
    expect(await readdir(store.directoryPath)).toEqual([]);
  });

  it("enforces declared content length and cancels an oversized envelope", async () => {
    const mismatchStore = await createStore();
    const body = `{"id":"${MESSAGE_ID}","sizeEstimate":3,"raw":"YWJj"}`;
    const mismatch = clientForResponse(
      streamedJsonResponse(body, 4, String(Buffer.byteLength(body) + 1)),
    );
    await expect(mismatch.getRawMessage(MESSAGE_ID, mismatchStore)).rejects.toEqual(
      new GmailApiError("gmail_response_invalid"),
    );
    expect(await readdir(mismatchStore.directoryPath)).toEqual([]);

    const cancelled = vi.fn();
    const oversizedBody = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(Buffer.from("{}"));
      },
      cancel() {
        cancelled();
      },
    });
    const oversizedStore = await createStore();
    const oversized = clientForResponse(
      new Response(oversizedBody, {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(GMAIL_API_LIMITS.rawResponseBytes + 1),
        },
      }),
    );
    await expect(oversized.getRawMessage(MESSAGE_ID, oversizedStore)).rejects.toEqual(
      new GmailApiError("gmail_response_invalid"),
    );
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(await readdir(oversizedStore.directoryPath)).toEqual([]);
  });

  it("cancels a mid-stream request and removes decoded temporary bytes", async () => {
    const store = await createStore();
    const controller = new AbortController();
    const secondPullStarted = deferred<void>();
    const releaseSecondPull = deferred<void>();
    let pulls = 0;
    const first = Buffer.from(`{"raw":"${"A".repeat(64 * 1024)}`);
    const suffix = Buffer.from(
      `","id":"${MESSAGE_ID}","sizeEstimate":49152}`,
    );
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        pulls += 1;
        if (pulls === 1) {
          stream.enqueue(first.slice());
          return;
        }
        secondPullStarted.resolve(undefined);
        await releaseSecondPull.promise;
        stream.enqueue(suffix.slice());
        stream.close();
      },
    });
    const client = clientForResponse(
      new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const fetching = client.getRawMessage(MESSAGE_ID, store, controller.signal);
    await secondPullStarted.promise;
    controller.abort();
    releaseSecondPull.resolve(undefined);

    await expect(fetching).rejects.toEqual(
      new GmailApiError("gmail_request_cancelled"),
    );
    expect(await readdir(store.directoryPath)).toEqual([]);
  });

  it("replays exactly once after 401 with a forced token refresh", async () => {
    const store = await createStore();
    const tokens: Buffer[] = [];
    const tokenPort = tokenPortFixture(tokens);
    const body = `{"id":"${MESSAGE_ID}","sizeEstimate":3,"raw":"YWJj"}`;
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonErrorResponse(401, "authError"))
      .mockResolvedValueOnce(streamedJsonResponse(body, 2));
    const client = new GmailApiClient({ tokenPort, request });

    await expect(client.getRawMessage(MESSAGE_ID, store)).resolves.toMatchObject({
      descriptor: descriptorFor(Buffer.from("abc")),
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(tokenPort.getAccessToken).toHaveBeenNthCalledWith(
      2,
      { forceRefresh: true },
      expect.any(AbortSignal),
    );
    expect(tokens.every((token) => token.every((byte) => byte === 0))).toBe(true);
  });

  it.each([
    [403, "rateLimitExceeded", "gmail_rate_limited"],
    [403, "domainPolicy", "gmail_permission_denied"],
    [429, "userRateLimitExceeded", "gmail_rate_limited"],
    [503, "backendError", "gmail_service_unavailable"],
  ])("maps raw HTTP %i/%s to %s", async (status, reason, code) => {
    const store = await createStore();
    const client = clientForResponse(jsonErrorResponse(status, reason));

    await expect(client.getRawMessage(MESSAGE_ID, store)).rejects.toEqual(
      new GmailApiError(code as never),
    );
    expect(await readdir(store.directoryPath)).toEqual([]);
  });

  it("maps a raw request network failure without exposing its detail", async () => {
    const store = await createStore();
    const client = new GmailApiClient({
      tokenPort: tokenPortFixture(),
      request: vi.fn<typeof fetch>().mockRejectedValue(
        new Error("socket detail that must not escape"),
      ),
    });

    let caught: unknown;
    try {
      await client.getRawMessage(MESSAGE_ID, store);
    } catch (error) {
      caught = error;
    }
    expect(caught).toEqual(new GmailApiError("gmail_service_unavailable"));
    expect(String(caught)).not.toContain("socket detail");
  });
});

function clientForResponse(response: Response): GmailApiClient {
  return new GmailApiClient({
    tokenPort: tokenPortFixture(),
    request: vi.fn<typeof fetch>().mockResolvedValue(response),
  });
}

function tokenPortFixture(observed: Buffer[] = []): GmailAccessTokenPort {
  return {
    getAccessToken: vi.fn(async ({ forceRefresh }) => {
      const token = Buffer.from(forceRefresh ? "fresh-token" : "cached-token");
      observed.push(token);
      return token;
    }),
  };
}

function streamedJsonResponse(
  value: string,
  chunkBytes: number,
  contentLength?: string,
): Response {
  const source = Buffer.from(value);
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= source.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkBytes, source.byteLength);
      controller.enqueue(source.subarray(offset, end).slice());
      offset = end;
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(contentLength === undefined ? {} : { "Content-Length": contentLength }),
    },
  });
}

function repeatedZeroRawResponse(
  rawBytes: number,
  options: {
    readonly padded: boolean;
    readonly envelopeBytes?: number;
  },
): Response {
  const prefix = Buffer.from(`{"raw":"`);
  const suffix = Buffer.from(
    `","id":"${MESSAGE_ID}","sizeEstimate":${Math.min(
      rawBytes,
      GMAIL_API_LIMITS.rawMessageBytes,
    )}}`,
  );
  const unpaddedCharacters = Math.ceil((rawBytes * 4) / 3);
  const padding = options.padded
    ? "=".repeat((4 - (unpaddedCharacters % 4)) % 4)
    : "";
  const minimumBytes =
    prefix.byteLength + unpaddedCharacters + padding.length + suffix.byteLength;
  const envelopeBytes = options.envelopeBytes ?? minimumBytes;
  if (envelopeBytes < minimumBytes) throw new Error("invalid test envelope");
  let stage: "prefix" | "raw" | "padding" | "suffix" | "spaces" | "done" =
    "prefix";
  let rawRemaining = unpaddedCharacters;
  let spacesRemaining = envelopeBytes - minimumBytes;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (stage === "prefix") {
        controller.enqueue(prefix.slice());
        stage = "raw";
        return;
      }
      if (stage === "raw") {
        const length = Math.min(rawRemaining, 64 * 1024);
        if (length > 0) {
          controller.enqueue(new Uint8Array(length).fill(0x41));
          rawRemaining -= length;
          return;
        }
        stage = "padding";
      }
      if (stage === "padding") {
        if (padding.length > 0) controller.enqueue(Buffer.from(padding));
        stage = "suffix";
        return;
      }
      if (stage === "suffix") {
        controller.enqueue(suffix.slice());
        stage = "spaces";
        return;
      }
      if (stage === "spaces") {
        const length = Math.min(spacesRemaining, 64 * 1024);
        if (length > 0) {
          controller.enqueue(new Uint8Array(length).fill(0x20));
          spacesRemaining -= length;
          return;
        }
        stage = "done";
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(envelopeBytes),
    },
  });
}

function jsonErrorResponse(status: number, reason: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: status,
        message: "provider detail that must not escape",
        errors: [{ reason }],
      },
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

async function createStore(): Promise<AtomicMailBlobStore> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-gmail-raw-test-"));
  roots.push(root);
  const store = new AtomicMailBlobStore({
    cacheRoot: path.join(root, "cache"),
    accountId: ACCOUNT_ID,
  });
  stores.push(store);
  await store.initialize();
  return store;
}

function descriptorFor(value: Uint8Array) {
  return Object.freeze({
    sha256: createHash("sha256").update(value).digest("hex"),
    bytes: value.byteLength,
  });
}

function sha256Zeros(bytes: number): string {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(64 * 1024);
  for (let remaining = bytes; remaining > 0; remaining -= chunk.byteLength) {
    hash.update(chunk.subarray(0, Math.min(remaining, chunk.byteLength)));
  }
  return hash.digest("hex");
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const values: Buffer[] = [];
  for await (const chunk of chunks) values.push(Buffer.from(chunk));
  return Buffer.concat(values);
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
