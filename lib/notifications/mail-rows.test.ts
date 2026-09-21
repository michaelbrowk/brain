import { describe, expect, it } from "vitest";
import {
  foldLegacyMailRows,
  mailRow,
  mailRowId,
  mailRowTitle,
  openMailRow,
} from "./mail-rows";
import { notificationSchema, type BrainNotification } from "./model";

const AT = "2026-09-14T12:00:00.000Z";
const LEGACY = "mail-new:account-adeadbeefdeadbeefdeadbeefdeadbeef:7468726561642d6f6e65";
const LEGACY_TWO = "mail-new:account-adeadbeefdeadbeefdeadbeefdeadbeef:7468726561642d74776f";

function legacy(id: string, extra: Partial<BrainNotification> = {}): BrainNotification {
  return {
    id,
    kind: "mail-new",
    at: AT,
    title: "Ana Silva",
    body: "Lunch on Friday",
    href: "/mail",
    ...extra,
  };
}

describe("the mail row", () => {
  it("counts letters in its title and says nothing else", () => {
    const row = mailRow(AT, 10, AT);
    expect(row).toEqual({
      id: "mail-new:2026-09-14T12:00:00.000Z",
      kind: "mail-new",
      at: AT,
      title: "10 new messages",
      href: "/mail",
    });
    expect(notificationSchema.safeParse(row).success).toBe(true);
  });

  it("says one message in the singular", () => {
    expect(mailRowTitle(1)).toBe("1 new message");
    expect(mailRowTitle(2)).toBe("2 new messages");
  });

  it("carries the instant it opened in its id, and moves its `at` without it", () => {
    const row = mailRow(AT, 5, "2026-09-14T12:30:00.000Z");
    expect(row.id).toBe(mailRowId(AT));
    expect(row.at).toBe("2026-09-14T12:30:00.000Z");
  });
});

describe("the open mail row", () => {
  it("is the unread one the centre holds, with its count read back", () => {
    const rows = [mailRow(AT, 3, AT), legacy(LEGACY)];
    expect(openMailRow(rows)).toEqual({ id: mailRowId(AT), at: AT, count: 3 });
  });

  it("is nothing once the row has been read", () => {
    expect(openMailRow([{ ...mailRow(AT, 3, AT), readAt: AT }])).toBeNull();
  });

  it("is nothing when the centre holds no mail row", () => {
    expect(openMailRow([])).toBeNull();
    expect(
      openMailRow([
        { id: "task-reminder:t:2026-09-14T13:00", kind: "task-reminder", at: AT, title: "Water the plants", href: "/tasks" },
      ]),
    ).toBeNull();
  });

  it("is the newest of two, which is a file written by an older build", () => {
    const older = mailRow("2026-09-14T09:00:00.000Z", 1, "2026-09-14T09:00:00.000Z");
    const newer = mailRow(AT, 4, AT);
    expect(openMailRow([older, newer])?.id).toBe(newer.id);
  });
});

/** ROWS OF THE OLD SHAPE, ON THE FIRST READ AFTER THE UPGRADE.
 *
 *  One row per thread is what the centre held until this release, and a
 *  person upgrading with thirty of them would otherwise keep a second inbox
 *  in their bell until each one was pressed. */
describe("folding the rows an older build wrote", () => {
  it("folds them into one row of the new shape, counted and dated by the newest", () => {
    const rows = [
      legacy(LEGACY, { at: "2026-09-14T11:00:00.000Z" }),
      legacy(LEGACY_TWO, { at: AT }),
    ];
    expect(foldLegacyMailRows(rows)).toEqual([mailRow(AT, 2, AT)]);
  });

  it("drops them when every one of them was read", () => {
    const rows = [
      legacy(LEGACY, { readAt: AT }),
      legacy(LEGACY_TWO, { at: "2026-09-14T11:00:00.000Z", readAt: AT }),
    ];
    expect(foldLegacyMailRows(rows)).toEqual([]);
  });

  it("keeps the fold unread when any one of them was", () => {
    const rows = [legacy(LEGACY, { readAt: AT }), legacy(LEGACY_TWO, { at: AT })];
    const folded = foldLegacyMailRows(rows);
    expect(folded).toHaveLength(1);
    expect(folded[0].readAt).toBeUndefined();
    expect(folded[0].title).toBe("2 new messages");
  });

  it("leaves every other kind where it stands", () => {
    const reminder: BrainNotification = {
      id: "task-reminder:task-alpha:2026-09-14T13:00",
      kind: "task-reminder",
      at: AT,
      title: "Water the plants",
      href: "/tasks",
    };
    expect(foldLegacyMailRows([reminder])).toEqual([reminder]);
  });

  it("leaves a file that already holds the new shape untouched", () => {
    const rows = [mailRow(AT, 3, AT)];
    expect(foldLegacyMailRows(rows)).toBe(rows);
  });

  it("folds the old rows into the row already open rather than beside it", () => {
    // Both shapes at once is the upgrade landing mid-poll: the scan wrote a
    // new row and the file still held the old ones. Two mail rows in one bell
    // is the second inbox again, in miniature.
    const open = mailRow(AT, 1, AT);
    const folded = foldLegacyMailRows([open, legacy(LEGACY, { at: "2026-09-14T11:00:00.000Z" })]);
    expect(folded).toEqual([mailRow(AT, 2, AT)]);
  });
});
