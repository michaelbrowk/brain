"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  animate,
  motion,
  useDragControls,
  useMotionValue,
  useReducedMotion,
} from "framer-motion";
import { SPRING_SHEET, SPRING_SHEET_GESTURE } from "@/lib/motion";
import {
  describeMailRecipientProblem,
  parseMailRecipientFields,
} from "@/lib/mail/recipients";
import { Button, IconButton } from "./ui/button";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { Icon } from "./ui/icon";
import { Kbd } from "./ui/primitives";
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

/** How far (px) or how fast (px/s) a downward drag must go to dismiss. */
const SHEET_DISMISS_OFFSET = 120;
const SHEET_DISMISS_VELOCITY = 800;

/** True while the pointer carries files. A file dropped on an unguarded page
 *  navigates the browser to the file itself, which takes the unsaved draft in
 *  React state with it — so the composer claims the drop and refuses it out
 *  loud. Compose-time attachments do not exist yet: `MailSendInput` carries
 *  no attachment list and the draft API stores none. */
function draggingFiles(event: DragEvent<HTMLElement>): boolean {
  const types = event.dataTransfer?.types;
  return types ? Array.from(types).includes("Files") : false;
}

/** True below md, where the composer keeps the sheet form: it slides in from
 *  the bottom edge and the grip drags it away. Read synchronously on the
 *  first client render so the entrance actually plays, then kept live. Guards
 *  the matchMedia surface for environments (jsdom) that stub it partially. */
function matchesSheet(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(max-width: 767px)").matches === true;
}

function useSheetGesture(): boolean {
  const [sheet, setSheet] = useState(matchesSheet);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 767px)");
    const update = () => setSheet(query.matches === true);
    update();
    if (typeof query.addEventListener !== "function") return;
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return sheet;
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
  const [to, setTo] = useState(initialDraft.to);
  const [cc, setCc] = useState(initialDraft.cc);
  const [bcc, setBcc] = useState(initialDraft.bcc);
  const [subject, setSubject] = useState(initialDraft.subject);
  const [text, setText] = useState(initialDraft.text);
  const [showCopies, setShowCopies] = useState(Boolean(initialDraft.cc || initialDraft.bcc));
  const [validationError, setValidationError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  /** The Discard button, held past the state clear so the confirmation can
   *  hand focus back to it — Radix asks where focus goes as it unmounts, and
   *  Cancel has to leave the composer exactly as it was. */
  const discardInvokerRef = useRef<HTMLElement | null>(null);
  const errorId = useId();
  const toId = useId();
  const ccId = useId();
  const bccId = useId();
  const subjectId = useId();
  const reportedInitial = useRef(false);
  const reduce = useReducedMotion();
  const sheet = useSheetGesture();
  const dragControls = useDragControls();
  const sheetY = useMotionValue(0);

  useEffect(() => {
    if (!reportedInitial.current) {
      reportedInitial.current = true;
      return;
    }
    onDraftChange({ to, cc, bcc, subject, text });
  }, [to, cc, bcc, subject, text, onDraftChange]);

  const dirty = Boolean(to.trim() || cc.trim() || bcc.trim() || subject.trim() || text.trim());

  const close = () => {
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
      setValidationError(describeMailRecipientProblem(recipients.problem));
      return;
    }
    setValidationError(null);
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
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="brain-composer"
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
      {/* A thick sheet on the pane's inset. Desktop materializes it on
          data-state (keyframes in globals.css); below md it keeps the sheet
          form — framer slides it in and the grip drags it away on a spring
          from the current value, past the threshold into a dismiss. Every
          writing surface inside is a paper inset: glass never sits under
          editable text. */}
      <motion.form
        aria-label={composerTitle(initialDraft.mode)}
        aria-describedby={validationError || sendError ? errorId : undefined}
        onSubmit={submit}
        onKeyDown={onKeyDown}
        data-state="open"
        className="brain-composer-sheet"
        style={sheet ? { y: sheetY } : undefined}
        initial={sheet && !reduce ? { y: 48 } : false}
        animate={sheet ? { y: 0 } : undefined}
        transition={reduce ? { duration: 0 } : SPRING_SHEET}
        drag={sheet ? "y" : false}
        dragControls={dragControls}
        dragListener={false}
        dragConstraints={{ top: 0 }}
        dragElastic={0}
        dragMomentum={false}
        onDragEnd={(_, info) => {
          if (
            info.offset.y > SHEET_DISMISS_OFFSET ||
            info.velocity.y > SHEET_DISMISS_VELOCITY
          ) {
            close();
            return;
          }
          animate(sheetY, 0, reduce ? { duration: 0 } : SPRING_SHEET_GESTURE);
        }}
      >
        {sheet && (
          <div
            aria-hidden
            className="brain-composer-grip"
            onPointerDown={(event) => dragControls.start(event)}
          >
            <span />
          </div>
        )}

        <header className="brain-composer-head">
          <h1 className="text-subheading min-w-0 flex-1 truncate text-ink">
            {composerTitle(initialDraft.mode)}
          </h1>
          <span
            aria-live="polite"
            className="text-control hidden shrink-0 items-center gap-1 text-ink-2 sm:flex"
          >
            {saveStatus === "saved" && (
              <Icon name="check-linear" size={13} aria-hidden />
            )}
            {saveStatusLabel(saveStatus)}
          </span>
          <IconButton
            type="button"
            size={28}
            aria-label="Close draft"
            title="Close draft"
            onClick={close}
            className="brain-touch-hit shrink-0"
          >
            <Icon name="close-linear" size={16} />
          </IconButton>
        </header>

        <ScrollEdge variant="fade" className="brain-composer-scroll">
          <div className="brain-composer-fields">
            {/* From is the one line here nobody can act on — the composer
                cannot switch account — so it reads as the envelope's meta on
                the fields' own label rule instead of sitting in the header
                pretending to be a control next to the save status. */}
            <p className="brain-composer-from text-control">
              <span>From</span>
              <span className="min-w-0 truncate">
                {account.displayName || account.emailAddress}
              </span>
            </p>
            <div className="brain-composer-row">
              <label
                htmlFor={toId}
                className="field brain-composer-field brain-touch-min"
              >
                <span>To</span>
                <input
                  id={toId}
                  type="text"
                  inputMode="email"
                  autoComplete="email"
                  value={to}
                  onChange={(event) => setTo(event.currentTarget.value)}
                  placeholder="name@example.com"
                />
              </label>
              {!showCopies && (
                <Button
                  type="button"
                  variant="quiet"
                  className="brain-composer-copies tint-hover brain-touch-hit shrink-0"
                  onClick={() => setShowCopies(true)}
                >
                  Cc Bcc
                </Button>
              )}
            </div>
            {showCopies && (
              <>
                <label
                  htmlFor={ccId}
                  className="field brain-composer-field brain-touch-min"
                >
                  <span>Cc</span>
                  <input
                    id={ccId}
                    type="text"
                    inputMode="email"
                    value={cc}
                    onChange={(event) => setCc(event.currentTarget.value)}
                  />
                </label>
                <label
                  htmlFor={bccId}
                  className="field brain-composer-field brain-touch-min"
                >
                  <span>Bcc</span>
                  <input
                    id={bccId}
                    type="text"
                    inputMode="email"
                    value={bcc}
                    onChange={(event) => setBcc(event.currentTarget.value)}
                  />
                </label>
              </>
            )}
            <label
              htmlFor={subjectId}
              className="field brain-composer-field brain-touch-min"
            >
              <span>Subject</span>
              <input
                id={subjectId}
                type="text"
                value={subject}
                onChange={(event) => setSubject(event.currentTarget.value)}
                placeholder="Subject"
              />
            </label>
          </div>

          {initialDraft.notice && (
            <p className="text-caption brain-composer-notice">{initialDraft.notice}</p>
          )}

          <label className="brain-composer-body">
            <span className="sr-only">Message</span>
            <textarea
              autoFocus
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
              placeholder="Write a message…"
              className="text-body"
            />
          </label>
        </ScrollEdge>

        <footer className="brain-composer-actions">
          <span className="text-control flex min-w-0 flex-1 items-center gap-1 text-ink-2">
            <span
              id={errorId}
              role={validationError || sendError ? "alert" : undefined}
              className={validationError || sendError ? "text-red" : undefined}
            >
              {validationError || sendError || ""}
            </span>
            {sendError && sendErrorSettings && onOpenSettings && (
              <Button
                type="button"
                variant="quiet"
                onClick={(event) => onOpenSettings(event.currentTarget)}
              >
                Mail settings
              </Button>
            )}
            {saveStatus === "error" && (
              <Button type="button" variant="quiet" onClick={onRetrySave}>
                Retry
              </Button>
            )}
          </span>
          <span aria-live="polite" className="text-control shrink-0 text-ink-2 sm:hidden">
            {saveStatusLabel(saveStatus)}
          </span>
          {/* The shortcut wears the Kbd atom, not the button register beside
              it: on ink-2 at Kbd size it was reading as a third control in the
              row (ink-3 is not an option — §1 bans it on glass). The words
              live in Send's own tooltip. */}
          <span aria-hidden className="hidden shrink-0 md:block">
            <Kbd>⌘↵</Kbd>
          </span>
          {!sendBlocked && (
            <Button
              type="button"
              variant="destructive"
              aria-label="Discard draft"
              title="Discard draft"
              className="brain-touch-hit shrink-0"
              onClick={(event) => discard(event)}
            >
              <Icon name="trash-bin-trash-linear" size={16} aria-hidden />
              Discard
            </Button>
          )}
          <Button
            type="submit"
            variant="ink"
            title="Send (⌘↵)"
            disabled={sending || sendBlocked}
            className="brain-touch-hit shrink-0"
          >
            <Icon name="plain-linear" size={16} aria-hidden />
            {sending ? "Sending" : "Send"}
          </Button>
        </footer>
      </motion.form>

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
    </div>
  );
}

function composerTitle(mode: MailComposerDraft["mode"]): string {
  if (mode === "reply") return "Reply";
  if (mode === "replyAll") return "Reply all";
  if (mode === "forward") return "Forward";
  return "New message";
}

function saveStatusLabel(status: MailComposerSaveStatus): string {
  if (status === "saving") return "Saving…";
  if (status === "saved") return "Saved";
  if (status === "error") return "Not saved";
  return "";
}
