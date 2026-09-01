#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { trackedFiles } from "./export-public.mjs";

// Supplied by the process, the platform, or systemd — never by .env.
const AMBIENT = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "NODE_ENV",
  "CI",
  "GITHUB_SHA",
  "NEXT_RUNTIME",
  "CREDENTIALS_DIRECTORY",
  "STATE_DIRECTORY",
  "LISTEN_PID",
  "LISTEN_FDS",
  "LISTEN_FDNAMES",
]);

const SOURCE_DIRECTORIES = ["app/", "lib/", "scripts/", "ops/", "components/", "workers/"];
// The repository root itself, which holds next.config.ts, playwright.config.ts
// and instrumentation.ts. Scanning only directories left those invisible, and
// next.config.ts's BRAIN_DIST_DIR was undocumented the whole time because of
// it. A root file is one with no separator in its tracked path.
const inScope = (file) =>
  !file.includes("/") || SOURCE_DIRECTORIES.some((dir) => file.startsWith(dir));
const TEST_FILE = /\.(test|spec)\.[jt]sx?$|_test\.py$|\/testing\//;

const SCRIPT_FILE = /\.(ts|tsx|mjs|js)$/;
const PYTHON_FILE = /\.py$/;
// Shell, systemd units and Compose files interpolate a name instead of calling
// a reader, so `${FOO}` there is indistinguishable from an ordinary local
// variable. Only the project's own prefixes count as an environment read.
const INTERPOLATING_FILE = /\.sh$|^ops\/[^/]+\.service$|^ops\/docker\/[^/]+\.ya?ml$/;
const PROJECT_PREFIX = /^(BRAIN_|AUTH_|NOTES_|MCP_|OPENROUTER_)/;

// A line whose first non-whitespace run opens a comment reads nothing, in
// every language here. Deliberately line-level: a `#` inside a quoted value is
// not a comment, and a real read keeps counting when a comment trails it.
const COMMENT_LINE = /^\s*(\/\/|#|\*|\/\*)/;

function codeOnly(body) {
  return body
    .split("\n")
    .map((line) => (COMMENT_LINE.test(line) ? "" : line))
    .join("\n");
}

export const COVERAGE =
  "tracked .ts/.tsx/.mjs/.js, .py, .sh, ops/*.service and ops/docker/*.yml in the " +
  "repository root and under " +
  SOURCE_DIRECTORIES.join(" ");

function addScriptNames(body, names) {
  for (const match of body.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(match[1]);
  for (const match of body.matchAll(/process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g)) names.add(match[1]);
  // The health route's named-read helper: exactEnvironmentValue("NAME").
  for (const match of body.matchAll(/exactEnvironmentValue\(\s*["']([A-Z][A-Z0-9_]*)["']/g)) names.add(match[1]);
}

function addPythonNames(body, names) {
  for (const match of body.matchAll(/os\.environ\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/g)) names.add(match[1]);
  for (const match of body.matchAll(/os\.environ\.get\(\s*["']([A-Z][A-Z0-9_]*)["']/g)) names.add(match[1]);
  for (const match of body.matchAll(/os\.getenv\(\s*["']([A-Z][A-Z0-9_]*)["']/g)) names.add(match[1]);
}

function addInterpolatedNames(body, names) {
  for (const match of body.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)) {
    if (PROJECT_PREFIX.test(match[1])) names.add(match[1]);
  }
  for (const match of body.matchAll(/\$([A-Z][A-Z0-9_]*)/g)) {
    if (PROJECT_PREFIX.test(match[1])) names.add(match[1]);
  }
}

export async function readEnvNames(root) {
  const files = (await trackedFiles(root)).filter(
    (file) =>
      inScope(file) &&
      !TEST_FILE.test(file) &&
      (SCRIPT_FILE.test(file) || PYTHON_FILE.test(file) || INTERPOLATING_FILE.test(file)),
  );
  const names = new Set();
  for (const file of files) {
    const body = codeOnly(await readFile(path.join(root, file), "utf8"));
    if (SCRIPT_FILE.test(file)) addScriptNames(body, names);
    if (PYTHON_FILE.test(file)) addPythonNames(body, names);
    if (INTERPOLATING_FILE.test(file)) addInterpolatedNames(body, names);
  }
  return [...names].filter((name) => !AMBIENT.has(name)).sort();
}

export async function documentedEnvNames(root) {
  const body = await readFile(path.join(root, ".env.example"), "utf8");
  const names = new Set();
  for (const line of body.split("\n")) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

export async function undocumentedEnvNames(root) {
  const documented = new Set(await documentedEnvNames(root));
  return (await readEnvNames(root)).filter((name) => !documented.has(name));
}

// The other direction: a block left behind after its reader was deleted, or a
// reader written in a language this scanner does not cover yet. Both are drift
// and both must be looked at, so neither gets an exemption list.
export async function unreadEnvNames(root) {
  const read = new Set(await readEnvNames(root));
  return (await documentedEnvNames(root)).filter((name) => !read.has(name));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = process.cwd();
  const missing = await undocumentedEnvNames(root);
  const unread = await unreadEnvNames(root);
  if (missing.length > 0) {
    console.error(`.env.example does not document:\n${missing.join("\n")}`);
  }
  if (unread.length > 0) {
    console.error(
      `.env.example documents names nothing in the tree reads. Delete the block, or teach the scanner the language its reader is written in:\n${unread.join("\n")}`,
    );
  }
  if (missing.length > 0 || unread.length > 0) process.exit(1);
  console.log(
    `${COVERAGE}: every name they read is documented in .env.example, and .env.example documents no name they never read`,
  );
}
