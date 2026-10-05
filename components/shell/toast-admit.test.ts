import { describe, expect, it } from "vitest";
import {
  TOAST_UNDO_LIMIT,
  toastAdmit,
  toastRelease,
  type ShellToast,
} from "./helpers";

const plain: ShellToast = { title: "Saved" };
const undoable: ShellToast = {
  title: "Notifications cleared",
  actionLabel: "Undo",
  onAction: () => {},
  durationMs: 10_000,
  id: "done:1",
};

function undo(title: string, id: string): ShellToast {
  return { title, actionLabel: "Undo", onAction: () => {}, durationMs: 9_000, id };
}

describe("toastAdmit", () => {
  it("hands the pill straight over when nothing is standing", () => {
    const admitted = toastAdmit([], [], plain);
    expect(admitted.present).toEqual([plain]);
    expect(admitted.waiting).toEqual([]);
    expect(admitted.left).toEqual([]);
    expect(admitted.replaced).toBeNull();
  });

  it("replaces a message nobody has to act on, in its place", () => {
    const standing: ShellToast = { title: "Saved" };
    const admitted = toastAdmit([standing], [], plain);
    expect(admitted.present).toEqual([plain]);
    expect(admitted.left).toEqual([standing]);
    expect(admitted.replaced).toBe(standing);
  });

  it("puts a second undo on top of a standing one, and keeps both live", () => {
    const blocked = undo("Blocked Lena Okafor", "mail-sender:1");
    const done = undo("Newsletters cleared", "mail-section-done");
    const admitted = toastAdmit([blocked], [], done);
    expect(admitted.present).toEqual([blocked, done]);
    expect(admitted.left).toEqual([]);
    expect(admitted.replaced).toBeNull();
    expect(admitted.waiting).toEqual([]);
  });

  it("lets a report of the same id correct its own pill in place, whatever stands beside it", () => {
    const blocked = undo("Blocked Lena Okafor", "mail-sender:1");
    const correction: ShellToast = { title: "Notifications partly cleared", id: "done:1" };
    const admitted = toastAdmit([undoable, blocked], [], correction);
    expect(admitted.present).toEqual([correction, blocked]);
    expect(admitted.left).toEqual([undoable]);
    expect(admitted.replaced).toBe(undoable);
  });

  it("takes a pill of the same id down and stands a new undo on top, in a place of its own", () => {
    // A second Done is a second gesture: it is what ⌘Z should reach and what
    // the reader is looking for at the head of the column, and its window is
    // a fresh one, so it does not inherit the first pill's place or ring.
    const blocked = undo("Blocked Lena Okafor", "mail-sender:1");
    const second: ShellToast = {
      title: "Newsletters cleared",
      actionLabel: "Undo",
      onAction: () => {},
      id: "done:1",
    };
    const admitted = toastAdmit([undoable, blocked], [], second);
    expect(admitted.present).toEqual([blocked, second]);
    expect(admitted.left).toEqual([undoable]);
    expect(admitted.replaced).toBeNull();
  });

  it("takes the only pill of the same id down without handing its place on", () => {
    const second: ShellToast = { ...undoable, title: "Newsletters cleared" };
    const admitted = toastAdmit([undoable], [], second);
    expect(admitted.present).toEqual([second]);
    expect(admitted.left).toEqual([undoable]);
    expect(admitted.replaced).toBeNull();
  });

  it(`stands at most ${TOAST_UNDO_LIMIT} undos, and a fourth commits the oldest`, () => {
    const first = undo("First", "a");
    const second = undo("Second", "b");
    const third = undo("Third", "c");
    const fourth = undo("Fourth", "d");
    const admitted = toastAdmit([first, second, third], [], fourth);
    expect(admitted.present).toEqual([second, third, fourth]);
    // Left unspent: the shell owes it `onExpire`, the same thing its window
    // closing would have done.
    expect(admitted.left).toEqual([first]);
  });

  it("never commits a pill whose own action is still settling: the oldest settled one goes", () => {
    // An undo already under way is spent as far as the column is concerned;
    // committing it would run `onExpire` after `onAction`.
    const first = undo("First", "a");
    const second = undo("Second", "b");
    const third = undo("Third", "c");
    const fourth = undo("Fourth", "d");
    const admitted = toastAdmit([first, second, third], [], fourth, (toast) => toast === first);
    expect(admitted.present).toEqual([first, third, fourth]);
    expect(admitted.left).toEqual([second]);
  });

  it("makes a fourth undo wait while all three standing are settling", () => {
    const standing = [undo("First", "a"), undo("Second", "b"), undo("Third", "c")];
    const fourth = undo("Fourth", "d");
    const admitted = toastAdmit(standing, [], fourth, () => true);
    expect(admitted.present).toEqual(standing);
    expect(admitted.waiting).toEqual([fourth]);
    expect(admitted.left).toEqual([]);
  });

  it("still makes a report wait behind a standing undo", () => {
    const second: ShellToast = { title: "Newsletters cleared", id: "done:2" };
    const admitted = toastAdmit([undoable], [], second);
    expect(admitted.present).toEqual([undoable]);
    expect(admitted.waiting).toEqual([second]);
    expect(admitted.left).toEqual([]);
  });

  it("corrects a waiting message in place rather than queueing both", () => {
    const queued: ShellToast = { title: "Newsletters cleared", id: "done:2" };
    const correction: ShellToast = {
      title: "Newsletters partly cleared",
      id: "done:2",
    };
    const admitted = toastAdmit([undoable], [queued], correction);
    expect(admitted.present).toEqual([undoable]);
    expect(admitted.waiting).toEqual([correction]);
  });

  it("drops a waiting report of the id an arriving undo wears", () => {
    // The report spoke for a sentence the undo has now said again: played
    // after it, the report would be the older sentence arriving last.
    const stale: ShellToast = { title: "Newsletters archived", id: "done:2" };
    const other: ShellToast = { title: "Saved" };
    const next = undo("People cleared", "done:2");
    const admitted = toastAdmit([undoable], [stale, other], next);
    expect(admitted.present).toEqual([undoable, next]);
    expect(admitted.waiting).toEqual([other]);
  });

  it("keeps the queue in arrival order", () => {
    const first: ShellToast = { title: "First", id: "a" };
    const second: ShellToast = { title: "Second", id: "b" };
    const admitted = toastAdmit([undoable], [first], second);
    expect(admitted.waiting).toEqual([first, second]);
  });
});

describe("toastRelease", () => {
  it("keeps the queue waiting while another undo still stands", () => {
    const blocked = undo("Blocked Lena Okafor", "mail-sender:1");
    const report: ShellToast = { title: "People partly cleared" };
    const released = toastRelease([undoable, blocked], [report], undoable);
    expect(released.present).toEqual([blocked]);
    expect(released.waiting).toEqual([report]);
  });

  it("gives the column to the first waiting report once the last undo leaves", () => {
    const first: ShellToast = { title: "First" };
    const second: ShellToast = { title: "Second" };
    const released = toastRelease([undoable], [first, second], undoable);
    expect(released.present).toEqual([first]);
    expect(released.waiting).toEqual([second]);
  });

  it("lets a waiting undo in as soon as a place is free, before any waiting report", () => {
    const first = undo("First", "a");
    const second = undo("Second", "b");
    const third = undo("Third", "c");
    const report: ShellToast = { title: "Saved" };
    const fourth = undo("Fourth", "d");
    const released = toastRelease([first, second, third], [report, fourth], first);
    expect(released.present).toEqual([second, third, fourth]);
    expect(released.waiting).toEqual([report]);
  });

  it("leaves an empty column empty", () => {
    const released = toastRelease([undoable], [], undoable);
    expect(released.present).toEqual([]);
    expect(released.left).toEqual([]);
  });
});
