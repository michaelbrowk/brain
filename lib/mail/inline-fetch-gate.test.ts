import { describe, expect, it, vi } from "vitest";

import { MailFetchGate } from "./inline-fetch-gate";

describe("inline mail fetch gate", () => {
  it("caps concurrent attachment work at two and skips an aborted waiter", async () => {
    const gate = new MailFetchGate(2);
    const releases: Array<() => void> = [];
    let active = 0;
    let maximum = 0;
    const task = vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
    });
    const controllers = Array.from({ length: 4 }, () => new AbortController());
    const runs = controllers.map((controller) =>
      gate.run(controller.signal, task).catch((error) => error.name),
    );
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(2));
    controllers[2]!.abort();
    releases.shift()!();
    await vi.waitFor(() => expect(task).toHaveBeenCalledTimes(3));
    expect(maximum).toBe(2);
    releases.splice(0).forEach((release) => release());
    await Promise.resolve();
    await Promise.resolve();
    releases.splice(0).forEach((release) => release());
    await expect(Promise.all(runs)).resolves.toContain("AbortError");
  });

  it("starts higher-priority work first within the same render turn", async () => {
    const gate = new MailFetchGate(1);
    const order: number[] = [];
    const release: Array<() => void> = [];
    const run = (priority: number) =>
      gate.run(new AbortController().signal, async () => {
        order.push(priority);
        await new Promise<void>((resolve) => release.push(resolve));
      }, priority);
    const tasks = [run(1), run(3), run(2)];
    await vi.waitFor(() => expect(order).toEqual([3]));
    release.shift()!();
    await vi.waitFor(() => expect(order).toEqual([3, 2]));
    release.shift()!();
    await vi.waitFor(() => expect(order).toEqual([3, 2, 1]));
    release.shift()!();
    await Promise.all(tasks);
  });
});
