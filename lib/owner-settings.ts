import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ALL_MODULES_ON, type ModuleSwitches } from "./modules";
import { atomicWrite } from "./store/atomic";

/** THE ONE DURABLE OWNER SETTING, AND WHY IT IS NOT IN THE NOTES TREE.
 *
 *  Every list request carries the reader's own `today` and `offsetMinutes`,
 *  which is right for what a person sees. A reminder has no request to read:
 *  it fires from a server timer against a day and a wall clock stored in a
 *  file, so somewhere there has to be one answer to "whose evening is this".
 *  That is this file.
 *
 *  It lives under the state directory, beside the update check's own answer
 *  (`lib/update-check.ts`), and never under `NOTES_ROOT`: only `lib/store`
 *  touches the notes filesystem, and a zone is a property of this instance
 *  rather than of the notes, so it must not travel in a portable archive or a
 *  git history of somebody's writing.
 *
 *  The write is `atomicWrite`, the house rule for every file write, and the
 *  read is memoised: a list request in the steady state opens nothing.
 */

/** Which modules this installation draws, serves and runs background work
 *  for. A property of the instance, like the zone above it: it is not in a
 *  portable archive and not in anybody's git history, because turning Mail
 *  off on the laptop must not turn it off on the server a restore lands on.
 *
 *  The shape and its default live in `lib/modules.ts`, which imports nothing:
 *  the shell is a client component and holds the pair, and reaching them
 *  through this file put `node:fs/promises` in a browser chunk. Re-exported
 *  here so a server caller reads them where it reads the zone. */
export { ALL_MODULES_ON, type ModuleSwitches } from "./modules";

export interface OwnerSettings {
  schema: 2;
  /** An IANA name, "Europe/Lisbon". Null until a client has offered one. */
  timeZone: string | null;
  modules: ModuleSwitches;
}

/** The slice of the environment this module reads. `process.env` fits it;
 *  tests pass a literal. A narrower type than NodeJS.ProcessEnv because Next
 *  declares NODE_ENV there as required, which a literal without it fails. */
export interface OwnerSettingsEnv {
  NODE_ENV?: string;
  BRAIN_SETTINGS_STATE_DIR?: string;
}

export const OWNER_SETTINGS_FILE = "owner.json";

const EMPTY: OwnerSettings = {
  schema: 2,
  timeZone: null,
  modules: ALL_MODULES_ON,
};

/** `scripts/check-env-docs.mjs` counts a read only when it is spelled
 *  `process.env.NAME`, so the default environment names the variable. */
function processEnv(): OwnerSettingsEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    BRAIN_SETTINGS_STATE_DIR: process.env.BRAIN_SETTINGS_STATE_DIR,
  };
}

export function ownerSettingsDirectory(env: OwnerSettingsEnv = processEnv()): string {
  if (env.BRAIN_SETTINGS_STATE_DIR) return env.BRAIN_SETTINGS_STATE_DIR;
  if (env.NODE_ENV === "production") return "/var/lib/brain/settings";
  return path.join(
    /* turbopackIgnore: true */ os.tmpdir(),
    `brain-settings-${process.getuid?.() ?? "dev"}`,
  );
}

/** THE ONE READING OF THE FILE, MEMOISED PER DIRECTORY, ACROSS LAYERS.
 *
 *  On `globalThis` and not in a module variable, for the reason
 *  `lib/store/events.ts` gives about its emitter: Next bundles `proxy.ts`
 *  separately from the route handlers, so a module-level Map is a different
 *  instance in each. The module gate reads this in the proxy and the PUT
 *  writes it in a handler, and with two caches the gate would answer from a
 *  file it read once at boot for as long as the process lived.
 *
 *  Keyed by directory, and the reset takes one. `pnpm check` runs
 *  `vitest run --maxWorkers=2`, whose default pool shares one `globalThis`,
 *  so a blanket clear from one test file would drop another file's entry
 *  while it was mid-case. The no-argument form still clears everything,
 *  which is what the zone's own suite already asks for. */
const g = globalThis as unknown as { __brainOwnerSettings?: Map<string, OwnerSettings> };
const cache = (g.__brainOwnerSettings ??= new Map<string, OwnerSettings>());

export function resetOwnerSettingsCache(dir?: string): void {
  if (dir === undefined) cache.clear();
  else cache.delete(dir);
}

/** An IANA region name and nothing else: a letter, then letters, digits and
 *  the three punctuation marks the database uses, in slash-separated parts.
 *  The shape gate is what refuses "+03:00", which the platform accepts and a
 *  reminder cannot use: a fixed offset carries no summer-time rule, so a
 *  13:00 alarm set in March would fire at 14:00 in July. */
const IANA_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

/** Whether the platform's own calendar knows this name. No list is shipped:
 *  the zone database moves and a copy of it here would go stale.
 *  `Intl.supportedValuesOf("timeZone")` is not the gate either, because it
 *  answers canonical names only: "UTC" and every alias a browser still
 *  reports ("Asia/Calcutta") are absent from it and are zones all the same. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || value === "" || value.length > 64) return false;
  if (!IANA_NAME.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function readModuleSwitches(raw: unknown): ModuleSwitches {
  if (!raw || typeof raw !== "object") return ALL_MODULES_ON;
  const held = raw as { mail?: unknown; tasks?: unknown };
  // A key that is missing, or carries anything but a boolean, reads as on.
  // The alternative is a typo in a hand-edited file silently hiding Mail.
  return {
    mail: held.mail !== false,
    tasks: held.tasks !== false,
  };
}

export async function readOwnerSettings(
  dir = ownerSettingsDirectory(),
): Promise<OwnerSettings> {
  const held = cache.get(dir);
  if (held) return held;
  let settings = EMPTY;
  try {
    const raw: unknown = JSON.parse(
      await fs.readFile(path.join(dir, OWNER_SETTINGS_FILE), "utf8"),
    );
    // A file somebody broke reads as unset rather than throwing. Settings are
    // not notes: the honest answer to an unreadable one is "nothing is set",
    // and the next capture writes a whole file over it.
    if (raw && typeof raw === "object") {
      const zone = (raw as { timeZone?: unknown }).timeZone;
      settings = {
        schema: 2,
        timeZone: isTimeZone(zone) ? zone : null,
        // A schema 1 file has no `modules` at all, which is the upgrade path
        // and reads as both on.
        modules: readModuleSwitches((raw as { modules?: unknown }).modules),
      };
    }
  } catch {
    settings = EMPTY;
  }
  cache.set(dir, settings);
  return settings;
}

export async function readModules(
  dir = ownerSettingsDirectory(),
): Promise<ModuleSwitches> {
  return (await readOwnerSettings(dir)).modules;
}

/** THE SWITCHES WITHOUT A FILE READ, for a caller that cannot await one.
 *
 *  `lib/store` checks the Tasks switch on the page-save path, inside a method
 *  whose signature is synchronous and which runs on every write. It reads
 *  what the memoised read already holds and nothing else, so a `null` here
 *  means "nobody has read the file yet in this process" rather than "both
 *  off"; the one caller treats that as on, which is the recoverable
 *  direction. `getStore()` warms it once before the Store's first pass. */
export function peekModules(dir = ownerSettingsDirectory()): ModuleSwitches | null {
  return cache.get(dir)?.modules ?? null;
}

export async function readTimeZone(
  dir = ownerSettingsDirectory(),
): Promise<string | null> {
  return (await readOwnerSettings(dir)).timeZone;
}

/** ONE WRITER AT A TIME, SO "CAPTURED ONCE" IS TRUE.
 *
 *  `captureTimeZone` reads, checks the zone is unset, and only then awaits a
 *  write. Two list requests arriving together from devices in different zones
 *  both read null, both write, and the later one lands, which is the opposite
 *  of what the function below promises. The queue is the same construction
 *  `lib/push/store.ts` uses over its own file, and for the same reason: a
 *  read-modify-write of a whole file loses one of two interleaved saves.
 *  Reads stay outside it, because a read never has to wait on a write. */
let queue: Promise<unknown> = Promise.resolve();
function serialise<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function write(dir: string, settings: OwnerSettings): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, OWNER_SETTINGS_FILE);
  await atomicWrite(file, `${JSON.stringify(settings)}\n`);
  // `atomicWrite` writes at the process umask, which the state files beside
  // this one do not accept: the directory is 0700 and the file is 0600, the
  // mode `lib/auth.ts` and the update check already write.
  await fs.chmod(file, 0o600);
  cache.set(dir, settings);
}

/** CAPTURED ONCE AND NEVER OVERWRITTEN.
 *
 *  The first client after the upgrade offers the zone its browser reports, and
 *  the server keeps it. A device in another zone does not change it: the
 *  reminder time is the owner's home clock, not the clock of whichever machine
 *  asked last. Answers the zone that stands after the call, or null when
 *  nothing is set and the offered name is not one the platform knows. */
export async function captureTimeZone(
  zone: string,
  dir = ownerSettingsDirectory(),
): Promise<string | null> {
  // The read and the write are one turn on the queue. Outside it, two first
  // requests both saw an unset file and the later one won.
  return serialise(async () => {
    const current = await readOwnerSettings(dir);
    if (current.timeZone !== null) return current.timeZone;
    if (!isTimeZone(zone)) return null;
    await write(dir, { ...current, timeZone: zone });
    return zone;
  });
}

/** The owner saying so, in Settings. This one does overwrite. The read and
 *  the write are one turn on the queue, so the modules beside the zone are
 *  the modules that stood when the write began. */
export async function setTimeZone(
  zone: string,
  dir = ownerSettingsDirectory(),
): Promise<void> {
  if (!isTimeZone(zone)) throw new Error(`unknown time zone: ${zone}`);
  await serialise(async () => {
    const current = await readOwnerSettings(dir);
    await write(dir, { ...current, timeZone: zone });
  });
}

/** A switch the owner flipped. Answers what stands after the call and whether
 *  anything was written: a PUT that changes nothing writes nothing, so the
 *  file's mtime, its backups and the SSE journal all stay quiet. */
export async function setModules(
  patch: Partial<ModuleSwitches>,
  dir = ownerSettingsDirectory(),
): Promise<{ modules: ModuleSwitches; changed: boolean }> {
  for (const value of Object.values(patch)) {
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error("module switch must be a boolean");
    }
  }
  return serialise(async () => {
    const current = await readOwnerSettings(dir);
    const modules: ModuleSwitches = {
      mail: patch.mail ?? current.modules.mail,
      tasks: patch.tasks ?? current.modules.tasks,
    };
    if (
      modules.mail === current.modules.mail &&
      modules.tasks === current.modules.tasks
    ) {
      return { modules: current.modules, changed: false };
    }
    await write(dir, { ...current, modules });
    return { modules, changed: true };
  });
}
