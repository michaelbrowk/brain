"use client";

import { Icon } from "./ui/icon";
import { Skeleton } from "./ui/primitives";
import type { MailAddress, MailThreadListItem } from "@/lib/mail/message-types";
import { sanitizeSnippet } from "@/lib/mail/reader-content";

/**
 * The mail row — one object for both lists (DESIGN.md §13: a mode may drop a
 * control, never restyle one). The unified inbox passes an avatar and the
 * source account; the single-account list passes neither, because it knows
 * which account it is looking at and an absent field takes its column with
 * it. Everything else — the rails, the registers, the truncation, the two
 * lines — is identical in both.
 *
 * The row-specific rules under it (the bracketed-prefix strip, the sender
 * words) are rules of the system applied at render, not per-provider patches,
 * so they live here beside the markup they serve and are unit-tested on their
 * own.
 */

/** The sender's own words: display name, and the domain it wrote from. */
function senderTokens(participants: readonly MailAddress[]): readonly string[] {
  const first = participants[0];
  if (!first) return [];
  const tokens: string[] = [];
  const name = first.name?.trim();
  if (name) tokens.push(name);
  const address = first.address ?? "";
  const at = address.lastIndexOf("@");
  if (at >= 0) {
    const domain = address.slice(at + 1);
    tokens.push(domain);
    // "github.example" → "github": the label a list mailer puts in brackets.
    const label = domain.split(".")[0];
    if (label) tokens.push(label);
  }
  return tokens.map((token) => token.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""));
}

/**
 * A bracketed prefix that only repeats the sender is dropped: `[GitHub] The
 * "Daily refresh" workflow` → `The "Daily refresh" workflow`. The sender is
 * already on the line above the subject, and the prefix was eating a third of
 * it. A rule, not a per-provider patch — and it fires only when the bracket
 * really is the sender, so `[Urgent]` and `[RFC 9110]` survive.
 */
export function stripSubjectSenderPrefix(
  subject: string | null | undefined,
  participants: readonly MailAddress[],
): string {
  const value = (subject ?? "").trim();
  const match = /^\[([^\]]{1,40})\]\s*(.+)$/u.exec(value);
  if (!match) return value;
  const inside = match[1]!.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  if (inside === "") return value;
  const tokens = senderTokens(participants);
  const repeats = tokens.some(
    (token) => token !== "" && (token === inside || token.includes(inside)),
  );
  return repeats ? match[2]!.trim() : value;
}

/**
 * The tokens one address can offer as its word, shortest first, with the
 * local part winning a tie because that is the word people say out loud.
 * The full address closes the list: two connected accounts cannot share one,
 * so a word always exists.
 */
function accountTokens(emailAddress: string): readonly string[] {
  const value = emailAddress.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  const local = at > 0 ? value.slice(0, at) : value;
  const label = at > 0 ? (value.slice(at + 1).split(".")[0] ?? "") : "";
  const tokens = label === "" || label === local ? [local] : [local, label];
  tokens.sort((a, b) => a.length - b.length || (a === local ? -1 : 1));
  return [...new Set([...tokens, value])];
}

/**
 * The source account as one word — computed for the whole connected set at
 * once, because a word only does its job if no other account answers to it.
 * Two connected accounts can share a local part, and where they do the local
 * part stops being a word. The merged column is the one place the reader
 * cannot otherwise tell which mailbox a letter landed in, so every account
 * needs one.
 *
 * The rule, one step at a time: each account takes the SHORTEST token no
 * other still-unnamed account is offering at that step and no account has
 * already taken — its local part, else the domain's first label, else the
 * address in full. So a collision costs only the accounts that collide: with
 * `ada@post.example`, `ada@atelier.example` and `t.nagy@desk.example`
 * connected, the first two fall to "post" and "atelier" while the third keeps
 * "desk". Data the reader cannot mis-set, unlike a display name, and the same
 * answer whatever order the accounts arrive in.
 */
export function accountWords(
  emailAddresses: readonly string[],
): ReadonlyMap<string, string> {
  const options = emailAddresses.map(
    (address) => [address, accountTokens(address)] as const,
  );
  const named = new Map<string, string>();
  const taken = new Set<string>();
  const steps = Math.max(0, ...options.map(([, tokens]) => tokens.length));
  for (let step = 0; step < steps; step += 1) {
    const pending = options.filter(([address]) => !named.has(address));
    const offers = new Map<string, number>();
    for (const [, tokens] of pending) {
      const token = tokens[step];
      if (token !== undefined) offers.set(token, (offers.get(token) ?? 0) + 1);
    }
    for (const [address, tokens] of pending) {
      const token = tokens[step];
      if (token === undefined) continue;
      if (offers.get(token) !== 1 || taken.has(token)) continue;
      named.set(address, token);
      taken.add(token);
    }
  }
  // Rebuilt in the order the accounts arrived: the resolution runs shortest
  // token first, which is not the caller's order.
  return new Map(
    options.map(([address]) => [
      address,
      named.get(address) ?? address.toLowerCase(),
    ]),
  );
}

export function MailRow({
  thread,
  active,
  avatar,
  account,
  sizeLabel,
  timeLabel,
  onSelect,
}: {
  thread: MailThreadListItem;
  active: boolean;
  /** The 32 sender avatar — unified only; the single-account list has none. */
  avatar?: React.ReactNode;
  /** The source account word — unified only, for the same reason. */
  account?: string;
  /** Replaces the time while the single-account list is sorted by size. */
  sizeLabel?: string;
  timeLabel: string;
  onSelect: () => void;
}) {
  const subject = stripSubjectSenderPrefix(thread.subject, thread.participants);
  const snippet = sanitizeSnippet(thread.snippet);
  const sender = formatParticipants(thread.participants);
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onSelect}
      className={`brain-mail-row group${avatar ? "" : " brain-mail-row_bare"}`}
    >
      {/* The rail. Unread is a column of its own left of the avatar, so every
          dot in the list lines up and the volume of unread mail is legible
          without reading. Ink, never colour alone — the text weight and ink
          level carry it too. */}
      <span className="brain-mail-rail" aria-hidden>
        {thread.unread && <span className="brain-mail-dot" />}
      </span>
      {thread.unread && <span className="sr-only">Unread. </span>}
      {avatar !== undefined && <span className="brain-mail-av">{avatar}</span>}
      <span className="brain-mail-body flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5 leading-[18px]">
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span
              className={`min-w-0 truncate text-[13px] ${
                thread.unread ? "font-semibold text-ink" : "text-ink-2"
              }`}
            >
              {sender}
            </span>
            {thread.messageCount > 1 && (
              <span className="brain-mail-count self-center">
                {thread.messageCount}
              </span>
            )}
          </span>
          {thread.starred && (
            <Icon name="star-linear" size={12} className="shrink-0 self-center text-ink-3" />
          )}
          {account !== undefined && (
            <span className="text-caption max-w-[9ch] shrink-0 truncate text-ink-3">
              {account}
            </span>
          )}
          {sizeLabel === undefined ? (
            <time
              dateTime={
                thread.lastMessageAt === null
                  ? undefined
                  : new Date(thread.lastMessageAt).toISOString()
              }
              className="text-caption shrink-0 tabular-nums text-ink-3"
            >
              {timeLabel}
            </time>
          ) : (
            <span className="text-caption shrink-0 tabular-nums text-ink-3">
              {sizeLabel}
            </span>
          )}
        </span>
        {/* The snippet continues the subject on the same line after a `·`.
            `dir="auto"` on both: an Arabic subject flips the line and takes
            its ellipsis to the left, while the sender, the account and the
            time above stay where they are. */}
        <span className="flex min-w-0 items-baseline gap-1.5 leading-[18px]">
          <span dir="auto" className="min-w-0 flex-1 truncate text-[13px]">
            <span className={thread.unread ? "font-medium text-ink" : "text-ink-2"}>
              {subject || "(no subject)"}
            </span>
            {snippet !== "" && (
              <span dir="auto" className="text-ink-3">
                {" · "}
                {snippet}
              </span>
            )}
          </span>
          {thread.hasAttachments && (
            <>
              <Icon
                name="paperclip-linear"
                size={13}
                className="shrink-0 self-center text-ink-3"
              />
              <span className="sr-only">Has attachment</span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}

/**
 * The loading row — the same rails and the same two lines, so a list that is
 * still arriving has the shape of the list that arrives. Used at the top of a
 * cold list and at the bottom of the merge window while `hasMore` loads.
 */
export function MailRowSkeleton({ avatar = false }: { avatar?: boolean }) {
  return (
    <div
      aria-hidden
      className={`brain-mail-row${avatar ? "" : " brain-mail-row_bare"}`}
    >
      <span className="brain-mail-rail" />
      {avatar && (
        <span className="brain-mail-av">
          <Skeleton className="size-8 rounded-full" />
        </span>
      )}
      <span className="brain-mail-body flex min-w-0 flex-1 flex-col gap-2.5 pt-1">
        <Skeleton className="h-2.5 w-28" />
        <Skeleton className="h-2.5 w-3/4" />
      </span>
    </div>
  );
}

export function formatParticipants(
  participants: readonly MailAddress[],
): string {
  if (participants.length === 0) return "Unknown sender";
  return participants
    .slice(0, 3)
    .map((person) => person.name?.trim() || person.address)
    .join(", ");
}
