import { describe, expect, it } from "vitest";
import {
  applyShownDecisions,
  domainScopeAllowed,
  senderDomain,
  senderName,
  splitNewSenders,
  waitingAtDomain,
  waitsOn,
  type ShownSenderDecision,
} from "./mail-new-senders";
import type { MailThreadListItem } from "@/lib/mail/message-types";

const ACCOUNT = "account-a0123456789abcdef0123456789abcdef";

function thread(
  threadId: string,
  from: { name: string | null; address: string } | null,
  overrides: Partial<MailThreadListItem> = {},
): MailThreadListItem {
  return {
    accountId: ACCOUNT,
    threadId,
    subject: threadId,
    // The first participant is deliberately someone else: a decision never
    // reads it.
    participants: [{ name: "Someone Else", address: "else@elsewhere.example" }],
    snippet: null,
    lastMessageAt: 1,
    messageCount: 1,
    unread: true,
    starred: false,
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 0,
    category: "people",
    newSender: from !== null,
    ...(from !== null ? { newSenderFrom: from } : {}),
    ...overrides,
  };
}

const lena = { name: "Lena Okafor", address: "lena@okafor.example" };
const mia = { name: "Mia Aalto", address: "mia@aalto.example" };
const studio = { name: null, address: "studio@aalto.example" };

function decision(
  scope: ShownSenderDecision["scope"],
  key: string,
  verdict: ShownSenderDecision["verdict"],
  archived: readonly string[] = [],
): ShownSenderDecision {
  return { scope, key, verdict, archived: new Set(archived) };
}

describe("new senders", () => {
  it("reads who a thread waits on from its first sender and nothing else", () => {
    expect(waitsOn(thread("a", lena))).toEqual(lena);
    expect(waitsOn(thread("b", null))).toBeNull();
    // A thread that says it waits but names nobody cannot be decided on.
    expect(waitsOn(thread("c", null, { newSender: true }))).toBeNull();
  });

  it("names a sender by its display name, else its address", () => {
    expect(senderName(lena)).toBe("Lena Okafor");
    expect(senderName(studio)).toBe("studio@aalto.example");
    expect(senderName({ name: "  ", address: "x@y.example" })).toBe("x@y.example");
    expect(senderDomain("Lena@Okafor.Example")).toBe("okafor.example");
  });

  it("splits a list into the waiting group and the rest, order kept", () => {
    const items = [thread("1", null), thread("2", lena), thread("3", null), thread("4", mia)];
    const { waiting, rest } = splitNewSenders(items);
    expect(waiting.map((item) => item.threadId)).toEqual(["2", "4"]);
    expect(rest.map((item) => item.threadId)).toEqual(["1", "3"]);
  });

  it("counts distinct waiting senders at a domain", () => {
    const items = [thread("1", mia), thread("2", studio), thread("3", mia), thread("4", lena)];
    expect(waitingAtDomain(items, "aalto.example")).toBe(2);
    expect(waitingAtDomain(items, "okafor.example")).toBe(1);
  });

  it("shows an accept as a thread that no longer waits, and a block as one that left", () => {
    const items = [thread("lena", lena), thread("mia", mia), thread("studio", studio), thread("old", null)];

    const accepted = applyShownDecisions(items, [decision("address", "lena@okafor.example", "accept")]);
    expect(accepted.map((item) => [item.threadId, item.newSender])).toEqual([
      ["lena", false],
      ["mia", true],
      ["studio", true],
      ["old", false],
    ]);
    expect(accepted[0]).not.toHaveProperty("newSenderFrom");

    const blocked = applyShownDecisions(items, [decision("domain", "aalto.example", "block")]);
    expect(blocked.map((item) => item.threadId)).toEqual(["lena", "old"]);
  });

  it("drops a thread the service says a block archived even when it did not wait", () => {
    const items = [thread("lena", lena), thread("old", null)];
    const shown = applyShownDecisions(items, [
      decision("address", "lena@okafor.example", "block", [`${ACCOUNT}\u0000old`]),
    ]);
    expect(shown).toEqual([]);
  });

  it("keeps an archived thread in every list the archive does not empty", () => {
    const items = [thread("old", null), thread("other", null)];
    const blocked = [decision("address", "lena@okafor.example", "block", [`${ACCOUNT}\u0000old`])];
    expect(applyShownDecisions(items, blocked, { inbox: false })).toBe(items);
    expect(
      applyShownDecisions(items, blocked, { inbox: true }).map((item) => item.threadId),
    ).toEqual(["other"]);
  });

  it("settles a blocked sender's letters in a list the archive does not empty", () => {
    const items = [thread("lena", lena), thread("mia", mia)];
    const shown = applyShownDecisions(
      items,
      [decision("address", "lena@okafor.example", "block")],
      { inbox: false },
    );
    expect(shown.map((item) => [item.threadId, item.newSender])).toEqual([
      ["lena", false],
      ["mia", true],
    ]);
    expect(shown[0]).not.toHaveProperty("newSenderFrom");
  });

  it("drops a thread the service marks blocked from an Inbox, with or without a decision", () => {
    const items = [thread("held", null, { senderBlocked: true }), thread("other", null)];
    expect(applyShownDecisions(items, []).map((item) => item.threadId)).toEqual(["other"]);
    expect(
      applyShownDecisions(items, [decision("address", "lena@okafor.example", "accept")]).map(
        (item) => item.threadId,
      ),
    ).toEqual(["other"]);
    expect(applyShownDecisions(items, [], { inbox: false })).toBe(items);
  });

  it("offers a domain only where the service takes one, and never before it has said", () => {
    const screen = { domainScopeRefused: ["gmail.example", "own.example"] };
    expect(domainScopeAllowed(screen, "okafor.example")).toBe(true);
    expect(domainScopeAllowed(screen, "gmail.example")).toBe(false);
    expect(domainScopeAllowed(screen, "own.example")).toBe(false);
    expect(domainScopeAllowed(screen, "")).toBe(false);
    expect(domainScopeAllowed(null, "okafor.example")).toBe(false);
  });

  it("lets an address decision outrank its domain's, as the service does", () => {
    const items = [thread("mia", mia), thread("studio", studio)];
    const shown = applyShownDecisions(items, [
      decision("address", "mia@aalto.example", "accept"),
      decision("domain", "aalto.example", "block"),
    ]);
    expect(shown.map((item) => [item.threadId, item.newSender])).toEqual([["mia", false]]);
  });

  it("hands back the same list when nothing it holds is covered", () => {
    const items = [thread("lena", lena)];
    expect(applyShownDecisions(items, [])).toBe(items);
    expect(applyShownDecisions(items, [decision("domain", "aalto.example", "block")])).toBe(items);
  });
});
