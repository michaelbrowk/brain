/** The one reading of a task line in a note's markdown.
 *
 *  Invariant 7 of AGENTS.md, applied to checkboxes: the editor and the store
 *  answer "what is a task line, and which one is this" the same way, so this
 *  file is the only place that knows the regex, the normalization and the
 *  hash. A second parser is how the two ends of a reconcile start to disagree.
 *
 *  Nothing here touches the clock, the filesystem or node builtins, because
 *  the editor imports it into the browser bundle.
 */

/** A task line found in a note. */
export interface TaskLine {
  /** Zero-based line in the markdown, so an anchor can name where it sat. */
  index: number;
  checked: boolean;
  /** The line's content: trimmed, with the HTML break tags removed. */
  text: string;
  /** `text` with runs of whitespace collapsed. What the hash is taken over. */
  normalized: string;
  /** First 16 hex characters of the sha1 of `normalized`. */
  hash: string;
  /** Which occurrence of this normalized text on the page, from 0. */
  ordinal: number;
}

/** The spec's regex, in one place and nowhere else. */
const TASK_LINE_RE = /^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/;

/** An opening or closing code fence: three or more backticks or tildes.
 *  An indented code block is knowingly out of scope. Milkdown serialises code
 *  fenced, so the four-space form only appears in hand-written or imported
 *  markdown, and treating four spaces as code would swallow the nested task
 *  lines that are the ordinary case. */
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/;

/** The template writes an empty task line as `<br />`, and a Notion export
 *  writes `<br>`. All three spellings are a line break, not content. */
const BREAK_TAG_RE = /<br\s*\/?>/gi;

const WHITESPACE_RUN_RE = /\s+/g;

/** The longest normalized task text there is. The record schema bounds both
 *  `title` and `anchor.text` at the same number, and a rebind copies a line's
 *  normalized text into both, so a line longer than this would mint a record
 *  the schema refuses: `writeTaskFile` does not validate, and the next index
 *  load would skip the file and the task would vanish from every list. The cap
 *  belongs here, where the hash is taken, so the text, the anchor and the hash
 *  are all taken over the same bytes. */
export const MAX_TASK_TEXT = 2000;

/** The reader's form of a task line: what a person sees, minus the break tags
 *  that are markup rather than words. */
function visibleText(raw: string): string {
  return raw.trim().replace(BREAK_TAG_RE, "").trim();
}

/** The hashing form. Collapsing runs of whitespace AFTER the break tags are
 *  gone is what makes `a  b`, `a b` and `a <br /> b` one text with one hash,
 *  which is what an anchor needs to survive a retyped line. */
export function normalizeTaskText(raw: string): string {
  const collapsed = visibleText(raw).replace(WHITESPACE_RUN_RE, " ").trim();
  if (collapsed.length <= MAX_TASK_TEXT) return collapsed;
  const cut = collapsed.slice(0, MAX_TASK_TEXT);
  // A cut between the two halves of a surrogate pair leaves a lone surrogate,
  // which encodes as a replacement character and reads as a broken glyph. Drop
  // the orphan. The trim keeps the result its own normalized form, so running
  // this again over it changes nothing, which is what the schema's
  // already-normalized check asks of stored anchor text.
  const last = cut.charCodeAt(cut.length - 1);
  const whole = last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
  return whole.trim();
}

export function hashTaskText(normalized: string): string {
  return sha1Hex(normalized).slice(0, 16);
}

export function parseTaskLines(markdown: string): TaskLine[] {
  const lines = markdown.split(/\r?\n/);
  const found: TaskLine[] = [];
  const seen = new Map<string, number>();
  // A bracket pair inside a code block is a code sample, not somebody's task.
  let fence: { marker: string; length: number } | null = null;

  for (const [index, line] of lines.entries()) {
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const run = fenceMatch[1];
      const rest = fenceMatch[2];
      if (!fence) {
        fence = { marker: run[0], length: run.length };
        continue;
      }
      // A fence closes only on its own marker, at least as long, with nothing
      // after it. Anything else is content the fence is still holding.
      if (run[0] === fence.marker && run.length >= fence.length && rest.trim() === "") {
        fence = null;
      }
      continue;
    }
    if (fence) continue;

    const match = TASK_LINE_RE.exec(line);
    if (!match) continue;

    const text = visibleText(match[2]);
    const normalized = normalizeTaskText(match[2]);
    const ordinal = seen.get(normalized) ?? 0;
    seen.set(normalized, ordinal + 1);
    found.push({
      index,
      checked: match[1] !== " ",
      text,
      normalized,
      hash: hashTaskText(normalized),
      ordinal,
    });
  }

  return found;
}

/** sha1 of a string, written out rather than taken from `node:crypto`,
 *  because this module is imported by the editor and a node builtin does not
 *  survive the browser bundle. `task-lines.test.ts` checks every digest
 *  against node's own sha1. */
function sha1Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLength = bytes.length * 8;
  // The message, a 1 bit, zeros, then the length in bits as a 64-bit big-endian.
  const blockCount = Math.floor((bytes.length + 8) / 64) + 1;
  const padded = new Uint8Array(blockCount * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(padded.length - 4, bitLength >>> 0, false);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);

  for (let block = 0; block < blockCount; block += 1) {
    const base = block * 64;
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(base + i * 4, false);
    for (let i = 16; i < 80; i += 1) {
      w[i] = rotateLeft(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i += 1) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const next = (rotateLeft(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotateLeft(b, 30);
      b = a;
      a = next;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  return [h0, h1, h2, h3, h4].map(toHex8).join("");
}

function rotateLeft(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function toHex8(value: number): string {
  return value.toString(16).padStart(8, "0");
}
