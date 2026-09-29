// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailMessageDto } from "@/lib/mail/message-types";
import {
  directActionForMailbox,
  letterInInbox,
  MailReader,
  type MailReaderState,
} from "./mail-reader";
import type {
  MailAccountCapabilities,
  MailSurfaceClient,
  MailSystemMailbox,
  MailThreadDetail,
} from "./mail-surface-client";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const ACCOUNT_ID = "account-a0123456789abcdef0123456789abcdef";

const capabilities: MailAccountCapabilities = {
  mailboxes: ["inbox", "starred", "sent", "all", "spam", "trash"],
  listThreads: true,
  sync: true,
  headerPreview: true,
  messageBodies: false,
  threadMutations: true,
  compose: false,
  send: false,
  reply: false,
};

function detailFor(inInbox: boolean): MailThreadDetail {
  const message: MailMessageDto = {
    accountId: ACCOUNT_ID,
    messageId: "message-1",
    threadId: "thread-1",
    from: { name: "Ben Johnson", address: "ben@example.test" },
    replyTo: [],
    to: [{ name: "Reader", address: "reader@example.test" }],
    cc: [],
    subject: "Lunch this Friday?",
    sentAt: 1_700_000_000_000,
    unread: false,
    inInbox,
    snippet: "12PM sounds great to me.",
    textBody: null,
    htmlBody: null,
    hasAttachments: false,
  };
  return {
    apiVersion: 1,
    thread: {
      accountId: ACCOUNT_ID,
      threadId: "thread-1",
      subject: message.subject,
      participants: [message.from!],
      snippet: message.snippet,
      lastMessageAt: message.sentAt,
      messageCount: 1,
      unread: false,
      starred: false,
      hasAttachments: false,
      listMessage: false,
      sizeBytes: 0,
      category: "people",
    },
    messages: [message],
  };
}

/** One conversation, a message per flag, each in the Inbox or not. */
function conversation(...inInbox: readonly boolean[]): MailThreadDetail {
  const single = detailFor(false);
  return {
    ...single,
    thread: { ...single.thread, messageCount: inInbox.length },
    messages: inInbox.map((flag, index) => ({
      ...single.messages[0]!,
      messageId: `message-${index + 1}`,
      inInbox: flag,
    })),
  };
}

const client: Pick<MailSurfaceClient, "getMessageContent" | "requestMessageContent"> = {
  getMessageContent: vi.fn(),
  requestMessageContent: vi.fn(),
};

describe("directActionForMailbox", () => {
  it.each([
    ["inbox", true, "Archive"],
    ["inbox", false, "Archive"],
    ["spam", false, "Not spam"],
    ["trash", false, "Restore"],
    ["all", false, "Move to Inbox"],
    ["starred", false, "Move to Inbox"],
    ["all", true, null],
    ["starred", true, null],
    // Sent lists letters that were never in the Inbox. Its way back is the
    // ⋯ menu, not the one action the strip draws.
    ["sent", false, null],
  ] as const)("%s, in Inbox %s: %s", (mailboxId, inInbox, label) => {
    expect(directActionForMailbox(mailboxId, inInbox)?.label ?? null).toBe(label);
  });

  it("moves a letter back with its own action", () => {
    expect(directActionForMailbox("all", false)?.action).toBe("move-to-inbox");
  });
});

describe("letterInInbox", () => {
  it("counts a conversation as in the Inbox while any message is", () => {
    // Both providers answer for the thread as a whole, so a reply that came
    // back to the Inbox brings the whole conversation with it.
    expect(letterInInbox(conversation(false, true))).toBe(true);
    expect(letterInInbox(conversation(false, false))).toBe(false);
  });
});

describe("MailReader's way back to the Inbox", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onAction = vi.fn();

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("PointerEvent", MouseEvent);
    onAction.mockReset();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(mailboxId: MailSystemMailbox, inInbox: boolean) {
    await renderState(mailboxId, { kind: "ready", detail: detailFor(inInbox) });
  }

  async function renderState(mailboxId: MailSystemMailbox, state: MailReaderState) {
    await act(async () =>
      root.render(
        <MailReader
          state={state}
          mutating={false}
          onBack={() => {}}
          onRetry={() => {}}
          onReply={() => {}}
          onReplyAll={() => {}}
          onForward={() => {}}
          mailboxId={mailboxId}
          capabilities={capabilities}
          onAction={onAction}
          contentClient={client}
        />,
      ),
    );
  }

  function toolbarButtons(): string[] {
    return [...host.querySelectorAll("header button")].map(
      (button) => button.textContent?.trim() ?? "",
    );
  }

  async function menuItems(): Promise<string[]> {
    const trigger = host.querySelector('button[aria-label="More mail actions"]');
    if (!(trigger instanceof HTMLElement)) throw new Error("No ⋯ menu");
    await act(async () => {
      trigger.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
      );
    });
    return [...document.body.querySelectorAll('[role="menuitem"]')].map(
      (item) => item.textContent?.trim() ?? "",
    );
  }

  it("draws Move to Inbox for an archived letter in All Mail, and sends it", async () => {
    await render("all", false);
    expect(toolbarButtons()).toContain("Move to Inbox");

    const button = [...host.querySelectorAll("header button")].find(
      (candidate) => candidate.textContent?.trim() === "Move to Inbox",
    ) as HTMLButtonElement;
    await act(async () => button.click());
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "thread-1" }),
      "move-to-inbox",
    );
  });

  it("offers Move to Inbox in the ⋯ menu from Sent", async () => {
    await render("sent", false);
    expect(toolbarButtons()).not.toContain("Move to Inbox");
    expect(await menuItems()).toContain("Move to Inbox");
  });

  it("offers no Move to Inbox for a letter already in the Inbox", async () => {
    await render("all", true);
    expect(toolbarButtons()).not.toContain("Move to Inbox");
    expect(await menuItems()).not.toContain("Move to Inbox");
  });

  it("offers no Move to Inbox for a conversation with one message in the Inbox", async () => {
    await renderState("all", { kind: "ready", detail: conversation(false, true) });
    expect(toolbarButtons()).not.toContain("Move to Inbox");
    expect(await menuItems()).not.toContain("Move to Inbox");
  });

  it("draws no Move to Inbox while the letter is still loading", async () => {
    // Whether it is in the Inbox is unknown until it arrives. Drawing the
    // action disabled meanwhile would flash it on every letter All Mail opens
    // that turns out to be in the Inbox.
    await renderState("all", { kind: "loading", thread: detailFor(false).thread });
    expect(toolbarButtons()).not.toContain("Move to Inbox");
  });

  it.each(["spam", "trash"] as const)(
    "leaves %s its own way back and no second one",
    async (mailboxId) => {
      await render(mailboxId, false);
      expect(toolbarButtons()).not.toContain("Move to Inbox");
      expect(await menuItems()).not.toContain("Move to Inbox");
    },
  );
});
