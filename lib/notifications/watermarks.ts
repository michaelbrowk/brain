import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "@/lib/store/atomic";
import { notificationStateDirectory } from "./state-dir";

/** The newest `lastMessageAt` this instance has reported per account.
 *
 *  Beside the centre's own file and under the same 0700 directory: it is the
 *  same kind of state (reconstructible, about the notes rather than in them),
 *  and a second state directory for one integer per account would be a second
 *  thing to back up, document and forget. It is never in the notes folder and
 *  never in the portable archive.
 */
export const WATERMARKS_FILE = "mail-watermarks.json";

export async function readMailWatermarks(
  dir = notificationStateDirectory(),
): Promise<Record<string, number>> {
  try {
    const parsed: unknown = JSON.parse(
      await fs.readFile(path.join(dir, WATERMARKS_FILE), "utf8"),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [accountId, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) out[accountId] = value;
    }
    return out;
  } catch {
    // A file this process cannot read or parse is not a file to delete. An
    // empty answer means the next poll is a first pass: it says nothing and
    // rewrites the mark, which is the safe side of this failure.
    return {};
  }
}

export async function writeMailWatermark(
  accountId: string,
  at: number,
  dir = notificationStateDirectory(),
): Promise<void> {
  const held = await readMailWatermarks(dir);
  if (held[accountId] === at) return;
  await fs.mkdir(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, WATERMARKS_FILE);
  await atomicWrite(file, JSON.stringify({ ...held, [accountId]: at }) + "\n");
  // atomicWrite opens the temp file with the process umask, which on a
  // developer machine is 0022. The systemd unit sets UMask=0077 so production
  // already lands at 0600; this makes the mode the same everywhere.
  await fs.chmod(/* turbopackIgnore: true */ file, 0o600);
}
