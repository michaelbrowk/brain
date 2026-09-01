// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailMessageDto } from "@/lib/mail/message-types";
import { MailReader } from "./mail-reader";
import type {
  MailAccountCapabilities,
  MailSurfaceClient,
  MailThreadDetail,
} from "./mail-surface-client";

// Playback is not under test. The mock surfaces the presence mode and each
// motion node's `animate` target so the thread-switch contract can be pinned
// structurally: the body presence must never run in `wait` mode (an
// interrupted enter froze mid-fade there), and after any burst of switches the
// one rendered body targets opacity 1.
vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({
    reducedMotion: false,
    onRender: ({ motion }) => ({
      "data-motion-animate": JSON.stringify(motion.animate),
    }),
    AnimatePresence: ({ children, mode }) =>
      createElement("div", { "data-presence-mode": mode ?? "sync" }, children),
  });
});

const ACCOUNT_ID = "account-a0123456789abcdef0123456789abcdef";

const capabilities: MailAccountCapabilities = {
  mailboxes: ["inbox"],
  listThreads: true,
  sync: true,
  headerPreview: true,
  messageBodies: false,
  threadMutations: false,
  compose: false,
  send: false,
  reply: false,
};

function detailFor(threadId: string): MailThreadDetail {
  const message: MailMessageDto = {
    accountId: ACCOUNT_ID,
    messageId: `${threadId}-message`,
    threadId,
    from: { name: `Sender ${threadId}`, address: "sender@example.test" },
    replyTo: [],
    to: [{ name: "Reader", address: "reader@example.test" }],
    cc: [],
    subject: `Subject ${threadId}`,
    sentAt: 1_700_000_000_000,
    unread: false,
    inInbox: true,
    snippet: `Snippet ${threadId}`,
    textBody: null,
    htmlBody: null,
    hasAttachments: false,
  };
  return {
    apiVersion: 1,
    thread: {
      accountId: ACCOUNT_ID,
      threadId,
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

const client: Pick<MailSurfaceClient, "getMessageContent" | "requestMessageContent"> = {
  getMessageContent: vi.fn(),
  requestMessageContent: vi.fn(),
};

function reader(threadId: string) {
  return (
    <MailReader
      state={{ kind: "ready", detail: detailFor(threadId) }}
      mutating={false}
      onBack={() => {}}
      onRetry={() => {}}
      onReply={() => {}}
      onReplyAll={() => {}}
      onForward={() => {}}
      mailboxId="inbox"
      capabilities={capabilities}
      onAction={() => {}}
      contentClient={client}
    />
  );
}

describe("MailReader thread switch", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("never waits on the leaving thread and lands every switch at opacity 1", async () => {
    await act(async () => root.render(reader("thread-a")));
    const presence = host.querySelector("[data-mail-reader-scroll] [data-presence-mode]");
    expect(presence).not.toBeNull();
    expect(presence?.getAttribute("data-presence-mode")).not.toBe("wait");

    // A burst of switches: each one must leave exactly one body behind,
    // keyed to the newest thread and targeting full opacity.
    await act(async () => root.render(reader("thread-b")));
    await act(async () => root.render(reader("thread-c")));

    const bodies = presence?.querySelectorAll(":scope > [data-motion-animate]") ?? [];
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.textContent).toContain("Sender thread-c");
    expect(bodies[0]?.textContent).not.toContain("Sender thread-b");
    expect(JSON.parse(bodies[0]?.getAttribute("data-motion-animate") ?? "{}")).toMatchObject({
      opacity: 1,
    });
  });
});
