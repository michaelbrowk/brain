import path from "node:path";
import os from "node:os";
import { Store } from "./store";

export * from "./types";
export { MAX_ATTACHMENT_BYTES, Store } from "./store";

/** Notes live outside the app release dir, and a deployment says where with
 *  NOTES_ROOT — the README and .env.example both ask for it. Unset, which is
 *  what a bare `pnpm dev` gives you, the fallback is a `brain-notes` folder in
 *  the running user's home directory: a path that means the same thing on
 *  anybody's machine, and the one place the app may create on its own. */
export const NOTES_ROOT = path.resolve(
  /* turbopackIgnore: true */
  process.env.NOTES_ROOT || path.join(os.homedir(), "brain-notes"),
);

/** The origin page links are classified against — the same rule the browser
 *  applies with `window.location.origin`, so a body's standalone page rows
 *  count the same on both sides of an API call. Unset or not an exact origin
 *  means only the relative `/p/<id>` form is a page link. */
export function configuredPublicOrigin(): string | null {
  const raw = process.env.BRAIN_PUBLIC_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.origin === raw ? url.origin : null;
  } catch {
    return null;
  }
}

// Next bundles route handlers and RSC pages into SEPARATE module layers, so a
// plain module-level singleton gives each layer its own Store — a page created
// via /api (one layer) then 404s on the /p/[id] RSC route (another layer). Pin
// the instance to globalThis so every layer in the process shares ONE Store.
const g = globalThis as unknown as {
  __brainStore?: Store;
  __brainStoreInit?: Promise<Store>;
};

/** Process-wide singleton — the single writer of the filesystem. */
export async function getStore(): Promise<Store> {
  if (g.__brainStore) return g.__brainStore;
  if (!g.__brainStoreInit) {
    const s = new Store(NOTES_ROOT, { publicOrigin: configuredPublicOrigin() });
    // A start that fails closed — a move journal the disk no longer matches —
    // must not be remembered as the answer. Nothing before the throw wrote
    // anything, `mkdir` is idempotent and a fresh instance rebuilds its index
    // from scratch, so the next request tries again and comes back on its own
    // once the operator has repaired the notes.
    g.__brainStoreInit = s.init().then(
      () => (g.__brainStore = s),
      (error: unknown) => {
        g.__brainStoreInit = undefined;
        throw error;
      },
    );
  }
  return g.__brainStoreInit;
}
