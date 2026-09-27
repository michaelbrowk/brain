import { describe, expect, it, vi } from "vitest";
import { parkDiscard } from "./mail-deferred-discard";

// A discard that has not happened yet. The sheet is gone and the pill offers
// the way back; the delete waits behind it. What is pinned here is that the
// parcel settles exactly once, whichever way: Undo hands it back and nothing
// is ever deleted, or the flush runs the delete and Undo has nothing to hand
// back. A second call of either is a no-op, so a stale pill, a pagehide and
// an expiry can all reach the same parcel without a second request.

describe("a parked discard", () => {
  it("hands the parcel back once on Undo and never runs the delete after that", () => {
    const flush = vi.fn();
    const parked = parkDiscard({ draftId: "draft-1" }, flush);
    expect(parked.state).toBe("parked");

    expect(parked.restore()).toEqual({ draftId: "draft-1" });
    expect(parked.state).toBe("restored");
    expect(parked.restore()).toBeNull();
    expect(parked.flush()).toBe(false);
    expect(flush).not.toHaveBeenCalled();
  });

  it("runs the delete once on flush and has nothing to hand back after that", () => {
    const flush = vi.fn();
    const parked = parkDiscard({ draftId: "draft-1" }, flush);

    expect(parked.flush()).toBe(true);
    expect(parked.state).toBe("flushed");
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith({ draftId: "draft-1" }, { keepalive: false });
    expect(parked.flush()).toBe(false);
    expect(parked.flush({ keepalive: true })).toBe(false);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(parked.restore()).toBeNull();
  });

  it("forwards keepalive to the delete, for the flush that runs while the page unloads", () => {
    const flush = vi.fn();
    const parked = parkDiscard({ draftId: "draft-1" }, flush);
    expect(parked.flush({ keepalive: true })).toBe(true);
    expect(flush).toHaveBeenCalledWith({ draftId: "draft-1" }, { keepalive: true });
  });
});
