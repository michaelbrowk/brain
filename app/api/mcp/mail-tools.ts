import type { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  createBrainMailClient,
  type PublicMailAccountV3,
} from "@/lib/mail/brain-mail-client";
import type {
  MailMailboxAvailability,
  MailSearchIndexStatus,
  MailThreadListItem,
  MailThreadMutationInput,
} from "@/lib/mail/message-types";
import { sanitizeSnippet } from "@/lib/mail/reader-content";
import { normalizeMailSearchQueryText } from "@/lib/mail/search-query";
import {
  logMailActivity,
  mailOutcome,
  mailRefusal,
  mailRefusalFields,
  sendBlockedReasonOf,
} from "./mail-tool-kit";
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
 *
 *  Each tool's own `hasScope` check is a second lock, not the only one:
 *  `toolScopeOf` in `tool-kit.ts` already refuses an ungranted call at the
 *  route, before any handler runs. The in-tool check stays so a tool that
 *  ever moves outside that gate is still refused here.
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

/** The client's own shapes (`lib/mail/message-codec.ts`), repeated here so a
 *  malformed id is refused by Brain, naming the field, rather than reaching
 *  the client only to come back as "the mail service refused this request"
 *  about a service that was never asked. */
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_MAIL_RESOURCE_ID = /^[A-Za-z0-9_-]{1,255}$/;

function invalidId(label: string, reason: string) {
  return refusal(`that ${label} is not valid`, reason);
}

/** One queried account's own state in a merged search: either the page it
 *  answered, carrying the same completeness signals the browser reads, or
 *  the reason it did not answer at all. An agent reading `threads` alone
 *  cannot tell an empty mailbox from one still indexing or one account down;
 *  this is what tells it. */
type SearchAccountStatus =
  | {
      readonly accountId: string;
      readonly availability: MailMailboxAvailability;
      readonly indexStatus: MailSearchIndexStatus;
      readonly resultsTruncated: boolean;
    }
  | { readonly accountId: string; readonly error: string; readonly reason: string };

/** Brain's shape, not the service's. One address field, named `address`,
 *  because it is the only address any mail tool ever answers with. An account
 *  that can send names no reason, which is why the shared derivation is asked
 *  only once the capability says it cannot. */
function mcpAccount(account: PublicMailAccountV3) {
  const sendBlockedReason = account.capabilities.send
    ? null
    : sendBlockedReasonOf(account);
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

/** The words in an HTML-only message, for the one shape the service's own
 *  extraction misses: an HTML part nested inside a multipart container with
 *  no text sibling. `html` here is already sanitizer output handed back by
 *  the client, so stripping its tags cannot expose anything active. Block
 *  boundaries become line breaks first, so paragraphs stay apart rather than
 *  running together, and each line is cleaned the way a snippet is: entities
 *  decoded, zero-width marks and image markers dropped. The markup itself is
 *  never in the answer. */
function textFromSanitizedHtml(html: string): string | null {
  const withLineBreaks = html.replace(
    /<\/?(?:p|div|br|li|tr|h[1-6]|blockquote)\b[^>]*>/gi,
    "\n",
  );
  const lines = withLineBreaks
    .replace(/<[^>]*>/g, " ")
    .split("\n")
    .map((line) => sanitizeSnippet(line))
    .filter((line) => line.length > 0);
  return lines.length === 0 ? null : lines.join("\n");
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

const TRIAGE_TOOL = "update_mail_thread";

/** The six changes a triage call may carry, in the order a refusal names them
 *  and the order the mutation is built in. There is no move, because Brain has
 *  no custom folders: the six system mailboxes are the whole map. */
const TRIAGE_FIELDS = [
  "read",
  "starred",
  "archive",
  "trash",
  "restore",
  "spam",
] as const;

type TriageField = (typeof TRIAGE_FIELDS)[number];

interface TriageFields {
  readonly read?: boolean;
  readonly starred?: boolean;
  readonly archive?: boolean;
  readonly trash?: boolean;
  readonly restore?: boolean;
  readonly spam?: boolean;
}

/** `trash` and `restore` move a thread one way. `false` names no second
 *  thing either word could mean, and left to the schema it fails as
 *  mcp-handler's own `-32602` text rather than the `{ error, reason }` shape
 *  every other refusal in this tool answers. The schema takes a plain
 *  boolean so that refusal can be written here instead. */
const TRUE_ONLY_FIELDS = ["trash", "restore"] as const;

/** One field and the account, and nothing else, because
 *  `validateMailThreadMutationInput` counts the keys and refuses a third.
 *  `null` when the caller named no change at all. Reached only once `trash`
 *  and `restore` are known to be `true` or absent, so the `=== true` checks
 *  below narrow the type `MailThreadMutationInput` needs without repeating
 *  that refusal here. */
function triageMutation(
  accountId: string,
  input: TriageFields,
): MailThreadMutationInput | null {
  if (input.read !== undefined) return { accountId, read: input.read };
  if (input.starred !== undefined) return { accountId, starred: input.starred };
  if (input.archive !== undefined) return { accountId, archive: input.archive };
  if (input.trash === true) return { accountId, trash: true };
  if (input.restore === true) return { accountId, restore: true };
  if (input.spam !== undefined) return { accountId, spam: input.spam };
  return null;
}

/** AN AGENT'S READ MARK TOUCHES THE CENTRE NO LONGER.
 *
 *  It used to: the centre held one row per thread, so a thread an agent read
 *  left a row about a letter already dealt with, and this file marked it read
 *  on the same PATCH. The centre holds one counted row now ("10 new
 *  messages"), which is the owner's tally of what is waiting for THEM. An
 *  agent reading one thread inside it is not the owner reading their mail, and
 *  a mark here would empty the tally on their behalf. The row is cleared by
 *  opening Mail or by pressing it, and by nothing else.
 */

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
      if (!SAFE_ACCOUNT_ID.test(accountId)) {
        return invalidId("account id", "invalid_account_id");
      }
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
        return text({
          threads: page.items,
          nextCursor: page.nextCursor,
          availability: page.availability,
        });
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
      if (accountId !== undefined && !SAFE_ACCOUNT_ID.test(accountId)) {
        return invalidId("account id", "invalid_account_id");
      }
      if (normalizeMailSearchQueryText(query) === null) {
        return refusal("that search query is empty or too long", "invalid_query");
      }
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
          return text({
            threads: page.items,
            nextCursor: page.nextCursor,
            availability: page.availability,
            indexStatus: page.indexStatus,
            resultsTruncated: page.resultsTruncated,
          });
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
        const accounts: SearchAccountStatus[] = [];
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
          try {
            const page = await client.searchThreads({
              accountId: id,
              mailboxId,
              query,
              cursor: named ? (per?.[id] ?? null) : null,
              limit: pageLimit,
            });
            items.push(...page.items);
            next[id] = page.nextCursor;
            accounts.push({
              accountId: id,
              availability: page.availability,
              indexStatus: page.indexStatus,
              resultsTruncated: page.resultsTruncated,
            });
          } catch (error) {
            // One account down does not take the merge with it. `next` keeps
            // no entry for this account, so a cursor built from this answer
            // asks it again from the start rather than marking it exhausted.
            accounts.push({ accountId: id, ...mailRefusalFields(error) });
          }
        }
        items.sort(byNewest);
        const exhausted = Object.values(next).every((value) => value === null);
        return text({
          threads: items,
          nextCursor: exhausted ? null : encodeSearchCursor(next),
          accounts,
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
      if (!SAFE_ACCOUNT_ID.test(accountId)) {
        return invalidId("account id", "invalid_account_id");
      }
      if (!SAFE_MAIL_RESOURCE_ID.test(threadId)) {
        return invalidId("thread id", "invalid_thread_id");
      }
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
      if (!SAFE_ACCOUNT_ID.test(accountId)) {
        return invalidId("account id", "invalid_account_id");
      }
      if (!SAFE_MAIL_RESOURCE_ID.test(messageId)) {
        return invalidId("message id", "invalid_message_id");
      }
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
        // The service's own extraction fills `textBody` for almost every
        // HTML-only message. The one shape it misses, an HTML part nested in
        // a multipart container with no text sibling, is handled here: Brain
        // derives the words itself from the sanitized `htmlBody` and answers
        // those. Raw markup never crosses this boundary either way.
        const messageText =
          content.textBody ??
          (content.htmlBody === null
            ? null
            : textFromSanitizedHtml(content.htmlBody));
        return text({
          state: content.state,
          text: messageText,
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

  server.tool(
    TRIAGE_TOOL,
    "Sort one thread: mark it read or unread, star it, archive it, move it to trash or spam, or restore it from either. Exactly one of the six per call, which is the shape the service's own PATCH takes. There is no purge: a thread in the trash stays there until the person empties it.",
    {
      accountId: z.string(),
      threadId: z.string(),
      read: z.boolean().optional(),
      starred: z.boolean().optional(),
      archive: z.boolean().optional(),
      trash: z
        .boolean()
        .optional()
        .describe("true moves it to the trash; false is refused, pass restore: true instead"),
      restore: z
        .boolean()
        .optional()
        .describe("true takes it back out of the trash or the spam folder; false is refused"),
      spam: z.boolean().optional(),
    },
    async (input, extra) => {
      if (!hasScope(extra, "brain:mail")) return insufficientScope("brain:mail");
      const { accountId, threadId } = input;

      // The same validators the read tools use, and for the same reason: an
      // id this shape cannot be real, so it is refused here rather than
      // reaching the mail client only to fail there, or reaching the
      // activity log unbounded. Nothing below this point, including the log,
      // ever sees an id that failed this check.
      if (!SAFE_ACCOUNT_ID.test(accountId)) {
        return invalidId("account id", "invalid_account_id");
      }
      if (!SAFE_MAIL_RESOURCE_ID.test(threadId)) {
        return invalidId("thread id", "invalid_thread_id");
      }

      // One line per call, whatever became of it, because the owner reading
      // the log wants the attempt as much as the change. A state directory
      // that cannot be written must never turn a completed triage into a
      // failed tool call, so every call site swallows its own failure.
      //
      // Awaited rather than fire-and-forget: `appendMcpActivity` is one
      // bounded O_APPEND write on the common path (the id checks above keep
      // every field here small), so the wait this adds to a triage call is
      // the cost of one write, not the read-and-rewrite the log used to pay
      // near its cap.
      const log = (outcome: string, change?: string) =>
        logMailActivity(
          extra,
          TRIAGE_TOOL,
          change === undefined ? { accountId, threadId } : { accountId, threadId, change },
          outcome,
        ).catch(() => undefined);

      // `trash` and `restore` mean one thing each. `false` is refused here,
      // with the shape every other refusal in this tool answers, rather than
      // left to the schema, where it would fail as mcp-handler's own
      // `-32602` text.
      for (const field of TRUE_ONLY_FIELDS) {
        if (input[field] === false) {
          await log(`${field}_is_true_only`, field);
          return refusal(
            field === "trash"
              ? "trash takes true or nothing; to take a thread out of the trash pass restore: true"
              : "restore takes true or nothing",
            `${field}_is_true_only`,
          );
        }
      }

      // Brain's own rule, enforced before the client, so the refusal names the
      // fields the agent sent rather than arriving as a generic
      // `mail_request_invalid` from the service.
      const given = TRIAGE_FIELDS.filter(
        (field: TriageField) => input[field] !== undefined,
      );
      if (given.length > 1) {
        await log("too_many_changes");
        return refusal("one change per call", given.join(", "));
      }
      const mutation = triageMutation(accountId, input);
      if (mutation === null) {
        await log("no_change");
        return refusal(
          "one change per call",
          `pass one of ${TRIAGE_FIELDS.join(", ")}`,
        );
      }
      const change = given[0];

      try {
        const client = createBrainMailClient();
        // The service withholds thread mutations per account, and the code it
        // coins for a thread that was never going to move reads as a problem
        // with the thread. Ask first, so the reason names the account. An
        // account this host does not know is left to the service, whose
        // `mail_account_not_found` is the truthful answer.
        const status = await client.listAccountCapabilities();
        const account = status.accounts.find(
          (held) => held.accountId === accountId,
        );
        if (account && !account.capabilities.threadMutations) {
          // The same code the wire uses for this condition
          // (`lib/mail/service/http.ts`, `mail_provider_mutation_unsupported`
          // mapped to the 409 `mail_thread_mutation_unsupported`), so an
          // agent branches on one string whether this pre-check catches it or
          // the service does.
          await log("mail_thread_mutation_unsupported", change);
          return refusal(
            "the mail service does not sort threads for this account",
            "mail_thread_mutation_unsupported",
          );
        }
        const result = await client.updateThread(threadId, mutation);
        await log("ok", change);
        return text({ thread: result.thread });
      } catch (error) {
        await log(mailOutcome(error), change);
        return mailRefusal(error);
      }
    },
  );
}
