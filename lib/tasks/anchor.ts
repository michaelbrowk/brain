import type { TaskAnchor } from "./model";
import type { TaskLine } from "./task-lines";

/** Where a linked task's checkbox went, decided on every reconcile.
 *
 *  The four steps below are a cascade and not a score. An earlier step that
 *  matches ends the search even when a later step would match something that
 *  looks closer, because the hash is a statement about identity and the
 *  similarity is only a guess. A resolver written as one weighted score binds
 *  a task to the wrong line the first time somebody types a near-duplicate.
 *
 *  Nothing here touches the clock, the filesystem or a Store, and no argument
 *  is mutated: `claimed` is read, never written. The caller owns the set and
 *  adds each returned `index` to it before resolving the next anchor.
 */

/** The rebind threshold from the spec. Below it the task detaches rather than
 *  attach itself to a line somebody wrote for another purpose. */
export const REBIND_SIMILARITY = 0.6;

export interface ResolvedAnchor {
  /** Position in the `lines` array, which is also what `claimed` holds. The
   *  markdown line is `anchor.line`, and the two are different numbers: a
   *  page's third task line can sit on its fortieth markdown line. */
  index: number;
  /** The anchor as it should now be stored. Step 1 returns the one it was
   *  given, unchanged and by reference. */
  anchor: TaskAnchor;
}

/** Dice's coefficient over character bigrams, as a multiset: `aaaa` carries
 *  three occurrences of `aa`, not one, so a repeated run cannot inflate the
 *  score of a short string against a long one.
 *
 *  Both arguments are normalized task text (`normalizeTaskText`), so case and
 *  spacing are the caller's business and not re-applied here. */
export function diceBigramSimilarity(a: string, b: string): number {
  // Answered first, because two strings under two characters long have no
  // bigrams between them and would otherwise divide zero by zero.
  if (a === b) return 1;

  const left = bigramCounts(a);
  const right = bigramCounts(b);
  const leftTotal = totalOf(left);
  const rightTotal = totalOf(right);
  if (leftTotal + rightTotal === 0) return 0;

  let shared = 0;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  return (2 * shared) / (leftTotal + rightTotal);
}

/** The line this anchor now names, or `null` for the caller to detach.
 *
 *  `claimed` holds the positions in `lines` that earlier anchors already took.
 *  It is consulted at every step and not only at the rebind, because two tasks
 *  pointing at one checkbox is the state that has no honest reading: whichever
 *  of them a person ticks, the other claims the tick too. */
export function resolveAnchor(
  anchor: TaskAnchor,
  lines: TaskLine[],
  claimed: ReadonlySet<number>,
): ResolvedAnchor | null {
  // Step 1. Same hash, same ordinal, same line. The page did not move it.
  for (const [index, line] of lines.entries()) {
    if (claimed.has(index)) continue;
    if (line.hash !== anchor.hash) continue;
    if (line.ordinal !== anchor.ordinal) continue;
    if (line.index !== anchor.line) continue;
    return { index, anchor };
  }

  // Step 2. Same hash, some other ordinal or line. The text is still on the
  // page, so the line moved or a duplicate above it was added or deleted.
  // The ordinal is preferred over the distance, because among identical texts
  // the ordinal is the only thing that tells two of them apart.
  let sameHash: { index: number; line: TaskLine } | null = null;
  for (const [index, line] of lines.entries()) {
    if (claimed.has(index)) continue;
    if (line.hash !== anchor.hash) continue;
    if (sameHash === null || preferredSameHash(line, sameHash.line, anchor)) {
      sameHash = { index, line };
    }
  }
  if (sameHash) {
    return {
      index: sameHash.index,
      anchor: { ...anchor, ordinal: sameHash.line.ordinal, line: sameHash.line.index },
    };
  }

  // Step 3. The hash is gone, so the line was edited. Take the nearest
  // unclaimed line that is still recognisably the same sentence. Nearest
  // wins among everything over the threshold: a closer line is more likely
  // to be the edited one than a more similar line on the other end of a page.
  let rebound: { index: number; line: TaskLine } | null = null;
  for (const [index, line] of lines.entries()) {
    if (claimed.has(index)) continue;
    if (diceBigramSimilarity(anchor.text, line.normalized) < REBIND_SIMILARITY) continue;
    if (rebound === null || nearer(line, rebound.line, anchor.line)) {
      rebound = { index, line };
    }
  }
  if (rebound) {
    return {
      index: rebound.index,
      anchor: {
        text: rebound.line.normalized,
        hash: rebound.line.hash,
        ordinal: rebound.line.ordinal,
        line: rebound.line.index,
      },
    };
  }

  // Step 4. Nothing on the page is this task any more.
  return null;
}

/** Step 2's order: the remembered ordinal first, then the nearer line. */
function preferredSameHash(
  candidate: TaskLine,
  incumbent: TaskLine,
  anchor: TaskAnchor,
): boolean {
  const candidateKeepsOrdinal = candidate.ordinal === anchor.ordinal;
  const incumbentKeepsOrdinal = incumbent.ordinal === anchor.ordinal;
  if (candidateKeepsOrdinal !== incumbentKeepsOrdinal) return candidateKeepsOrdinal;
  return nearer(candidate, incumbent, anchor.line);
}

/** Distance in markdown lines, with the lower line winning a tie so that the
 *  answer does not depend on the order the page happened to be parsed in. */
function nearer(candidate: TaskLine, incumbent: TaskLine, line: number): boolean {
  const candidateDistance = Math.abs(candidate.index - line);
  const incumbentDistance = Math.abs(incumbent.index - line);
  if (candidateDistance !== incumbentDistance) return candidateDistance < incumbentDistance;
  return candidate.index < incumbent.index;
}

function bigramCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i + 1 < text.length; i += 1) {
    const gram = text.slice(i, i + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

function totalOf(counts: Map<string, number>): number {
  let total = 0;
  for (const count of counts.values()) total += count;
  return total;
}
