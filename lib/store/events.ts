import { EventEmitter } from "node:events";

export interface StoreEvent {
  /** `task` carries a task record's id, not a page id. Nothing in the page
   *  tree changes on one, so a client that refreshes its tree on every event
   *  has to skip it or it refetches the tree on every tick.
   *
   *  `notification` carries a notification's id and comes from the reminder
   *  scan and the mail poll rather than from a write to the notes. It reaches
   *  the same emitter for the same reason the task event does: there is one
   *  live stream to an open tab (app/api/events/route.ts) and a second one
   *  would be a second reconnect, a second replay cursor and a second
   *  heartbeat for one bell. A client has to skip it the way it skips `task`,
   *  or the bell refetches the page tree. */
  type: "write" | "create" | "move" | "delete" | "meta" | "task" | "notification";
  id: string;
  /** rev of the content after a write — lets clients skip a GET when they
   *  already hold this rev */
  rev?: string;
  /** originating client's id (x-brain-client header). A client ignores its own
   *  echo instead of round-tripping a reload + rev-conflict toast at itself. */
  src?: string;
}

export interface SequencedStoreEvent extends StoreEvent {
  sequence: number;
}

export interface StoreEventReplay {
  events: SequencedStoreEvent[];
  reconcile: boolean;
  latestSequence: number;
}

/** Bounded in-memory replay for short SSE disconnects. A cursor outside the
 * retained window requires a full client reconcile instead of pretending no
 * mutations happened. */
export class StoreEventJournal {
  private sequence = 0;
  private readonly events: SequencedStoreEvent[] = [];

  constructor(private readonly capacity = 256) {}

  append(event: StoreEvent): SequencedStoreEvent {
    const sequenced = { ...event, sequence: ++this.sequence };
    this.events.push(sequenced);
    if (this.events.length > this.capacity) this.events.shift();
    return sequenced;
  }

  latestSequence(): number {
    return this.sequence;
  }

  after(cursor: number): StoreEventReplay {
    const latestSequence = this.latestSequence();
    const earliestSequence = this.events[0]?.sequence ?? latestSequence + 1;
    const reconcile =
      !Number.isSafeInteger(cursor) ||
      cursor < 0 ||
      cursor > latestSequence ||
      cursor < earliestSequence - 1;

    return {
      events: reconcile ? [] : this.events.filter((event) => event.sequence > cursor),
      reconcile,
      latestSequence,
    };
  }
}

// One emitter shared across Next's separate module layers (route handlers vs
// RSC), same globalThis trick as the store singleton — otherwise an MCP write in
// one layer wouldn't reach the SSE stream in another.
const g = globalThis as unknown as {
  __brainEvents?: EventEmitter;
  __brainEventJournal?: StoreEventJournal;
};
export const brainEvents = g.__brainEvents ?? (g.__brainEvents = new EventEmitter());
const brainEventJournal =
  g.__brainEventJournal ?? (g.__brainEventJournal = new StoreEventJournal());
brainEvents.setMaxListeners(50);

export function latestStoreEventSequence(): number {
  return brainEventJournal.latestSequence();
}

export function replayStoreEvents(cursor: number): StoreEventReplay {
  return brainEventJournal.after(cursor);
}

export function emitStore(ev: StoreEvent): void {
  brainEvents.emit("change", brainEventJournal.append(ev));
}
