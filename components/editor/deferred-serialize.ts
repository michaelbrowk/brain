import type { Ctx } from "@milkdown/kit/ctx";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { $prose } from "@milkdown/kit/utils";

/** WHEN THE DOCUMENT IS SERIALIZED FOR THE SHELL.
 *
 *  Serializing is the one cost of a keystroke that still grows with the page:
 *  about a tenth of a second for a 5,000-line note, on the main thread, and
 *  nothing below can split it. Milkdown's listener ran it 200 ms after the
 *  last change, whatever the browser was doing then, so a writer who paused
 *  between two words on a long page typed the first letter of the next word
 *  into that serialize. This waits for quiet first: 200 ms, or three times
 *  what the last serialize cost when that is longer (capped at 500 ms), so a
 *  page whose serialize takes 100 ms is serialized in pauses of 300 ms and
 *  not between every two words. Then it asks for an idle moment
 *  (`requestIdleCallback`) and runs there, postponing while the browser
 *  reports less free time than the last run needed. Quiet and idle together
 *  are capped at one second after the last change: whatever the page and
 *  whatever the tab is doing, the serialize starts within that second.
 *
 *  What that costs in safety: the local draft, which `shell.tsx` writes from
 *  the serialized Markdown, used to be 200 ms behind the last key and can now
 *  be up to a second behind it (plus the serialize itself): 200 ms on a small
 *  page in an idle tab, as before, and the full second on a long page or in
 *  a tab whose frames leave no idle time. The paths that matter do not wait
 *  for this timer at all: `pagehide`, `visibilitychange`, navigation and a
 *  page switch all serialize synchronously through the registered flush, so
 *  a closed or hidden tab leaves with its newest text as before, and the
 *  shell marks the page unsaved on the first keystroke (`onDirty`), not on
 *  the serialize. The exposure is a tab that dies (a crash, not a close)
 *  inside that second.
 *
 *  Only transactions in the history count, as with Milkdown's listener: a
 *  load-time normalisation marked `addToHistory: false` waits for the next
 *  real edit or the next flush. */

export interface DeferredSerializer {
  /** Run `work` after the quiet period, at an idle moment. A later call
   *  replaces the work and restarts the quiet period. */
  schedule: (work: () => void) => void;
  /** Forget the scheduled work: the caller has serialized itself. */
  drop: () => void;
}

export const SERIALIZE_QUIET_MS = 200;
export const SERIALIZE_QUIET_CAP_MS = 500;
/** Quiet and idle wait together, from the last change. */
export const SERIALIZE_LAG_CAP_MS = 1000;
/** The quiet a serialize earns per millisecond it cost last time. */
const QUIET_PER_COST = 3;
/** `timeRemaining()` is capped near 50 ms by the browser, so a run that
 *  needs more is asked for the whole of an idle frame rather than never. */
const IDLE_FRAME_MS = 45;

export function createDeferredSerializer(
  options: { quietMs?: number; lagCapMs?: number } = {},
): DeferredSerializer {
  const quietMs = options.quietMs ?? SERIALIZE_QUIET_MS;
  const lagCapMs = options.lagCapMs ?? SERIALIZE_LAG_CAP_MS;
  let quiet: ReturnType<typeof setTimeout> | null = null;
  let idle: number | null = null;
  let job: (() => void) | null = null;
  let lastCostMs = 0;
  /** When the current wait has to end: the last change plus the lag cap. */
  let deadline = 0;

  const clear = () => {
    if (quiet !== null) clearTimeout(quiet);
    quiet = null;
    if (idle !== null && typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
    idle = null;
  };

  const run = () => {
    const work = job;
    job = null;
    if (!work) return;
    const started = performance.now();
    work();
    lastCostMs = performance.now() - started;
  };

  const onIdle = (frame: IdleDeadline) => {
    idle = null;
    if (!job) return;
    const needed = Math.min(lastCostMs, IDLE_FRAME_MS);
    if (!frame.didTimeout && performance.now() < deadline && frame.timeRemaining() < needed) {
      idle = requestIdleCallback(onIdle, { timeout: Math.max(1, deadline - performance.now()) });
      return;
    }
    run();
  };

  const afterQuiet = () => {
    quiet = null;
    if (typeof requestIdleCallback !== "function") {
      run();
      return;
    }
    idle = requestIdleCallback(onIdle, { timeout: Math.max(1, deadline - performance.now()) });
  };

  return {
    schedule: (work) => {
      job = work;
      clear();
      deadline = performance.now() + lagCapMs;
      const earned = Math.min(lastCostMs * QUIET_PER_COST, SERIALIZE_QUIET_CAP_MS);
      quiet = setTimeout(afterQuiet, Math.min(Math.max(quietMs, earned), lagCapMs));
    },
    drop: () => {
      job = null;
      clear();
    },
  };
}

/** How many history transactions have changed the document. A count, so the
 *  view can tell a state that carries a new change from the same state
 *  handed to it again: ProseMirror updates plugin views on `setProps` and on
 *  an unchanged state too, and a flag that stayed true until the next
 *  transaction restarted the quiet period on each of those, so on a page
 *  whose chrome updated often the serialize never came. */
const deferredSerializeKey = new PluginKey<number>("brainDeferredSerialize");

/** The editor's half: a transaction in the history that changed the document
 *  schedules a serialize, and a blur serializes at once, as Milkdown's
 *  listener did. `serialize` reads the view through the ctx it is given. */
export function deferredSerialize(
  scheduler: DeferredSerializer,
  serialize: (ctx: Ctx) => void,
) {
  return $prose(
    (ctx) =>
      new Plugin<number>({
        key: deferredSerializeKey,
        state: {
          init: () => 0,
          apply: (tr, changes) =>
            tr.docChanged && tr.getMeta("addToHistory") !== false ? changes + 1 : changes,
        },
        view: () => ({
          update: (view, previous) => {
            if (
              deferredSerializeKey.getState(view.state) !==
              deferredSerializeKey.getState(previous)
            ) {
              scheduler.schedule(() => {
                if (!view.isDestroyed) serialize(ctx);
              });
            }
          },
          destroy: () => scheduler.drop(),
        }),
        props: {
          handleDOMEvents: {
            blur: () => {
              serialize(ctx);
              return false;
            },
          },
        },
      }),
  );
}
