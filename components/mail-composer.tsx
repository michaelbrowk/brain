"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  CHIP_ROW_AIR,
  CHIP_ROW_RING,
  DUR,
  EASE_OUT,
  SHEET_ENTER_Y,
  SPIN,
  SPRING_SELECT,
  SPRING_SHEET,
} from "@/lib/motion";

import { useSheetGesture } from "./use-sheet-gesture";
import { formatBytes } from "@/lib/mail/attachment-preview";
import {
  describeMailRecipientProblem,
  parseMailRecipientFields,
  type MailRecipientField,
} from "@/lib/mail/recipients";
import {
  ATTACHMENT_REFUSALS,
  admitAttachments,
  encodeAttachments,
  UnreadableAttachmentError,
  type ComposeAttachment,
} from "./mail-composer-attachments";
import { Button, IconButton } from "./ui/button";
import { Chip } from "./ui/chip";
import { Icon } from "./ui/icon";
import { Kbd, useShortcutTitle } from "./ui/primitives";
import { ScrollEdge } from "./ui/scroll-edge";
import type { MailSendInput, PublicMailAccount } from "./mail-surface-client";

export type MailComposerDraft = {
  readonly idempotencyKey: string;
  readonly mode: "compose" | "reply" | "replyAll" | "forward";
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly text: string;
  readonly replyToMessageId: string | null;
  readonly notice: string | null;
};

export type MailComposerFields = {
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly text: string;
};

export type MailComposerSaveStatus = "idle" | "saving" | "saved" | "error";

export type MailComposerLeaving = { readonly withFiles: boolean };

/** True while the pointer carries files. The whole sheet is the drop zone: a
 *  file dropped on an unguarded page navigates the browser to the file
 *  itself, which takes the unsaved draft in React state with it, so the
 *  sheet claims every file drag, whether it takes the file or not. */
function draggingFiles(event: DragEvent<HTMLElement>): boolean {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes("Files") : false;
}

/** The files a drop carries, and whether a folder was among them. A folder
 *  arrives as a file the browser cannot read, so it is told apart by its
 *  entry, which can only be asked during the drop itself. */
function droppedFiles(transfer: DataTransfer): {
  readonly files: readonly File[];
  /** The first folder in the drop, by name, or null. */
  readonly folder: string | null;
} {
  const items = transfer.items ? Array.from(transfer.items) : [];
  if (items.length === 0) return { files: Array.from(transfer.files ?? []), folder: null };
  const files: File[] = [];
  let folder: string | null = null;
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (item.webkitGetAsEntry?.()?.isDirectory) {
      folder ??= file?.name ?? "";
      continue;
    }
    if (file) files.push(file);
  }
  return { files, folder };
}

/** What the actions row's slot says, if anything. One sentence at a time, in
 *  this order: a refusal the writer can fix stands over a refusal from the
 *  service, both stand over a file the sheet did not take, and all of them
 *  over a save that did not land. */
type SlotMessage = {
  readonly key: "validation" | "send" | "attach" | "save";
  readonly text: string;
  readonly role: "alert" | "status";
};

/** When each part of the letter arrives, in seconds after the sheet: From,
 *  To, then a resumed Cc/Bcc and the notice (the parts a draft may or may not
 *  carry, on a half step so the rows around them keep theirs), Subject, and
 *  the fold with the body together at the last step. */
const ROW_DELAYS = [0.05, 0.08, 0.095, 0.11, 0.14] as const;

/**
 * THE SHEET. Writing a letter takes the whole window: the composer is an
 * opaque paper surface in a portal at the body, on `--z-modal`, and the shell
 * under it goes inert (`blockingSurfaceOpen` in shell.tsx). Radix Dialog
 * supplies what a modal owes — the role, the focus trap, Esc, and focus
 * returning to whatever opened it — and framer draws the motion inside it.
 * The Root is always open: the sheet's life is its mount, and the surface
 * that renders it decides when it leaves.
 *
 * There is no title row. The mode is the dialog's name (`aria-label`), and
 * the first thing on the page is the letter.
 */
export function MailComposePaper({
  title,
  sending,
  holdEscape = false,
  focusOnOpen,
  onDismiss,
  children,
}: {
  title: string;
  /** While a send is out nothing on the sheet answers: Esc and the cross are
   *  inert, so the dialog refuses its own dismissal until it is over. */
  sending: boolean;
  /** A menu inside the sheet is open, and Esc belongs to it. Two copies of
   *  Radix's dismissable layer live in node_modules (the dialog's and the
   *  menu's), so neither knows the other is above it and one Esc used to
   *  reach both: the menu closed and the letter went with it. Until the
   *  copies are deduplicated the sheet refuses Esc while a menu of its own
   *  is up; after, this stays harmless. */
  holdEscape?: boolean;
  /** Where the caret goes the moment the sheet stands. Placed from Radix's
   *  own mount hook rather than `autoFocus`, so the element Radix remembers
   *  as "focused before" is the button that opened the sheet and not the
   *  field the caret was put in, and focus returns there when it closes. */
  focusOnOpen: () => HTMLElement | null | undefined;
  onDismiss: () => void;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const sheet = useSheetGesture();
  /** Read by the Esc guard through a ref rather than its closure: Radix
   *  registers the document listener once and its effect-event wrapper hands
   *  it the handler of the layer's own last render, which is not always the
   *  sheet's last render. A ref is current whichever render the handler
   *  came from. */
  const escapeHeldRef = useRef(sending || holdEscape);
  useEffect(() => {
    escapeHeldRef.current = sending || holdEscape;
  }, [sending, holdEscape]);
  /** Whatever had the focus when the sheet was asked for: the New message
   *  pill, a Reply button in the reader, a draft's row. Read on the first
   *  render, before Radix moves the caret in, and focused again when the
   *  sheet goes. Radix's modal content would hand focus to a `Dialog.Trigger`
   *  and there is none here, so the return is written out. */
  const [opener] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null,
  );
  /** The arrival. A desktop sheet fades up 12px over the page duration while
   *  the shell recedes behind it; a phone sheet rises from `SHEET_ENTER_Y` on
   *  the sheet spring, the way every sheet on the phone arrives. Reduced
   *  motion: a crossfade over `DUR.fast` and nothing travels. */
  const enter = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: DUR.fast } }
    : sheet
      ? {
          initial: { opacity: 0, y: SHEET_ENTER_Y },
          animate: { opacity: 1, y: 0 },
          transition: SPRING_SHEET,
        }
      : {
          initial: { opacity: 0, y: 12 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: DUR.page, ease: EASE_OUT },
        };
  /** The leaving, by the way it was dismissed. A sheet still `sending` when
   *  it goes is one whose send landed: it lets go outward (scale to 1.02)
   *  over the page duration, the way a dialog commits. Anything else is a
   *  dismissal, down and out, fast, ease-in: 8px on a desktop, the sheet's
   *  own distance on a phone. framer reads this off the last render, which is
   *  why the send flow never has to tell the sheet how it is leaving. */
  const exit = reduce
    ? { opacity: 0, transition: { duration: DUR.fast } }
    : sending
      ? { opacity: 0, scale: 1.02, transition: { duration: DUR.page, ease: EASE_OUT } }
      : {
          opacity: 0,
          y: sheet ? SHEET_ENTER_Y : 8,
          transition: { duration: DUR.fast, ease: "easeIn" as const },
        };
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !sending) onDismiss();
      }}
    >
      <Dialog.Portal>
        <Dialog.Content
          asChild
          aria-label={title}
          aria-modal="true"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            focusOnOpen()?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => {
            if (escapeHeldRef.current) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const target =
              opener?.isConnected && opener.closest("[inert]") === null
                ? opener
                : document.querySelector<HTMLElement>("[data-dialog-focus-fallback]");
            target?.focus({ preventScroll: true });
          }}
          // The sheet is the whole window, so nothing outside it is a place
          // to press: a toast standing over it must not close the letter.
          onInteractOutside={(event) => event.preventDefault()}
        >
          <motion.div
            className="brain-compose-paper"
            data-sheet={sheet ? "" : undefined}
            initial={enter.initial}
            animate={enter.animate}
            exit={exit}
            transition={enter.transition}
          >
            <Dialog.Title className="sr-only">{title}</Dialog.Title>
            {children}
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function MailComposer({
  account,
  accounts = [],
  initialDraft,
  sending,
  sendError,
  sendBlocked,
  sendErrorSettings = false,
  saveStatus = "idle",
  onCancel,
  onDiscard,
  onDraftChange,
  onRetrySave,
  onSend,
  onOpenSettings,
  onSwitchAccount,
}: {
  account: PublicMailAccount;
  /** Every account the letter could go from: the ones that can compose and
   *  send. With two or more, and a surface to hand the switch to, the From
   *  value becomes a menu; a lone account keeps it as text. */
  accounts?: readonly PublicMailAccount[];
  initialDraft: MailComposerDraft;
  sending: boolean;
  sendError: string | null;
  sendBlocked: boolean;
  /** The send error is a reauth failure — offer Mail settings next to it. */
  sendErrorSettings?: boolean;
  saveStatus?: MailComposerSaveStatus;
  /** Close and Discard say whether the sheet left with files on it. The
   *  files live only in the sheet and go with it, so the surface is told,
   *  to say that the draft it keeps has none. */
  onCancel: (leaving: MailComposerLeaving) => void;
  onDiscard: (leaving: MailComposerLeaving) => void;
  onDraftChange: (fields: MailComposerFields) => void;
  onRetrySave: () => void;
  onSend: (input: MailSendInput) => void;
  onOpenSettings?: (invoker: HTMLElement) => void;
  /** The writer chose another account in the From menu. The surface opens
   *  the same letter there and closes this draft with delete; the fields are
   *  handed over as they stand, so nothing typed is lost to the move. */
  onSwitchAccount?: (accountId: string, fields: MailComposerFields) => void;
}) {
  const sendTitle = useShortcutTitle("Send", "⌘↵");
  const [to, setTo] = useState(initialDraft.to);
  const [cc, setCc] = useState(initialDraft.cc);
  const [bcc, setBcc] = useState(initialDraft.bcc);
  const [subject, setSubject] = useState(initialDraft.subject);
  const [text, setText] = useState(initialDraft.text);
  const [showCopies, setShowCopies] = useState(Boolean(initialDraft.cc || initialDraft.bcc));
  /** True once the Cc Bcc press revealed the rows: they grow into place.
   *  A draft that already carried a copy shows them standing. */
  const [revealedByPress, setRevealedByPress] = useState(false);
  const [validation, setValidation] = useState<{
    readonly field: MailRecipientField;
    readonly message: string;
  } | null>(null);
  /** The files on the sheet, in its memory only (`mail-composer-attachments`),
   *  and what the slot says about a file it did not take. The refusal stands
   *  until the writer types on or changes the shelf: it answered a gesture,
   *  and the next gesture is the writer moving past it. */
  const [attachments, setAttachments] = useState<readonly ComposeAttachment[]>([]);
  const [attachRefusal, setAttachRefusal] = useState<string | null>(null);
  const nextAttachmentIdRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const shelfRef = useRef<HTMLDivElement | null>(null);
  /** Where the caret goes after a chip leaves: the chip that took its place,
   *  the one before it, or the paperclip once the shelf is empty. */
  const refocusRef = useRef<number | "clip" | null>(null);
  /** The files are being read for the send. A beat, not a state anyone sees
   *  for long, but the sheet reads as sending through it so nothing can be
   *  typed into a letter that has already gone to be sent. */
  const [preparing, setPreparing] = useState(false);
  const busy = sending || preparing;
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  const canAttach = account.capabilities.send;
  const toRef = useRef<HTMLInputElement | null>(null);
  const ccRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  /** Set by the Cc Bcc press alone: a draft resumed with a copy already on it
   *  shows the rows without moving the caret. */
  const focusCcRef = useRef(false);
  const errorId = useId();
  const toId = useId();
  const ccId = useId();
  const bccId = useId();
  const subjectId = useId();
  const bodyLabelId = useId();
  const reportedInitial = useRef(false);
  const reduce = useReducedMotion();
  /** How many times `sending` has flipped since the sheet stood, so the label
   *  swap knows it is a swap: the word arrives through a blur when the state
   *  flips and not when the sheet itself arrives. State adjusted during the
   *  render rather than a ref read in it (React's own pattern for a previous
   *  prop), so the count is right on the very render that remounts the word. */
  const [swaps, setSwaps] = useState({ sending: busy, count: 0 });
  if (swaps.sending !== busy) setSwaps({ sending: busy, count: swaps.count + 1 });
  const swapping = swaps.count > 0;
  const title = composerTitle(initialDraft.mode);
  const fromName = account.displayName || account.emailAddress;

  /**
   * THE FROM SWITCH. Compose only, and only with two or more accounts that
   * can send: a reply or a forward goes from the account the letter arrived
   * in, and one account is not a choice. The value stays what it is, quiet
   * ink-2 text on the rule, and gains the chevron and a menu (the reader's
   * `MailActionsMenu` pattern) listing each account by name with its address
   * as a caption, the current one marked with a bare check. Choosing another
   * hands the fields over as they stand. It is drawn twice, in the envelope
   * row and in the phone's actions row, and CSS shows one at any width, so the
   * phone can switch too.
   */
  const canSwitchFrom =
    initialDraft.mode === "compose" && accounts.length >= 2 && onSwitchAccount !== undefined;
  /** Whether either copy of the From menu is open: while one is, Esc is the
   *  menu's and the sheet holds still (`holdEscape`). */
  const [fromMenuOpen, setFromMenuOpen] = useState(false);
  const fromValue = () =>
    canSwitchFrom ? (
      <FromSwitch
        account={account}
        accounts={accounts}
        fromName={fromName}
        // A blocked sheet is one whose send may already be on its way: a
        // switch would open the letter afresh in another account, with Send
        // live again, and the same words and files could go twice.
        disabled={busy || sendBlocked}
        onOpenChange={setFromMenuOpen}
        onSwitch={(accountId) => onSwitchAccount?.(accountId, { to, cc, bcc, subject, text })}
      />
    ) : (
      <span className="truncate">{fromName}</span>
    );

  /** The rows arrive one after another, each a 4px rise over `DUR.base`:
   *  From, To, a resumed copy and the notice, Subject, then the fold and the
   *  body together, so the last of them lands at 300ms with the sheet.
   *  Reduced motion: they are simply there. The steps are the spec's own
   *  numbers. */
  const arrive = (step: 0 | 1 | 2 | 3 | 4) =>
    reduce
      ? { initial: false as const }
      : {
          initial: { opacity: 0, y: 4 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: DUR.base, ease: EASE_OUT, delay: ROW_DELAYS[step] },
        };

  useEffect(() => {
    if (!reportedInitial.current) {
      reportedInitial.current = true;
      return;
    }
    onDraftChange({ to, cc, bcc, subject, text });
  }, [to, cc, bcc, subject, text, onDraftChange]);

  useEffect(() => {
    if (!showCopies || !focusCcRef.current) return;
    focusCcRef.current = false;
    ccRef.current?.focus({ preventScroll: true });
  }, [showCopies]);

  useEffect(() => {
    const target = refocusRef.current;
    if (target === null) return;
    refocusRef.current = null;
    const next =
      target === "clip"
        ? fileInputRef.current?.parentElement?.querySelector<HTMLElement>(
            ".brain-compose-clip",
          )
        : shelfRef.current?.querySelector<HTMLElement>(`[data-attachment="${target}"]`);
    next?.focus({ preventScroll: true });
  }, [attachments]);

  /** Close keeps the draft and asks nothing. Inert while a send is out. */
  const close = () => {
    if (busy) return;
    onCancel({ withFiles: attachments.length > 0 });
  };

  /**
   * Discard is not Close. Closing keeps the draft — it is already saved and
   * the writer finds it in Drafts. Discard removes it, and it no longer asks
   * first: the sheet goes at the press and the surface puts up a pill with
   * Undo, holding the provider delete behind it for the pill's window. The
   * protection is the way back, not a question in the way. Inert while a
   * send is out.
   */
  const discard = () => {
    if (busy) return;
    onDiscard({ withFiles: attachments.length > 0 });
  };

  /**
   * Files from the paperclip or a drop join the shelf when the codec's caps
   * say they fit; what does not fit is said in the slot, by name. A folder
   * in a drop is its own refusal, said before the caps'.
   */
  const attach = (files: readonly File[], folder: string | null = null) => {
    if (busy || !canAttach) return;
    const { admitted, refusal } = admitAttachments(attachments, files);
    if (admitted.length > 0) {
      setAttachments([
        ...attachments,
        ...admitted.map((entry) => ({ ...entry, id: nextAttachmentIdRef.current++ })),
      ]);
    }
    setAttachRefusal(folder !== null ? ATTACHMENT_REFUSALS.folder(folder) : refusal);
  };

  const detach = (id: number) => {
    if (busy) return;
    const index = attachments.findIndex((entry) => entry.id === id);
    const rest = attachments.filter((entry) => entry.id !== id);
    refocusRef.current = rest[Math.min(index, rest.length - 1)]?.id ?? "clip";
    setAttachments(rest);
    setAttachRefusal(null);
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || sendBlocked) return;
    // The same contract the Mail service applies to the stored draft text, so
    // the writer never gets an opaque refusal for a list this screen approved.
    const recipients = parseMailRecipientFields({ to, cc, bcc });
    if (!recipients.ok) {
      // A problem with no field of its own (nobody to send to, too many in
      // all) is the envelope's, and To is where the envelope starts.
      setValidation({
        field: "field" in recipients.problem ? recipients.problem.field : "to",
        message: describeMailRecipientProblem(recipients.problem),
      });
      return;
    }
    setValidation(null);
    onDraftChange({ to, cc, bcc, subject, text });
    const letter: Omit<MailSendInput, "attachments"> = {
      accountId: account.accountId,
      idempotencyKey: initialDraft.idempotencyKey,
      mode:
        initialDraft.mode === "reply" || initialDraft.mode === "replyAll"
          ? "reply"
          : "compose",
      to: recipients.recipients.to,
      cc: recipients.recipients.cc,
      bcc: recipients.recipients.bcc,
      subject,
      text,
      replyToMessageId: initialDraft.replyToMessageId,
      // A message a person typed is never marked as an agent's.
      origin: "app",
      agentLine: false,
    };
    if (attachments.length === 0) {
      onSend({ ...letter, attachments: [] });
      return;
    }
    // The files are read only now, as the letter goes. The hand-off and the
    // end of the read land in one render, so the sheet reads as sending
    // from the press straight through to the surface's own `sending`.
    setPreparing(true);
    encodeAttachments(attachments).then(
      (encoded) => {
        if (!aliveRef.current) return;
        onSend({ ...letter, attachments: encoded });
        setPreparing(false);
      },
      (error: unknown) => {
        if (!aliveRef.current) return;
        setPreparing(false);
        setAttachRefusal(
          ATTACHMENT_REFUSALS.unreadable(
            error instanceof UnreadableAttachmentError ? error.filename : "",
          ),
        );
      },
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };

  /** Typing on clears what the writer was told about a gesture: a file the
   *  sheet did not take, and a recipient refusal once that field is being
   *  edited. */
  const typed = () => {
    if (attachRefusal) setAttachRefusal(null);
  };
  const recipient =
    (set: (value: string) => void) => (event: FormEvent<HTMLInputElement>) => {
      set(event.currentTarget.value);
      typed();
      if (validation) setValidation(null);
    };

  const message: SlotMessage | null = validation
    ? { key: "validation", text: validation.message, role: "alert" }
    : sendError
      ? { key: "send", text: sendError, role: "alert" }
      : attachRefusal
        ? { key: "attach", text: attachRefusal, role: "status" }
        : saveStatus === "error"
          ? { key: "save", text: "Not saved", role: "status" }
          : null;
  /** The slot's box outlives its sentence by the sentence's exit: on the
   *  phone the box collapses to give the row back to From, and collapsing
   *  it the instant the sentence is taken back clipped the fade. Raised in
   *  the render that shows a sentence, lowered when the presence reports
   *  the exit complete. */
  const [slotStanding, setSlotStanding] = useState(message !== null);
  if (message && !slotStanding) setSlotStanding(true);

  return (
    <MailComposePaper
      title={title}
      sending={busy}
      holdEscape={fromMenuOpen}
      focusOnOpen={() => (initialDraft.mode === "compose" ? toRef.current : bodyRef.current)}
      onDismiss={close}
    >
      <form
        className="brain-compose-form"
        onSubmit={submit}
        onKeyDown={onKeyDown}
        onDragOver={(event) => {
          if (!draggingFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = busy || !canAttach ? "none" : "copy";
        }}
        onDrop={(event) => {
          if (!draggingFiles(event)) return;
          event.preventDefault();
          // The sheet is the whole window, so whatever it has to say about
          // the drop is said on it, in the slot, and not in a pill under it.
          const { files, folder } = droppedFiles(event.dataTransfer);
          attach(files, folder);
        }}
      >
        {/* THE ACTIONS ROW, ON TOP. Send stands where a thumb reaches it and
            where no keyboard can cover it: the phone's standing failure was a
            footer under the keys. The slot in the middle always keeps its
            place, so a sentence arriving in it moves nothing else. On the
            phone From reads here as quiet text and keeps the row; a sentence
            takes a second line under the actions (`data-message` opens it). */}
        {/* While a send is out the cross, the trash and Cc Bcc do not only
            refuse, they read as inert: `aria-disabled` and `disabled` take
            the atoms' own dimmed state, and `data-sending` names the row's. */}
        <div
          className="brain-compose-actions"
          data-message={message || slotStanding ? "" : undefined}
          data-sending={busy ? "" : undefined}
        >
          <IconButton
            type="button"
            size={28}
            aria-label="Close draft"
            title="Close draft"
            aria-disabled={busy || undefined}
            onClick={close}
            className="brain-touch-hit"
          >
            <Icon name="close-linear" size={16} />
          </IconButton>
          <span className="brain-compose-actions-from text-control">{fromValue()}</span>
          <div className="brain-compose-slot text-control">
            <AnimatePresence
              initial={false}
              onExitComplete={() => setSlotStanding(message !== null)}
            >
              {message && (
                <motion.span
                  key={message.key}
                  className="brain-compose-slot-line"
                  initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
                  animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
                  exit={{ opacity: 0, transition: { duration: DUR.fast } }}
                  transition={{ duration: DUR.base, ease: EASE_OUT }}
                >
                  <span
                    id={errorId}
                    role={message.role}
                    className={message.role === "alert" ? "text-red" : "text-ink-2"}
                  >
                    {message.text}
                  </span>
                  {message.key === "send" && sendErrorSettings && onOpenSettings && (
                    <Button
                      type="button"
                      variant="quiet"
                      className="brain-compose-slot-action"
                      onClick={(event) => onOpenSettings(event.currentTarget)}
                    >
                      Mail settings
                    </Button>
                  )}
                  {message.key === "save" && (
                    <Button
                      type="button"
                      variant="quiet"
                      className="brain-compose-slot-action"
                      onClick={onRetrySave}
                    >
                      Retry
                    </Button>
                  )}
                </motion.span>
              )}
            </AnimatePresence>
          </div>
          {/* The paperclip opens the system's file chooser through an input
              nobody sees or tabs to: the clip is the control. Offered only
              to an account that can send, and inert while a send is out. */}
          {canAttach && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                tabIndex={-1}
                disabled={busy}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  // Emptied at once, so choosing the same file again is a
                  // change the input reports.
                  event.currentTarget.value = "";
                  attach(files);
                }}
              />
              <IconButton
                type="button"
                size={28}
                aria-label="Attach files"
                title="Attach files"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (busy) return;
                  fileInputRef.current?.click();
                }}
                className="brain-compose-clip brain-touch-hit"
              >
                <Icon name="paperclip-linear" size={16} />
              </IconButton>
            </>
          )}
          {!sendBlocked && (
            <IconButton
              type="button"
              size={28}
              aria-label="Discard draft"
              title="Discard draft"
              aria-disabled={busy || undefined}
              onClick={discard}
              className="brain-touch-hit"
            >
              <Icon name="trash-bin-trash-linear" size={16} />
            </IconButton>
          )}
          {/* The shortcut wears the Kbd atom, not the button register beside
              it. The words live in Send's own tooltip. */}
          <span aria-hidden className="brain-compose-kbd">
            <Kbd>⌘↵</Kbd>
          </span>
          {/* The one ink fill on the surface (§2 → Primary), a 28 capsule
              like the controls beside it. At rest it is the one word; while
              a send is out the word is "Sending" with the glyph turning
              before it. The label swaps inside a box that never changes
              size: a hidden cell holds the widest state (glyph and
              "Sending"), so the button is the same object before and after
              the press. The press is refused by the submit handler rather
              than by `disabled`, so the button still reads as the way out. */}
          <Button
            type="submit"
            variant="ink"
            title={sendTitle}
            aria-busy={busy || undefined}
            disabled={sendBlocked}
            className="brain-compose-send brain-touch-hit"
          >
            <span className="brain-compose-send-label">
              <span aria-hidden className="brain-compose-send-ghost">
                <Icon name="restart-linear" size={16} />
                Sending
              </span>
              {/* Two words changing in one place read as two words unless
                  something bridges them, so the swap resolves from a 2px blur
                  over DUR.base. Only the swap: the word does not blur in with
                  the sheet. The wait is the glyph turning on SPIN; under
                  reduced motion it stands still and the word says the work
                  is happening. */}
              <motion.span
                key={busy ? "working" : "waiting"}
                className="brain-compose-send-word"
                initial={reduce || !swapping ? false : { opacity: 0.5, filter: "blur(2px)" }}
                animate={{ opacity: 1, filter: "blur(0px)" }}
                transition={{ duration: DUR.base, ease: EASE_OUT }}
              >
                {busy && (
                  <motion.span
                    className="brain-compose-send-glyph"
                    animate={reduce ? undefined : { rotate: 360 }}
                    transition={reduce ? undefined : SPIN}
                  >
                    <Icon name="restart-linear" size={16} />
                  </motion.span>
                )}
                {busy ? "Sending" : "Send"}
              </motion.span>
            </span>
          </Button>
        </div>

        {/* ONE SCROLLER, ONE DOCUMENT. The envelope, the fold and the body
            are one column of 700 on the paper, with nothing drawn around any
            of them: a label at ink-3 that turns to ink when its row holds the
            caret is the whole focus signal, and the keyboard's own ring
            (`html[data-kbd] :focus-visible`) stays global. */}
        <ScrollEdge variant="fade" className="brain-compose-scroll">
          <div className="brain-compose-column">
            <div className="brain-compose-envelope">
              <motion.div className="brain-compose-row brain-compose-from" {...arrive(0)}>
                <span className="brain-compose-label text-control">From</span>
                <span className="brain-compose-value text-table">{fromValue()}</span>
              </motion.div>
              <motion.div className="brain-compose-row" {...arrive(1)}>
                <label htmlFor={toId} className="brain-compose-label text-control">
                  To
                </label>
                <input
                  ref={toRef}
                  id={toId}
                  className="brain-compose-input text-table"
                  type="text"
                  inputMode="email"
                  autoComplete="email"
                  value={to}
                  onChange={recipient(setTo)}
                  readOnly={busy}
                  placeholder="name@example.com"
                  aria-invalid={validation?.field === "to" || undefined}
                  aria-describedby={validation?.field === "to" ? errorId : undefined}
                />
                <AnimatePresence initial={false}>
                  {!showCopies && (
                    <Button
                      type="button"
                      variant="quiet"
                      className="brain-compose-copies"
                      disabled={busy}
                      onClick={() => {
                        focusCcRef.current = true;
                        setRevealedByPress(true);
                        setShowCopies(true);
                      }}
                      exit={{ opacity: 0, transition: { duration: DUR.fast } }}
                    >
                      Cc Bcc
                    </Button>
                  )}
                </AnimatePresence>
              </motion.div>
              {showCopies && (
                /* From a press the two rows grow into place on the select
                   spring and the caret lands in Cc; a resumed draft that
                   already carries a copy shows them standing, arriving in the
                   stagger between To and Subject. */
                <motion.div
                  className="brain-compose-copies-rows"
                  {...(revealedByPress
                    ? {
                        initial: reduce ? (false as const) : { height: 0, opacity: 0 },
                        animate: { height: "auto", opacity: 1 },
                        transition: SPRING_SELECT,
                      }
                    : arrive(2))}
                >
                  <div className="brain-compose-row">
                    <label htmlFor={ccId} className="brain-compose-label text-control">
                      Cc
                    </label>
                    <input
                      ref={ccRef}
                      id={ccId}
                      className="brain-compose-input text-table"
                      type="text"
                      inputMode="email"
                      value={cc}
                      onChange={recipient(setCc)}
                      readOnly={busy}
                      aria-invalid={validation?.field === "cc" || undefined}
                      aria-describedby={validation?.field === "cc" ? errorId : undefined}
                    />
                  </div>
                  <div className="brain-compose-row">
                    <label htmlFor={bccId} className="brain-compose-label text-control">
                      Bcc
                    </label>
                    <input
                      id={bccId}
                      className="brain-compose-input text-table"
                      type="text"
                      inputMode="email"
                      value={bcc}
                      onChange={recipient(setBcc)}
                      readOnly={busy}
                      aria-invalid={validation?.field === "bcc" || undefined}
                      aria-describedby={validation?.field === "bcc" ? errorId : undefined}
                    />
                  </div>
                </motion.div>
              )}
              {/* The subject is the letter's heading, not a field with a
                  label: it stands on the values' rule at the subheading size. */}
              <motion.div className="brain-compose-row brain-compose-subject" {...arrive(3)}>
                <label htmlFor={subjectId} className="sr-only">
                  Subject
                </label>
                <input
                  id={subjectId}
                  className="brain-compose-input text-subheading"
                  type="text"
                  value={subject}
                  onChange={(event) => {
                    setSubject(event.currentTarget.value);
                    typed();
                  }}
                  readOnly={busy}
                  placeholder="Subject"
                />
              </motion.div>
            </div>

            {/* THE SHELF: the letter's files under Subject, over the fold. A
                chip per file, the document glyph, the name, the size and a
                bare cross; the whole chip is the one button, and pressing it
                takes the file off. It grows in the way Cc and Bcc do, on the
                select spring, with the chips' ring room travelling with it
                (`CHIP_ROW_RING`, the Tasks chips' own clip); a chip comes and
                goes by opacity over DUR.fast and the rest close up on the
                same spring. Reduced motion: the fades only. */}
            <AnimatePresence initial={false}>
              {attachments.length > 0 && (
                <motion.div
                  key="shelf"
                  ref={shelfRef}
                  role="group"
                  aria-label="Attachments"
                  className="brain-compose-shelf"
                  initial={
                    reduce
                      ? { opacity: 0 }
                      : { height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0, marginTop: 0, marginBottom: 0 }
                  }
                  animate={{
                    height: "auto",
                    opacity: 1,
                    paddingTop: CHIP_ROW_RING,
                    paddingBottom: CHIP_ROW_RING,
                    marginTop: CHIP_ROW_AIR - CHIP_ROW_RING,
                    marginBottom: CHIP_ROW_AIR - CHIP_ROW_RING,
                  }}
                  exit={
                    reduce
                      ? { opacity: 0, transition: { duration: DUR.fast } }
                      : { height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0, marginTop: 0, marginBottom: 0 }
                  }
                  transition={reduce ? { duration: DUR.fast } : SPRING_SELECT}
                >
                  <AnimatePresence initial={false} mode="popLayout">
                    {attachments.map((attachment) => {
                      const size = formatBytes(attachment.file.size);
                      return (
                        <motion.div
                          key={attachment.id}
                          className="brain-compose-shelf-item"
                          layout={reduce ? false : "position"}
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={{
                            opacity: { duration: DUR.fast },
                            layout: SPRING_SELECT,
                          }}
                        >
                          <Chip
                            icon="document-text-linear"
                            className="brain-compose-attachment"
                            data-attachment={attachment.id}
                            aria-label={`Remove ${attachment.filename}, ${size}`}
                            title="Remove"
                            aria-disabled={busy || undefined}
                            onClick={() => detach(attachment.id)}
                          >
                            <span className="brain-compose-attachment-name">
                              {attachment.filename}
                            </span>
                            <span className="brain-compose-attachment-size text-caption tabular-nums">
                              {size}
                            </span>
                            <Icon
                              name="close-linear"
                              size={14}
                              className="brain-compose-attachment-remove"
                            />
                          </Chip>
                        </motion.div>
                      );
                    })}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>

            {initialDraft.notice && (
              /* What a forward or a recovered draft has to say about itself
                 arrives on the same half step as a resumed copy. */
              <motion.p className="brain-compose-notice text-caption" {...arrive(2)}>
                {initialDraft.notice}
              </motion.p>
            )}

            {/* The one line on the sheet: where the envelope ends and the
                letter begins. It arrives with the body. */}
            <motion.div className="brain-compose-fold" aria-hidden {...arrive(4)} />

            {/* Named through `aria-labelledby`, not a wrapping label: a label
                around an embedded textbox names it with its VALUE too (the
                accessible-name rule for embedded controls), so "Message" grew
                into "Message Never mind" the moment a letter stood. */}
            <motion.div className="brain-compose-body" {...arrive(4)}>
              <span id={bodyLabelId} className="sr-only">
                Message
              </span>
              <textarea
                ref={bodyRef}
                aria-labelledby={bodyLabelId}
                value={text}
                onChange={(event) => {
                  setText(event.currentTarget.value);
                  typed();
                }}
                readOnly={busy}
                placeholder="Write a message…"
                className="text-body"
              />
            </motion.div>
          </div>
        </ScrollEdge>
      </form>
    </MailComposePaper>
  );
}

/**
 * The From menu: the value as a quiet button with a chevron, and a Radix menu
 * of the accounts that can send, the current one marked. Controlled, so Esc
 * can close it by hand: the menu's dismissable layer and the dialog's are two
 * copies that cannot see each other, so the menu takes Esc itself and the
 * sheet, told through `onOpenChange`, refuses the same key.
 */
function FromSwitch({
  account,
  accounts,
  fromName,
  disabled,
  onOpenChange,
  onSwitch,
}: {
  account: PublicMailAccount;
  accounts: readonly PublicMailAccount[];
  fromName: string;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onSwitch: (accountId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const setOpenState = (next: boolean) => {
    setOpen(next);
    onOpenChange(next);
  };
  return (
    <Dropdown.Root open={open} onOpenChange={setOpenState}>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          className="brain-compose-from-switch"
          aria-label={`From: ${fromName}`}
          disabled={disabled}
        >
          {/* A switch moves the letter under a sheet that stays, so the one
              thing that changes on it is this word: the old name and the new
              cross in one cell over DUR.fast. Opacity only, which is also
              what reduced motion keeps. */}
          <span className="brain-compose-from-name">
            <AnimatePresence initial={false}>
              <motion.span
                key={account.accountId}
                className="brain-compose-from-word truncate"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: DUR.fast }}
              >
                {fromName}
              </motion.span>
            </AnimatePresence>
          </span>
          <Icon name="alt-arrow-down-linear" size={14} className="brain-compose-from-mark" />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className="brain-menu brain-compose-from-menu z-[var(--z-modal)]"
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            setOpenState(false);
          }}
        >
          <Dropdown.RadioGroup
            value={account.accountId}
            onValueChange={(accountId) => {
              if (accountId === account.accountId) return;
              onSwitch(accountId);
            }}
          >
            {accounts.map((candidate) => (
              <Dropdown.RadioItem
                key={candidate.accountId}
                value={candidate.accountId}
                className="brain-menu-item"
              >
                <span className="brain-compose-from-lines">
                  <span className="truncate">
                    {candidate.displayName || candidate.emailAddress}
                  </span>
                  {candidate.displayName && (
                    <span className="text-caption truncate text-ink-3">
                      {candidate.emailAddress}
                    </span>
                  )}
                </span>
                {candidate.accountId === account.accountId && (
                  <Icon name="check-linear" size={14} className="shrink-0 text-ink-2" />
                )}
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function composerTitle(mode: MailComposerDraft["mode"]): string {
  if (mode === "reply") return "Reply";
  if (mode === "replyAll") return "Reply all";
  if (mode === "forward") return "Forward";
  return "New message";
}
