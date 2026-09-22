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
 *  The order is load-bearing. The workers go down first and the flag is
 *  written after, and a stop that throws leaves the flag alone. A record that
 *  says paused over a worker still running is the one state a restart cannot
 *  repair: it would read the flag, skip `start()`, and the running pass would
 *  be the only thing left sending.
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
  return {
    isPaused: () => paused,
    async setPaused(next: boolean): Promise<void> {
      if (next === paused) return;
      for (const worker of options.workers) {
        if (next) await worker.stop();
        else await worker.start();
      }
      options.writePaused(next);
      paused = next;
    },
  };
}
