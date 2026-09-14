"use client";

// MAIL, ON HOME.
//
// Three unread People rows and one digest row under them, because "important"
// already means "from a person" in the unified derivation and the rest is a
// pile with a size rather than a list. The counts live INSIDE a row that leads
// somewhere, not in a strip of numbers: a figure a reader cannot press is a
// figure they can do nothing about.
//
// NO MAIL ACTION HERE. Done carries its own undo machinery and belongs in the
// column; every control in this block is a way into Mail.
//
// AND NOTHING ELSE ON HOME WAITS FOR IT. Mail is another process with its own
// latency and its own 503. One aggregate request for the whole dashboard would
// wait for the slowest of three sources and fail whole, so this block owns its
// own fetch, its own pending state and its own failure row. The last answer is
// kept in `sessionStorage` and revalidated on mount and on `visibilitychange`,
// the pattern the visit marker at the head of Home already uses.

import { motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

import { formatAgo } from "@/lib/format-ago";
import type { MailThreadListItem } from "@/lib/mail/message-types";
import { DUR, EASE_OUT } from "@/lib/motion";

import { HubRow } from "./hub-row";
import { formatParticipants, stripSubjectSenderPrefix } from "./mail-row";
import { MailSenderIcon } from "./mail-sender-icon";
import {
  defaultMailSurfaceClient,
  type MailSurfaceClient,
  type PublicMailAccount,
} from "./mail-surface-client";
import {
  UNIFIED_PAGE_SIZE,
  compareUnified,
  deriveUnifiedSections,
} from "./mail-unified";
import { Empty } from "./ui/empty";
import { Icon } from "./ui/icon";
import { Skeleton } from "./ui/primitives";

/** Three, the same number the unified column previews a section with. */
const PEOPLE_ROWS = 3;

/** One tab's copy of the last answer. `sessionStorage` and not `localStorage`:
 *  it is somebody's mail, and it should not outlive the tab that asked for
 *  it. The version rides in the key, so a shape change discards the old one
 *  rather than reading it wrong. */
const SNAPSHOT_KEY = "brain-hub-mail-v2";

/** What one People row needs, and not one field more. */
interface MailRowView {
  readonly accountId: string;
  readonly threadId: string;
  readonly sender: string;
  readonly subject: string;
  readonly at: number | null;
}

interface MailBlockData {
  readonly people: readonly MailRowView[];
  readonly notifications: number;
  readonly newsletters: number;
  /** The address of every account whose stream did not answer. */
  readonly unreachable: readonly string[];
  /** Every connected address, as of the last answer the accounts call gave.
   *  Kept so that a tab which cannot reach the mail service at all still knows
   *  WHOSE mailbox it cannot reach, and can say so by name. */
  readonly accounts: readonly string[];
}

type MailBlockState =
  /** The accounts are not known yet, so neither is whether this block exists. */
  | { readonly kind: "unknown" }
  /** No account is connected: an absent control takes its chrome with it. */
  | { readonly kind: "absent" }
  /** There is at least one account and its streams are still in flight. */
  | { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly data: MailBlockData };

export interface HubMailProps {
  onOpenMail: () => void;
  client?: Pick<MailSurfaceClient, "loadAccounts" | "listThreads">;
}

export function HubMail({
  onOpenMail,
  client = defaultMailSurfaceClient,
}: HubMailProps) {
  const reduce = useReducedMotion() ?? false;
  const [state, setState] = useState<MailBlockState>({ kind: "unknown" });
  const alive = useRef(true);

  const revalidate = useCallback(async () => {
    // The last answer this tab had, so walking back to Home draws the block
    // it drew a moment ago instead of a skeleton. Read here and not in the
    // effect body: the server has no session storage, so the first render has
    // to match the HTML it was handed, and this runs after that.
    const cached = readSnapshot();
    if (cached) {
      setState((current) =>
        current.kind === "unknown" ? { kind: "ready", data: cached } : current,
      );
    }

    let accounts: readonly PublicMailAccount[];
    try {
      accounts = await client.loadAccounts();
    } catch {
      // THE MAIL SERVICE IS DOWN, which is not the same as having no mail.
      // The accounts call is the one that decides whether this block exists,
      // so unanswered it cannot decide it: claiming "no account" would delete
      // a connected mailbox from the screen and claiming one would draw chrome
      // for a control that may not be there.
      //
      // But a tab that has ever had an answer knows which addresses are
      // connected, from this session's snapshot or from the answer it is
      // already drawing. Those get the spec's row, by name, beside whatever
      // was last true: rows that may be hours stale with nothing saying so are
      // the worse of the two failures.
      //
      // With no answer ever, there is no mailbox to name and the block stays
      // away, which is the same thing it does when there is no account.
      if (!alive.current) return;
      setState((current) => {
        const known = current.kind === "ready" ? current.data : cached;
        if (!known || known.accounts.length === 0) return current;
        return { kind: "ready", data: { ...known, unreachable: known.accounts } };
      });
      return;
    }
    if (!alive.current) return;
    if (accounts.length === 0) {
      forgetSnapshot();
      setState({ kind: "absent" });
      return;
    }
    setState((current) => (current.kind === "ready" ? current : { kind: "pending" }));

    // Every stream on its own. One account timing out is one row, not a
    // block that never arrives.
    const pages = await Promise.allSettled(
      accounts.map((account) =>
        client.listThreads({
          accountId: account.accountId,
          view: "unread",
          limit: UNIFIED_PAGE_SIZE,
        }),
      ),
    );
    if (!alive.current) return;

    const items: MailThreadListItem[] = [];
    const unreachable: string[] = [];
    for (const [at, result] of pages.entries()) {
      const account = accounts[at];
      if (account === undefined) continue;
      if (result.status === "fulfilled") items.push(...result.value.items);
      else unreachable.push(account.emailAddress);
    }

    const merged = [...items].sort(compareUnified);
    const sections = deriveUnifiedSections(merged, accounts);
    // The People groups are per account, in the accounts' own order. Home
    // shows the freshest three across all of them, so the merge's order wins
    // over the grouping's.
    const people = sections.people.groups
      .flatMap((group) => group.items)
      .sort(compareUnified)
      .slice(0, PEOPLE_ROWS)
      .map(rowViewOf);

    const data: MailBlockData = {
      people,
      notifications: sections.notifications.items.length,
      newsletters: sections.newsletters.items.length,
      unreachable,
      accounts: accounts.map((account) => account.emailAddress),
    };
    rememberSnapshot(data);
    setState({ kind: "ready", data });
  }, [client]);

  useEffect(() => {
    alive.current = true;
    // Off the commit, the way the visit marker at the head of Home reads its
    // own storage: the first paint belongs to the tree and the tasks, which
    // are already in this tab, and mail asks its questions after it.
    const frame = window.requestAnimationFrame(() => void revalidate());
    const onVisible = () => {
      if (document.visibilityState === "visible") void revalidate();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      alive.current = false;
      window.cancelAnimationFrame(frame);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [revalidate]);

  if (state.kind === "unknown" || state.kind === "absent") return null;

  const enter = (index: number) => ({
    initial: reduce ? { opacity: 0 } : { opacity: 0, y: 6 },
    animate: reduce ? { opacity: 1 } : { opacity: 1, y: 0 },
    transition: reduce
      ? { duration: DUR.base }
      : { duration: DUR.base, ease: EASE_OUT, delay: 0.03 * index },
  });

  return (
    <section className="mt-8" data-hub-mail>
      <button
        type="button"
        data-hub-mail-open
        onClick={onOpenMail}
        className="text-h3 -mx-2 mb-1.5 rounded-sm px-2 py-0.5 text-left text-ink transition-colors hover:bg-fill-hover"
      >
        Mail
      </button>

      {state.kind === "pending" ? (
        <div data-hub-mail-pending aria-hidden className="space-y-1.5 py-1">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-6 w-full rounded-[var(--r-block)]" />
          ))}
        </div>
      ) : (
        <MailBlockBody
          data={state.data}
          enter={enter}
          onOpenMail={onOpenMail}
        />
      )}
    </section>
  );
}

function MailBlockBody({
  data,
  enter,
  onOpenMail,
}: {
  data: MailBlockData;
  enter: (index: number) => Record<string, unknown>;
  onOpenMail: () => void;
}) {
  const digest = digestLabel(data.notifications, data.newsletters);
  const quiet =
    data.people.length === 0 && digest === null && data.unreachable.length === 0;
  let index = 0;

  return (
    <>
      {data.people.map((row) => (
        <motion.div key={`${row.accountId}:${row.threadId}`} {...enter(index++)}>
          <HubRow
            data-hub-mail-row
            data-hub-mail-person={row.threadId}
            glyph={
              <MailSenderIcon
                participants={[{ name: row.sender, address: senderAddressOf(row) }]}
                size={16}
              />
            }
            trailing={row.at === null ? undefined : formatAgo(new Date(row.at).toISOString(), { compact: true })}
            onClick={onOpenMail}
          >
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink">
              {row.sender}
              {row.subject !== "" && <span className="text-ink-3"> {row.subject}</span>}
            </span>
          </HubRow>
        </motion.div>
      ))}

      {data.unreachable.map((address) => (
        <motion.div key={address} {...enter(index++)}>
          <HubRow
            data-hub-mail-row
            data-hub-mail-unreachable
            glyph={<Icon name="cloud-cross" size={16} className="text-ink-3" />}
            onClick={onOpenMail}
          >
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink-2">
              {`Couldn't reach ${address}`}
            </span>
          </HubRow>
        </motion.div>
      ))}

      {digest !== null && (
        <motion.div {...enter(index++)}>
          {/* The pile, on the bundle idiom the unified column uses: one row
              that says how big it is and opens the place it lives. */}
          <HubRow
            data-hub-mail-row
            data-hub-mail-digest
            glyph={<Icon name="letter" size={16} className="text-ink-3" />}
            trailing="→ Mail"
            onClick={onOpenMail}
          >
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink-2">
              {digest}
            </span>
          </HubRow>
        </motion.div>
      )}

      {quiet && (
        <motion.div {...enter(0)} className="px-2 py-5">
          <Empty icon="letter-linear" title="Inbox is quiet" />
        </motion.div>
      )}
    </>
  );
}

/** `12 notifications, 40 newsletters`, and only the halves that have anything
 *  in them. Null when the pile is empty, which is what takes the row away. */
export function digestLabel(
  notifications: number,
  newsletters: number,
): string | null {
  const parts = [
    countLabel(notifications, "notification"),
    countLabel(newsletters, "newsletter"),
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(", ");
}

/** A count at the page size is a count the derivation could not finish, so it
 *  says so rather than printing a number it cannot stand behind. */
function countLabel(count: number, noun: string): string | null {
  if (count === 0) return null;
  if (count >= UNIFIED_PAGE_SIZE) return `${UNIFIED_PAGE_SIZE}+ ${noun}s`;
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

function rowViewOf(item: MailThreadListItem): MailRowView {
  return {
    accountId: item.accountId,
    threadId: item.threadId,
    sender: formatParticipants(item.participants),
    subject: stripSubjectSenderPrefix(item.subject, item.participants),
    at: item.lastMessageAt,
  };
}

/** The monogram needs an address to look a domain up by, and the snapshot
 *  keeps none: a favicon is worth one request, not somebody's address book in
 *  session storage. Without one the icon draws the sender's initial, which is
 *  what it falls back to for every address it cannot resolve anyway. */
function senderAddressOf(row: MailRowView): string {
  return row.sender;
}

function readSnapshot(): MailBlockData | null {
  try {
    const raw = sessionStorage.getItem(SNAPSHOT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<MailBlockData>;
    if (
      !Array.isArray(value.people) ||
      typeof value.notifications !== "number" ||
      typeof value.newsletters !== "number" ||
      !Array.isArray(value.unreachable) ||
      !Array.isArray(value.accounts)
    ) {
      return null;
    }
    return {
      people: value.people,
      notifications: value.notifications,
      newsletters: value.newsletters,
      unreachable: value.unreachable,
      accounts: value.accounts,
    };
  } catch {
    return null;
  }
}

function rememberSnapshot(data: MailBlockData): void {
  try {
    sessionStorage.setItem(SNAPSHOT_KEY, JSON.stringify(data));
  } catch {
    // A browser with storage off revalidates on every mount, which is the
    // behaviour without a snapshot and not a failure.
  }
}

function forgetSnapshot(): void {
  try {
    sessionStorage.removeItem(SNAPSHOT_KEY);
  } catch {}
}
