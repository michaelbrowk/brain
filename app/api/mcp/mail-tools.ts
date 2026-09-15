import type { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  BrainMailClientError,
  createBrainMailClient,
  type PublicMailAccountV3,
} from "@/lib/mail/brain-mail-client";
import type { MailThreadListItem } from "@/lib/mail/message-types";
import { hasScope, insufficientScope, refusal, text } from "./tool-kit";

/** THE MAIL READS: ACCOUNTS, THREADS, SEARCH, ONE THREAD, ONE BODY.
 *
 *  Every tool here calls `createBrainMailClient()` in process, over the mail
 *  service's Unix socket. It never calls `/api/mail/*`: those routes are
 *  same-origin gated for the browser and carry no bearer, so an agent reaching
 *  them would be refused by a check that was never about the agent.
 *
 *  The client is built per call rather than once per module, because a tool
 *  that held one open would keep a socket path from before the service was
 *  reconfigured, and because a test replaces the factory.
 */

type McpToolServer = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

/** The six system mailboxes are the whole map. Brain has no custom folders. */
const mailboxSchema = z.enum([
  "inbox",
  "all",
  "sent",
  "starred",
  "spam",
  "trash",
]);

const viewSchema = z.enum(["unread", "attachments", "lists", "people"]);

const limitSchema = z.number().int().min(1).max(50);

const DEFAULT_MAILBOX = "inbox" as const;
const DEFAULT_LIMIT = 25;
const DEFAULT_WAIT_MS = 8000;
const MAX_WAIT_MS = 20_000;
const POLL_INTERVAL_MS = 400;

/** The service's own code, handed over as a reason an agent can act on. A
 *  throw here would arrive at the agent as a transport error with no code at
 *  all, and the agent would retry a permanent refusal forever. Anything that
 *  is not the client's own error is an outage as far as the agent is
 *  concerned, and its wording stays on this side of the boundary. */
function mailRefusal(error: unknown) {
  if (error instanceof BrainMailClientError) {
    if (error.code === "mail_service_unavailable") {
      return refusal("the mail service is unavailable", error.code);
    }
    if (error.code === "mail_account_not_found") {
      return refusal("account not found", error.code);
    }
    if (error.code === "mail_thread_not_found") {
      return refusal("thread not found", error.code);
    }
    if (error.code === "mail_account_reauth_required") {
      return refusal("this account needs to be reconnected", error.code);
    }
    return refusal("the mail service refused this request", error.code);
  }
  return refusal("the mail service is unavailable", "mail_service_unavailable");
}

/** The service reports sending as one boolean, so the reason it is false is
 *  Brain's own read. Reconnection comes first because it is the one the owner
 *  can act on today; an IMAP account with no SMTP endpoint was never set up to
 *  send; anything left is the relay this host cannot reach. */
function sendBlockedReasonOf(account: PublicMailAccountV3): string | null {
  if (account.capabilities.send) return null;
  if (account.status === "reauth_required") return "account_reauth_required";
  if (account.providerKind === "imap" && account.smtp === undefined) {
    return "smtp_not_configured";
  }
  return "smtp_relay_unavailable";
}

/** Brain's shape, not the service's. One address field, named `address`,
 *  because it is the only address any mail tool ever answers with. */
function mcpAccount(account: PublicMailAccountV3) {
  const sendBlockedReason = sendBlockedReasonOf(account);
  return {
    accountId: account.accountId,
    address: account.emailAddress,
    displayName: account.displayName,
    provider: account.providerKind,
    canSend: account.capabilities.send,
    ...(sendBlockedReason === null ? {} : { sendBlockedReason }),
  };
}

type SearchCursor = Record<string, string | null>;

/** Opaque by construction. An agent hands back the one string it was given and
 *  never unpacks a cursor per account. */
function encodeSearchCursor(per: SearchCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, per })).toString("base64url");
}

function decodeSearchCursor(cursor: string): SearchCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as { v?: unknown; per?: unknown };
  if (value.v !== 1 || typeof value.per !== "object" || value.per === null) {
    return null;
  }
  const per: SearchCursor = {};
  for (const [accountId, entry] of Object.entries(
    value.per as Record<string, unknown>,
  )) {
    if (entry !== null && typeof entry !== "string") return null;
    per[accountId] = entry;
  }
  return per;
}

/** A total order, so two pages of the same search always merge the same way.
 *  `threadId` breaks a tie because two threads can carry one timestamp, and a
 *  page that reshuffles between calls drops rows across the cursor. */
function byNewest(left: MailThreadListItem, right: MailThreadListItem): number {
  const leftAt = left.lastMessageAt ?? 0;
  const rightAt = right.lastMessageAt ?? 0;
  if (leftAt !== rightAt) return rightAt - leftAt;
  if (left.threadId === right.threadId) return 0;
  return left.threadId < right.threadId ? -1 : 1;
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function registerMailTools(server: McpToolServer): void {
  server.tool(
    "list_mail_accounts",
    "List the connected mail accounts, each with whether this host can send from it and why not when it cannot.",
    {},
    async (_input, extra) => {
      if (!hasScope(extra, "brain:mail")) return insufficientScope("brain:mail");
      try {
        const status = await createBrainMailClient().listAccountCapabilities();
        return text({ accounts: status.accounts.map(mcpAccount) });
      } catch (error) {
        return mailRefusal(error);
      }
    },
  );

  server.tool(
    "list_mail_threads",
    "List one account's threads in one system mailbox, newest first. Pass `nextCursor` back as `cursor` for the next page.",
    {
      accountId: z.string(),
      mailbox: mailboxSchema
        .optional()
        .describe("one of the six system mailboxes, inbox by default"),
      view: viewSchema.optional().describe("narrow the mailbox to one view"),
      cursor: z.string().optional().describe("the previous page's nextCursor"),
      limit: limitSchema.optional().describe("1 to 50, 25 by default"),
    },
    async ({ accountId, mailbox, view, cursor, limit }, extra) => {
      if (!hasScope(extra, "brain:mail")) return insufficientScope("brain:mail");
      try {
        const page = await createBrainMailClient().listMailboxThreads(
          accountId,
          mailbox ?? DEFAULT_MAILBOX,
          {
            cursor: cursor ?? null,
            limit: limit ?? DEFAULT_LIMIT,
            view: view ?? null,
          },
        );
        return text({ threads: page.items, nextCursor: page.nextCursor });
      } catch (error) {
        return mailRefusal(error);
      }
    },
  );

  server.tool(
    "search_mail",
    "Search cached thread headers and previews. Message bodies are never searched. With no `accountId` every account is searched and the results merge newest first behind one cursor.",
    {
      query: z.string(),
      accountId: z
        .string()
        .optional()
        .describe("one account, or every account when left out"),
      mailbox: mailboxSchema.optional(),
      cursor: z.string().optional().describe("the previous page's nextCursor"),
      limit: limitSchema
        .optional()
        .describe("1 to 50 per account, 25 by default"),
    },
    async ({ query, accountId, mailbox, cursor, limit }, extra) => {
      if (!hasScope(extra, "brain:mail")) return insufficientScope("brain:mail");
      const mailboxId = mailbox ?? DEFAULT_MAILBOX;
      const pageLimit = limit ?? DEFAULT_LIMIT;
      try {
        const client = createBrainMailClient();
        if (accountId !== undefined) {
          const page = await client.searchThreads({
            accountId,
            mailboxId,
            query,
            cursor: cursor ?? null,
            limit: pageLimit,
          });
          return text({ threads: page.items, nextCursor: page.nextCursor });
        }
        const accountIds = (await client.listAccounts()).accounts.map(
          (account) => account.accountId,
        );
        let per: SearchCursor | null = null;
        if (cursor !== undefined) {
          per = decodeSearchCursor(cursor);
          if (
            per === null ||
            Object.keys(per).some((id) => !accountIds.includes(id))
          ) {
            return refusal("that cursor is not usable any more", "stale_cursor");
          }
        }
        const items: MailThreadListItem[] = [];
        const next: SearchCursor = {};
        for (const id of accountIds) {
          const named =
            per !== null && Object.prototype.hasOwnProperty.call(per, id);
          // An account the previous page ran to the end keeps its null and is
          // not asked again. An account the cursor never named is new since
          // that page, so it starts from the beginning.
          if (named && per?.[id] === null) {
            next[id] = null;
            continue;
          }
          const page = await client.searchThreads({
            accountId: id,
            mailboxId,
            query,
            cursor: named ? (per?.[id] ?? null) : null,
            limit: pageLimit,
          });
          items.push(...page.items);
          next[id] = page.nextCursor;
        }
        items.sort(byNewest);
        const exhausted = Object.values(next).every((value) => value === null);
        return text({
          threads: items,
          nextCursor: exhausted ? null : encodeSearchCursor(next),
        });
      } catch (error) {
        return mailRefusal(error);
      }
    },
  );

  server.tool(
    "get_mail_thread",
    "Read one thread: its row and every message's headers, preview and whether a body is already cached. Bodies come from read_mail_message.",
    { accountId: z.string(), threadId: z.string() },
    async ({ accountId, threadId }, extra) => {
      if (!hasScope(extra, "brain:mail")) return insufficientScope("brain:mail");
      try {
        const detail = await createBrainMailClient().getThread(
          accountId,
          threadId,
        );
        return text({
          thread: detail.thread,
          messages: detail.messages.map((message) => ({
            messageId: message.messageId,
            from: message.from,
            to: message.to,
            cc: message.cc,
            subject: message.subject,
            sentAt: message.sentAt,
            unread: message.unread,
            snippet: message.snippet,
            hasAttachments: message.hasAttachments,
            bodyCached: message.textBody !== null,
          })),
        });
      } catch (error) {
        return mailRefusal(error);
      }
    },
  );

  server.tool(
    "read_mail_message",
    "Read one message's plain-text body and its attachment list. Answers `state` fetching when the body is still on its way, and the caller asks again.",
    {
      accountId: z.string(),
      messageId: z.string(),
      wait: z
        .number()
        .int()
        .min(0)
        .max(MAX_WAIT_MS)
        .optional()
        .describe("milliseconds to wait for the body, 8000 by default"),
    },
    async ({ accountId, messageId, wait }, extra) => {
      if (!hasScope(extra, "brain:mail")) return insufficientScope("brain:mail");
      try {
        const client = createBrainMailClient();
        // The body cache drops rows outside the three-newest-Inbox cohort
        // unless a live demand holds them, so the POST is not an optimisation:
        // without it the GET can answer `not_requested` forever. Brain records
        // the demand, then polls its own cache. The poll is capped by the
        // caller's own `wait` and answers `fetching` rather than holding the
        // tool call open, and an agent that gets `fetching` calls again, which
        // records the demand once more.
        const deadline = Date.now() + (wait ?? DEFAULT_WAIT_MS);
        let content = await client.requestMessageContent(accountId, messageId);
        while (content.state === "fetching" && Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          content = await client.getMessageContent(accountId, messageId);
        }
        if (content.state !== "ready") {
          return text({ state: content.state, attachments: [] });
        }
        // `htmlBody` is never read. When a message carried only an HTML part
        // the service's own extraction has already put the words in
        // `textBody`, so an agent gets what a person reads.
        return text({
          state: content.state,
          text: content.textBody,
          attachments: content.attachments.map((attachment) => ({
            attachmentId: attachment.attachmentId,
            filename: attachment.filename,
            mimeType: attachment.mimeType,
            bytes: attachment.bytes,
          })),
        });
      } catch (error) {
        return mailRefusal(error);
      }
    },
  );
}
