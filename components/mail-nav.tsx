"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { ScrollEdge } from "./ui/scroll-edge";
import { ToolbarPill } from "./ui/toolbar-pill";
import { accountWords as resolveAccountWords } from "./mail-row";
import {
  formatMailboxLabel,
  mailDraftsLabel,
  mailSmartViewItems,
} from "./mail-thread-list";
import { UNIFIED_ACCOUNT_ID } from "./mail-unified";
import type {
  MailSystemMailbox,
  PublicMailAccount,
} from "./mail-surface-client";
import type { MailThreadView } from "@/lib/mail/message-types";

const MAILBOX_ICONS: Record<MailSystemMailbox, string> = {
  inbox: "inbox-linear",
  starred: "star-linear",
  sent: "plain-linear",
  all: "archive-linear",
  spam: "danger-linear",
  trash: "trash-bin-trash-linear",
};

const SMART_VIEW_ICONS: Record<MailThreadView, string> = {
  unread: "letter-unread-linear",
  lists: "mailbox-linear",
  people: "user-rounded-linear",
  attachments: "paperclip-linear",
};

/** Drafts is a destination, not a tool: `MailDraftsList` renders the same
 *  `.brain-mail-list` with the same head, so it occupies exactly the slot a
 *  folder does and belongs in the same block — between Sent and All Mail,
 *  where a mail client has always put it. */
const DRAFTS_KEY = "drafts";

/** A destination as one string, so the block can be a radio group: the
 *  mailbox id, `mailbox|view` for a smart view, and `drafts`. Two groups mean
 *  two `aria-checked` rows — which is the two checks the menu draws, said out
 *  loud instead of only drawn. */
function destinationValue(
  draftsOpen: boolean,
  mailboxId: MailSystemMailbox,
  view: MailThreadView | null,
): string {
  if (draftsOpen) return DRAFTS_KEY;
  return view === null ? mailboxId : `${mailboxId}|${view}`;
}

/**
 * ONE CONTROL OWNS MAIL NAVIGATION, at every width and in every mode.
 *
 * An account and a folder are one thing — the address the column stands at —
 * and the rail used to spend a whole sidebar splitting them into two controls
 * while the list beside it stood with no head at all. This names the address
 * in one line at the head of the column and opens one menu where accounts and
 * mailboxes lie in the same list.
 *
 * The mode does not change the object, it only takes out of it what the mode
 * does not have: a block is drawn only where it exists. Unified has one
 * mailbox and no smart views, so it has no destinations block and no Smart
 * block, and the menu is the Accounts label and its rows. That is the same
 * rule §13 already writes for the column — an absent control takes its chrome
 * with it — applied to a menu.
 */
export function MailNav({
  accounts,
  selectedAccountId,
  selectedMailboxId,
  selectedView,
  draftsOpen,
  inboxUnreadCount,
  failedDraftCount,
  submittingDraftCount,
  onSelectAccount,
  onSelectMailbox,
  onSelectView,
  onOpenDrafts,
}: {
  accounts: readonly PublicMailAccount[];
  selectedAccountId: string;
  selectedMailboxId: MailSystemMailbox;
  selectedView: MailThreadView | null;
  /** The drafts list holds the column, so Drafts is the checked destination
   *  and the trigger names it. */
  draftsOpen: boolean;
  inboxUnreadCount: number | null;
  failedDraftCount: number;
  submittingDraftCount: number;
  onSelectAccount: (accountId: string) => void;
  onSelectMailbox: (mailboxId: MailSystemMailbox) => void;
  onSelectView: (mailboxId: MailSystemMailbox, view: MailThreadView) => void;
  onOpenDrafts: () => void;
}) {
  const unified = selectedAccountId === UNIFIED_ACCOUNT_ID;
  const selectedAccount = accounts.find(
    (account) => account.accountId === selectedAccountId,
  );
  const availableMailboxes: readonly MailSystemMailbox[] = unified
    ? ["inbox"]
    : (selectedAccount?.capabilities.mailboxes ?? ["inbox"]);
  const smartItems = unified ? [] : mailSmartViewItems(availableMailboxes);
  const draftsRow = !unified && selectedAccount?.capabilities.compose === true;
  const destinations: readonly (MailSystemMailbox | typeof DRAFTS_KEY)[] = unified
    ? []
    : withDrafts(availableMailboxes, draftsRow);

  // The account word appears only where it says something: one account is
  // never ambiguous, and in unified "All inboxes" already names every one of
  // them. Same resolution the merged rows use — the shortest token no
  // neighbour shares.
  const accountWord =
    unified || accounts.length < 2 || !selectedAccount
      ? null
      : (resolveAccountWords(
          accounts.map((account) => account.emailAddress),
        ).get(selectedAccount.emailAddress) ?? null);

  const destinationLabel = unified
    ? "All inboxes"
    : draftsOpen
      ? "Drafts"
      : selectedView
        ? (smartItems.find((item) => item.view === selectedView)?.label ??
          formatMailboxLabel(selectedMailboxId))
        : formatMailboxLabel(selectedMailboxId);
  const spoken = accountWord
    ? `${destinationLabel}, ${accountWord}`
    : destinationLabel;
  const destination = destinationValue(draftsOpen, selectedMailboxId, selectedView);
  const goTo = (value: string) => {
    if (value === DRAFTS_KEY) {
      onOpenDrafts();
      return;
    }
    const separator = value.indexOf("|");
    if (separator === -1) {
      onSelectMailbox(value as MailSystemMailbox);
      return;
    }
    onSelectView(
      value.slice(0, separator) as MailSystemMailbox,
      value.slice(separator + 1) as MailThreadView,
    );
  };
  const hasDestinations = destinations.length > 0 || smartItems.length > 0;
  const accountsBlock = accounts.length > 1;

  return (
    <Dropdown.Root>
      {/* min-w-0 so the label, not the toolbar pill beside it, is what gives
          way when the column narrows: the toolbar is fixed-size controls. */}
      <ToolbarPill className="min-w-0 max-w-full">
        <Dropdown.Trigger asChild>
          <Button
            type="button"
            variant="quiet"
            aria-label={`Mailbox: ${spoken}`}
            title={spoken}
            className="brain-touch-hit brain-mail-nav"
          >
            <span className="min-w-0 truncate">{destinationLabel}</span>
            {accountWord && (
              <span className="min-w-0 truncate text-ink-3">{accountWord}</span>
            )}
            {/* the chevron does not turn: the feedback is the menu
                materializing, and a second one says the same thing twice */}
            <Icon
              name="alt-arrow-down-linear"
              size={16}
              className="shrink-0 text-ink-3"
            />
          </Button>
        </Dropdown.Trigger>
      </ToolbarPill>
      <Dropdown.Portal>
        <Dropdown.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="brain-menu z-[var(--z-modal)] w-[264px]"
        >
          {/* THE LIST SCROLLS, NOT THE MATERIAL. Fourteen rows is 534px and
              this menu is the only way out of an account, so a window shorter
              than that — a phone in landscape, an iPad split view, a short
              laptop window — used to put the Accounts block off screen with
              nothing to scroll: the content ran past the foot, and the
              keyboard walked focus onto rows nobody could see.

              Radix measures the room and publishes it; this reads it. The cap
              is the available height less the material's own 6px of padding
              top and bottom, so the menu ends where the window does and the
              rows move inside it.

              It is scoped to this menu rather than to `.brain-menu` on
              purpose, and that is the house answer rather than a new one:
              `subpages` caps its own list on this same variable for this same
              reason, and the emoji and category pickers keep their search
              field OUT of the scroller and roll only the list under it —
              which is what §12's "lists inside scroll under an edge-fade"
              asks for. `.brain-menu` is the MATERIAL: glass, radius, the 6px
              padding, the materialize keyframes and the ::before edge-light.
              A scroller on it would clip that layer against its own rounded
              corner, and would roll the pickers' chrome away with their
              lists. This menu is all list and no chrome, so the scroller
              wraps its whole body — the same rule, one level up. The fade is
              a mask, not a backdrop layer, so the head's budget stays where
              it was measured. */}
          <ScrollEdge
            variant="fade"
            className="max-h-[calc(var(--radix-dropdown-menu-content-available-height,100vh)-12px)] overscroll-contain"
            scrollerProps={{ role: "none" }}
          >
          {/* Both blocks are ONE group: they name destinations, and only one
              of them can be where the column stands. A radio group is what
              says so — `aria-checked` on the row the check is drawn on, so a
              reader who cannot see the check is told the same thing. */}
          {hasDestinations && (
            <Dropdown.RadioGroup value={destination} onValueChange={goTo}>
              {destinations.map((entry) =>
                entry === DRAFTS_KEY ? (
                  <MenuRow
                    key={DRAFTS_KEY}
                    value={DRAFTS_KEY}
                    icon="document-text-linear"
                    label="Drafts"
                    ariaLabel={mailDraftsLabel(failedDraftCount, submittingDraftCount)}
                    selected={draftsOpen}
                    trailing={
                      failedDraftCount > 0 ? (
                        <span className="tree-row-count">
                          {failedDraftCount > 9 ? "9+" : failedDraftCount}
                        </span>
                      ) : submittingDraftCount > 0 ? (
                        <span
                          aria-hidden
                          className="size-1.5 animate-pulse rounded-full bg-ink-3"
                        />
                      ) : null
                    }
                  />
                ) : (
                  <MenuRow
                    key={entry}
                    value={entry}
                    icon={MAILBOX_ICONS[entry]}
                    label={formatMailboxLabel(entry)}
                    selected={
                      !draftsOpen &&
                      selectedMailboxId === entry &&
                      selectedView === null
                    }
                    trailing={
                      /* The count stands only on a row that names ONE mailbox
                         of ONE account — the same rule the rail's badge had,
                         now a consequence of the menu's shape rather than a
                         guard. */
                      entry === "inbox" &&
                      inboxUnreadCount !== null &&
                      inboxUnreadCount > 0 ? (
                        <span className="tree-row-count">{inboxUnreadCount}</span>
                      ) : null
                    }
                  />
                ),
              )}
              {destinations.length > 0 && smartItems.length > 0 && (
                <Dropdown.Separator className="brain-menu-sep" />
              )}
              {smartItems.length > 0 && (
                <>
                  <Dropdown.Label className="brain-menu-label">
                    Smart
                  </Dropdown.Label>
                  {smartItems.map((item) => (
                    <MenuRow
                      key={item.view}
                      value={`${item.mailboxId}|${item.view}`}
                      icon={SMART_VIEW_ICONS[item.view]}
                      label={item.label}
                      selected={
                        !draftsOpen &&
                        selectedMailboxId === item.mailboxId &&
                        selectedView === item.view
                      }
                    />
                  ))}
                </>
              )}
            </Dropdown.RadioGroup>
          )}
          {hasDestinations && accountsBlock && (
            <Dropdown.Separator className="brain-menu-sep" />
          )}

          {/* A block is drawn only where the mode has one, and this one
              exists only where there is a second address to switch to. For
              one account its two rows would be All inboxes — a merge of one
              inbox, which the surface never enters — and the address the
              reader is already at, and a block of one row is not a block.
              The moment a second account connects the block appears with
              both rows in it (§13). */}
          {accountsBlock && (
            <Dropdown.RadioGroup
              value={selectedAccountId}
              onValueChange={onSelectAccount}
            >
              <Dropdown.Label className="brain-menu-label">Accounts</Dropdown.Label>
              {/* the stack, not the tray: the tray stands a block above meaning
                  one mailbox, and "all" is not one of them (§13) */}
              <MenuRow
                value={UNIFIED_ACCOUNT_ID}
                icon="layers-minimalistic-linear"
                label="All inboxes"
                selected={unified}
              />
              {accounts.map((account) => (
                <MenuRow
                  key={account.accountId}
                  value={account.accountId}
                  /* an address, not a mailbox — the envelope, never the tray */
                  icon="letter-linear"
                  label={account.emailAddress}
                  ariaLabel={`Open ${account.emailAddress}`}
                  title={account.emailAddress}
                  selected={account.accountId === selectedAccountId}
                />
              ))}
            </Dropdown.RadioGroup>
          )}
          </ScrollEdge>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

/** Drafts sits after Sent where the account has one, and at the end of a
 *  short list where it does not — an IMAP account whose capabilities name
 *  only the inbox gets Inbox and Drafts, the same block one row shorter. */
function withDrafts(
  mailboxes: readonly MailSystemMailbox[],
  drafts: boolean,
): readonly (MailSystemMailbox | typeof DRAFTS_KEY)[] {
  if (!drafts) return mailboxes;
  const sent = mailboxes.indexOf("sent");
  if (sent === -1) return [...mailboxes, DRAFTS_KEY];
  return [
    ...mailboxes.slice(0, sent + 1),
    DRAFTS_KEY,
    ...mailboxes.slice(sent + 1),
  ];
}

function MenuRow({
  value,
  icon,
  label,
  ariaLabel,
  title,
  selected,
  trailing,
}: {
  value: string;
  icon: string;
  label: string;
  ariaLabel?: string;
  /** The whole label where the row can truncate it. §13 promises the full
   *  address is one press away in this block; a domain past ~26 characters
   *  ends in an ellipsis, and the `aria-label` that carries it in full is no
   *  help to a reader who can see. */
  title?: string;
  selected: boolean;
  trailing?: React.ReactNode;
}) {
  return (
    <Dropdown.RadioItem
      value={value}
      className="brain-menu-item"
      aria-label={ariaLabel}
      title={title}
    >
      <Icon name={icon} size={16} className="brain-menu-icon" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing}
      {selected && (
        <Icon name="check-linear" size={14} className="shrink-0 text-ink-2" />
      )}
    </Dropdown.RadioItem>
  );
}
