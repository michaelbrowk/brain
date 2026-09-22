import { spawn } from "node:child_process";
import path from "node:path";
import { getStore, NOTES_ROOT } from "./store";
import {
  projectMarkdownSearchText,
  type SearchTextTarget,
} from "./search-navigation";

export interface SearchHit {
  id: string;
  title: string;
  icon?: string;
  /** An app page, so a result wears the AI chip the way a tree row does. */
  kind?: "app";
  /** match window: emphasis is applied client-side by weight, not colour */
  snippet: { before: string; match: string; after: string };
  /** Lets the command palette avoid repeating title-only matches it already
   *  found locally while MCP consumers still get complete retrieval. */
  source?: "title" | "body";
  /** Stable body-match intent used only for "In text" navigation. */
  target?: SearchTextTarget;
}

const MAX_HITS = 20;
const TIMEOUT_MS = 3000;

let inflight: Promise<SearchHit[]> | null = null;

export class SearchBackendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SearchBackendError";
  }
}

/** THE SEARCH ENGINE FAILING, TOLD FROM THE NOTES FOLDER FAILING.
 *
 *  A caller that catches everything alike cannot tell "ripgrep is not
 *  installed" from "the notes folder is unwritable", and those two call for
 *  opposite responses. Read off the name rather than the class, the way
 *  `lib/store`'s own predicates are, so a module that mocks this one still
 *  answers for the errors it throws. */
export function isSearchBackendError(error: unknown): boolean {
  return error instanceof Error && error.name === "SearchBackendError";
}

/** Production readiness must fail loudly when the external full-text engine is
 *  absent. Interactive requests also fail explicitly instead of pretending an
 *  unavailable backend returned zero matches. */
export function assertSearchReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const rg = spawn("rg", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      rg.kill("SIGKILL");
      finish(new Error("ripgrep readiness check timed out"));
    }, TIMEOUT_MS);
    rg.stdout.on("data", (chunk) => {
      if (stdout.length < 4_096) stdout += chunk.toString();
    });
    rg.stderr.on("data", (chunk) => {
      if (stderr.length < 4_096) stderr += chunk.toString();
    });
    rg.once("error", (error) => {
      finish(new Error(`ripgrep is not executable: ${error.message}`));
    });
    rg.once("close", (code) => {
      if (code === 0 && /^ripgrep\s+\d+/m.test(stdout)) {
        finish();
        return;
      }
      finish(
        new Error(
          `ripgrep readiness check failed (${code ?? "signal"})` +
            (stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""),
        ),
      );
    });
  });
}

/** Full-text search over the notes .md files via ripgrep.
 *  Single-flight + timeout + result cap — safe on 1 vCPU. */
export async function searchNotes(query: string): Promise<SearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  if (inflight) await inflight.catch(() => {});
  const run = doSearch(q);
  inflight = run;
  try {
    return await run;
  } finally {
    if (inflight === run) inflight = null;
  }
}

async function doSearch(q: string): Promise<SearchHit[]> {
  const store = await getStore();
  const terms = tokenizeSearchQuery(q);
  if (terms.length === 0) return [];

  // dir-path → page id map (each page dir contains index.md)
  type SearchPage = {
    id: string;
    title: string;
    icon?: string;
    kind?: "app";
    updated: string;
  };
  const dirToId = new Map<string, SearchPage>();
  const candidates = new Map<
    string,
    SearchPage & { lines: string[]; matchedTerms: Set<string>; phrase: boolean }
  >();
  const normalizedQuery = q.toLocaleLowerCase();
  const walk = (nodes: ReturnType<typeof store.getTree>) => {
    for (const n of nodes) {
      const page = {
        id: n.id,
        title: n.title,
        icon: n.icon,
        kind: n.kind,
        updated: n.updated,
      };
      dirToId.set(store.resolve(n.id), page);
      const title = n.title.toLocaleLowerCase();
      const matchedTerms = new Set(terms.filter((term) => title.includes(term)));
      if (matchedTerms.size > 0) {
        candidates.set(n.id, {
          ...page,
          lines: [],
          matchedTerms,
          phrase: title.includes(normalizedQuery),
        });
      }
      walk(n.children);
    }
  };
  walk(store.getTree());

  // THE PHRASE RUN FIRST, AND ITS HITS FIRST.
  //
  // A note holding "Урок 15 сентября" as written is what somebody typing that
  // wanted, above a note holding урок in one place and сентября in another.
  // The whole query in the title counts too: a page called by its name is the
  // same kind of hit, and sorting a body phrase above it would be a worse
  // answer than the one this had before.
  const { phrase: phraseLines, words: wordLines } = await rgJson(q);
  const scanned = [
    ...phraseLines.map((line) => ({ line, fromPhrase: true })),
    ...wordLines.map((line) => ({ line, fromPhrase: false })),
  ];
  for (const { line, fromPhrase } of scanned) {
    let obj: {
      type?: string;
      data?: {
        path?: { text?: string };
        lines?: { text?: string };
      };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "match") continue;
    const file = obj.data?.path?.text;
    if (!file) continue;
    // rg emits paths relative to its cwd (NOTES_ROOT), not the app cwd
    const dir = path.dirname(path.resolve(NOTES_ROOT, file));
    const page = dirToId.get(dir);
    if (!page) continue;
    const text = (obj.data?.lines?.text ?? "").trim();
    // skip frontmatter matches
    if (
      /^(id|title|icon|order|created|updated|notionId|notionSourceHash|notionConversionHash|notionTargetRev|notionTargetParentId|notionTargetBeforeId|notionTargetOrder|notionImportHash|notionImportToken|notionImportStarted|notionImportBaseRev|notionImportCreated|notionImportParentId|notionImportBeforeId|notionImportBaseParentId|notionImportBaseBeforeId|notionImportBaseOrder):\s/.test(
        text,
      )
    )
      continue;
    const normalizedLine = text.toLocaleLowerCase();
    const candidate = candidates.get(page.id) ?? {
      ...page,
      lines: [],
      matchedTerms: new Set<string>(),
      phrase: page.title.toLocaleLowerCase().includes(normalizedQuery),
    };
    if (fromPhrase) candidate.phrase = true;
    for (const term of terms) {
      if (normalizedLine.includes(term)) candidate.matchedTerms.add(term);
    }
    if (candidate.lines.length < 12 && !candidate.lines.includes(text)) {
      candidate.lines.push(text);
    }
    candidates.set(page.id, candidate);
  }

  const ranked = [...candidates.values()]
    .filter((candidate) => terms.every((term) => candidate.matchedTerms.has(term)))
    .map((candidate) => {
      const bestLine = bestSearchLine(candidate.lines, q, terms);
      const snippet = bestLine
        ? makeSnippet(bestLine, q, terms)
        : { before: "", match: candidate.title, after: "" };
      return {
        id: candidate.id,
        title: candidate.title,
        icon: candidate.icon,
        kind: candidate.kind,
        updated: candidate.updated,
        rank: rankSearchCandidate(candidate.title, candidate.lines, q),
        phrase: candidate.phrase,
        source: bestLine ? ("body" as const) : ("title" as const),
        bestLine,
        snippet,
      };
    })
    .sort(
      (a, b) =>
        Number(b.phrase) - Number(a.phrase) ||
        a.rank - b.rank ||
        searchTimestamp(b.updated) - searchTimestamp(a.updated) ||
        a.title.localeCompare(b.title),
    )
    .slice(0, MAX_HITS);

  return Promise.all(
    ranked.map(async (result): Promise<SearchHit> => {
      let target: SearchTextTarget | undefined;
      if (result.bestLine) {
        try {
          const current = await store.readPage(result.id);
          target =
            buildSearchTextTarget(
              current.markdown,
              result.bestLine,
              result.snippet.match,
            ) ?? undefined;
        } catch {
          // A page can move between ripgrep and the read. Missing target data
          // keeps this a text intent, but selection will fail closed in Shell.
        }
      }
      return {
        id: result.id,
        title: result.title,
        icon: result.icon,
        kind: result.kind,
        source: result.source,
        snippet: result.snippet,
        target,
      };
    }),
  );
}

export interface Backlink {
  id: string;
  title: string;
  icon?: string;
  snippet: string;
}

/** Pages that link TO `id` (via a `/p/<id>` markdown link). ripgrep over the
 *  notes — always fresh, no index to maintain. Self-links excluded. */
export async function backlinksFor(id: string): Promise<Backlink[]> {
  if (!/^[\w-]+$/.test(id)) return [];
  const store = await getStore();
  const dirToId = new Map<string, { id: string; title: string; icon?: string }>();
  const walk = (nodes: ReturnType<typeof store.getTree>) => {
    for (const n of nodes) {
      dirToId.set(store.resolve(n.id), { id: n.id, title: n.title, icon: n.icon });
      walk(n.children);
    }
  };
  walk(store.getTree());

  const lines = await rgLines(`/p/${id})`, 1);
  const seen = new Set<string>();
  const out: Backlink[] = [];
  for (const line of lines) {
    let obj: {
      type?: string;
      data?: { path?: { text?: string }; lines?: { text?: string } };
    };
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type !== "match") continue;
    const file = obj.data?.path?.text;
    if (!file) continue;
    const dir = path.dirname(path.resolve(NOTES_ROOT, file));
    const page = dirToId.get(dir);
    if (!page || page.id === id || seen.has(page.id)) continue;
    seen.add(page.id);
    const text = stripMd((obj.data?.lines?.text ?? "").trim()).slice(0, 160);
    out.push({ ...page, snippet: text });
  }
  return out;
}

/** Strip markdown syntax so snippets read as prose, not source. */
function stripMd(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`#>|]+/g, "")
    .replace(/\s{2,}/g, " ");
}

/** Bind a body result to one exact visible occurrence. Surrounding Markdown
 * syntax is intentionally discarded so the payload describes what Milkdown
 * renders, not storage offsets that disappear during parsing. */
export function buildSearchTextTarget(
  markdown: string,
  line: string,
  backendMatch: string,
): SearchTextTarget | null {
  const body = projectMarkdownSearchText(markdown);
  const exact = projectMarkdownSearchText(backendMatch);
  if (!exact) return null;

  const bodyLower = body.toLocaleLowerCase();
  const exactLower = exact.toLocaleLowerCase();

  // `line` is the raw line selected by ripgrep. Bind to that identity before
  // projection: a different Markdown line can project to the same visible
  // prefix (for example `Needle **special** extended`). If the raw identity is
  // duplicated, there is no trustworthy offset in the body-only page payload,
  // so navigation must fail closed.
  const selectedRawLine = line.trim();
  const rawLineMatches: Array<{ start: number; source: string }> = [];
  let rawLineStart = 0;
  while (rawLineStart <= markdown.length) {
    const newline = markdown.indexOf("\n", rawLineStart);
    const rawLineEnd = newline === -1 ? markdown.length : newline;
    const rawLine = markdown.slice(rawLineStart, rawLineEnd).replace(/\r$/, "");
    if (rawLine.trim() === selectedRawLine) {
      rawLineMatches.push({ start: rawLineStart, source: rawLine });
    }
    if (newline === -1) break;
    rawLineStart = newline + 1;
  }
  if (rawLineMatches.length !== 1) return null;

  const selectedLineMatch = selectedRawLine
    .toLocaleLowerCase()
    .indexOf(backendMatch.toLocaleLowerCase());
  const selectedLineOffset = rawLineMatches[0].source.indexOf(selectedRawLine);
  if (selectedLineMatch === -1 || selectedLineOffset === -1) return null;

  // Project one marked document so the selected raw match and its visible
  // offset are resolved in exactly the same whitespace-collapse pass. Counting
  // a projected prefix and projected line separately misses phrases synthesized
  // across their collapsed boundary.
  const startMarker = "\uE000\uE001";
  const endMarker = "\uE002\uE003";
  if (markdown.includes(startMarker) || markdown.includes(endMarker)) return null;
  const rawMatchStart =
    rawLineMatches[0].start + selectedLineOffset + selectedLineMatch;
  const rawMatchEnd = rawMatchStart + backendMatch.length;
  const markedBody = projectMarkdownSearchText(
    `${markdown.slice(0, rawMatchStart)}${startMarker}` +
      `${markdown.slice(rawMatchStart, rawMatchEnd)}${endMarker}` +
      markdown.slice(rawMatchEnd),
  );
  const absoluteIndex = markedBody.indexOf(startMarker);
  const markedMatchEnd = markedBody.indexOf(
    endMarker,
    absoluteIndex + startMarker.length,
  );
  if (absoluteIndex === -1 || markedMatchEnd === -1) return null;
  if (
    markedBody.slice(absoluteIndex + startMarker.length, markedMatchEnd) !==
      exact ||
    markedBody.replace(startMarker, "").replace(endMarker, "") !== body ||
    bodyLower.slice(absoluteIndex, absoluteIndex + exact.length) !== exactLower
  ) {
    return null;
  }

  const occurrence = allTextOccurrences(bodyLower, exactLower).indexOf(
    absoluteIndex,
  );
  if (occurrence === -1) return null;
  return {
    exact: body.slice(absoluteIndex, absoluteIndex + exact.length),
    occurrence,
    before: body.slice(Math.max(0, absoluteIndex - 48), absoluteIndex),
    after: body.slice(
      absoluteIndex + exact.length,
      absoluteIndex + exact.length + 80,
    ),
  };
}

function allTextOccurrences(value: string, exact: string): number[] {
  const occurrences: number[] = [];
  let cursor = value.indexOf(exact);
  while (cursor !== -1) {
    occurrences.push(cursor);
    cursor = value.indexOf(exact, cursor + 1);
  }
  return occurrences;
}

/** Split a human query into a bounded set of Unicode words. The cap prevents a
 *  pasted paragraph from becoming dozens of ripgrep patterns. */
export function tokenizeSearchQuery(query: string): string[] {
  const words = query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const unique = [...new Set(words)].slice(0, 8);
  if (unique.length > 0) return unique;
  const fallback = query.trim().toLocaleLowerCase();
  return fallback ? [fallback] : [];
}

/** Lower is better. This is deliberately lexical rather than "AI search":
 *  predictable title and phrase matches win, then same-line coverage. */
export function rankSearchCandidate(
  title: string,
  lines: string[],
  query: string,
): number {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const terms = tokenizeSearchQuery(query);
  const normalizedTitle = title.toLocaleLowerCase();
  if (normalizedTitle === normalizedQuery) return 0;
  if (normalizedTitle.startsWith(normalizedQuery)) return 10;
  if (normalizedTitle.includes(normalizedQuery)) return 20;
  if (terms.every((term) => normalizedTitle.includes(term))) return 30;

  const normalizedLines = lines.map((line) => line.toLocaleLowerCase());
  if (normalizedLines.some((line) => line.includes(normalizedQuery))) return 40;
  if (
    normalizedLines.some((line) =>
      terms.every((term) => line.includes(term)),
    )
  ) {
    return 50;
  }
  const titleCoverage = terms.filter((term) => normalizedTitle.includes(term)).length;
  return 80 - titleCoverage * 5;
}

function bestSearchLine(lines: string[], query: string, terms: string[]): string | null {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  return (
    [...lines]
      .map((line, index) => {
        const normalized = line.toLocaleLowerCase();
        const coverage = terms.filter((term) => normalized.includes(term)).length;
        const exact = normalized.includes(normalizedQuery);
        return { line, index, coverage, exact };
      })
      .sort(
        (a, b) =>
          Number(b.exact) - Number(a.exact) ||
          b.coverage - a.coverage ||
          a.index - b.index,
      )[0]?.line ?? null
  );
}

function searchTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/** Window around the exact phrase, or around the first matching word. */
function makeSnippet(line: string, q: string, terms: string[]) {
  const normalizedLine = line.toLocaleLowerCase();
  const normalizedQuery = q.toLocaleLowerCase();
  let idx = normalizedLine.indexOf(normalizedQuery);
  let matchLength = q.length;
  if (idx === -1) {
    const first = terms
      .map((term) => ({ term, index: normalizedLine.indexOf(term) }))
      .filter(({ index }) => index !== -1)
      .sort((a, b) => a.index - b.index)[0];
    idx = first?.index ?? -1;
    matchLength = first?.term.length ?? 0;
  }
  if (idx === -1) {
    return { before: stripMd(line).slice(0, 120), match: "", after: "" };
  }
  const start = Math.max(0, idx - 40);
  const before = (start > 0 ? "…" : "") + stripMd(line.slice(start, idx));
  const match = line.slice(idx, idx + matchLength);
  const after = stripMd(line.slice(idx + matchLength, idx + matchLength + 100));
  return { before, match, after };
}

/** THE WORD THAT IS IN EVERY NOTE.
 *
 *  A run is one ripgrep invocation. The phrase comes first and the words
 *  follow, each on its own: a single multi-pattern command applies max-count
 *  to their combined output, so a common first word hides a rarer second word
 *  later in the same note.
 *
 *  EVERY WORD KEEPS ITS RUN, AND THE BROAD ONES GO LAST. "Урок 15 сентября"
 *  failed on Michael's notebook because "15" is in three lines of nearly every
 *  note he keeps and the whole search was refused over its output. A first cut
 *  of this dropped that run: a word under three characters, or one that is
 *  only digits, is nearly free of meaning on its own. It also cost real
 *  recall — a note holding урок, 15 and сентября on three separate lines was a
 *  hit before and stopped being one — and the cap below made the run cheap
 *  again, so the exclusion was buying nothing. It is an ordering now.
 *
 *  ORDER IS NOT COSMETIC HERE. A candidate keeps the first twelve lines that
 *  land on it (`doSearch`), and that is what the snippet and the same-line
 *  ranking are read out of, so the run that says least about the query must
 *  not be the one that fills those twelve. The broad word goes last for that
 *  reason, and because a run capped at 300 answers whichever lines ripgrep
 *  walked first — luck, and different on every machine. */
export interface SearchRun {
  readonly pattern: string;
  /** The whole trimmed query, as one fixed string. Its hits rank first. */
  readonly phrase: boolean;
}

const SHORT_WORD_CHARS = 3;

export function searchRunPlan(query: string): SearchRun[] {
  const phrase = query.trim();
  const terms = tokenizeSearchQuery(query);
  if (!phrase || terms.length === 0) return [];
  // A one-word query is its own phrase. Running it twice would be the same
  // search for the same lines against the same cap.
  const words = terms.filter((term) => term !== phrase.toLocaleLowerCase());
  const ordered = [
    ...words.filter((term) => !saysLittleAlone(term)),
    ...words.filter(saysLittleAlone),
  ];
  return [
    { pattern: phrase, phrase: true },
    ...ordered.map((term) => ({ pattern: term, phrase: false })),
  ];
}

/** A word that carries nearly no intent by itself: under three characters, or
 *  only digits. It is still searched — it is still one of the words the
 *  reader typed — but after the words that say something. */
function saysLittleAlone(term: string): boolean {
  return [...term].length < SHORT_WORD_CHARS || /^\p{N}+$/u.test(term);
}

async function rgJson(query: string): Promise<{ phrase: string[]; words: string[] }> {
  const phrase: string[] = [];
  const words: string[] = [];
  for (const run of searchRunPlan(query)) {
    const lines = await runRipgrep([
      "--fixed-strings",
      "--ignore-case",
      "--max-count",
      "3",
      "-e",
      run.pattern,
    ]);
    (run.phrase ? phrase : words).push(...lines);
  }
  return { phrase, words };
}

/** Case-sensitive fixed-string match (ids are case-sensitive). */
function rgLines(pattern: string, maxCount: number): Promise<string[]> {
  return runRipgrep(["--fixed-strings", "--max-count", String(maxCount), "-e", pattern]);
}

/** How many `match` lines one run answers before ripgrep is stopped.
 *
 *  A BROAD TERM DEGRADES, IT DOES NOT FAIL. The old guard counted bytes over
 *  the whole run and refused everything at 512 KB, so a word in most of the
 *  notes — "15", in the query that reported this — turned the search into
 *  `search_backend` rather than into the first matches it had already read.
 *  Three hundred is well past `MAX_HITS` even when every line lands on a
 *  different page, so the answer a reader sees is the same answer for
 *  anything narrower than the cap. */
export const MAX_MATCH_LINES = 300;

/** The one thing bytes are still counted for: a single line past this cannot
 *  be answered out of half of itself, and nothing downstream will parse it.
 *  Measured in bytes with `Buffer.byteLength`, not in `String.length`, which
 *  is UTF-16 units — a line of Cyrillic is two bytes a character and would
 *  otherwise reach a megabyte before this fired. */
const MAX_LINE_BYTES = 512 * 1024;

const MATCH_LINE = /"type"\s*:\s*"match"/;

export function runRipgrep(
  args: string[],
  cwd: string = NOTES_ROOT,
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const rg = spawn(
      "rg",
      ["--json", ...args, "-g", "index.md", "."],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    const lines: string[] = [];
    let pending = "";
    let matches = 0;
    let stderr = "";
    let settled = false;
    let exceededOutputLimit = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(lines);
    };
    const timer = setTimeout(() => {
      rg.kill("SIGKILL");
      finish(new SearchBackendError("ripgrep search timed out"));
    }, TIMEOUT_MS);
    // Decoded here rather than by concatenating buffers: a multi-byte
    // character split across two chunks is one character again.
    rg.stdout.setEncoding("utf8");
    rg.stdout.on("data", (chunk: string) => {
      // Nothing after the answer or after the guard: a kill is not instant,
      // and a chunk already in flight must not reopen a run that is over.
      if (settled || exceededOutputLimit) return;
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line) {
          lines.push(line);
          if (MATCH_LINE.test(line)) matches += 1;
        }
        if (matches >= MAX_MATCH_LINES) {
          // Answered, not refused: these are the first matches, and ripgrep
          // has no more work to do for a caller that keeps twenty of them.
          rg.kill("SIGKILL");
          finish();
          return;
        }
        newline = pending.indexOf("\n");
      }
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES) {
        exceededOutputLimit = true;
        rg.kill("SIGKILL");
      }
    });
    rg.stderr.on("data", (chunk) => {
      if (stderr.length < 4_096) stderr += chunk.toString();
    });
    rg.on("close", (code) => {
      if (exceededOutputLimit) {
        finish(new SearchBackendError("ripgrep search exceeded output limit"));
        return;
      }
      // THE RUN THIS SIDE ENDED IS NOT A RUN THAT FAILED. A cap and a timeout
      // both close on a SIGKILL, and close then arrives with a null code and
      // whatever ripgrep had written to stderr — an unreadable file, a
      // warning. Logging that as a failure puts failure lines in the server's
      // log for searches that answered.
      if (settled) return;
      // ripgrep uses exit 1 for a successful search with no matches.
      if (code === 0 || code === 1) {
        // A last line with no newline after it. ripgrep terminates every JSON
        // line, so this is the shape of a run that was cut off elsewhere.
        if (pending) lines.push(pending);
        finish();
        return;
      }
      // THE MESSAGE LEAVES THE PROCESS, SO THE STDERR STAYS IN IT.
      //
      // This sentence now reaches an MCP agent verbatim (`search_backend`),
      // and the other three throwers say nothing of the machine because they
      // are fixed strings. This one interpolated a third-party binary's error
      // text, so what it names is ripgrep's business and not something this
      // code can promise — an `RIPGREP_CONFIG_PATH` that will not parse, for
      // one, is reported with its absolute path. The operator still needs it,
      // so it goes to the server's own log and the exit code travels alone.
      if (stderr.trim()) {
        console.error(
          `ripgrep search failed (${code ?? "signal"}): ${stderr.trim().slice(0, 500)}`,
        );
      }
      finish(new SearchBackendError(`ripgrep search failed (${code ?? "signal"})`));
    });
    rg.on("error", (error) => {
      finish(new SearchBackendError(`ripgrep search unavailable: ${error.message}`));
    });
  });
}
