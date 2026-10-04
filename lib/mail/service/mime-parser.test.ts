import { createHash } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MailMimeParseBudget, MailMimeParseOutcome } from "../ports";
import { UnixSocketMailMimeParser } from "./mime-parser-client";
import { runMimeParserWorkerConnection } from "./mime-parser-runtime";
import { BMP1_FRAME, writeBmp1JsonFrame } from "./mime-protocol";

let socketSequence = 0;
const sockets = new Set<string>();
const servers = new Set<Server>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())).catch(
          () => undefined,
        ),
    ),
  );
  servers.clear();
  await Promise.all([...sockets].map((socketPath) => unlink(socketPath).catch(() => undefined)));
  sockets.clear();
});

describe("isolated BMP1 MIME parser", () => {
  it("decodes quoted-printable/base64 and returns inert HTML plus attachment metadata", async () => {
    const attachment = tinyPng();
    const html = [
      '<p onclick="steal()">Hello',
      "<script>alert(1)</script>",
      '<img src="https://tracker.example/pixel" alt="tracker">',
      '<img src="https://127.0.0.1/internal" alt="internal blocked">',
      '<img src="cid:pixel@example.com">',
      '<a href="javascript:steal()">bad</a>',
      '<a href="https://example.com/path">safe</a>',
      "</p>",
    ].join("");
    const raw = Buffer.from(
      [
        "From: Alice <alice@example.com>",
        "To: Bob <bob@example.com>",
        "Subject: MIME fixture",
        'Content-Type: multipart/related; boundary="mix"',
        "",
        "--mix",
        'Content-Type: text/plain; charset="utf-8"',
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "Hello =F0=9F=8C=8D",
        "--mix",
        'Content-Type: text/html; charset="utf-8"',
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(html).toString("base64"),
        "--mix",
        'Content-Type: image/png; name="pixel.png"',
        'Content-Disposition: inline; filename="pixel.png"',
        "Content-ID: <pixel@example.com>",
        "Content-Transfer-Encoding: base64",
        "",
        attachment.toString("base64"),
        "--mix--",
        "",
      ].join("\r\n"),
    );

    const result = await parseWithWorker(raw);
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.artifacts.text?.data.toString()).toContain("Hello 🌍");
    const sanitized = result.artifacts.sanitizedHtml?.data.toString() ?? "";
    expect(sanitized).toContain("Hello");
    expect(sanitized).toContain("internal blocked");
    expect(sanitized).toContain('data-brain-cid="pixel@example.com"');
    expect(sanitized).toContain('data-brain-href="https://example.com/path"');
    expect(sanitized).not.toMatch(/script|onclick|javascript:|https:\/\/tracker|\ssrc=/i);
    expect(result.artifacts.remoteImages).toHaveLength(1);
    expect(result.artifacts.remoteImages[0]).toMatchObject({
      sourceUrl: "https://tracker.example/pixel",
    });
    expect(sanitized).toContain(
      `data-brain-remote-image="${result.artifacts.remoteImages[0]!.remoteImageId}"`,
    );
    expect(result.artifacts.remoteImages[0]!.remoteImageId).toMatch(
      /^remote-image-a[0-9a-f]{32}$/,
    );
    expect(result.artifacts.attachments).toHaveLength(1);
    expect(result.artifacts.attachments[0]).toMatchObject({
      filename: "pixel.png",
      mimeType: "image/png",
      disposition: "inline",
      contentId: "pixel@example.com",
    });
    expect(result.artifacts.attachments[0]!.blob.data).toEqual(attachment);
  });

  it("treats a referenced CID with no disposition as inline but honors explicit attachment", async () => {
    const attachment = tinyPng();
    const raw = Buffer.from(
      [
        'Content-Type: multipart/related; boundary="cid"',
        "",
        "--cid",
        'Content-Type: text/html; charset="utf-8"',
        "",
        '<img src="cid:implicit@example.test"><img src="cid:download@example.test">',
        "--cid",
        'Content-Type: image/png; name="implicit.png"',
        "Content-ID: <implicit@example.test>",
        "Content-Transfer-Encoding: base64",
        "",
        attachment.toString("base64"),
        "--cid",
        'Content-Type: image/png; name="download.png"',
        'Content-Disposition: attachment; filename="download.png"',
        "Content-ID: <download@example.test>",
        "Content-Transfer-Encoding: base64",
        "",
        attachment.toString("base64"),
        "--cid--",
        "",
      ].join("\r\n"),
    );

    const result = await parseWithWorker(raw);
    expect(result.kind).toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.artifacts.attachments).toHaveLength(2);
    expect(result.artifacts.attachments[0]).toMatchObject({
      disposition: "inline",
      contentId: "implicit@example.test",
    });
    expect(result.artifacts.attachments[1]).toMatchObject({
      disposition: "attachment",
      contentId: null,
    });
  });

  it("preserves UTF-8 when the parent readable splits a code point", async () => {
    const raw = Buffer.from(
      "From: a@example.com\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSplit 🌍 safely",
    );
    const emoji = raw.indexOf(Buffer.from("🌍"));
    const chunks = [
      raw.subarray(0, emoji + 1),
      raw.subarray(emoji + 1, emoji + 3),
      raw.subarray(emoji + 3),
    ];
    const result = await parseWithWorker(raw, {}, chunks);
    expect(result.kind).toBe("parsed");
    if (result.kind === "parsed") {
      expect(result.artifacts.text?.data.toString()).toContain("Split 🌍 safely");
    }
  });

  it.each([
    {
      label: "aggregate headers",
      raw: Buffer.from(`Subject: ${"x".repeat(300)}\r\n\r\nbody`),
      budget: { maxHeaderBytes: 128 },
    },
    {
      label: "parts",
      raw: Buffer.from(
        [
          'Content-Type: multipart/mixed; boundary="p"',
          "",
          "--p",
          "Content-Type: text/plain",
          "",
          "one",
          "--p",
          "Content-Type: text/plain",
          "",
          "two",
          "--p--",
          "",
        ].join("\r\n"),
      ),
      budget: { maxParts: 2 },
    },
    {
      label: "nesting depth",
      raw: Buffer.from(
        [
          'Content-Type: multipart/mixed; boundary="outer"',
          "",
          "--outer",
          'Content-Type: multipart/mixed; boundary="inner"',
          "",
          "--inner",
          "Content-Type: text/plain",
          "",
          "deep",
          "--inner--",
          "--outer--",
          "",
        ].join("\r\n"),
      ),
      budget: { maxDepth: 2 },
    },
  ])("rejects $label before publishing artifacts", async ({ raw, budget }) => {
    const result = await parseWithWorker(raw, budget);
    expect(result).toEqual({
      kind: "permanent_failure",
      errorCode: "mail_mime_limit_exceeded",
    });
  });

  it("parses a bounded 300 KB one-line HTML body without weakening header limits", async () => {
    const html = `<p>${"x".repeat(300 * 1024)}</p>`;
    const raw = Buffer.from(
      [
        "From: a@example.com",
        'Content-Type: text/html; charset="utf-8"',
        "",
        html,
      ].join("\r\n"),
    );

    const result = await parseWithWorker(raw, {
      maxRawBytes: 512 * 1024,
      maxHtmlCharacters: 384 * 1024,
    });

    expect(result.kind).toBe("parsed");
    if (result.kind === "parsed") {
      expect(result.artifacts.sanitizedHtml?.data.toString()).toBe(html);
    }

    const oversizedHeader = Buffer.from(
      `Subject: ${"x".repeat(300 * 1024)}\r\n\r\nbody`,
    );
    await expect(
      parseWithWorker(oversizedHeader, {
        maxRawBytes: 512 * 1024,
        maxHeaderBytes: 256 * 1024,
      }),
    ).resolves.toEqual({
      kind: "permanent_failure",
      errorCode: "mail_mime_limit_exceeded",
    });
  });

  it("rejects an oversized remote-image manifest as a permanent MIME limit", async () => {
    const html = Array.from(
      { length: 32 },
      (_, index) =>
        `<img src="https://images.example.com/banner.png?n=${index}&amp;p=${"x".repeat(1_980)}">`,
    ).join("");
    const raw = Buffer.from(
      [
        "From: a@example.com",
        'Content-Type: text/html; charset="utf-8"',
        "",
        html,
      ].join("\r\n"),
    );

    await expect(parseWithWorker(raw)).resolves.toEqual({
      kind: "permanent_failure",
      errorCode: "mail_mime_limit_exceeded",
    });
  });

  it("contains malformed MIME without turning it into a transient retry", async () => {
    const raw = Buffer.from(
      [
        'Content-Type: multipart/mixed; boundary="never-closed"',
        "",
        "--never-closed",
        "Content-Type: text/plain",
        "Content-Transfer-Encoding: base64",
        "",
        "%%%not-base64%%%",
      ].join("\r\n"),
    );
    const result = await parseWithWorker(raw);
    expect(["parsed", "permanent_failure"]).toContain(result.kind);
  });

  it("reports a connection closed before any answer as dropped, and recovers on the next message", async () => {
    // What the parser socket does with a connection past its limit.
    const socketPath = nextSocketPath();
    await startServer(socketPath, (socket) => socket.destroy());
    const parser = new UnixSocketMailMimeParser({ socketPath });
    const raw = Buffer.from("From: a@example.com\r\n\r\nfirst");
    await expect(parse(parser, raw)).resolves.toEqual({
      kind: "transient_failure",
      errorCode: "mail_mime_worker_dropped",
    });

    await unlink(socketPath).catch(() => undefined);
    await startServer(socketPath, (socket) => {
      void runMimeParserWorkerConnection(socket);
    });
    const recovered = await parse(parser, Buffer.from("From: a@example.com\r\n\r\nsecond"));
    expect(recovered.kind).toBe("parsed");
    if (recovered.kind === "parsed") {
      expect(recovered.artifacts.text?.data.toString()).toBe("second");
    }
  });

  it("reports a worker that read the request and hung up without a word as dropped", async () => {
    const socketPath = nextSocketPath();
    await startServer(socketPath, (socket) => {
      socket.on("error", () => undefined);
      socket.once("data", () => socket.destroy());
    });
    const raw = Buffer.from("From: a@example.com\r\n\r\nunanswered");
    await expect(
      parse(new UnixSocketMailMimeParser({ socketPath }), raw),
    ).resolves.toEqual({
      kind: "transient_failure",
      errorCode: "mail_mime_worker_dropped",
    });
  });

  it("reports a worker that answered and then went quiet as crashed", async () => {
    const socketPath = nextSocketPath();
    await startServer(socketPath, (socket) => {
      socket.on("error", () => undefined);
      socket.once("data", () => {
        void writeBmp1JsonFrame(socket, BMP1_FRAME.artifactBegin, { kind: "text" })
          .catch(() => undefined)
          .finally(() => socket.destroy());
      });
    });
    const raw = Buffer.from("From: a@example.com\r\n\r\nhalf answered");
    await expect(
      parse(new UnixSocketMailMimeParser({ socketPath }), raw),
    ).resolves.toEqual({
      kind: "transient_failure",
      errorCode: "mail_mime_worker_crashed",
    });
  });

  it("cuts off a worker that exceeds the caller deadline", async () => {
    const socketPath = nextSocketPath();
    await startServer(socketPath, (socket) => {
      socket.on("error", () => undefined);
      socket.resume();
    });
    const raw = Buffer.from("From: a@example.com\r\n\r\ntimeout");
    const result = await parse(new UnixSocketMailMimeParser({ socketPath }), raw, {
      deadlineAt: Date.now() + 100,
    });
    expect(result).toEqual({
      kind: "transient_failure",
      errorCode: "mail_mime_worker_timeout",
    });
  });

  it("answers an aborted parse only once the worker has closed the connection", async () => {
    // A worker part way through a synchronous sanitize hears the hang-up
    // late, and the parser socket counts it until then.
    const socketPath = nextSocketPath();
    const events: string[] = [];
    const worker = await startBusyWorker(socketPath, events, (socket) => {
      setTimeout(() => {
        events.push("worker closed");
        socket.destroy();
      }, 80);
    });
    const controller = new AbortController();
    const raw = Buffer.from("From: a@example.com\r\n\r\ndisplaced");
    const parsing = parse(
      new UnixSocketMailMimeParser({ socketPath }),
      raw,
      {},
      [raw],
      controller.signal,
    ).then((outcome) => {
      events.push("answered");
      return outcome;
    });
    await vi.waitFor(() => expect(worker.receivedBytes()).toBeGreaterThan(raw.length));
    controller.abort();

    await expect(parsing).resolves.toEqual({
      kind: "transient_failure",
      errorCode: "mail_mime_aborted",
    });
    expect(events.slice(0, 3)).toEqual(["hang-up heard", "worker closed", "answered"]);
  });

  it("hangs up on a worker that was still starting when the parse was aborted, and waits for it too", async () => {
    const socketPath = nextSocketPath();
    const events: string[] = [];
    const worker = await startBusyWorker(socketPath, events, (socket) => {
      setTimeout(() => {
        events.push("worker closed");
        socket.destroy();
      }, 40);
    });
    const controller = new AbortController();
    const raw = Buffer.from("From: a@example.com\r\n\r\nnever sent");
    // The abort lands while the connection is being made, before the client
    // listens for it.
    const parsing = parse(
      new UnixSocketMailMimeParser({ socketPath }),
      raw,
      {},
      [raw],
      controller.signal,
    ).then((outcome) => {
      events.push("answered");
      return outcome;
    });
    controller.abort();

    await expect(parsing).resolves.toEqual({
      kind: "transient_failure",
      errorCode: "mail_mime_aborted",
    });
    expect(events.slice(0, 3)).toEqual(["hang-up heard", "worker closed", "answered"]);
    expect(worker.receivedBytes()).toBe(0);
  });

  it("gives up on a worker that does not close within the let-go deadline", async () => {
    const socketPath = nextSocketPath();
    const events: string[] = [];
    const worker = await startBusyWorker(socketPath, events, () => undefined);
    const controller = new AbortController();
    const raw = Buffer.from("From: a@example.com\r\n\r\nstuck");
    const parsing = parse(
      new UnixSocketMailMimeParser({ socketPath, workerLetGoDeadlineMs: 60 }),
      raw,
      {},
      [raw],
      controller.signal,
    );
    await vi.waitFor(() => expect(worker.receivedBytes()).toBeGreaterThan(raw.length));
    const abortedAt = performance.now();
    controller.abort();

    await expect(parsing).resolves.toEqual({
      kind: "transient_failure",
      errorCode: "mail_mime_aborted",
    });
    // The worker heard the hang-up and never closed its side.
    expect(performance.now() - abortedAt).toBeGreaterThanOrEqual(55);
    expect(events).toEqual(["hang-up heard"]);
  });

  it("gives a worker two seconds to close when nothing says otherwise", async () => {
    const socketPath = nextSocketPath();
    const events: string[] = [];
    const worker = await startBusyWorker(socketPath, events, () => undefined);
    const controller = new AbortController();
    const raw = Buffer.from("From: a@example.com\r\n\r\nstuck for good");
    const parsing = parse(
      new UnixSocketMailMimeParser({ socketPath }),
      raw,
      {},
      [raw],
      controller.signal,
    );
    await vi.waitFor(() => expect(worker.receivedBytes()).toBeGreaterThan(raw.length));
    const abortedAt = performance.now();
    controller.abort();

    await expect(parsing).resolves.toEqual({
      kind: "transient_failure",
      errorCode: "mail_mime_aborted",
    });
    // The runner's last wait for an owner's letter is sized on this figure.
    // The parse's own deadline, five seconds here, is what a longer let-go
    // would run into.
    const heldMs = performance.now() - abortedAt;
    expect(heldMs).toBeGreaterThanOrEqual(1_990);
    expect(heldMs).toBeLessThan(4_000);
  }, 10_000);

  it.each([
    ["between two chunks of the message", 10],
    ["after the last chunk of the message, before its end is sent", null],
  ] as const)(
    "writes nothing more to a busy worker and leaves the connection to it when aborted %s",
    async (_where, splitAt) => {
      const socketPath = nextSocketPath();
      const events: string[] = [];
      // A worker that hears the hang-up part way through a parse, says what
      // stopped it, and closes its side a quarter of a second later.
      const worker = await startBusyWorker(socketPath, events, (socket) => {
        void writeBmp1JsonFrame(socket, BMP1_FRAME.error, {
          category: "permanent",
          errorCode: "mail_mime_invalid",
        }).catch(() => undefined);
        setTimeout(() => {
          events.push("worker closed");
          socket.destroy();
        }, 250);
      });
      const controller = new AbortController();
      const raw = Buffer.from("From: a@example.com\r\n\r\ndisplaced mid-message");
      const source = heldStream(
        raw.subarray(0, splitAt ?? raw.length),
        splitAt === null ? null : raw.subarray(splitAt),
      );
      const parsing = parse(
        new UnixSocketMailMimeParser({ socketPath }),
        raw,
        {},
        source.stream,
        controller.signal,
      ).then((outcome) => {
        events.push("answered");
        return outcome;
      });
      // The first part is with the worker and the client is waiting for more
      // of the message when the parse is given up.
      await vi.waitFor(() => expect(source.held()).toBe(true));
      controller.abort();
      await vi.waitFor(() => expect(events).toContain("hang-up heard"));
      const receivedAtHangUp = worker.receivedBytes();
      // Time for the worker's frame to arrive before the source goes on.
      await new Promise((resolve) => setTimeout(resolve, 40));
      source.release();

      await expect(parsing).resolves.toEqual({
        kind: "transient_failure",
        errorCode: "mail_mime_aborted",
      });
      // Neither the rest of the source, nor the frame the worker sent, nor
      // the send's own failure ended the connection before the worker did.
      expect(events.slice(0, 3)).toEqual(["hang-up heard", "worker closed", "answered"]);
      expect(worker.receivedBytes()).toBe(receivedAtHangUp);
    },
  );

  it("keeps a parse that ran out of time a timeout when its caller gives up after it", async () => {
    const socketPath = nextSocketPath();
    let workerSawClose = false;
    await startServer(socketPath, (socket) => {
      socket.on("error", () => undefined);
      socket.once("close", () => {
        workerSawClose = true;
      });
      socket.resume();
    });
    const controller = new AbortController();
    const raw = Buffer.from("From: a@example.com\r\n\r\ntimed out, then given up");
    const source = heldStream(raw.subarray(0, 10), raw.subarray(10));
    const parsing = parse(
      new UnixSocketMailMimeParser({ socketPath }),
      raw,
      { deadlineAt: Date.now() + 100 },
      source.stream,
      controller.signal,
    );
    // The deadline has cut the worker off. The parse has not answered yet,
    // as it is still waiting for its source.
    await vi.waitFor(() => expect(workerSawClose).toBe(true));
    controller.abort();
    source.release();

    await expect(parsing).resolves.toEqual({
      kind: "transient_failure",
      errorCode: "mail_mime_worker_timeout",
    });
  });

  it("refuses a let-go deadline that is not a bounded whole number of milliseconds", () => {
    for (const workerLetGoDeadlineMs of [0, -1, 1.5, 60_001, Number.NaN]) {
      expect(
        () => new UnixSocketMailMimeParser({ workerLetGoDeadlineMs }),
      ).toThrow("mail MIME worker let-go deadline is invalid");
    }
  });
});

async function parseWithWorker(
  raw: Buffer,
  overrides: Partial<MailMimeParseBudget> = {},
  chunks: readonly Uint8Array[] = [raw],
): Promise<MailMimeParseOutcome> {
  const socketPath = nextSocketPath();
  await startServer(socketPath, (socket) => {
    void runMimeParserWorkerConnection(socket);
  });
  return parse(new UnixSocketMailMimeParser({ socketPath }), raw, overrides, chunks);
}

function tinyPng(): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from([1])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, "ascii");
  data.copy(chunk, 8);
  return chunk;
}

async function parse(
  parser: UnixSocketMailMimeParser,
  raw: Buffer,
  overrides: Partial<MailMimeParseBudget> = {},
  chunks: readonly Uint8Array[] | AsyncIterable<Uint8Array> = [raw],
  signal: AbortSignal = new AbortController().signal,
): Promise<MailMimeParseOutcome> {
  return parser.parse({
    operationId: `parse-${Date.now()}-${socketSequence}`,
    rawMime: {
      sha256: createHash("sha256").update(raw).digest("hex"),
      bytes: raw.length,
    },
    budget: budget(overrides),
    rawMimeStream: Symbol.asyncIterator in chunks ? chunks : chunkStream(chunks),
    signal,
  });
}

/**
 * A raw message whose source stops after its first part until `release`:
 * with a second part still to come, or with nothing left but its end.
 */
function heldStream(
  first: Uint8Array,
  rest: Uint8Array | null,
): {
  readonly stream: AsyncIterable<Uint8Array>;
  held(): boolean;
  release(): void;
} {
  let held = false;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* stream(): AsyncIterable<Uint8Array> {
    yield first;
    held = true;
    await released;
    if (rest !== null) yield rest;
  }
  return { stream: stream(), held: () => held, release };
}

/**
 * A worker as its client sees it while it is busy: it reads, hears the
 * client's half-close, and closes its own side only when `close` says so.
 */
async function startBusyWorker(
  socketPath: string,
  events: string[],
  close: (socket: Socket) => void,
): Promise<{ receivedBytes(): number }> {
  await unlink(socketPath).catch(() => undefined);
  let received = 0;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    server.close();
    servers.delete(server);
    socket.on("error", () => undefined);
    socket.on("data", (chunk) => {
      received += chunk.length;
    });
    socket.once("end", () => {
      events.push("hang-up heard");
      close(socket);
    });
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return { receivedBytes: () => received };
}

function budget(overrides: Partial<MailMimeParseBudget>): MailMimeParseBudget {
  return {
    deadlineAt: Date.now() + 5_000,
    maxRawBytes: 1024 * 1024,
    maxDecodedBytes: 2 * 1024 * 1024,
    maxHeaderBytes: 16 * 1024,
    maxHtmlCharacters: 128 * 1024,
    maxTextCharacters: 128 * 1024,
    maxAddresses: 20,
    maxParts: 32,
    maxDepth: 8,
    maxDomNodes: 2_000,
    maxDomAttributes: 4_000,
    maxInlineImagePixels: 1_000_000,
    maxInlineImageFrames: 10,
    maxRemoteImages: 32,
    ...overrides,
  };
}

async function* chunkStream(
  chunks: readonly Uint8Array[],
): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield chunk;
}

function nextSocketPath(): string {
  const socketPath = `/tmp/brain-mime-${process.pid}-${socketSequence++}.sock`;
  sockets.add(socketPath);
  return socketPath;
}

async function startServer(
  socketPath: string,
  handler: (socket: Socket) => void,
): Promise<void> {
  await unlink(socketPath).catch(() => undefined);
  const server = createServer((socket) => {
    server.close();
    servers.delete(server);
    handler(socket);
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
