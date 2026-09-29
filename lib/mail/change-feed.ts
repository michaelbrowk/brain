import { brainEvents, emitMail, type SequencedStoreEvent } from "@/lib/store/events";
import { registerActiveSseClose } from "@/lib/store/sse-shutdown";

import type { BrainMailEvent } from "./mail-events";
import type { MailSystemMailbox } from "./message-types";
import type { MailChangeFeedAnswer, MailServiceChange } from "./service/change-feed-ring";

/** THE LOOP THAT BRINGS THE MAIL SERVICE'S CHANGES INTO THIS PROCESS.
 *
 *  The service never dials Brain (section 4 of the mail architecture), so
 *  Brain asks: one long poll of `GET /v1/changes` at a time, re-armed the
 *  moment an answer lands, whose changes leave here as `mail` events on
 *  `brainEvents` and reach every open tab through `app/api/events`. One loop
 *  per process; it is started beside the reminder scan in `instrumentation.ts`
 *  and stopped with the SSE streams on shutdown.
 *
 *  NEVER A HOT LOOP. A failed read waits one second, then two, four, and so
 *  on to a minute. A quiet answer that came back at once was not a long poll
 *  (an old service, a broken one), and it waits the same way rather than
 *  being asked again straight off.
 *
 *  MAIL OFF MEANS NO ASKING. With the module switched off the loop sleeps and
 *  wakes on the switch's own event, with a slow look every minute in case
 *  that event was missed. The cursor is kept across the sleep, so a switch
 *  back on picks up where it stopped or hears a reset.
 *
 *  A LOSS IS SAID ONCE, AS A RESET. The service answers `reset` when the
 *  cursor left its ring or it restarted; a first answer after reads that
 *  failed is treated the same, because nothing says what happened in the gap.
 */
export const MAIL_CHANGE_WAIT_MS = 25_000;
export const MAIL_CHANGE_RETRY_BASE_MS = 1_000;
export const MAIL_CHANGE_RETRY_MAX_MS = 60_000;
const MAIL_OFF_RECHECK_MS = 60_000;
/** A quiet answer faster than this was not held by the service. */
const QUIET_ANSWER_FLOOR_MS = 1_000;

export interface MailChangeFeedLoopPort {
  readChanges(
    input: { readonly cursor: number | null; readonly waitMs: number },
    signal: AbortSignal,
  ): Promise<MailChangeFeedAnswer>;
  mailEnabled(): Promise<boolean>;
  emit(event: BrainMailEvent): void;
  /** Called when the owner's module switches change; answers an unsubscribe. */
  onModulesChange(listener: () => void): () => void;
}

export class MailChangeFeedLoop {
  private readonly port: MailChangeFeedLoopPort;
  private readonly waitMs: number;
  private controller: AbortController | null = null;

  constructor(port: MailChangeFeedLoopPort, options: { readonly waitMs?: number } = {}) {
    this.port = port;
    this.waitMs = options.waitMs ?? MAIL_CHANGE_WAIT_MS;
  }

  start(): void {
    if (this.controller !== null) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.run(controller.signal);
  }

  stop(): void {
    this.controller?.abort();
    this.controller = null;
  }

  private async run(signal: AbortSignal): Promise<void> {
    let cursor: number | null = null;
    let failures = 0;
    while (!signal.aborted) {
      let enabled: boolean;
      try {
        enabled = await this.port.mailEnabled();
      } catch {
        enabled = false;
      }
      if (signal.aborted) return;
      if (!enabled) {
        await this.sleep(MAIL_OFF_RECHECK_MS, signal, true);
        continue;
      }
      const startedAt = Date.now();
      let answer: MailChangeFeedAnswer;
      try {
        answer = await this.port.readChanges({ cursor, waitMs: this.waitMs }, signal);
      } catch {
        if (signal.aborted) return;
        failures += 1;
        await this.sleep(retryDelay(failures), signal, false);
        continue;
      }
      if (signal.aborted) return;
      if (answer.reset === true || (cursor === null && failures > 0)) {
        cursor = answer.cursor;
        failures = 0;
        this.emit({ kind: "mail", changeKind: "reset" });
        continue;
      }
      const first = cursor === null;
      cursor = answer.cursor;
      if (first) continue;
      if (answer.changes.length === 0 && Date.now() - startedAt < QUIET_ANSWER_FLOOR_MS) {
        failures += 1;
        await this.sleep(retryDelay(failures), signal, false);
        continue;
      }
      failures = 0;
      for (const event of coalesceChanges(answer.changes)) this.emit(event);
    }
  }

  private emit(event: BrainMailEvent): void {
    try {
      this.port.emit(event);
    } catch {
      // A listener's failure is its own; the loop keeps reading.
    }
  }

  private sleep(ms: number, signal: AbortSignal, wakeOnModules: boolean): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      let unsubscribe = () => {};
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        unsubscribe();
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref?.();
      signal.addEventListener("abort", done, { once: true });
      if (wakeOnModules) unsubscribe = this.port.onModulesChange(done);
    });
  }
}

function retryDelay(failures: number): number {
  return Math.min(
    MAIL_CHANGE_RETRY_BASE_MS * 2 ** Math.min(failures - 1, 16),
    MAIL_CHANGE_RETRY_MAX_MS,
  );
}

/** One event per account and kind in an answer: a burst of records about one
 *  account is one refresh in a tab, not one per record. */
function coalesceChanges(changes: readonly MailServiceChange[]): BrainMailEvent[] {
  const groups = new Map<
    string,
    {
      readonly accountId: string;
      readonly changeKind: MailServiceChange["kind"];
      readonly mailboxIds: MailSystemMailbox[];
      readonly messageIds: string[];
    }
  >();
  for (const change of changes) {
    const key = `${change.accountId}\u0000${change.kind}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = {
        accountId: change.accountId,
        changeKind: change.kind,
        mailboxIds: [],
        messageIds: [],
      };
      groups.set(key, group);
    }
    for (const mailboxId of change.mailboxIds) {
      if (!group.mailboxIds.includes(mailboxId)) group.mailboxIds.push(mailboxId);
    }
    if (change.messageId !== undefined && !group.messageIds.includes(change.messageId)) {
      group.messageIds.push(change.messageId);
    }
  }
  return [...groups.values()].map((group) =>
    group.changeKind === "content_ready"
      ? {
          kind: "mail",
          changeKind: group.changeKind,
          accountId: group.accountId,
          mailboxIds: group.mailboxIds,
          messageIds: group.messageIds,
        }
      : {
          kind: "mail",
          changeKind: group.changeKind,
          accountId: group.accountId,
          mailboxIds: group.mailboxIds,
        },
  );
}

function defaultPort(): MailChangeFeedLoopPort {
  return {
    readChanges: async (input, signal) => {
      const { readMailChanges } = await import("./brain-mail-client");
      return readMailChanges(input, signal);
    },
    mailEnabled: async () => {
      const { readModules } = await import("@/lib/owner-settings");
      return (await readModules()).mail;
    },
    emit: emitMail,
    onModulesChange: (listener) => {
      const onChange = (event: SequencedStoreEvent) => {
        if (event.type === "modules") listener();
      };
      brainEvents.on("change", onChange);
      return () => brainEvents.off("change", onChange);
    },
  };
}

const feedGlobal = globalThis as typeof globalThis & {
  __brainMailChangeFeed?: MailChangeFeedLoop;
};

/** Boot-time start. Off under NODE_ENV=test like its neighbours in
 *  `instrumentation.ts`, and once per process: Next can evaluate this module
 *  in more than one layer, and two loops would each be refused as busy by
 *  the service half the time. Returns a disposer; shutdown calls it through
 *  the SSE registry. */
export function startMailChangeFeed(
  options: {
    readonly env?: { readonly NODE_ENV?: string };
    readonly port?: MailChangeFeedLoopPort;
  } = {},
): () => void {
  const env = options.env ?? { NODE_ENV: process.env.NODE_ENV };
  if (env.NODE_ENV === "test" || feedGlobal.__brainMailChangeFeed !== undefined) {
    return () => {};
  }
  const loop = new MailChangeFeedLoop(options.port ?? defaultPort());
  feedGlobal.__brainMailChangeFeed = loop;
  let unregister = () => {};
  const stop = () => {
    if (feedGlobal.__brainMailChangeFeed === loop) feedGlobal.__brainMailChangeFeed = undefined;
    loop.stop();
    unregister();
  };
  loop.start();
  unregister = registerActiveSseClose(stop);
  return stop;
}
