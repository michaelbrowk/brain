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
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { DUR } from "@/lib/motion";

import { useSheetGesture } from "./use-sheet-gesture";
import {
  describeMailRecipientProblem,
  parseMailRecipientFields,
  type MailRecipientField,
} from "@/lib/mail/recipients";
import { Button, IconButton } from "./ui/button";
import { ConfirmDialog } from "./ui/confirm-dialog";
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

/** True while the pointer carries files. A file dropped on an unguarded page
 *  navigates the browser to the file itself, which takes the unsaved draft in
 *  React state with it — so the sheet claims the drop and refuses it out
 *  loud. Compose-time attachments do not exist yet: `MailSendInput` carries
 *  no attachment list and the draft API stores none. */
function draggingFiles(event: DragEvent<HTMLElement>): boolean {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes("Files") : false;
}

/** What the actions row's slot says, if anything. One sentence at a time, in
 *  this order: a refusal the writer can fix stands over a refusal from the
 *  service, and both stand over a save that did not land. */
type SlotMessage = {
  readonly key: "validation" | "send" | "save";
  readonly text: string;
  readonly role: "alert" | "status";
};

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
  focusOnOpen,
  onDismiss,
  children,
}: {
  title: string;
  /** While a send is out nothing on the sheet answers: Esc and the cross are
   *  inert, so the dialog refuses its own dismissal until it is over. */
  sending: boolean;
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
            if (sending) event.preventDefault();
          }}
          // The sheet is the whole window, so nothing outside it is a place
          // to press: a toast standing over it must not close the letter.
          onInteractOutside={(event) => event.preventDefault()}
        >
          <motion.div
            className="brain-compose-paper"
            data-sheet={sheet ? "" : undefined}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduce ? DUR.fast : DUR.fast }}
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
  onToast,
}: {
  account: PublicMailAccount;
  initialDraft: MailComposerDraft;
  sending: boolean;
  sendError: string | null;
  sendBlocked: boolean;
  /** The send error is a reauth failure — offer Mail settings next to it. */
  sendErrorSettings?: boolean;
  saveStatus?: MailComposerSaveStatus;
  onCancel: () => void;
  onDiscard: () => void;
  onDraftChange: (fields: MailComposerFields) => void;
  onRetrySave: () => void;
  onSend: (input: MailSendInput) => void;
  onOpenSettings?: (invoker: HTMLElement) => void;
  onToast?: (title: string) => void;
}) {
  const sendTitle = useShortcutTitle("Send", "⌘↵");
  const [to, setTo] = useState(initialDraft.to);
  const [cc, setCc] = useState(initialDraft.cc);
  const [bcc, setBcc] = useState(initialDraft.bcc);
  const [subject, setSubject] = useState(initialDraft.subject);
  const [text, setText] = useState(initialDraft.text);
  const [showCopies, setShowCopies] = useState(Boolean(initialDraft.cc || initialDraft.bcc));
  const [validation, setValidation] = useState<{
    readonly field: MailRecipientField;
    readonly message: string;
  } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** The Discard button, held past the state clear so the confirmation can
   *  hand focus back to it — Radix asks where focus goes as it unmounts, and
   *  Cancel has to leave the composer exactly as it was. */
  const discardInvokerRef = useRef<HTMLElement | null>(null);
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
  const reportedInitial = useRef(false);
  const title = composerTitle(initialDraft.mode);
  const fromName = account.displayName || account.emailAddress;

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

  const dirty = Boolean(to.trim() || cc.trim() || bcc.trim() || subject.trim() || text.trim());

  /** Close keeps the draft and asks nothing. Inert while a send is out. */
  const close = () => {
    if (sending) return;
    onCancel();
  };

  /**
   * Discard is not Close. Closing keeps the draft — it is already saved and
   * the writer finds it in Drafts — and asks nothing. Discard DELETES it from
   * the provider, which nothing undoes, so it asks, and the question names
   * what disappears rather than saying "this draft". An empty composer has
   * nothing to lose and goes without a word.
   */
  const discard = (event: { currentTarget: HTMLElement }) => {
    if (sending) return;
    if (dirty) {
      discardInvokerRef.current = event.currentTarget;
      setConfirmDiscard(true);
      return;
    }
    onDiscard();
  };

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    if (sending || sendBlocked) return;
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
    onSend({
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
      // The sheet has no attachment control in this release, and a message
      // a person typed is never marked as an agent's.
      attachments: [],
      origin: "app",
      agentLine: false,
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };

  /** A recipient field edited after a refusal clears it: the writer is
   *  already doing what the sentence asked. */
  const recipient =
    (set: (value: string) => void) => (event: FormEvent<HTMLInputElement>) => {
      set(event.currentTarget.value);
      if (validation) setValidation(null);
    };

  const message: SlotMessage | null = validation
    ? { key: "validation", text: validation.message, role: "alert" }
    : sendError
      ? { key: "send", text: sendError, role: "alert" }
      : saveStatus === "error"
        ? { key: "save", text: "Not saved", role: "status" }
        : null;

  return (
    <MailComposePaper
      title={title}
      sending={sending}
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
        }}
        onDrop={(event) => {
          if (!draggingFiles(event)) return;
          event.preventDefault();
          onToast?.("Attachments aren’t supported yet.");
        }}
      >
        {/* THE ACTIONS ROW, ON TOP. Send stands where a thumb reaches it and
            where no keyboard can cover it: the phone's standing failure was a
            footer under the keys. The slot in the middle always keeps its
            place, so a sentence arriving in it moves nothing else. On the
            phone From reads here as quiet text and yields the row to the slot
            while a sentence stands (`data-message`). */}
        <div
          className="brain-compose-actions"
          data-message={message ? "" : undefined}
        >
          <IconButton
            type="button"
            size={28}
            aria-label="Close draft"
            title="Close draft"
            onClick={close}
            className="brain-touch-hit"
          >
            <Icon name="close-linear" size={16} />
          </IconButton>
          <span className="brain-compose-actions-from text-control">{fromName}</span>
          <div className="brain-compose-slot text-control">
            <AnimatePresence initial={false}>
              {message && (
                <motion.span
                  key={message.key}
                  className="brain-compose-slot-line"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: DUR.fast } }}
                  transition={{ duration: DUR.fast }}
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
          {/* Attachments are the next slice; the clip stands in its place,
              disabled and quiet, so the row does not reflow when it arrives. */}
          <IconButton
            type="button"
            size={28}
            aria-label="Attach files"
            title="Attachments aren’t available yet."
            disabled
            className="brain-touch-hit"
          >
            <Icon name="paperclip-linear" size={16} />
          </IconButton>
          {!sendBlocked && (
            <IconButton
              type="button"
              size={28}
              aria-label="Discard draft"
              title="Discard draft"
              onClick={(event) => discard(event)}
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
          {/* The one ink fill on the surface (§2 → Primary). The label swaps
              inside a box that never changes size: a hidden "Sending" holds
              the width, so the button is the same object before and after
              the press. The wait is a glyph, and the press is refused by the
              submit handler rather than by `disabled`, so the button still
              reads as the way out. */}
          <Button
            type="submit"
            variant="ink"
            title={sendTitle}
            aria-busy={sending || undefined}
            disabled={sendBlocked}
            className="brain-compose-send brain-touch-hit"
          >
            <span className="brain-compose-send-glyph">
              <Icon name={sending ? "restart-linear" : "plain-linear"} size={16} />
            </span>
            <span className="brain-compose-send-label">
              <span aria-hidden className="brain-compose-send-ghost">
                Sending
              </span>
              <span className="brain-compose-send-word">{sending ? "Sending" : "Send"}</span>
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
              <div className="brain-compose-row brain-compose-from">
                <span className="brain-compose-label text-control">From</span>
                <span className="brain-compose-value text-table truncate">{fromName}</span>
              </div>
              <div className="brain-compose-row">
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
                  readOnly={sending}
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
                      onClick={() => {
                        focusCcRef.current = true;
                        setShowCopies(true);
                      }}
                      exit={{ opacity: 0, transition: { duration: DUR.fast } }}
                    >
                      Cc Bcc
                    </Button>
                  )}
                </AnimatePresence>
              </div>
              {showCopies && (
                <div className="brain-compose-copies-rows">
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
                      readOnly={sending}
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
                      readOnly={sending}
                      aria-invalid={validation?.field === "bcc" || undefined}
                      aria-describedby={validation?.field === "bcc" ? errorId : undefined}
                    />
                  </div>
                </div>
              )}
              {/* The subject is the letter's heading, not a field with a
                  label: it stands on the values' rule at the subheading size. */}
              <div className="brain-compose-row brain-compose-subject">
                <label htmlFor={subjectId} className="sr-only">
                  Subject
                </label>
                <input
                  id={subjectId}
                  className="brain-compose-input text-subheading"
                  type="text"
                  value={subject}
                  onChange={(event) => setSubject(event.currentTarget.value)}
                  readOnly={sending}
                  placeholder="Subject"
                />
              </div>
            </div>

            {initialDraft.notice && (
              <p className="brain-compose-notice text-caption">{initialDraft.notice}</p>
            )}

            {/* The one line on the sheet: where the envelope ends and the
                letter begins. */}
            <div className="brain-compose-fold" aria-hidden />

            <label className="brain-compose-body">
              <span className="sr-only">Message</span>
              <textarea
                ref={bodyRef}
                value={text}
                onChange={(event) => setText(event.currentTarget.value)}
                readOnly={sending}
                placeholder="Write a message…"
                className="text-body"
              />
            </label>
          </div>
        </ScrollEdge>
      </form>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this draft?"
        description={
          subject.trim()
            ? `“${subject.trim()}” will be deleted from Drafts. This can’t be undone — closing the composer instead keeps it there.`
            : "This draft will be deleted from Drafts. This can’t be undone — closing the composer instead keeps it there."
        }
        confirmLabel="Discard"
        returnFocus={() => discardInvokerRef.current}
        onConfirm={() => {
          setConfirmDiscard(false);
          onDiscard();
        }}
      />
    </MailComposePaper>
  );
}

function composerTitle(mode: MailComposerDraft["mode"]): string {
  if (mode === "reply") return "Reply";
  if (mode === "replyAll") return "Reply all";
  if (mode === "forward") return "Forward";
  return "New message";
}
