import { describe, expect, it } from "vitest";
import { readBoundedBody, readBoundedText } from "./bounded-body";

/** A body that declares no length, the way a chunked request arrives, and
 *  reports how much of it was ever pulled. */
function chunkedRequest(chunkCount: number, chunkBytes = 1024) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunkCount) {
        controller.close();
        return;
      }
      pulled += 1;
      controller.enqueue(new Uint8Array(chunkBytes).fill(0x61));
    },
  });
  const req = new Request("https://brain.test/api/share-edit/page/p", {
    method: "PUT",
    body: stream,
    // @ts-expect-error duplex is required for a streaming body and is not in
    // the DOM lib's RequestInit yet.
    duplex: "half",
  });
  return { req, pulledChunks: () => pulled };
}

describe("readBoundedBody", () => {
  it("stops pulling once the cap is crossed, rather than draining the body", async () => {
    const { req, pulledChunks } = chunkedRequest(1_000);
    expect(req.headers.get("content-length")).toBeNull();

    await expect(readBoundedBody(req, 4 * 1024)).resolves.toBeNull();

    // Five 1 KiB chunks: the four that fit, and the one that crossed the line.
    // Not a thousand.
    expect(pulledChunks()).toBe(5);
  });

  it("returns the whole body when it fits", async () => {
    const { req } = chunkedRequest(3);
    const bytes = await readBoundedBody(req, 4 * 1024);
    expect(bytes?.byteLength).toBe(3 * 1024);
  });

  it("refuses a declared length over the cap before a byte is read", async () => {
    const { req, pulledChunks } = chunkedRequest(1_000);
    const declared = new Request(req.url, {
      method: "PUT",
      headers: { "content-length": String(64 * 1024) },
      body: req.body,
      // @ts-expect-error see above
      duplex: "half",
    });
    await expect(readBoundedBody(declared, 4 * 1024)).resolves.toBeNull();
    // Nothing this function pulled. Wrapping a stream in a Request primes one
    // chunk on its own, which is the runtime's buffering and not a read.
    expect(pulledChunks()).toBeLessThanOrEqual(1);
  });

  it("decodes what it read", async () => {
    const req = new Request("https://brain.test/x", {
      method: "PUT",
      body: '{"markdown":"hello"}',
    });
    await expect(readBoundedText(req, 1024)).resolves.toBe(
      '{"markdown":"hello"}',
    );
  });
});
