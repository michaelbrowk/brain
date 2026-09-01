import { createHash } from "node:crypto";

import {
  GMAIL_OAUTH_SCOPES,
  type GmailOAuthGrant,
} from "@/lib/mail/providers/gmail/oauth";
import type { GmailCredentialBinding } from "@/lib/mail/providers/gmail/token-envelope";
import type { StoredImapMailAccount } from "@/lib/mail/service/account-types";
import type {
  CachedProviderMessage,
  CachedProviderThread,
} from "@/lib/mail/service/message-cache";
import type { StoredMailSendSubmission } from "@/lib/mail/service/outbound";

export const ACCOUNT_ID = "account-a11111111111111111111111111111111";
export const FIXTURE_KEY = Buffer.alloc(32, 7);
export const TOKEN_BINDING: GmailCredentialBinding = Object.freeze({
  accountId: ACCOUNT_ID,
  kind: "oauth_refresh" as const,
  credentialRef: "credential-r22222222222222222222222222222222",
  version: 1,
});
export const HISTORY_ID = "100";
export const OPERATION_ID = "send-00000000-0000-4000-8000-000000000001";

export function imapAccountFixture(): StoredImapMailAccount {
  return {
    account: {
      accountId: ACCOUNT_ID,
      emailAddress: "person@example.test",
      endpoint: { hostname: "imap.example.test", port: 993, tls: "implicit" },
      username: "person@example.test",
      credentialRef: {
        id: "credential-r22222222222222222222222222222222",
        version: 1,
      },
      transportBindingRef: {
        id: "binding-r33333333333333333333333333333333",
        version: 1,
      },
      connectedAt: 1,
    },
    providerKind: "imap",
    displayName: null,
    status: "connected",
    createdAt: 1,
    updatedAt: 1,
  };
}

export function threadFixture(): CachedProviderThread {
  const message: CachedProviderMessage = Object.freeze({
    accountId: ACCOUNT_ID,
    messageId: "message-thread-a",
    threadId: "thread-a",
    from: Object.freeze({ name: "Sender", address: "sender@example.test" }),
    replyTo: Object.freeze([]),
    to: Object.freeze([{ name: null, address: "reader@example.test" }]),
    cc: Object.freeze([]),
    subject: "Subject thread-a",
    sentAt: 1_000,
    unread: true,
    inInbox: true,
    snippet: "Snippet thread-a",
    textBody: "Body thread-a",
    htmlBody: null,
    hasAttachments: false,
    rfcMessageId: "<thread-a@example.test>",
    references: Object.freeze([]),
    listMessage: false,
    category: "people",
    sizeEstimate: null,
  });
  return Object.freeze({
    thread: Object.freeze({
      accountId: ACCOUNT_ID,
      threadId: "thread-a",
      subject: message.subject,
      participants: Object.freeze([message.from!]),
      snippet: message.snippet,
      lastMessageAt: 1_000,
      messageCount: 1,
      unread: true,
      starred: false,
      hasAttachments: false,
      listMessage: false,
      sizeBytes: 0,
      category: "people",
    }),
    messages: Object.freeze([message]),
    inInbox: true,
    mailboxes: Object.freeze(["all", "inbox"] as const),
  });
}

export function submissionFixture(): StoredMailSendSubmission {
  const raw = Buffer.from(
    "From: me@example.com\r\nTo: friend@example.net\r\n\r\nBody\r\n",
    "utf8",
  );
  return Object.freeze({
    version: 0,
    operationId: OPERATION_ID,
    idempotencyKey: "compose-action-1",
    requestFingerprint: "a".repeat(64),
    accountId: ACCOUNT_ID,
    providerKind: "gmail" as const,
    status: "queued" as const,
    attemptCount: 0,
    lease: null,
    message: Object.freeze({
      messageId: "<brain.1@example.com>",
      envelope: Object.freeze({
        from: "me@example.com",
        to: Object.freeze(["friend@example.net"]),
        cc: Object.freeze([]),
        bcc: Object.freeze([]),
      }),
      providerThreadId: null,
      rawRfc2822Base64Url: raw.toString("base64url"),
      rawRfc2822Bytes: raw.byteLength,
      rawRfc2822Sha256: createHash("sha256").update(raw).digest("hex"),
    }),
    providerMessageId: null,
    providerThreadId: null,
    lastErrorCode: null,
    nextAttemptAt: 1_800_000_000_000,
    createdAt: 1_800_000_000_000,
    updatedAt: 1_800_000_000_000,
  });
}

export function gmailGrantFixture(): GmailOAuthGrant {
  return Object.freeze({
    provider: "gmail" as const,
    subject: "google-subject-1",
    emailAddress: "person@gmail.com",
    scopes: GMAIL_OAUTH_SCOPES,
    accessToken: Buffer.from("test-access-token"),
    refreshToken: Buffer.from("test-refresh-token"),
    accessTokenExpiresAt: 1_800_003_600_000,
    grantedAt: 1_800_000_000_000,
  });
}
