/** THE MODULE SWITCHES, WITH NO DEPENDENCIES, SO A CLIENT MAY HOLD THEM.
 *
 *  The switches are read and written by `lib/owner-settings.ts`, which opens a
 *  file and therefore imports `node:fs/promises`. The shell is a client
 *  component and carries the pair as a prop with a default, so it needs the
 *  shape and the default and nothing else: importing them from there put
 *  `node:fs/promises` in a browser chunk, which Turbopack refuses outright
 *  ("the chunking context does not support external modules") and every page
 *  answered 500. `lib/owner-settings.ts` re-exports both, so a server caller
 *  reads them where it reads everything else.
 */
export interface ModuleSwitches {
  mail: boolean;
  tasks: boolean;
}

/** The reading of an absent, half-written or unreadable answer. Silence is
 *  "nothing is off": an installation that upgrades into 0.14.0 keeps every
 *  surface it had the day before. */
export const ALL_MODULES_ON: ModuleSwitches = Object.freeze({
  mail: true,
  tasks: true,
});
