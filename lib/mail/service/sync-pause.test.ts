import { describe, expect, it, vi } from "vitest";

import { createMailSyncPause, mailSyncPauseWorkers } from "./sync-pause";

function harness(startPaused = false) {
  let stored = startPaused;
  const worker = () => ({ start: vi.fn(), stop: vi.fn(async () => {}) });
  const workers = [worker(), worker(), worker()];
  const pause = createMailSyncPause({
    readPaused: () => stored,
    writePaused: (value) => {
      stored = value;
    },
    workers,
  });
  return { pause, workers, stored: () => stored };
}

/** A worker whose `stop()` hangs until the test lets it finish, which is the
 *  shape the real ones have: `stop()` aborts the provider call and then awaits
 *  the pass in flight, and an IMAP fetch or an SMTP handshake can hold that
 *  open for tens of seconds. */
function blockingWorker(events: string[]) {
  let release: () => void = () => {};
  const drained = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release,
    worker: {
      start: async () => {
        events.push("start");
      },
      stop: async () => {
        events.push("stop");
        await drained;
      },
    },
  };
}

describe("the mail service's own pause", () => {
  // Off means nothing leaves: the background sync, the outbox drainer and the
  // SMTP submission worker all go down, not just the first.
  it("stops every worker and records the pause", async () => {
    const { pause, workers, stored } = harness();
    expect(pause.isPaused()).toBe(false);
    await pause.setPaused(true);
    for (const worker of workers) expect(worker.stop).toHaveBeenCalledTimes(1);
    expect(pause.isPaused()).toBe(true);
    // Durable, so a restart comes up paused rather than syncing and sending
    // for an interval before anybody tells it again.
    expect(stored()).toBe(true);
  });

  it("starts every worker again on resume", async () => {
    const { pause, workers, stored } = harness(true);
    await pause.setPaused(false);
    for (const worker of workers) expect(worker.start).toHaveBeenCalledTimes(1);
    expect(pause.isPaused()).toBe(false);
    expect(stored()).toBe(false);
  });

  it("does nothing twice", async () => {
    const { pause, workers } = harness();
    await pause.setPaused(true);
    await pause.setPaused(true);
    expect(workers[0].stop).toHaveBeenCalledTimes(1);
  });

  // The record moves first and the workers follow, in both directions. What
  // makes that safe is the rollback below and the command tail further down:
  // the window where the record and the workers disagree is inside one
  // serialized command, and a process that dies inside it leaves a record
  // saying paused over workers that died with it.
  it("writes the flag before it stops the workers", async () => {
    const order: string[] = [];
    const pause = createMailSyncPause({
      readPaused: () => false,
      writePaused: () => order.push("write"),
      workers: [
        {
          start: () => {
            order.push("start");
          },
          stop: async () => {
            order.push("stop");
          },
        },
      ],
    });
    await pause.setPaused(true);
    expect(order).toEqual(["write", "stop"]);
  });

  it("writes the flag before it starts the workers again", async () => {
    const order: string[] = [];
    const pause = createMailSyncPause({
      readPaused: () => true,
      writePaused: () => order.push("write"),
      workers: [
        {
          start: () => {
            order.push("start");
          },
          stop: async () => {
            order.push("stop");
          },
        },
      ],
    });
    await pause.setPaused(false);
    expect(order).toEqual(["write", "start"]);
  });

  // A stop that throws rolls the record back, so the service comes back up
  // running, which is what it actually is.
  it("does not record a pause that did not happen", async () => {
    let stored = false;
    const pause = createMailSyncPause({
      readPaused: () => stored,
      writePaused: (value) => {
        stored = value;
      },
      workers: [
        {
          start: () => {},
          stop: async () => {
            throw new Error("worker would not stop");
          },
        },
      ],
    });
    await expect(pause.setPaused(true)).rejects.toThrow("worker would not stop");
    expect(stored).toBe(false);
    expect(pause.isPaused()).toBe(false);
  });

  // The same in the other direction, which is the half the first version of
  // this module left asymmetric: a start that throws must not leave a record
  // saying running over workers that are down.
  it("does not record a resume that did not happen", async () => {
    let stored = true;
    const pause = createMailSyncPause({
      readPaused: () => stored,
      writePaused: (value) => {
        stored = value;
      },
      workers: [
        {
          start: () => {
            throw new Error("worker would not start");
          },
          stop: async () => {},
        },
      ],
    });
    await expect(pause.setPaused(false)).rejects.toThrow(
      "worker would not start",
    );
    expect(stored).toBe(true);
    expect(pause.isPaused()).toBe(true);
  });

  /** THE RACE THE SWITCH ACTUALLY HAS.
   *
   *  Two flips of one toggle, the second arriving while the first is still
   *  draining a pass. Without a command tail the resume reads the old value,
   *  early-returns on `next === paused`, answers the caller `paused: false`,
   *  and then the pause it raced finishes and writes the row: Mail off, the
   *  switch saying on, and a restart coming up off. */
  it("serializes a resume issued while the pause is still draining", async () => {
    let stored = false;
    const events: string[] = [];
    const { release, worker } = blockingWorker(events);
    const pause = createMailSyncPause({
      readPaused: () => stored,
      writePaused: (value) => {
        stored = value;
        events.push(`write ${value ? "1" : "0"}`);
      },
      workers: [worker],
    });

    const pausing = pause.setPaused(true);
    const resuming = pause.setPaused(false);
    release();
    await pausing;
    await resuming;

    expect(events).toEqual(["write 1", "stop", "write 0", "start"]);
    expect(pause.isPaused()).toBe(false);
    expect(stored).toBe(false);
  });

  it("comes up paused when the store says so", () => {
    expect(harness(true).pause.isPaused()).toBe(true);
  });
});

/** THE WIRING, WHICH IS WHERE "OFF MEANS NOTHING LEAVES" IS EASIEST TO LOSE.
 *
 *  `main.ts` has no test of its own, so a worker quietly dropped from the
 *  pause's list used to survive the whole gate. The list is built here and
 *  asserted by identity, and the builder's required fields make a dropped
 *  worker a compile error rather than a silent change of behaviour. */
describe("the workers the pause turns off", () => {
  const outboundWorker = { start: async () => {}, stop: async () => {} };
  const smtpWorker = { start: async () => {}, stop: async () => {} };

  it("carries the outbox drainer, the SMTP worker and the scheduler", async () => {
    const backgroundSync = { start: vi.fn(), stop: vi.fn(async () => {}) };
    const workers = mailSyncPauseWorkers({
      outboundWorker,
      smtpWorker,
      backgroundSync,
    });
    expect(workers).toHaveLength(3);
    expect(workers[0]).toBe(outboundWorker);
    expect(workers[1]).toBe(smtpWorker);
    // The scheduler is adapted rather than passed, because its `start()` is
    // synchronous, so it is proved by what it delegates to.
    await workers[2]!.stop();
    expect(backgroundSync.stop).toHaveBeenCalledTimes(1);
    await workers[2]!.start();
    expect(backgroundSync.start).toHaveBeenCalledTimes(1);
  });

  it("drops only the SMTP worker when the runtime has none", () => {
    const backgroundSync = { start: vi.fn(), stop: vi.fn(async () => {}) };
    const workers = mailSyncPauseWorkers({ outboundWorker, backgroundSync });
    expect(workers).toHaveLength(2);
    expect(workers[0]).toBe(outboundWorker);
  });
});
