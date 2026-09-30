import type { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  createBrainMailClient,
  type PublicMailAccountV3,
} from "@/lib/mail/brain-mail-client";
import type { MailThreadMutationInput } from "@/lib/mail/message-types";
import { sanitizeSnippet } from "@/lib/mail/reader-content";
import {
  decodeSearchCursor,
  encodeSearchCursor,
  searchAllAccounts,
  type SearchCursor,
} from "@/lib/mail/search-all";
import { normalizeMailSearchQueryText } from "@/lib/mail/search-query";
import {
  logMailActivity,
  mailOutcome,
  mailRefusal,
  sendBlockedReasonOf,
} from "./mail-tool-kit";
import { hasScope, hints, insufficientScope, refusal, text } from "./tool-kit";

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
  server.registerTool(
    "list_mail_accounts",
    {
      title: "List mail accounts",
      description:
        "List the connected mail accounts, each with whether this host can send from it and why not when it cannot.",
      inputSchema: {},
      annotations: hints("read keeps idempotent outside"),
    },
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

  server.registerTool(
    "list_mail_threads",
    {
      title: "List mail threads",
      description:
        "List one account's threads in one system mailbox, newest first. Pass `nextCursor` back as `cursor` for the next page.",
      inputSchema: {
        accountId: z.string(),
        mailbox: mailboxSchema
          .optional()
          .describe("one of the six system mailboxes, inbox by default"),
        view: viewSchema.optional().describe("narrow the mailbox to one view"),
        cursor: z.string().optional().describe("the previous page's nextCursor"),
        limit: limitSchema.optional().describe("1 to 50, 25 by default"),
      },
      annotations: hints("read keeps idempotent outside"),
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

  server.registerTool(
    "search_mail",
    {
      title: "Search mail",
      description:
        "Search cached thread headers and previews. Message bodies are never searched. With no `accountId` every account is searched and the results merge newest first behind one cursor.",
      inputSchema: {
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
      annotations: hints("read keeps idempotent outside"),
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
        const { accounts } = await client.listAccounts();
        let per: SearchCursor | null = null;
        if (cursor !== undefined) {
          per = decodeSearchCursor(cursor);
          if (
            per === null ||
            Object.keys(per).some(
              (id) => !accounts.some((account) => account.accountId === id),
            )
          ) {
            return refusal("that cursor is not usable any more", "stale_cursor");
          }
        }
        // The fan-out and the merge are `lib/mail/search-all.ts`, shared with
        // the browser's `/api/mail/search/all`. Only the cursor's encoding is
        // this tool's: one opaque string, `null` once every account has run
        // to the end.
        const merged = await searchAllAccounts(client, {
          query,
          limit: pageLimit,
          accounts,
          mailboxFor: () => mailboxId,
          cursor: per,
        });
        const exhausted = Object.values(merged.next).every(
          (value) => value === null,
        );
        return text({
          threads: merged.threads,
          nextCursor: exhausted ? null : encodeSearchCursor(merged.next),
          accounts: merged.accounts,
        });
      } catch (error) {
        return mailRefusal(error);
      }
    },
  );

  server.registerTool(
    "get_mail_thread",
    {
      title: "Read a mail thread",
      description:
        "Read one thread: its row and every message's headers, preview and whether a body is already cached. Bodies come from read_mail_message.",
      inputSchema: { accountId: z.string(), threadId: z.string() },
      annotations: hints("read keeps idempotent outside"),
    },
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

  server.registerTool(
    "read_mail_message",
    {
      title: "Read a mail message",
      description:
        "Read one message's plain-text body and its attachment list. Answers `state` fetching when the body is still on its way, and the caller asks again.",
      inputSchema: {
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
      annotations: hints("read keeps idempotent outside"),
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
        // The body cache drops rows outside the prefetch cohort (the 200
        // newest Inbox messages of the last 30 days) unless a live demand
        // holds them, and the byte budget can evict even those, so the POST
        // is not an optimisation:
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

  server.registerTool(
    TRIAGE_TOOL,
    {
      title: "Sort a mail thread",
      description:
        "Sort one thread: mark it read or unread, star it, archive it, move it to trash or spam, or restore it from either. Exactly one of the six per call, which is the shape the service's own PATCH takes. There is no purge: a thread in the trash stays there until the person empties it.",
      inputSchema: {
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
      // One tool covering six changes, and two of them — trash and spam — take
      // a thread out of the mailbox the owner reads. A host confirming this
      // call is confirming the worst of the six, which is the right default for
      // a tool whose argument decides which it is.
      annotations: hints("write destroys idempotent outside"),
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
