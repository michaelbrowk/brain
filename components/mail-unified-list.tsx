"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { DUR, EASE_OUT } from "@/lib/motion";
import { Button, IconButton } from "./ui/button";
import { Empty } from "./ui/empty";
import { Icon } from "./ui/icon";
import { ScrollEdge } from "./ui/scroll-edge";
import { ToolbarPill } from "./ui/toolbar-pill";
import { MailSenderIcon } from "./mail-sender-icon";
import {
  MailRow,
  MailRowSkeleton,
  accountWords as resolveAccountWords,
  formatParticipants,
  stripSubjectSenderPrefix,
} from "./mail-row";
import { formatThreadTime } from "./mail-thread-list";
import {
  UNIFIED_SECTION_PREVIEW,
  unifiedBundleSummary,
  unifiedSectionForm,
  visiblePeopleGroups,
  visibleSectionItems,
  visibleUnifiedItems,
  type MailUnifiedSections,
  type UnifiedBundleSummary,
  type UnifiedExpandKey,
  type UnifiedExpandState,
  type UnifiedState,
  type UnifiedStream,
} from "./mail-unified";
import type {
  MailThreadListItem,
  PublicMailAccount,
} from "./mail-surface-client";

/**
 * The unified inbox list pane: Spark-like sections over the merged streams.
 * Renders instead of MailThreadList while All inboxes is selected — no
 * folder select, no smart views, no sort, no search; those are single-account
 * surfaces in v1.
 */
export function MailUnifiedList({
  accounts,
  nav,
  state,
  sections,
  hasMore,
  expand,
  selectedThreadKey,
  exitFades,
  onToggleExpand,
  onSelectThread,
  onCompose,
  onLoadMore,
  onRetryStream,
  onSectionDone,
  onOpenSettings,
}: {
  accounts: readonly PublicMailAccount[];
  /** The one control that owns account and folder navigation, built by the
   *  surface and the same object on every mail column (`MailNav`). */
  nav: React.ReactNode;
  state: UnifiedState;
  sections: MailUnifiedSections | null;
  hasMore: boolean;
  expand: UnifiedExpandState;
  selectedThreadKey: string | null;
  /**
   * True while an explicit mutation is in flight (the section Done loop and
   * its undo, archive/trash/spam). Only then do unmounting rows play the exit
   * fade — every other re-partition (sticky release, silent refresh) removes
   * and moves rows as a plain re-render.
   */
  exitFades: boolean;
  onToggleExpand: (key: UnifiedExpandKey) => void;
  onSelectThread: (thread: MailThreadListItem) => void;
  onCompose?: () => void;
  onLoadMore: () => void;
  onRetryStream: (accountId: string) => void;
  /** Done: archive every thread in one section, naming it for the report. */
  onSectionDone: (items: readonly MailThreadListItem[], label: string) => void;
  onOpenSettings: (invoker: HTMLElement, accountId?: string) => void;
}) {
  const reduce = useReducedMotion();
  // The entrance fade/stagger belongs to the container context — entering All
  // inboxes mounts this component fresh and the first render that shows
  // sections plays it. Every later row mount (re-partition, section move,
  // expansion, new mail) renders settled with `initial={false}`. The flag
  // flips in a microtask right after that first render commits (never a sync
  // setState inside the effect); rows that animated their mount ignore later
  // `initial` values, so the flip only affects rows mounted afterwards.
  const [entranceDone, setEntranceDone] = useState(false);
  const entranceSeenRef = useRef(false);
  useEffect(() => {
    if (entranceSeenRef.current || sections === null) return;
    entranceSeenRef.current = true;
    queueMicrotask(() => setEntranceDone(true));
  });
  const entrance = !entranceDone;
  const streams = state.kind === "ready" ? state.streams : [];
  const failedStreams = streams.filter(
    (stream) => stream.status === "error" || stream.status === "reauth",
  );
  const allStreamsReady =
    state.kind === "ready" &&
    streams.length > 0 &&
    streams.every((stream) => stream.status === "ready");
  const empty =
    sections !== null &&
    sections.people.total === 0 &&
    sections.notifications.items.length === 0 &&
    sections.newsletters.items.length === 0 &&
    sections.seen.items.length === 0;

  // Sub-headers only when more than one account contributes People rows.
  const showPeopleSubheaders =
    sections !== null && sections.people.groups.length > 1;
  // Compose is the only control unified can put in the toolbar beside the nav
  // pill; the head itself is always there, so the pad and the edge no longer
  // hang off it.
  const composePill = onCompose !== undefined;

  /* Which accounts Done can act on. An account whose service withholds
     thread mutations puts rows in a section that Done will never move, so the
     header counts what it will move and draws nothing at all when that is
     zero. A control that promises fourteen and moves eleven is the failure
     this count exists to prevent. */
  const archivable = new Set(
    accounts
      .filter((account) => account.capabilities.threadMutations)
      .map((account) => account.accountId),
  );
  const doneCount = (items: readonly MailThreadListItem[]) =>
    items.reduce(
      (total, item) => (archivable.has(item.accountId) ? total + 1 : total),
      0,
    );

  // The stagger index runs across every visible row in every section, so the
  // first 8 rows overall get the 25ms cascade — same convention as the
  // single-account list. Precomputed from the same derivation the keyboard
  // layer walks, so visual order and index can never drift.
  const rowIndexByKey = new Map<string, number>(
    sections === null
      ? []
      : visibleUnifiedItems(sections, expand).map((item, index) => [
          `${item.accountId}:${item.threadId}`,
          index,
        ]),
  );

  // The source account as a word on every row — the merged column is the one
  // place a reader cannot tell where a letter landed without being told, so
  // the word has to be unique across the connected set or the field says
  // nothing. Resolved for all of them at once (two accounts can share a local
  // part), then keyed by account id for the rows.
  const wordByAddress = resolveAccountWords(
    accounts.map((account) => account.emailAddress),
  );
  const accountWords = new Map(
    accounts.map((account) => [
      account.accountId,
      wordByAddress.get(account.emailAddress) ?? account.emailAddress,
    ]),
  );

  // The merge window loads on scroll: skeleton rows stand at the bottom for
  // what is still coming, and reaching them is the request. Re-arms only when
  // the loaded count actually moved, so a sentinel that stays on screen after
  // a page lands cannot spin the fetch.
  const loadedCount =
    sections === null
      ? 0
      : sections.people.total +
        sections.notifications.items.length +
        sections.newsletters.items.length +
        sections.seen.items.length;
  const moreRef = useRef<HTMLDivElement | null>(null);
  const requestedAtRef = useRef(-1);
  useEffect(() => {
    const node = moreRef.current;
    if (!node || !hasMore || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (requestedAtRef.current === loadedCount) return;
        requestedAtRef.current = loadedCount;
        onLoadMore();
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, loadedCount, onLoadMore]);

  return (
    <section
      aria-label="Mailbox"
      className="brain-mail-list"
      data-chrome-rows="1"
    >
      {/* ONE ROW, AND NO SEARCH CAPSULE. Unified reads no cross-account index
          — search is one account's cached headers — so the second row is not
          drawn, and the head is 36 tall rather than 80. There is no folder row
          either and never was: unified has exactly one folder by construction,
          so the nav pill names it once ("All inboxes") and nothing else here
          can be pressed to change it.

          Compose rides the toolbar pill in BOTH modes now. It used to move to
          the account row's free right edge here and back to the toolbar in the
          single-account list, which meant switching accounts on a phone moved
          the button between rows. The nav pill leaves the toolbar row a right
          edge of its own in every mode, so nothing moves. */}
      <header className="brain-mail-head">
        <div className="brain-mail-navrow">
          {nav}
          {composePill && (
            <ToolbarPill className="ml-auto shrink-0">
              <IconButton
                type="button"
                size={36}
                aria-label="New message"
                title="New message"
                className="brain-touch-hit"
                onClick={onCompose}
              >
                <Icon name="pen-new-square-linear" size={18} />
              </IconButton>
            </ToolbarPill>
          )}
        </div>
      </header>

      <div className="brain-mail-scroll">
        {/* the head floats over the rows in every mode now, so the edge is
            unconditional and its height follows --mail-chrome in CSS (§7) */}
        <ScrollEdge variant="blur" steps={1} />
        <div className="brain-mail-scrollfoot brain-mail-scrollpad">
        {failedStreams.length > 0 && (
          <div className="brain-mail-section">
            {failedStreams.map((stream) => (
              <StreamNotice
                key={stream.accountId}
                stream={stream}
                onRetry={() => onRetryStream(stream.accountId)}
                onOpenSettings={onOpenSettings}
              />
            ))}
          </div>
        )}
        {state.kind !== "ready" || sections === null ? (
          <UnifiedListSkeleton />
        ) : empty ? (
          allStreamsReady ? (
            <div className="px-5 py-14">
              <Empty
                icon="letter-linear"
                title="Inbox zero"
                hint="Nothing unread across your accounts"
              />
            </div>
          ) : failedStreams.length > 0 ? (
            <div className="px-5 py-14">
              <Empty
                icon="letter-linear"
                title="Nothing to show yet"
                hint="Some accounts couldn’t load — retry above"
              />
            </div>
          ) : (
            <UnifiedListSkeleton />
          )
        ) : (
          <div role="list" aria-label="All inboxes threads">
            {sections.people.total > 0 && (
              <section aria-label="People" className="brain-mail-section">
                <SectionHeader
                  icon="user-rounded-linear"
                  label="People"
                  count={sections.people.total}
                  expanded={expand.people}
                  onToggle={
                    sections.people.total > UNIFIED_SECTION_PREVIEW
                      ? () => onToggleExpand("people")
                      : undefined
                  }
                  doneCount={doneCount(
                    sections.people.groups.flatMap((group) => group.items),
                  )}
                  onDone={() =>
                    onSectionDone(
                      sections.people.groups.flatMap((group) => group.items),
                      "People",
                    )
                  }
                />
                <SectionRows
                  form={
                    unifiedSectionForm(sections.people.total, expand.people) ===
                    "bundle"
                      ? "bundle"
                      : "rows"
                  }
                >
                  {unifiedSectionForm(sections.people.total, expand.people) ===
                  "bundle" ? (
                    <BundleRow
                      summary={unifiedBundleSummary(
                        sections.people.groups.flatMap((group) => group.items),
                      )}
                    />
                  ) : (
                    <AnimatePresence mode="popLayout">
                      {visiblePeopleGroups(
                        sections.people,
                        expand.people,
                      ).flatMap((group) => [
                        ...(showPeopleSubheaders
                          ? [
                              <motion.div
                                key={`subheader:${group.accountId}`}
                                exit={
                                  exitFades
                                    ? {
                                        opacity: 0,
                                        transition: { duration: 0.08 },
                                      }
                                    : undefined
                                }
                                className="brain-mail-subhead text-label truncate text-ink-3"
                              >
                                {group.emailAddress}
                              </motion.div>,
                            ]
                          : []),
                        ...group.items.map((thread) => (
                          <UnifiedRow
                            key={`${thread.accountId}:${thread.threadId}`}
                            thread={thread}
                            account={accountWords.get(thread.accountId)}
                            index={
                              rowIndexByKey.get(
                                `${thread.accountId}:${thread.threadId}`,
                              ) ?? 8
                            }
                            reduce={reduce}
                            entrance={entrance}
                            exitFades={exitFades}
                            active={
                              `${thread.accountId}:${thread.threadId}` ===
                              selectedThreadKey
                            }
                            onSelect={() => onSelectThread(thread)}
                          />
                        )),
                      ])}
                    </AnimatePresence>
                  )}
                </SectionRows>
              </section>
            )}
            {sections.notifications.items.length > 0 && (
              <PlainSection
                sectionKey="notifications"
                icon="bell-linear"
                label="Notifications"
                items={sections.notifications.items}
                expanded={expand.notifications}
                reduce={reduce}
                entrance={entrance}
                exitFades={exitFades}
                selectedThreadKey={selectedThreadKey}
                rowIndexByKey={rowIndexByKey}
                accountWords={accountWords}
                onToggleExpand={onToggleExpand}
                onSelectThread={onSelectThread}
                onSectionDone={onSectionDone}
                doneCount={doneCount}
              />
            )}
            {sections.newsletters.items.length > 0 && (
              <PlainSection
                sectionKey="newsletters"
                icon="mailbox-linear"
                label="Newsletters"
                items={sections.newsletters.items}
                expanded={expand.newsletters}
                reduce={reduce}
                entrance={entrance}
                exitFades={exitFades}
                selectedThreadKey={selectedThreadKey}
                rowIndexByKey={rowIndexByKey}
                accountWords={accountWords}
                onToggleExpand={onToggleExpand}
                onSelectThread={onSelectThread}
                onSectionDone={onSectionDone}
                doneCount={doneCount}
              />
            )}
            {sections.seen.items.length > 0 && (
              <section aria-label="Seen" className="brain-mail-section">
                {/* Seen hides all of itself when collapsed, so it is
                    expandable at any count and its digest is a count: read
                    mail owes the reader a number, not a preview. */}
                <SectionHeader
                  icon="eye-linear"
                  label="Seen"
                  count={sections.seen.items.length}
                  expanded={expand.seen}
                  onToggle={() => onToggleExpand("seen")}
                  doneCount={doneCount(sections.seen.items)}
                  onDone={() => onSectionDone(sections.seen.items, "Seen")}
                />
                <SectionRows form={expand.seen ? "rows" : "bundle"}>
                  {expand.seen ? (
                    <AnimatePresence mode="popLayout">
                      {sections.seen.items.map((thread) => (
                        <UnifiedRow
                          key={`${thread.accountId}:${thread.threadId}`}
                          thread={thread}
                          account={accountWords.get(thread.accountId)}
                          index={
                            rowIndexByKey.get(
                              `${thread.accountId}:${thread.threadId}`,
                            ) ?? 8
                          }
                          reduce={reduce}
                          entrance={entrance}
                          exitFades={exitFades}
                          active={
                            `${thread.accountId}:${thread.threadId}` ===
                            selectedThreadKey
                          }
                          onSelect={() => onSelectThread(thread)}
                        />
                      ))}
                    </AnimatePresence>
                  ) : (
                    <p
                      role="listitem"
                      className="text-control brain-mail-bundle brain-mail-bundle_flat font-normal"
                    >
                      {sections.seen.items.length === 1
                        ? "1 thread, nothing unread"
                        : `${sections.seen.items.length} threads, nothing unread`}
                    </p>
                  )}
                </SectionRows>
              </section>
            )}
          </div>
        )}
        {/* The bottom of the merge window. Skeletons rather than a button:
            the column continues, and reaching them is what asks for the next
            page (§7's bottom edge is gated the same way — a list that ends
            shows nothing). Scrolling is a pointer gesture, so the same
            request keeps a control for everyone who is not making one: the
            button is there for the keyboard and for assistive technology,
            and shows itself the moment it takes focus. */}
        {state.kind === "ready" && sections !== null && hasMore && (
          <div
            ref={moreRef}
            aria-busy="true"
            aria-label="Loading more mail"
            className="brain-mail-section brain-mail-more"
          >
            {/* A loading state has the shape of the loaded state: a group
                bounded by the same rule, its rows taking the wrapper that
                stops the last one drawing a separator the boundary repeats. */}
            <div className="brain-mail-row-item">
              <MailRowSkeleton avatar />
            </div>
            <div className="brain-mail-row-item">
              <MailRowSkeleton avatar />
            </div>
            <Button
              variant="quiet"
              className="sr-only focus:not-sr-only focus:mx-auto focus:mt-2 focus:block"
              onClick={onLoadMore}
            >
              Load more
            </Button>
          </div>
        )}
        </div>
        {/* Below md the column runs under the mobile tab bar (§7: "a list
            bottom under … the mobile tab bar"). The scroller reserves the
            bar's height so the last group can close above it; this softens the
            rows still passing beneath, and only while there are any. */}
        <ScrollEdge
          variant="blur"
          position="bottom"
          steps={1}
          size={90}
          className="md:hidden"
        />
      </div>
    </section>
  );
}

function PlainSection({
  sectionKey,
  icon,
  label,
  items,
  expanded,
  reduce,
  entrance,
  exitFades,
  selectedThreadKey,
  rowIndexByKey,
  accountWords,
  onToggleExpand,
  onSelectThread,
  onSectionDone,
  doneCount,
}: {
  sectionKey: Exclude<UnifiedExpandKey, "seen">;
  icon: string;
  label: string;
  items: readonly MailThreadListItem[];
  expanded: boolean;
  reduce: boolean | null;
  entrance: boolean;
  exitFades: boolean;
  selectedThreadKey: string | null;
  rowIndexByKey: ReadonlyMap<string, number>;
  accountWords: ReadonlyMap<string, string>;
  onToggleExpand: (key: UnifiedExpandKey) => void;
  onSelectThread: (thread: MailThreadListItem) => void;
  onSectionDone: (items: readonly MailThreadListItem[], label: string) => void;
  /** How many of `items` Done can actually archive — see `archivable`. */
  doneCount: (items: readonly MailThreadListItem[]) => number;
}) {
  const bundled = unifiedSectionForm(items.length, expanded) === "bundle";
  const visible = visibleSectionItems(items, expanded);
  return (
    <section aria-label={label} className="brain-mail-section">
      <SectionHeader
        icon={icon}
        label={label}
        count={items.length}
        expanded={expanded}
        onToggle={
          items.length > UNIFIED_SECTION_PREVIEW
            ? () => onToggleExpand(sectionKey)
            : undefined
        }
        doneCount={doneCount(items)}
        onDone={() => onSectionDone(items, label)}
      />
      <SectionRows form={bundled ? "bundle" : "rows"}>
        {bundled ? (
          <BundleRow summary={unifiedBundleSummary(items)} />
        ) : (
          <AnimatePresence mode="popLayout">
            {visible.map((thread) => (
              <UnifiedRow
                key={`${thread.accountId}:${thread.threadId}`}
                thread={thread}
                account={accountWords.get(thread.accountId)}
                index={
                  rowIndexByKey.get(`${thread.accountId}:${thread.threadId}`) ??
                  8
                }
                reduce={reduce}
                entrance={entrance}
                exitFades={exitFades}
                active={
                  `${thread.accountId}:${thread.threadId}` === selectedThreadKey
                }
                onSelect={() => onSelectThread(thread)}
              />
            ))}
          </AnimatePresence>
        )}
      </SectionRows>
    </section>
  );
}

/**
 * The group's rows, and the crossfade between the two things they can be.
 *
 * Preview and bundle are two states of one section, and the section can cross
 * the line without the reader touching anything — a background refresh takes
 * Newsletters from 6 to 7 and the form changes under the eye. So the swap
 * runs through presence rather than as a cut: the outgoing form leaves the
 * flow and fades over `DUR.exit`, the incoming one fades in over `DUR.fast`,
 * and the height lands in one step.
 *
 * It used to animate that height, on `layout="size"` with the ring carrying
 * it. The ring was the reason: a hairline contour that jumped 104px is a
 * contour a reader watches jump. Nothing is drawn on this box any more, so
 * the animation had a box and no edge — and it was never free. `layout`
 * animates height as a scaleY, a scale is inherited, and the crossfade layer
 * needed a `layout` of its own carrying the exact inverse or the rows painted
 * squashed. Worse, it only ever smoothed itself: the DOM height changes at
 * once, so every group below snapped to the new position immediately while
 * this box's ghost went on shrinking over them for 300ms. Dropping it costs
 * the glide of an edge that no longer exists and buys back the one thing the
 * reader could actually see going wrong. The column now moves in one piece.
 *
 * `mode="popLayout"` stays: it takes the outgoing form out of flow so the
 * incoming one has the space at once, which is why `.brain-mail-rows` clips.
 * What is left is an opacity crossfade of 120ms, which is inside what §6
 * allows under reduced motion, so there is no second path for it either.
 * `role="presentation"` here and on the crossfade layer — the rows inside are
 * `role="listitem"` and their list is two levels up, so neither wrapper may
 * stand between them in the accessibility tree.
 */
function SectionRows({
  form,
  children,
}: {
  form: "bundle" | "rows";
  children: React.ReactNode;
}) {
  return (
    <div role="presentation" className="brain-mail-rows">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.div
          key={form}
          role="presentation"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: DUR.exit } }}
          transition={{ duration: DUR.fast, ease: EASE_OUT }}
        >
          {children}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/**
 * The bundled section's one row: who is in the pile, how big it is, and the
 * newest thing in it. Sixty-four newsletters occupy sixty-four pixels. It is
 * not a control — the chevron in the header above it is, and a second button
 * doing the same job would be a new object where the brief asks for a new
 * state of an old one.
 */
function BundleRow({ summary }: { summary: UnifiedBundleSummary }) {
  const newest = summary.newest;
  return (
    <div role="listitem" className="brain-mail-bundle">
      <span className="brain-mail-rail" aria-hidden>
        {summary.unread > 0 && <span className="brain-mail-dot" />}
      </span>
      {/* The dot is a rail, so it is a mark — the count it stands for has to
          be said out loud somewhere, and this row is the only place left. */}
      {summary.unread > 0 && (
        <span className="sr-only">{summary.unread} unread. </span>
      )}
      <span className="brain-mail-avstack" aria-hidden>
        {summary.senders.map((item) => (
          <MailSenderIcon
            key={`${item.accountId}:${item.threadId}`}
            participants={item.participants}
            size={18}
          />
        ))}
      </span>
      <span className="ml-2.5 flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-baseline gap-1.5 leading-[18px]">
          {/* The names truncate; the count never does. "and 62 more" is the
              whole point of the row, and at 360 it was the first thing the
              ellipsis ate when the two shared one truncating span. */}
          <span className="flex min-w-0 flex-1 items-baseline text-[13px] font-medium text-ink-2">
            <span className="min-w-0 truncate">
              {formatBundleSenders(summary)}
            </span>
            {summary.more > 0 && (
              <span className="shrink-0">&nbsp;and {summary.more} more</span>
            )}
          </span>
          {newest && (
            <time
              dateTime={
                newest.lastMessageAt === null
                  ? undefined
                  : new Date(newest.lastMessageAt).toISOString()
              }
              className="text-caption shrink-0 tabular-nums text-ink-3"
            >
              {formatThreadTime(newest.lastMessageAt)}
            </time>
          )}
        </span>
        {newest && (
          <span
            dir="auto"
            className="min-w-0 truncate text-[13px] leading-[18px] text-ink-3"
          >
            {stripSubjectSenderPrefix(newest.subject, newest.participants) ||
              "(no subject)"}
          </span>
        )}
      </span>
    </div>
  );
}

/**
 * Two names carry the pile, because a third is already unreadable at 360. The
 * "and N more" that follows is rendered beside this, in a span truncation
 * cannot reach.
 */
export function formatBundleSenders(summary: UnifiedBundleSummary): string {
  const names = summary.senders
    .slice(0, 2)
    .map((item) => formatParticipants(item.participants.slice(0, 1)));
  if (names.length === 0) return `${summary.total} threads`;
  return summary.more > 0 ? names.join(", ") : names.join(" and ");
}

/**
 * Section header — one object for every section, chevron included, standing
 * on the column rather than on a plate of its own.
 *
 * Register is Label (11/600) in FULL ink, with the count tabular in ink-3:
 * register down, colour up. It does not have to compete with the rows for
 * size, because it is not competing with them at all — the boundary rule and
 * the 24px above it say a group starts here, and the header only has to name
 * it. Small and dark reads as structure; large would read as another row.
 * (It was Control 13/500 ink-2, one step under the sender; that worked while
 * a section was only a gap between rows.) The 16 glyph rides the row's avatar
 * gutter so the title starts on the senders' left rule.
 *
 * Every row under People/Notifications/Newsletters is unread by construction,
 * so `count` is the unread count and **Done** renders whenever the section
 * exists. Done archives the whole section — the letters leave the inbox and
 * are marked read on the way out — so it is named for what it does to a
 * mailbox, not for the mark it wears, and it names the section it will empty.
 * It is **always visible**, at the IconButton's own resting ink beside the
 * chevron: a control that clears sixty-four newsletters has to be findable,
 * and one that appears under the pointer is a control a reader meets by
 * accident. What makes that safe is not hiding it but the undo behind it —
 * and the order of the two buttons, which leaves the harmless chevron on the
 * column's edge, the easiest target in the row, with Done inboard of it.
 *
 * `doneCount` is the one thing that can take it away, and the one thing that
 * changes its words. An account whose service withholds thread mutations can
 * put rows in a section that Done will never move. The label counts what the
 * press will MOVE ("Done — archive 11 of 14 in Newsletters"), never what the
 * section holds, because "all 14" would be a promise the button cannot keep
 * and the three left behind would stay in the column with nothing said about
 * them. Where it can move nothing the button is not drawn: an always-visible
 * destructive control that silently does nothing is worse than an absent one,
 * and §13's own rule is that an absent control takes its chrome with it.
 *
 * `onToggle` arrives whenever the collapsed section hides rows — always for
 * Seen, past the 3-row preview for the others — and its chevron sits at the
 * header's right edge beside Done, never in a separate control under the
 * rows: a reader who learns that the chevron opens Seen has to find the same
 * chevron in the same place on Newsletters. The slot is kept even when there
 * is nothing to disclose, so Done never inherits the column's edge and the
 * two glyphs line up down a stack of headers. The header is a `<div>` with
 * two 28 IconButtons on its right, so no button nests inside another.
 *
 * **Seen gets Done too.** It was the one section without it, on the argument
 * that a read pile holds nothing to finish — which is a mark-all-read
 * argument that outlived mark-all-read: Done files mail away, and a pile of
 * letters already read is precisely the pile a reader wants out of the
 * column. The other half of that argument, that a stray press would remove
 * what someone deliberately kept, is the one this file rejects two paragraphs
 * above when it says the protection is the undo and not the hiding. Spark
 * puts the same control on the same header, which is where the owner met it.
 */
function SectionHeader({
  icon,
  label,
  count,
  expanded,
  onToggle,
  doneCount,
  onDone,
}: {
  icon: string;
  label: string;
  count: number;
  expanded: boolean;
  onToggle?: () => void;
  /** How many of the section's threads Done can archive. Defaults to the
   *  whole section for callers with one account and no capability question. */
  doneCount?: number;
  onDone?: () => void;
}) {
  const archivable = doneCount ?? count;
  /* The label counts what the press will MOVE, never what the section holds.
     "all 14" while three of them sit on an account that cannot archive is a
     promise the button cannot keep, and the three would then stay in the
     column with nothing said about them. */
  const doneLabel =
    archivable === count
      ? `Done — archive all ${count} in ${label}`
      : `Done — archive ${archivable} of ${count} in ${label}`;
  return (
    <div className="brain-mail-section-head">
      <span className="brain-mail-section-glyph" aria-hidden>
        <Icon name={icon} size={16} />
      </span>
      <span className="text-label min-w-0 truncate text-ink">{label}</span>
      <span className="text-label shrink-0 tabular-nums text-ink-3">
        {count}
      </span>
      <span className="flex-1" />
      {onDone && archivable > 0 && (
        <IconButton
          type="button"
          size={28}
          aria-label={doneLabel}
          title={doneLabel}
          className="brain-touch-hit"
          onClick={onDone}
        >
          <Icon name="check-linear" size={16} />
        </IconButton>
      )}
      {onToggle ? (
        /* The name carries the state as well as `aria-expanded` does, because
           it is also the tooltip, and a tooltip has no ARIA state to lean on. */
        <IconButton
          type="button"
          size={28}
          aria-expanded={expanded}
          aria-label={
            expanded ? `Collapse ${label}` : `Show all ${count} in ${label}`
          }
          title={
            expanded ? `Collapse ${label}` : `Show all ${count} in ${label}`
          }
          className="brain-touch-hit"
          onClick={onToggle}
        >
          <span
            className="brain-mail-disclose"
            data-expanded={expanded ? "" : undefined}
            aria-hidden
          >
            <Icon name="alt-arrow-right-linear" size={12} />
          </span>
        </IconButton>
      ) : (
        /* A section small enough to show itself whole has no disclosure — and
           the slot stays anyway. Two threads under People is the ordinary
           case, not an edge one, and without the spacer Done would take the
           column's edge there: the easiest target in the row, which is the
           position the argument above reserves for the HARMLESS control. It
           would also move Done 34px between one section of a column and the
           next, so the glyphs would not line up down the header stack. */
        <span className="size-7 shrink-0" aria-hidden />
      )}
    </div>
  );
}

/**
 * The single-account ThreadRow anatomy with a sender icon leading. Row keys
 * are strictly `${accountId}:${threadId}` — thread ids are provider-scoped,
 * so the same id can exist in two accounts.
 */
function UnifiedRow({
  thread,
  account,
  index,
  reduce,
  entrance,
  exitFades,
  active,
  onSelect,
}: {
  thread: MailThreadListItem;
  account: string | undefined;
  index: number;
  reduce: boolean | null;
  entrance: boolean;
  exitFades: boolean;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <motion.div
      role="listitem"
      className="brain-mail-row-item"
      initial={
        entrance ? (reduce ? { opacity: 0 } : { opacity: 0, y: 4 }) : false
      }
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
      exit={
        exitFades ? { opacity: 0, transition: { duration: 0.08 } } : undefined
      }
      transition={{
        duration: DUR.fast,
        ease: EASE_OUT,
        delay: reduce || index >= 8 ? 0 : index * 0.025,
      }}
    >
      <MailRow
        thread={thread}
        active={active}
        account={account}
        avatar={<MailSenderIcon participants={thread.participants} size={32} />}
        timeLabel={formatThreadTime(thread.lastMessageAt)}
        onSelect={onSelect}
      />
    </motion.div>
  );
}

/**
 * Quiet per-stream failure row: the rest of the accounts keep merging. The
 * notices are a group like the sections below them — bounded by the same rule,
 * separating on the same soft hairline inside.
 */
function StreamNotice({
  stream,
  onRetry,
  onOpenSettings,
}: {
  stream: UnifiedStream;
  onRetry: () => void;
  onOpenSettings: (invoker: HTMLElement, accountId?: string) => void;
}) {
  return (
    <div className="brain-mail-notice text-caption text-ink-2">
      <span className="min-w-0 flex-1 truncate">
        {stream.status === "reauth"
          ? `${stream.emailAddress} needs to be reconnected`
          : `${stream.emailAddress} couldn’t load`}
      </span>
      {stream.status === "reauth" ? (
        <Button
          variant="quiet"
          className="shrink-0"
          onClick={(event) =>
            onOpenSettings(event.currentTarget, stream.accountId)
          }
        >
          Mail settings
        </Button>
      ) : (
        <Button variant="quiet" className="shrink-0" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

function UnifiedListSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading all inboxes"
      className="brain-mail-section"
    >
      {[0, 1, 2, 3, 4].map((item) => (
        <div key={item} className="brain-mail-row-item">
          <MailRowSkeleton avatar />
        </div>
      ))}
    </div>
  );
}
