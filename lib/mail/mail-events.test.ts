import { describe, expect, it } from "vitest";

import { MAIL_EVENT_DEBOUNCE_MS, parseBrainMailEvent } from "./mail-events";

const ACCOUNT = `account-a${"1".repeat(32)}`;

describe("the debounce every reader of the mail event waits", () => {
  it("is 400ms", () => {
    // The Mail column, Home's mail block and the palette's re-ask all read
    // this one number, and each of their tests advances by the constant, so
    // none of them would notice it change. A burst from one sync lands inside
    // it, and a reader waits no longer than that for a new letter.
    expect(MAIL_EVENT_DEBOUNCE_MS).toBe(400);
  });
});

describe("the mail event a tab reads off the stream", () => {
  it("reads each kind the loop sends", () => {
    expect(parseBrainMailEvent({ kind: "mail", changeKind: "reset" })).toEqual({
      kind: "mail",
      changeKind: "reset",
    });
    expect(
      parseBrainMailEvent({
        kind: "mail",
        changeKind: "sync",
        accountId: ACCOUNT,
        mailboxIds: ["inbox", "sent"],
      }),
    ).toEqual({ kind: "mail", changeKind: "sync", accountId: ACCOUNT, mailboxIds: ["inbox", "sent"] });
    expect(
      parseBrainMailEvent({
        kind: "mail",
        changeKind: "content_ready",
        accountId: ACCOUNT,
        mailboxIds: [],
        messageIds: ["m-1"],
      }),
    ).toMatchObject({ changeKind: "content_ready", messageIds: ["m-1"] });
  });

  it("answers null for anything it does not recognise", () => {
    for (const value of [
      null,
      "mail",
      { type: "write", id: "x" },
      { kind: "mail", changeKind: "moved", accountId: ACCOUNT, mailboxIds: [] },
      { kind: "mail", changeKind: "sync", accountId: "someone", mailboxIds: [] },
      { kind: "mail", changeKind: "sync", accountId: ACCOUNT, mailboxIds: ["drafts"] },
      { kind: "mail", changeKind: "content_ready", accountId: ACCOUNT, mailboxIds: [] },
      {
        kind: "mail",
        changeKind: "content_ready",
        accountId: ACCOUNT,
        mailboxIds: [],
        messageIds: ["../x"],
      },
    ]) {
      expect(parseBrainMailEvent(value)).toBeNull();
    }
  });
});
