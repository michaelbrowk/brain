import { describe, expect, it, vi } from "vitest";

import { createMailSyncPause } from "./sync-pause";

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
    const { pause, workers } = harness(true);
    await pause.setPaused(false);
    for (const worker of workers) expect(worker.start).toHaveBeenCalledTimes(1);
    expect(pause.isPaused()).toBe(false);
  });

  it("does nothing twice", async () => {
    const { pause, workers } = harness();
    await pause.setPaused(true);
    await pause.setPaused(true);
    expect(workers[0].stop).toHaveBeenCalledTimes(1);
  });

  // The flag is written only once the workers are actually down. A record
  // saying paused over a worker still running is the one state a restart
  // cannot repair: it would read the flag, skip `start()`, and the running
  // pass would be the only thing left sending.
  it("writes the flag after the workers are down", async () => {
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
    expect(order).toEqual(["stop", "write"]);
  });

  // A stop that throws leaves the flag alone, so the service comes back up
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

  it("comes up paused when the store says so", () => {
    expect(harness(true).pause.isPaused()).toBe(true);
  });
});
