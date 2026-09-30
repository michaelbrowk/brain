import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { afterEach, expect, it, vi } from "vitest";

import { MAIL_RESOURCE_LIMITS } from "../security";

// A parser that takes the whole message and never finishes on its own, as a
// heavy letter looks from outside, and says when the worker ends its input.
const parsers = vi.hoisted(() => ({
  made: [] as { readonly destroyed: boolean }[],
  onEnd: null as (() => void) | null,
}));

vi.mock("mailparser", async () => {
  const { Duplex } = await import("node:stream");
  class MailParser extends Duplex {
    constructor() {
      super({
        readableObjectMode: true,
        read() {},
        write(_chunk, _encoding, callback) {
          callback();
        },
        final(callback) {
          parsers.onEnd?.();
          callback();
        },
      });
      parsers.made.push(this);
    }
  }
  return { MailParser };
});

import { UnixSocketMailMimeParser } from "./mime-parser-client";
import { runMimeParserWorkerConnection } from "./mime-parser-runtime";

const servers = new Set<Server>();
const sockets = new Set<string>();

afterEach(async () => {
  parsers.made.length = 0;
  parsers.onEnd = null;
  for (const server of servers) server.close();
  servers.clear();
  await Promise.all([...sockets].map((path) => unlink(path).catch(() => undefined)));
  sockets.clear();
});

it("stops parsing and lets go of the connection when its client hangs up", async () => {
  const socketPath = `/tmp/brain-mime-hangup-${process.pid}.sock`;
  sockets.add(socketPath);
  await unlink(socketPath).catch(() => undefined);
  let workerDone = false;
  const server = createServer((socket) => {
    server.close();
    void runMimeParserWorkerConnection(socket).finally(() => {
      workerDone = true;
    });
  });
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  // The client gives up once the worker has the whole message, as a
  // prefetch displaced for an owner's letter does.
  const controller = new AbortController();
  parsers.onEnd = () => controller.abort();
  const raw = Buffer.from("From: a@example.com\r\n\r\nheavy letter");
  await expect(
    new UnixSocketMailMimeParser({ socketPath }).parse({
      operationId: "hang-up",
      rawMime: {
        sha256: createHash("sha256").update(raw).digest("hex"),
        bytes: raw.length,
      },
      budget: {
        deadlineAt: Date.now() + 5_000,
        maxRawBytes: MAIL_RESOURCE_LIMITS.rawMessageBytes,
        maxDecodedBytes: MAIL_RESOURCE_LIMITS.maxDecodedMimeBytes,
        maxHeaderBytes: MAIL_RESOURCE_LIMITS.headerBytes,
        maxHtmlCharacters: MAIL_RESOURCE_LIMITS.htmlCharacters,
        maxTextCharacters: MAIL_RESOURCE_LIMITS.textCharacters,
        maxAddresses: MAIL_RESOURCE_LIMITS.addressesPerMessage,
        maxParts: MAIL_RESOURCE_LIMITS.mimeParts,
        maxDepth: MAIL_RESOURCE_LIMITS.mimeNestingDepth,
        maxDomNodes: MAIL_RESOURCE_LIMITS.maxDomNodes,
        maxDomAttributes: MAIL_RESOURCE_LIMITS.maxDomAttributes,
        maxRemoteImages: MAIL_RESOURCE_LIMITS.maxRemoteImagesPerMessage,
        maxInlineImagePixels: MAIL_RESOURCE_LIMITS.maxInlineImagePixels,
        maxInlineImageFrames: MAIL_RESOURCE_LIMITS.maxInlineImageFrames,
      },
      rawMimeStream: (async function* () {
        yield raw;
      })(),
      signal: controller.signal,
    }),
  ).resolves.toEqual({ kind: "transient_failure", errorCode: "mail_mime_aborted" });

  // The parse is still under way, yet the worker is done: it stopped the
  // parser, and in production its process exits with it.
  await vi.waitFor(() => expect(workerDone).toBe(true));
  expect(parsers.made).toHaveLength(1);
  expect(parsers.made[0]!.destroyed).toBe(true);
});
