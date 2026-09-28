import {
  mailApiBodyError,
  mailApiError,
  readBoundedMailJson,
  runMailApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";
import {
  createBrainMailClient,
  type PublicMailAccountV3,
} from "@/lib/mail/brain-mail-client";
import { validateMailSearchAllInput } from "@/lib/mail/message-codec";
import type {
  MailSearchAllAccountStatus,
  MailSearchAllInput,
  MailSearchAllResponse,
  MailSystemMailbox,
} from "@/lib/mail/message-types";
import { searchAllAccounts } from "@/lib/mail/search-all";
import { normalizeMailSearchQueryText } from "@/lib/mail/search-query";

export const dynamic = "force-dynamic";

/** THE PALETTE'S DOOR: ONE QUERY ACROSS EVERY CONNECTED ACCOUNT.
 *
 *  `/api/mail/search` answers one account in one mailbox behind a cursor,
 *  which is what the Mail surface wants. The ⌘K palette wants the twenty
 *  newest matches across every account in one answer, which is what the MCP
 *  tool `search_mail` already computed for agents. The fan-out is shared
 *  (`lib/mail/search-all.ts`); this route is the same-origin, JSON, bounded
 *  door in front of it, and the module gate in `proxy.ts` answers 409 for it
 *  while Mail is paused before this file runs.
 *
 *  The scope is the index's: subjects, participants and previews. Bodies are
 *  never searched and never fetched to answer this.
 */

/** The widest mailbox the account has. Gmail carries an All Mail view that
 *  holds archived threads too, and a match the person remembers is as likely
 *  archived as not; an IMAP account is synced Inbox-only, so its Inbox is the
 *  whole index. Read off the same capabilities the browser gets from
 *  `/api/mail/accounts/capabilities`, so the two never disagree about what an
 *  account has. */
function searchMailboxOf(account: PublicMailAccountV3): MailSystemMailbox {
  return account.capabilities.mailboxes.includes("all") ? "all" : "inbox";
}

export async function POST(request: Request) {
  const rejected = validateMailMutationRequest(
    request,
    true,
    false,
    "mail_request_invalid",
    1,
  );
  if (rejected) return rejected;

  let body: unknown;
  try {
    body = await readBoundedMailJson(request);
  } catch (error) {
    return mailApiBodyError(error, "mail_request_invalid", 1);
  }

  let input: MailSearchAllInput;
  try {
    input = validateMailSearchAllInput(body);
  } catch {
    return mailApiError(400, "mail_request_invalid", 1);
  }
  // Its own code, apart from the shape refusal above: a palette that sent
  // punctuation or a cleared field has nothing to search for, and can say so,
  // whereas `mail_request_invalid` would read as a bug in the caller.
  if (normalizeMailSearchQueryText(input.query) === null) {
    return mailApiError(400, "invalid_query", 1);
  }

  return runMailApiAction(async (): Promise<MailSearchAllResponse> => {
    const client = createBrainMailClient();
    // A throw here, before any account is asked, is the service's own answer
    // and travels as it: the browser gets the 503 the proxy path always gives,
    // never a 200 with an empty list that reads as "no mail matched".
    const { accounts } = await client.listAccountCapabilities(request.signal);
    const merged = await searchAllAccounts(client, {
      query: input.query,
      limit: input.limit,
      accounts,
      mailboxFor: searchMailboxOf,
      signal: request.signal,
    });
    const statuses: MailSearchAllAccountStatus[] = [];
    for (const account of accounts) {
      const status = merged.accounts.find(
        (candidate) => candidate.accountId === account.accountId,
      );
      // Without a cursor every account is asked, so every account has one.
      if (status === undefined) continue;
      const named = { accountId: account.accountId, emailAddress: account.emailAddress };
      statuses.push(
        "error" in status
          ? { ...named, error: status.error, reason: status.reason }
          : {
              ...named,
              mailboxId: searchMailboxOf(account),
              availability: status.availability,
              indexStatus: status.indexStatus,
              resultsTruncated: status.resultsTruncated,
            },
      );
    }
    return {
      apiVersion: 1,
      threads: merged.threads.slice(0, input.limit),
      accounts: statuses,
      indexBuilding: statuses.some(
        (status) => "indexStatus" in status && status.indexStatus === "building",
      ),
      // Three ways the answer can be short of the whole: the merge held more
      // than the limit, an account cut its own page short, or an account has
      // a page behind the one it answered. The palette has no cursor, so the
      // third reads as "more than shown" too.
      truncated:
        merged.threads.length > input.limit ||
        statuses.some(
          (status) => "resultsTruncated" in status && status.resultsTruncated,
        ) ||
        Object.values(merged.next).some((cursor) => cursor !== null),
    };
  }, 1);
}
