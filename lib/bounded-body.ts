/**
 * Read a request body and stop at a cap.
 *
 * The three visitor routes decided their 413 from `Content-Length` and then
 * buffered the whole body anyway. That header is optional: a chunked request
 * omits it, `Number(null ?? 0)` is 0, and the pre-check decided nothing for
 * exactly the request it existed to refuse. The real cap only applied after
 * the parse, so an anonymous caller could make the process hold a body of any
 * size, bounded in the documented deployment only by nginx buffering the
 * request and supplying a length upstream. Put Brain behind a proxy that
 * streams, or in front of nothing, and it was not bounded at all.
 *
 * This reads the stream and gives up as soon as more than `max` bytes have
 * arrived, so nothing past the cap plus the one chunk that crossed it is ever
 * held. The declared length is still honoured when it is there, because
 * refusing before the first byte is cheaper than refusing after the last.
 */
export async function readBoundedBody(
  req: Request,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return null;

  const body = req.body;
  if (!body) {
    // No stream to read: a request with no body, or a runtime that has
    // already buffered it. The declared length above is the only pre-check
    // available, and the count below is still exact.
    const buffered = new Uint8Array(await req.arrayBuffer());
    return buffered.byteLength > max ? null : buffered;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled reader has already given the lock up.
    }
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** The same, decoded. UTF-8 is what every one of these routes sends. */
export async function readBoundedText(
  req: Request,
  max: number,
): Promise<string | null> {
  const bytes = await readBoundedBody(req, max);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}
