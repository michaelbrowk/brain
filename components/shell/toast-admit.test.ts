import { describe, expect, it } from "vitest";
import { toastAdmit, type ShellToast } from "./helpers";

const plain: ShellToast = { title: "Saved" };
const undoable: ShellToast = {
  title: "Notifications cleared",
  actionLabel: "Undo",
  onAction: () => {},
  durationMs: 10_000,
  id: "done:1",
};

describe("toastAdmit", () => {
  it("hands the pill straight over when nothing is standing", () => {
    const admitted = toastAdmit(null, [], plain);
    expect(admitted.present).toBe(plain);
    expect(admitted.waiting).toEqual([]);
  });

  it("replaces a message nobody has to act on", () => {
    const admitted = toastAdmit({ title: "Saved" }, [], plain);
    expect(admitted.present).toBe(plain);
  });

  it("never overwrites a standing undo — the second message waits", () => {
    const second: ShellToast = { title: "Newsletters cleared", id: "done:2" };
    const admitted = toastAdmit(undoable, [], second);
    expect(admitted.present).toBeNull();
    expect(admitted.waiting).toEqual([second]);
  });

  it("lets a message of the same id correct the one standing", () => {
    const correction: ShellToast = {
      title: "Notifications partly cleared",
      actionLabel: "Undo",
      onAction: () => {},
      id: "done:1",
    };
    const admitted = toastAdmit(undoable, [], correction);
    expect(admitted.present).toBe(correction);
    expect(admitted.waiting).toEqual([]);
  });

  it("corrects a waiting message in place rather than queueing both", () => {
    const queued: ShellToast = { title: "Newsletters cleared", id: "done:2" };
    const correction: ShellToast = {
      title: "Newsletters partly cleared",
      id: "done:2",
    };
    const admitted = toastAdmit(undoable, [queued], correction);
    expect(admitted.present).toBeNull();
    expect(admitted.waiting).toEqual([correction]);
  });

  it("keeps the queue in arrival order", () => {
    const first: ShellToast = { title: "First", id: "a" };
    const second: ShellToast = { title: "Second", id: "b" };
    const admitted = toastAdmit(undoable, [first], second);
    expect(admitted.waiting).toEqual([first, second]);
  });
});
