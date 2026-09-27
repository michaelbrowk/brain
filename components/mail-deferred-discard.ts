// A DISCARD THAT HAS NOT HAPPENED YET.
//
// Pressing the trash on the compose sheet takes the sheet down at once and
// puts a pill up with Undo; the provider delete waits behind that pill. This
// is the parcel it waits in: the draft's sync record and the composer state
// that would bring the sheet back, held apart from `draftSyncRef` so nothing
// on the surface mistakes a parked draft for an open one.
//
// It settles exactly once, one of two ways. Undo hands the parcel back and
// the delete never runs. A flush runs the delete and Undo has nothing left to
// hand back. The window running out, the page unloading, the writer opening
// another composer and a stale pill can all reach the same parcel, so every
// call after the first is a no-op rather than a second request.

export type DeferredDiscardState = "parked" | "restored" | "flushed";

export type DeferredDiscard<T> = {
  readonly parcel: T;
  readonly state: DeferredDiscardState;
  /** Undo. The parcel, once; `null` when the discard has already settled. */
  restore(): T | null;
  /** Runs the delete, once. `keepalive` is for the flush that runs while the
   *  page unloads, where an ordinary request would be cancelled with the
   *  document. Returns whether this call was the one that ran it. */
  flush(options?: { readonly keepalive?: boolean }): boolean;
};

export function parkDiscard<T>(
  parcel: T,
  onFlush: (parcel: T, options: { readonly keepalive: boolean }) => void,
): DeferredDiscard<T> {
  let state: DeferredDiscardState = "parked";
  return {
    parcel,
    get state() {
      return state;
    },
    restore() {
      if (state !== "parked") return null;
      state = "restored";
      return parcel;
    },
    flush(options) {
      if (state !== "parked") return false;
      state = "flushed";
      onFlush(parcel, { keepalive: options?.keepalive === true });
      return true;
    },
  };
}
