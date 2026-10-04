import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";

import type { MailBlobDescriptor } from "../ports";
import { MAIL_RESOURCE_LIMITS } from "../security";
import {
  MailContentWorkError,
  type MailContentWorkInput,
} from "./content-coordinator";
import {
  ProductionMailContentWorkRunner,
  type MailContentSourceFactoryPort,
} from "./content-work-runner";
import { UnixSocketMailMimeParser } from "./mime-parser-client";

/*
  The parser socket as systemd runs it, with the worker that ships: the
  bundle `build-mail-service.mjs` makes, one process per connection with the
  connection as its stdin (`Accept=yes`, `StandardInput=socket`), and a
  connection made while two workers are alive closed without a word
  (`MaxConnections=2`). A worker counts until its process has exited, which is
  what `brain-mail-mime.socket` counts too.

  What the test holds the client to is relative, so it reads the same on a
  fast machine and a starved one: the client answers its caller only once the
  worker has gone, however long the worker's synchronous sanitize took. Under
  the unit's `CPUQuota=20%` that sanitize outlasts the 100 and 400 ms the
  runner waits before it parses again, which is how the owner's letter came to
  fail; `--jitless` on the worker's command line below reproduces that here
  (the owner's letter is then dropped three times by a client that returns at
  the abort), and is left out because a starved machine would then run the
  parse past its own 15 second deadline.
*/

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
/** Longer than a sanitize on a starved runner, so the worker's close is what
 *  ends the hold in this file, never the deadline. */
const PATIENT_LET_GO_MS = 20_000;

let bundleRoot: string;
let workerPath: string;
const stops: (() => Promise<void>)[] = [];

beforeAll(async () => {
  bundleRoot = await mkdtemp(path.join(tmpdir(), "brain-mime-worker-"));
  workerPath = path.join(bundleRoot, "mime-parser-worker.js");
  await build({
    entryPoints: [path.join(__dirname, "mime-parser-worker.ts")],
    outfile: workerPath,
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    sourcemap: false,
    legalComments: "none",
    logLevel: "silent",
  });
}, 60_000);

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
});

afterAll(async () => {
  await rm(bundleRoot, { recursive: true, force: true });
});

it(
  "holds a displaced parse's slot until its worker is gone, so the owner's next letter is not dropped",
  async () => {
    const unit = await startParserSocketUnit();
    const tap = await startAnswerTap(unit.socketPath);
    const committed: string[] = [];
    const runner = new ProductionMailContentWorkRunner({
      sourceFactory: descriptorSource,
      parser: new UnixSocketMailMimeParser({
        socketPath: tap.socketPath,
        workerLetGoDeadlineMs: PATIENT_LET_GO_MS,
      }),
    });
    const heavy = heavyLetter();

    // The prefetch has one slot and an owner's letter the other, each parsing
    // a heavy letter.
    const prefetch = new AbortController();
    const prefetchRun = runner
      .run(workInput("prefetch", heavy, committed), prefetch.signal)
      .then(
        () => null,
        (error: unknown) => error,
      );
    await waitFor(() => unit.workers().length === 1);
    const prefetchWorker = unit.workers()[0]!;
    const ownerOne = runner
      .run(workInput("owner-one", heavy, committed), new AbortController().signal)
      .then(
        () => null,
        (error: unknown) => error,
      );
    await waitFor(() => unit.workers().length === 2);

    // The prefetch's worker starts to answer: the plain part is out and the
    // synchronous sanitize of the HTML part, which no hang-up interrupts, is
    // next. A second owner's letter displaces the prefetch at that moment.
    await tap.firstAnswer(0);
    expect(unit.liveWorkers()).toBe(2);
    const abortedAt = performance.now();
    prefetch.abort();
    const prefetchError = await prefetchRun;
    const letGoAt = performance.now();
    expect(prefetchError).toBeInstanceOf(MailContentWorkError);

    // The queue frees the prefetch's slot here, and the second owner's letter
    // takes it at once. The worker has closed its connection and is exiting,
    // a moment one re-parse wait covers.
    await runner.run(
      workInput("owner-two", smallLetter(), committed),
      new AbortController().signal,
    );
    expect(await ownerOne).toBeNull();
    expect(committed).toContain("owner-two");
    expect(committed).toContain("owner-one");
    expect(committed).not.toContain("prefetch");

    // The client held on for as long as its worker lived rather than
    // returning at the abort.
    const lingeredMs = (await prefetchWorker.exitedAt) - abortedAt;
    const heldMs = letGoAt - abortedAt;
    expect(heldMs).toBeGreaterThan(lingeredMs / 2);
  },
  60_000,
);

interface ParserSocketUnit {
  readonly socketPath: string;
  liveWorkers(): number;
  workers(): readonly { readonly exitedAt: Promise<number> }[];
}

let socketSequence = 0;

function nextSocketPath(): string {
  return `/tmp/brain-mime-linger-${process.pid}-${socketSequence++}.sock`;
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await unlink(socketPath).catch(() => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function startParserSocketUnit(): Promise<ParserSocketUnit> {
  const socketPath = nextSocketPath();
  const live = new Set<ChildProcess>();
  const started: { readonly exitedAt: Promise<number> }[] = [];
  // Paused on connect: the bytes are the worker's to read, not this process's.
  const server = createServer({ pauseOnConnect: true }, (socket) => {
    if (live.size >= MAIL_RESOURCE_LIMITS.concurrentMimeParsers) {
      socket.destroy();
      return;
    }
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=128", workerPath],
      { stdio: [socket, "ignore", "ignore"], env: { NODE_ENV: "production" } },
    );
    live.add(child);
    started.push({
      exitedAt: new Promise<number>((resolve) => {
        child.once("exit", () => {
          live.delete(child);
          resolve(performance.now());
        });
      }),
    });
    // This process's copy of the connection; the worker's stdin keeps it open.
    socket.destroy();
  });
  await listen(server, socketPath);
  stops.push(async () => {
    for (const child of live) child.kill("SIGKILL");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
  });
  return {
    socketPath,
    liveWorkers: () => live.size,
    workers: () => started,
  };
}

/**
 * A relay in front of the unit that only watches: it says when the worker
 * behind a connection sends its first byte, which the client under test
 * cannot. Each direction's end is passed on as an end, so a half-close stays
 * a half-close and a connection the unit drops reads as dropped.
 */
async function startAnswerTap(unitSocketPath: string): Promise<{
  readonly socketPath: string;
  firstAnswer(connection: number): Promise<void>;
}> {
  const socketPath = nextSocketPath();
  const answers: { readonly seen: Promise<void>; readonly see: () => void }[] = [];
  const answerOf = (connection: number) => {
    while (answers.length <= connection) {
      let see!: () => void;
      const seen = new Promise<void>((resolve) => {
        see = resolve;
      });
      answers.push({ seen, see });
    }
    return answers[connection]!;
  };
  let connections = 0;
  const open = new Set<{ destroy(): void }>();
  const server = createServer({ allowHalfOpen: true }, (client) => {
    const answer = answerOf(connections++);
    const worker = createConnection({ path: unitSocketPath, allowHalfOpen: true });
    open.add(client).add(worker);
    client.on("data", (chunk) => worker.write(chunk));
    client.on("end", () => worker.end());
    worker.on("data", (chunk) => {
      answer.see();
      client.write(chunk);
    });
    worker.on("end", () => client.end());
    client.on("error", () => worker.destroy());
    worker.on("error", () => client.destroy());
    client.on("close", () => {
      open.delete(client);
      worker.destroy();
    });
    worker.on("close", () => {
      open.delete(worker);
      // The worker's last bytes go out before this side closes.
      client.end();
    });
  });
  await listen(server, socketPath);
  stops.push(async () => {
    for (const socket of open) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(socketPath).catch(() => undefined);
  });
  return {
    socketPath,
    firstAnswer: (connection) => answerOf(connection).seen,
  };
}

/** A source that has the letter already: the fetch is not what is measured. */
const descriptorSource: MailContentSourceFactoryPort = {
  async create(input) {
    return {
      source: {
        async fetchRaw() {
          const raw = (input.blobStore as unknown as { readonly raw: Buffer }).raw;
          return { descriptor: descriptor(raw) };
        },
      },
      destroy() {},
    };
  },
};

/** The runner's input with the cache and the blob store reduced to what a
 *  parse touches: the raw message in, the commit out. */
function workInput(
  messageId: string,
  raw: Buffer,
  committed: string[],
): MailContentWorkInput {
  return {
    accountId: ACCOUNT_ID,
    providerMessageId: messageId,
    lease: { token: `lease-${messageId}` },
    deadlineAt: Date.now() + 60_000,
    lane: { background: messageId === "prefetch" },
    cache: {
      incomingBlobStore: () => ({}),
      stageBlob: async () => undefined,
      commitReady: async () => {
        committed.push(messageId);
      },
    },
    blobStore: {
      raw,
      read: async function* () {
        yield raw;
      },
    },
  } as unknown as MailContentWorkInput;
}

/**
 * A short plain part, which the worker answers with first, and an HTML part
 * near the parser's own size limit, whose sanitize is the long step.
 */
function heavyLetter(): Buffer {
  const row =
    '<p style="color:#333333;font-size:14px;margin:0 0 8px 0"><b>Row</b> of a long newsletter <a href="https://example.test/read">read</a></p>\r\n';
  return Buffer.from(
    [
      "From: Sender <sender@example.test>",
      "To: Owner <owner@example.test>",
      "Subject: Heavy",
      "MIME-Version: 1.0",
      'Content-Type: multipart/alternative; boundary="alt"',
      "",
      "--alt",
      'Content-Type: text/plain; charset="utf-8"',
      "",
      "A long newsletter",
      "--alt",
      'Content-Type: text/html; charset="utf-8"',
      "",
      `<html><body>\r\n${row.repeat(6_000)}</body></html>`,
      "--alt--",
      "",
    ].join("\r\n"),
  );
}

function smallLetter(): Buffer {
  return Buffer.from("From: sender@example.test\r\n\r\nA short letter");
}

function descriptor(value: Uint8Array): MailBlobDescriptor {
  return {
    sha256: createHash("sha256").update(value).digest("hex"),
    bytes: value.byteLength,
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 20_000;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error("condition was not met");
    await delay(5);
  }
}
