/** THE SERVICE'S OWN ANSWER TO "SHOULD I BE RUNNING".
 *
 *  Brain owns the switch and the service owns the consequence, because the
 *  two are different processes with different users: `ops/brain-mail.service`
 *  runs as `brain-mail` and cannot read `/var/lib/brain/settings`. So the
 *  pause arrives as `PATCH /v1/sync` and is written here, into the service's
 *  own state directory, which is what makes a restart come up paused instead
 *  of syncing and sending until Brain next boots and says it again.
 *
 *  OFF MEANS NOTHING LEAVES. Three workers, not one: the background sync
 *  scheduler, the outbox drainer and the SMTP submission worker. All three
 *  abort their in-flight provider call and then await it, so the pass in
 *  flight finishes rather than being torn out mid-connection, and all three
 *  `start()` idempotently from their own initial delay. Rows already in the
 *  outbox are untouched: nothing here deletes, fails or expires one, and they
 *  drain on resume.
 *
 *  ONE COMMAND AT A TIME. `stop()` waits for the pass in flight, which an IMAP
 *  fetch or an SMTP handshake can hold open for tens of seconds, and a switch
 *  is a thing people flick twice. So commands queue on a tail: a resume issued
 *  while the pause is still draining runs after it and leaves the workers
 *  running, instead of reading the old value, answering the caller that Mail
 *  is on, and then being overwritten by the pause it raced.
 *
 *  THE RECORD MOVES FIRST, IN BOTH DIRECTIONS, AND ROLLS BACK. The flag is
 *  written before the workers are touched and restored if one refuses, so the
 *  record never outlives the attempt it describes. Ordering it the other way
 *  round is what opens the gap this closes: with the write last, a caller that
 *  arrives mid-drain sees a stale answer, and there is no point at which the
 *  service can say what it is doing. A process that dies inside a command
 *  leaves a row saying paused over workers that died with it, which the next
 *  boot reads as paused and honours.
 *
 *  A ROW IT CANNOT READ MEANS RUNNING. `readPaused` is the store's, and the
 *  store answers false for a missing row and for any value Brain did not
 *  write. Fail-open is the deliberate choice: Brain sends the switch again at
 *  every startup, so a wrong `false` costs a few seconds of sync, while a
 *  wrong `true` is a mail client stuck off with nothing in the interface to
 *  explain it.
 */
export interface MailSyncPauseWorker {
  start(): Promise<void> | void;
  stop(): Promise<void>;
}

export interface MailSyncPausePort {
  isPaused(): boolean;
  setPaused(paused: boolean): Promise<void>;
}

export function createMailSyncPause(options: {
  readPaused: () => boolean;
  writePaused: (paused: boolean) => void;
  workers: readonly MailSyncPauseWorker[];
}): MailSyncPausePort {
  let paused = options.readPaused();
  let tail: Promise<void> = Promise.resolve();
  const apply = async (next: boolean): Promise<void> => {
    if (next === paused) return;
    const previous = paused;
    paused = next;
    options.writePaused(next);
    try {
      for (const worker of options.workers) {
        if (next) await worker.stop();
        else await worker.start();
      }
    } catch (error) {
      paused = previous;
      options.writePaused(previous);
      throw error;
    }
  };
  return {
    isPaused: () => paused,
    setPaused(next: boolean): Promise<void> {
      const command = tail.then(() => apply(next));
      // The tail swallows the failure so one worker that refuses to stop does
      // not strand every later flip of the switch behind a rejected promise.
      // The caller still gets the rejection, from `command`.
      tail = command.catch(() => undefined);
      return command;
    },
  };
}

/** THE THREE THINGS THE SWITCH TURNS OFF, NAMED IN ONE PLACE.
 *
 *  `main.ts` wires the service together and has no test of its own, so a
 *  worker quietly missing from this list is a change nothing would see: Mail
 *  would report itself off while one of its three engines kept running. The
 *  list is built here instead, where `sync-pause.test.ts` asserts its members
 *  by identity, and the required fields below turn a dropped worker into a
 *  compile error.
 *
 *  The order is the order `main.ts` starts them in. The scheduler is adapted
 *  rather than passed because its `start()` is synchronous.
 */
export function mailSyncPauseWorkers(runtime: {
  readonly outboundWorker: MailSyncPauseWorker;
  readonly smtpWorker?: MailSyncPauseWorker;
  readonly backgroundSync: { start(): void; stop(): Promise<void> };
}): readonly MailSyncPauseWorker[] {
  return Object.freeze([
    runtime.outboundWorker,
    ...(runtime.smtpWorker ? [runtime.smtpWorker] : []),
    {
      start: () => runtime.backgroundSync.start(),
      stop: () => runtime.backgroundSync.stop(),
    },
  ]);
}
