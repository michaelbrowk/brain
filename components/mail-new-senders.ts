/**
 * The rules the column applies to letters from new senders, with no React in
 * them: who a thread waits on, which group it stands in, and how a decision
 * the reader has just made shows before the service's next list read says it.
 *
 * The service owns the decision and recomputes `newSender` only when a list is
 * read again, so the column keeps what the reader decided as a short list of
 * shown decisions and lays it over whatever the streams hold. Laid over, not
 * written in: a silent refresh that left before the decision and lands after
 * it would otherwise put the row straight back in New senders, and an Undo
 * would have to find and rewrite every copy of the row it touched. Taking the
 * decision off the list is the whole of an Undo or a rollback on screen.
 */

import type { MailAddress, MailThreadListItem } from "@/lib/mail/message-types";
import { unifiedThreadKey, waitsOn } from "./mail-unified";

export { waitsOn };

export type SenderScope = "address" | "domain";
export type SenderVerdict = "accept" | "block";

/** One decision the column is showing ahead of the service. */
export type ShownSenderDecision = {
  readonly scope: SenderScope;
  /** The sender's address as the service normalized it, or its domain. */
  readonly key: string;
  readonly verdict: SenderVerdict;
  /** Threads the service answered as archived by a block, keyed by
   *  `unifiedThreadKey`. A block can archive a thread that did not wait, and
   *  that row leaves the column too. */
  readonly archived: ReadonlySet<string>;
};

export function senderDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).toLowerCase();
}

/** What a row, a toast and a menu call the sender: the name it wrote under,
 *  else its address. */
export function senderName(from: MailAddress): string {
  const name = from.name?.trim();
  return name ? name : from.address;
}

/** Whether "everyone at <domain>" may be offered and made: never for a domain
 *  the service refuses whole (the big providers, the owner's own), and never
 *  while the screen's state has not been read. One rule for the row menu, the
 *  reader's switch and the keys, so none of them can offer what another
 *  refuses. */
export function domainScopeAllowed(
  screen: { readonly domainScopeRefused: readonly string[] } | null,
  domain: string,
): boolean {
  return screen !== null && domain !== "" && !screen.domainScopeRefused.includes(domain);
}

/** The waiting group and everything else, each in the order it arrived. */
export function splitNewSenders(items: readonly MailThreadListItem[]): {
  readonly waiting: readonly MailThreadListItem[];
  readonly rest: readonly MailThreadListItem[];
} {
  const waiting: MailThreadListItem[] = [];
  const rest: MailThreadListItem[] = [];
  for (const item of items) {
    if (waitsOn(item) !== null) waiting.push(item);
    else rest.push(item);
  }
  return { waiting, rest };
}

/** How many different senders at a domain are waiting: what "Accept N
 *  senders" counts, since a domain decision takes all of them at once. */
export function waitingAtDomain(
  items: readonly MailThreadListItem[],
  domain: string,
): number {
  const addresses = new Set<string>();
  for (const item of items) {
    const from = waitsOn(item);
    if (from !== null && senderDomain(from.address) === domain) {
      addresses.add(from.address.toLowerCase());
    }
  }
  return addresses.size;
}

function covers(decision: ShownSenderDecision, from: MailAddress): boolean {
  const address = from.address.toLowerCase();
  return decision.scope === "address"
    ? address === decision.key
    : senderDomain(address) === decision.key;
}

/**
 * The decision that speaks for one sender. An address's own decision
 * outranks its domain's, which is the order the service keeps, and among
 * decisions of one scope the latest is the one the reader made last.
 */
function standingFor(
  decisions: readonly ShownSenderDecision[],
  from: MailAddress,
): ShownSenderDecision | null {
  let domain: ShownSenderDecision | null = null;
  for (let index = decisions.length - 1; index >= 0; index -= 1) {
    const decision = decisions[index]!;
    if (!covers(decision, from)) continue;
    if (decision.scope === "address") return decision;
    domain ??= decision;
  }
  return domain;
}

/**
 * The list as the reader's own decisions leave it: an accepted sender's
 * letters stop waiting and fall into the group they belong to, a blocked
 * sender's letters leave, and so does any thread a block reported archiving
 * from a list the archive empties. The same array comes back when nothing in
 * it is touched, so a render that decided nothing costs nothing downstream.
 */
export function applyShownDecisions(
  items: readonly MailThreadListItem[],
  decisions: readonly ShownSenderDecision[],
  options: {
    /** Whether the list is one a block's archive leaves: an Inbox, or the
     *  merged Inboxes. All Mail and the other mailboxes still hold the
     *  letter, and a search there has to find it. */
    readonly inbox: boolean;
  } = { inbox: true },
): readonly MailThreadListItem[] {
  if (decisions.length === 0) return items;
  let changed = false;
  const shown: MailThreadListItem[] = [];
  for (const item of items) {
    if (
      options.inbox &&
      decisions.some((decision) => decision.archived.has(unifiedThreadKey(item)))
    ) {
      changed = true;
      continue;
    }
    const from = waitsOn(item);
    const standing = from === null ? null : standingFor(decisions, from);
    if (standing === null) {
      shown.push(item);
      continue;
    }
    changed = true;
    if (standing.verdict === "block") continue;
    shown.push(settled(item));
  }
  return changed ? shown : items;
}

/** A thread that no longer waits carries no sender to wait on. */
export function settled(item: MailThreadListItem): MailThreadListItem {
  const next: MailThreadListItem = { ...item, newSender: false };
  delete (next as { newSenderFrom?: MailAddress }).newSenderFrom;
  return next;
}
