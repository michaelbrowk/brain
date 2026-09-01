import { describe, expect, it } from "vitest";
import { StoreEventJournal } from "./events";

describe("StoreEventJournal", () => {
  it("replays mutations after a reconnect cursor in order", () => {
    const journal = new StoreEventJournal(4);
    const first = journal.append({ type: "write", id: "a", rev: "r1" });
    journal.append({ type: "move", id: "b" });
    journal.append({ type: "delete", id: "c" });

    const replay = journal.after(first.sequence);

    expect(replay.reconcile).toBe(false);
    expect(replay.events.map((event) => [event.sequence, event.type, event.id])).toEqual([
      [2, "move", "b"],
      [3, "delete", "c"],
    ]);
    expect(replay.latestSequence).toBe(3);
  });

  it("requires a full reconcile when the cursor fell out of the replay window", () => {
    const journal = new StoreEventJournal(2);
    journal.append({ type: "write", id: "a" });
    journal.append({ type: "write", id: "b" });
    journal.append({ type: "write", id: "c" });

    expect(journal.after(0)).toMatchObject({
      events: [],
      reconcile: true,
      latestSequence: 3,
    });
  });

  it("requires a reconcile when a server restart resets the sequence", () => {
    const journal = new StoreEventJournal();
    expect(journal.after(42).reconcile).toBe(true);
  });
});
