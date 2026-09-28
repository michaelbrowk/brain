import type { BrainMailClient } from "./brain-mail-client";
import type {
  MailMailboxAvailability,
  MailSearchIndexStatus,
  MailSystemMailbox,
  MailThreadListItem,
} from "./message-types";
import { mailRefusalFields } from "./refusal-fields";

/** ONE SEARCH ACROSS EVERY ACCOUNT, FOR THE AGENT AND THE PALETTE ALIKE.
 *
 *  The MCP tool `search_mail` fanned out over every account and merged the
 *  pages newest first; the browser's ⌘K palette needs the same merge and had
 *  no route for it. The fan-out lives here so both read one copy: the caller
 *  lists the accounts (the tool through `listAccounts`, the route through
 *  `listAccountCapabilities`, because only the latter says which mailboxes an
 *  account has), says which mailbox to search in each, and gets back the
 *  merged rows, a per-account cursor map and one status per account asked.
 *
 *  Accounts are asked one after another, in the order given. Two threads can
 *  carry one timestamp, so `byNewest` is a total order and two pages of the
 *  same search always merge the same way.
 */

/** The one field the fan-out needs from an account. Callers hand in whatever
 *  richer shape they listed, and `mailboxFor` sees that shape. */
export interface MailAccountSummary {
  readonly accountId: string;
}

/** The service's cursor per account, or `null` for an account the previous
 *  page ran to the end. An account with no entry has not been asked yet, or
 *  failed last time and is asked again from the start. */
export type SearchCursor = Record<string, string | null>;

/** One queried account's own state in a merged search: either the page it
 *  answered, carrying the same completeness signals the browser reads, or
 *  the reason it did not answer at all. A caller reading `threads` alone
 *  cannot tell an empty mailbox from one still indexing or one account down;
 *  this is what tells it. */
export type SearchAccountStatus =
  | {
      readonly accountId: string;
      readonly availability: MailMailboxAvailability;
      readonly indexStatus: MailSearchIndexStatus;
      readonly resultsTruncated: boolean;
    }
  | { readonly accountId: string; readonly error: string; readonly reason: string };

export interface SearchAllAccountsInput<A extends MailAccountSummary> {
  /** Already checked by the caller: `normalizeMailSearchQueryText` is not
   *  null for it. The client normalises again on the wire. */
  readonly query: string;
  /** Per account, in the client's own 1..50 range. */
  readonly limit: number;
  /** Every account to ask, in the order to ask them. */
  readonly accounts: readonly A[];
  readonly mailboxFor: (account: A) => MailSystemMailbox;
  /** Paging, for the MCP tool only; the route passes nothing and starts every
   *  account from the beginning. The caller has already validated it against
   *  the accounts it holds. */
  readonly cursor?: SearchCursor | null;
  readonly signal?: AbortSignal;
}

export interface SearchAllAccountsResult {
  /** Every account's rows, merged `byNewest`. */
  readonly threads: readonly MailThreadListItem[];
  /** Per-account cursors for the next page. An account that failed has no
   *  entry, so a cursor built from this answer asks it again from the start
   *  rather than marking it exhausted. */
  readonly next: SearchCursor;
  /** One entry per account asked, in the order they were asked. An account
   *  the cursor marked exhausted was not asked and has none. */
  readonly accounts: readonly SearchAccountStatus[];
}

/** Opaque by construction. An agent hands back the one string it was given and
 *  never unpacks a cursor per account. */
export function encodeSearchCursor(per: SearchCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, per })).toString("base64url");
}

export function decodeSearchCursor(cursor: string): SearchCursor | null {
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
export function byNewest(
  left: MailThreadListItem,
  right: MailThreadListItem,
): number {
  const leftAt = left.lastMessageAt ?? 0;
  const rightAt = right.lastMessageAt ?? 0;
  if (leftAt !== rightAt) return rightAt - leftAt;
  if (left.threadId === right.threadId) return 0;
  return left.threadId < right.threadId ? -1 : 1;
}

export async function searchAllAccounts<A extends MailAccountSummary>(
  client: BrainMailClient,
  input: SearchAllAccountsInput<A>,
): Promise<SearchAllAccountsResult> {
  const per = input.cursor ?? null;
  const items: MailThreadListItem[] = [];
  const next: SearchCursor = {};
  const accounts: SearchAccountStatus[] = [];
  for (const account of input.accounts) {
    const id = account.accountId;
    const named =
      per !== null && Object.prototype.hasOwnProperty.call(per, id);
    // An account the previous page ran to the end keeps its null and is not
    // asked again. An account the cursor never named is new since that page,
    // so it starts from the beginning.
    if (named && per[id] === null) {
      next[id] = null;
      continue;
    }
    try {
      const page = await client.searchThreads(
        {
          accountId: id,
          mailboxId: input.mailboxFor(account),
          query: input.query,
          cursor: named ? per[id] : null,
          limit: input.limit,
        },
        input.signal,
      );
      items.push(...page.items);
      next[id] = page.nextCursor;
      accounts.push({
        accountId: id,
        availability: page.availability,
        indexStatus: page.indexStatus,
        resultsTruncated: page.resultsTruncated,
      });
    } catch (error) {
      // One account down does not take the merge with it. `next` keeps no
      // entry for this account, so a cursor built from this answer asks it
      // again from the start rather than marking it exhausted.
      accounts.push({ accountId: id, ...mailRefusalFields(error) });
    }
  }
  items.sort(byNewest);
  return { threads: items, next, accounts };
}
