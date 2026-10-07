/** A save that has to leave a closing tab cannot carry the whole page: a
 *  browser refuses a keepalive body over 64 KiB, and a long page is larger
 *  than that on its own. What it can carry is the span that changed, cut
 *  against a body the tab knows the server held, and the hash of that body so
 *  the server applies the span only to exactly that text.
 *
 *  The hash is computed synchronously because pagehide gives no time to wait
 *  for `crypto.subtle`, and the same function runs on the server so both
 *  sides agree byte for byte. */

export interface BodySpan {
  /** UTF-16 offset of the first changed code unit in the older body. */
  at: number;
  /** Code units of the older body the span replaces. */
  del: number;
  ins: string;
}

export interface BodyPatch extends BodySpan {
  /** SHA-256 hex of the canonical body the span was cut from. */
  base: string;
}

const MAX_PATCHES = 8;
const HASH_RE = /^[0-9a-f]{64}$/;

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 of the UTF-8 bytes of `text`, as lowercase hex. */
export function bodyHash(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array((((bytes.length + 9 + 63) >> 6) << 6));
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i += 1) {
      const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i] + w[i]) | 0;
      const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  return Array.from(h, (word) => word.toString(16).padStart(8, "0")).join("");
}

/** The one span that turns `from` into `to`: the common head and tail stay,
 *  the middle is replaced. Typing between two saves changes one place, so the
 *  span is a few words however long the page is. */
export function diffBodyPatch(from: string, to: string): BodySpan {
  const limit = Math.min(from.length, to.length);
  let head = 0;
  while (head < limit && from.charCodeAt(head) === to.charCodeAt(head)) head += 1;
  let tail = 0;
  while (
    tail < limit - head &&
    from.charCodeAt(from.length - 1 - tail) === to.charCodeAt(to.length - 1 - tail)
  ) {
    tail += 1;
  }
  return {
    at: head,
    del: from.length - head - tail,
    ins: to.slice(head, to.length - tail),
  };
}

/** `body` with the span applied, or null when the span does not fit it. */
export function applyBodyPatch(body: string, span: BodySpan): string | null {
  if (span.at + span.del > body.length) return null;
  return body.slice(0, span.at) + span.ins + body.slice(span.at + span.del);
}

function isOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The patches of a request body, or null when the field is malformed. */
export function parseBodyPatches(value: unknown): BodyPatch[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PATCHES) {
    return null;
  }
  const patches: BodyPatch[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { base, at, del, ins } = item as Record<string, unknown>;
    if (typeof base !== "string" || !HASH_RE.test(base)) return null;
    if (!isOffset(at) || !isOffset(del) || typeof ins !== "string") return null;
    patches.push({ base, at, del, ins });
  }
  return patches;
}
