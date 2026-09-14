import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

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

export interface OwnerSettings {
  schema: 1;
  /** An IANA name, "Europe/Lisbon". Null until a client has offered one. */
  timeZone: string | null;
}

/** The slice of the environment this module reads. `process.env` fits it;
 *  tests pass a literal. A narrower type than NodeJS.ProcessEnv because Next
 *  declares NODE_ENV there as required, which a literal without it fails. */
export interface OwnerSettingsEnv {
  NODE_ENV?: string;
  BRAIN_SETTINGS_STATE_DIR?: string;
}

export const OWNER_SETTINGS_FILE = "owner.json";

const EMPTY: OwnerSettings = { schema: 1, timeZone: null };

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

/** The one reading of the file, memoised per directory. */
const cache = new Map<string, OwnerSettings>();

export function resetOwnerSettingsCache(): void {
  cache.clear();
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
      settings = { schema: 1, timeZone: isTimeZone(zone) ? zone : null };
    }
  } catch {
    settings = EMPTY;
  }
  cache.set(dir, settings);
  return settings;
}

export async function readTimeZone(
  dir = ownerSettingsDirectory(),
): Promise<string | null> {
  return (await readOwnerSettings(dir)).timeZone;
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
  const current = await readOwnerSettings(dir);
  if (current.timeZone !== null) return current.timeZone;
  if (!isTimeZone(zone)) return null;
  await write(dir, { schema: 1, timeZone: zone });
  return zone;
}

/** The owner saying so, in Settings. This one does overwrite. */
export async function setTimeZone(
  zone: string,
  dir = ownerSettingsDirectory(),
): Promise<void> {
  if (!isTimeZone(zone)) throw new Error(`unknown time zone: ${zone}`);
  await write(dir, { schema: 1, timeZone: zone });
}
