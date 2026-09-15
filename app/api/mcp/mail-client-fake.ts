import {
  BrainMailClientError,
  type BrainMailClient,
  type MailTlsMode,
  type PublicMailAccountV2,
  type PublicMailAccountV3,
} from "@/lib/mail/brain-mail-client";
import type {
  MailMessageDto,
  MailThreadListItem,
} from "@/lib/mail/message-types";

/** THE RECORDING STAND-IN EVERY MAIL TOOL'S TESTS INSTALL.
 *
 *  A tool must never reach the real socket from a unit test, and the thing a
 *  test wants to assert is usually the call, not the answer: which account,
 *  which mailbox, which cursor. So the fake records every call in order and
 *  answers a benign default, and a test overrides only the one method it is
 *  about. An override is wrapped too, so `calls` stays the whole story.
 *
 *  A method with no benign default throws `mail_service_unavailable` rather
 *  than answering an empty shape. A tool that reaches for a method its test
 *  did not expect then fails loudly instead of quietly reading nothing.
 */

/** Low entropy on purpose. `SAFE_ACCOUNT_ID` in the client wants
 *  `account-a` + 32 hex, and a random 32-hex string in a fixture reads as a
 *  secret to the scanner that runs on every push to `main`. */
export const FAKE_ACCOUNT_ID = `account-a${"0".repeat(30)}ab`;
export const FAKE_ACCOUNT_ID_TWO = `account-a${"0".repeat(30)}cd`;

type MailAccountCapabilities = PublicMailAccountV3["capabilities"];
type MailProviderKind = PublicMailAccountV2["providerKind"];

const FAKE_IMAP = Object.freeze({
  hostname: "imap.example.test",
  port: 993,
  tls: "implicit" as MailTlsMode,
  username: "me",
});

/** What the service reports for each provider before a test says otherwise:
 *  Gmail sends, a bare IMAP account does not. */
function baseCapabilities(
  providerKind: MailProviderKind,
): MailAccountCapabilities {
  if (providerKind === "gmail") {
    return {
      mailboxes: ["inbox", "starred", "sent", "all", "spam", "trash"],
      listThreads: true,
      sync: true,
      headerPreview: true,
      messageBodies: true,
      threadMutations: true,
      compose: true,
      send: true,
      reply: true,
    };
  }
  return {
    mailboxes: ["inbox"],
    listThreads: true,
    sync: true,
    headerPreview: true,
    messageBodies: true,
    threadMutations: true,
    compose: false,
    send: false,
    reply: false,
  };
}

export interface FakeAccountOverrides {
  readonly emailAddress?: string;
  readonly displayName?: string | null;
  readonly status?: PublicMailAccountV2["status"];
  readonly providerKind?: MailProviderKind;
  /** Only an IMAP account carries one, and carrying one is what separates
   *  "no SMTP configured" from "SMTP configured and blocked". */
  readonly smtp?: {
    readonly hostname: string;
    readonly port: number;
    readonly tls: MailTlsMode;
    readonly username: string;
  };
  readonly capabilities?: Partial<MailAccountCapabilities>;
}

export function fakeAccountV2(
  accountId: string = FAKE_ACCOUNT_ID,
  overrides: FakeAccountOverrides = {},
): PublicMailAccountV2 {
  const base = {
    accountId,
    emailAddress: overrides.emailAddress ?? "me@example.test",
    displayName: overrides.displayName === undefined ? "Me" : overrides.displayName,
    status: overrides.status ?? "connected",
    connectedAt: 0,
    createdAt: 0,
    updatedAt: 0,
  } as const;
  if ((overrides.providerKind ?? "gmail") === "gmail") {
    return { ...base, providerKind: "gmail" };
  }
  return {
    ...base,
    providerKind: "imap",
    imap: FAKE_IMAP,
    ...(overrides.smtp ? { smtp: overrides.smtp } : {}),
  };
}

export function fakeAccountV3(
  accountId: string = FAKE_ACCOUNT_ID,
  overrides: FakeAccountOverrides = {},
): PublicMailAccountV3 {
  const account = fakeAccountV2(accountId, overrides);
  const capabilities = {
    ...baseCapabilities(account.providerKind),
    ...overrides.capabilities,
  };
  return { ...account, capabilities };
}

export function fakeThread(
  overrides: Partial<MailThreadListItem> = {},
): MailThreadListItem {
  return {
    accountId: FAKE_ACCOUNT_ID,
    threadId: "thread-alpha",
    subject: "the subject",
    participants: [{ name: "Me", address: "me@example.test" }],
    snippet: "the snippet",
    lastMessageAt: 0,
    messageCount: 1,
    unread: false,
    starred: false,
    hasAttachments: false,
    listMessage: false,
    sizeBytes: 0,
    category: "people",
    ...overrides,
  };
}

export function fakeMessage(
  overrides: Partial<MailMessageDto> = {},
): MailMessageDto {
  return {
    accountId: FAKE_ACCOUNT_ID,
    messageId: "message-alpha",
    threadId: "thread-alpha",
    from: { name: "Me", address: "me@example.test" },
    replyTo: [],
    to: [],
    cc: [],
    subject: "the subject",
    sentAt: 0,
    unread: false,
    inInbox: true,
    snippet: "the snippet",
    textBody: null,
    htmlBody: null,
    hasAttachments: false,
    ...overrides,
  };
}

export interface MailClientFake {
  readonly calls: Array<{ method: string; args: readonly unknown[] }>;
  readonly client: BrainMailClient;
}

const unavailable = async (): Promise<never> => {
  throw new BrainMailClientError(503, "mail_service_unavailable");
};

/** Every member of `BrainMailClient`, so a method added to the interface fails
 *  `tsc --noEmit` here rather than going untested everywhere. */
function defaultClient(): BrainMailClient {
  return {
    status: unavailable,
    connect: unavailable,
    disconnect: unavailable,
    listAccounts: async () => ({
      apiVersion: 2,
      accounts: [fakeAccountV2()],
    }),
    listAccountCapabilities: async () => ({
      apiVersion: 3,
      accounts: [fakeAccountV3()],
    }),
    createAccount: unavailable,
    updateAccount: unavailable,
    deleteAccount: unavailable,
    listThreads: async () => ({
      apiVersion: 1,
      items: [],
      nextCursor: null,
      sync: { status: "idle", lastSuccessfulAt: 0 },
    }),
    listMailboxThreads: async (_accountId, mailboxId) => ({
      apiVersion: 1,
      mailboxId,
      items: [],
      nextCursor: null,
      availability: {
        status: "available",
        lastSuccessfulAt: 0,
        windowTruncated: false,
      },
    }),
    searchThreads: async (input) => ({
      apiVersion: 1,
      mailboxId: input.mailboxId,
      scope: "headers_and_previews",
      items: [],
      nextCursor: null,
      availability: {
        status: "available",
        lastSuccessfulAt: 0,
        windowTruncated: false,
      },
      indexStatus: "ready",
      resultsTruncated: false,
    }),
    getThread: unavailable,
    getMailboxThread: unavailable,
    syncAccount: unavailable,
    updateThread: unavailable,
    createDraft: unavailable,
    listDrafts: unavailable,
    getDraft: unavailable,
    updateDraft: unavailable,
    deleteDraft: unavailable,
    sendDraft: unavailable,
    sendMessage: async () => ({
      apiVersion: 1,
      operationId: "send-alpha",
      created: true,
      status: "queued",
    }),
    getSendOperation: unavailable,
    getMessageContent: unavailable,
    requestMessageContent: unavailable,
    downloadAttachment: unavailable,
    downloadRemoteImage: unavailable,
  };
}

export function createMailClientFake(
  overrides: Partial<BrainMailClient> = {},
): MailClientFake {
  const calls: Array<{ method: string; args: readonly unknown[] }> = [];
  const defaults = defaultClient();
  const client: Record<string, unknown> = {};
  for (const method of Object.keys(defaults) as Array<keyof BrainMailClient>) {
    // Every member is a function of its own argument list, and the recorder
    // has to accept all of them, so the call site is widened once here rather
    // than twenty-seven times above.
    const chosen = (overrides[method] ?? defaults[method]) as (
      ...args: unknown[]
    ) => unknown;
    client[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chosen(...args);
    };
  }
  return { calls, client: client as unknown as BrainMailClient };
}
