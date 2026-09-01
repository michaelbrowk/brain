import { describe, expect, it } from "vitest";

import {
  MAIL_THREAD_STATE_CONTRACT_VALUE,
  mailThreadStateContractTier,
  projectMailThreadStateContract,
} from "./thread-contract";

describe("mail thread-state contract", () => {
  it("advertises tier 4", () => {
    expect(MAIL_THREAD_STATE_CONTRACT_VALUE).toBe("4");
  });

  it.each([
    ["4", 4],
    ["3", 3],
    ["2", 2],
    ["1", 1],
    ["5", 1],
    ["", 1],
    [null, 1],
    [undefined, 1],
    [["4"], 1],
  ] as const)("parses header value %j as tier %i", (value, tier) => {
    expect(mailThreadStateContractTier(value)).toBe(tier);
  });

  it("keeps the full payload at tier 4", () => {
    const page = threadPageFixture();
    expect(projectMailThreadStateContract(page, 4)).toEqual(page);
  });

  it("drops exactly category from deep items at tier 3", () => {
    const projected = projectMailThreadStateContract(
      threadPageFixture(),
      3,
    ) as { items: Record<string, unknown>[] };
    expect(projected.items[0]).toEqual(
      omit(threadItemFixture(), ["category"]),
    );
  });

  it("drops category and the view fields at tier 2", () => {
    const projected = projectMailThreadStateContract(
      threadPageFixture(),
      2,
    ) as { items: Record<string, unknown>[] };
    expect(projected.items[0]).toEqual(
      omit(threadItemFixture(), ["category", "listMessage", "sizeBytes"]),
    );
  });

  it("drops category, the view fields, and starred at tier 1", () => {
    const projected = projectMailThreadStateContract(
      threadPageFixture(),
      1,
    ) as { items: Record<string, unknown>[] };
    expect(projected.items[0]).toEqual(
      omit(threadItemFixture(), [
        "category",
        "listMessage",
        "sizeBytes",
        "starred",
      ]),
    );
  });

  it("projects the thread nested in a mutation result", () => {
    const result = { apiVersion: 1, thread: threadItemFixture() };
    expect(projectMailThreadStateContract(result, 3)).toEqual({
      apiVersion: 1,
      thread: omit(threadItemFixture(), ["category"]),
    });
    expect(projectMailThreadStateContract(result, 4)).toEqual(result);
  });

  it("projects the thread nested in a detail without touching messages", () => {
    const message = {
      accountId: "account-a0123456789abcdef0123456789abcdef",
      messageId: "message-1",
      threadId: "thread-1",
      subject: "Hello",
      unread: true,
    };
    const detail = {
      apiVersion: 1,
      thread: threadItemFixture(),
      messages: [message],
    };
    expect(projectMailThreadStateContract(detail, 2)).toEqual({
      apiVersion: 1,
      thread: omit(threadItemFixture(), [
        "category",
        "listMessage",
        "sizeBytes",
      ]),
      messages: [message],
    });
  });

  it("leaves scalars and null untouched", () => {
    expect(projectMailThreadStateContract(null, 1)).toBeNull();
    expect(projectMailThreadStateContract("category", 1)).toBe("category");
    expect(projectMailThreadStateContract(7, 2)).toBe(7);
  });
});

function threadItemFixture(): Record<string, unknown> {
  return {
    accountId: "account-a0123456789abcdef0123456789abcdef",
    threadId: "thread-1",
    subject: "Hello",
    participants: [{ name: "Person", address: "person@example.test" }],
    snippet: "Preview",
    lastMessageAt: 123,
    messageCount: 1,
    unread: true,
    starred: true,
    hasAttachments: false,
    listMessage: true,
    sizeBytes: 4_096,
    category: "newsletter",
  };
}

function threadPageFixture(): Record<string, unknown> {
  return {
    apiVersion: 1,
    items: [threadItemFixture()],
    nextCursor: null,
    sync: { status: "idle", lastSuccessfulAt: 123 },
  };
}

function omit(
  value: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key)),
  );
}
