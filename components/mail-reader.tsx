"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { DUR, EASE_OUT, pageTransition } from "@/lib/motion";
import { Button, IconButton } from "./ui/button";
import { Empty } from "./ui/empty";
import { Icon } from "./ui/icon";
import { Skeleton } from "./ui/primitives";
import { ScrollEdge } from "./ui/scroll-edge";
import { ToolbarPill } from "./ui/toolbar-pill";
import { MailSenderIcon } from "./mail-sender-icon";
import { formatThreadTime } from "./mail-thread-list";
import type {
  MailAccountCapabilities,
  MailSurfaceClient,
  MailSystemMailbox,
  MailThreadDetail,
  MailThreadListItem,
} from "./mail-surface-client";
import type { MailMessageDto } from "@/lib/mail/message-types";
import {
  MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY,
  MAIL_INLINE_IMAGE_MAX_BYTES,
  type MailContentAttachmentDto,
  type MailMessageContent,
} from "@/lib/mail/content-types";
import {
  createMailHtmlDocument,
  MAIL_READER_IFRAME_SANDBOX,
  referencedInlineCidAttachments,
  referencedRemoteImageIds,
} from "@/lib/mail/reader-html";
import {
  preferSanitizedHtmlAlternative,
  readableMailBody,
  sanitizeSnippet,
  readableSanitizedMailHtml,
} from "@/lib/mail/reader-content";
import {
  mailCidFetchGate,
  mailContentFetchGate,
} from "@/lib/mail/inline-fetch-gate";

export type MailReaderState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly thread: MailThreadListItem }
  | { readonly kind: "error"; readonly thread: MailThreadListItem }
  | { readonly kind: "ready"; readonly detail: MailThreadDetail };

export type MailReaderAction =
  | "toggle-read"
  | "archive"
  | "trash"
  | "restore"
  | "mark-spam"
  | "unmark-spam"
  | "star"
  | "unstar";

export function MailReader({
  state,
  mutating,
  onBack,
  onRetry,
  onReply,
  onReplyAll,
  onForward,
  mailboxId,
  capabilities,
  onAction,
  contentClient,
}: {
  state: MailReaderState;
  mutating: boolean;
  onBack: () => void;
  onRetry: () => void;
  onReply: (detail: MailThreadDetail) => void;
  onReplyAll: (detail: MailThreadDetail) => void;
  onForward: (detail: MailThreadDetail) => void;
  mailboxId: MailSystemMailbox;
  capabilities: MailAccountCapabilities;
  onAction: (thread: MailThreadListItem, action: MailReaderAction) => void;
  contentClient: Pick<
    MailSurfaceClient,
    "getMessageContent" | "requestMessageContent"
  >;
}) {
  const reduce = useReducedMotion();
  if (state.kind === "idle") {
    return (
      <section
        aria-label="Message reader"
        className="hidden min-h-0 flex-1 items-center justify-center px-8 text-center panes:flex"
      >
        <Empty
          icon="letter-linear"
          title="Choose a message"
          hint="The conversation will open here"
        />
      </section>
    );
  }

  const thread = state.kind === "ready" ? state.detail.thread : state.thread;
  const directAction = capabilities.threadMutations
    ? directActionForMailbox(mailboxId)
    : null;
  const canReply = capabilities.reply && capabilities.send;
  const canForward =
    capabilities.compose && capabilities.send && capabilities.messageBodies;
  return (
    <section
      aria-label="Message reader"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      {/* The reader toolbar is pills in an OPAQUE paper strip above the
          scroller — the iframe scrolls under paper, never under glass
          (DESIGN.md v2 → Materials: glass only over its own scroller). On the
          canvas it stays opaque for exactly that reason and answers for its
          edges instead: no radius and no hairline, so it has no contour that
          could read as a plate while the message still passes behind
          something solid — measured ΔL 0.001 light / 0.004 dark from the
          canvas under it.
          The strip carries the SUBJECT and the message count: it is the one
          thing every message in the thread shares. A sender there would be
          the thread's first participant, which is the wrong name as soon as
          you scroll to a reply — each article names its own sender. */}
      <header className="brain-mail-reader-head">
        <IconButton
          type="button"
          size={28}
          aria-label={`Back to ${mailboxLabel(mailboxId)}`}
          onClick={onBack}
          className="brain-touch-hit -ml-2 panes:hidden!"
        >
          <Icon name="arrow-left-linear" size={16} />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h1 className="text-h3 truncate text-ink">
            {thread.subject || "(no subject)"}
          </h1>
          <p className="text-caption truncate text-ink-2">
            {thread.messageCount > 1 && `${thread.messageCount} messages`}
            {thread.messageCount > 1 && thread.lastMessageAt !== null && " · "}
            {thread.lastMessageAt !== null && formatThreadTime(thread.lastMessageAt)}
          </p>
        </div>
        {(canReply || capabilities.threadMutations || canForward) && (
          <ToolbarPill className="shrink-0">
            {/* The resting label is drawn only where the strip can hold it
                beside the subject's floor. The pill does not shrink, so the
                105 of "Mark unread" comes straight out of the subject
                wherever the head is short of room: one pane at 768 left it
                103 and clipped the caption under it. The width is
                `--breakpoint-strip` in globals.css, derived the way `panes`
                is — the head at its minimum plus the sidebar — and the token
                is the only place the number lives. Below it the action stays
                one press away in the ⋯ menu, which has carried it all along. */}
            {capabilities.threadMutations && (
              <Button
                type="button"
                variant="quiet"
                className="brain-touch-hit hidden! shrink-0 strip:inline-flex!"
                disabled={mutating || state.kind !== "ready"}
                onClick={() => onAction(thread, "toggle-read")}
              >
                {thread.unread ? "Mark read" : "Mark unread"}
              </Button>
            )}
            {directAction && (
              <Button
                type="button"
                variant="quiet"
                className="brain-touch-hit shrink-0"
                disabled={mutating || state.kind !== "ready"}
                onClick={() => onAction(thread, directAction.action)}
              >
                {directAction.label}
              </Button>
            )}
            {canReply && (
              <Button
                type="button"
                variant="quiet"
                className="brain-touch-hit shrink-0"
                disabled={state.kind !== "ready"}
                onClick={() => state.kind === "ready" && onReply(state.detail)}
              >
                Reply
              </Button>
            )}
            {(canReply || canForward || capabilities.threadMutations) && (
              <MailActionsMenu
                mailboxId={mailboxId}
                thread={thread}
                detail={state.kind === "ready" ? state.detail : null}
                disabled={mutating || state.kind !== "ready"}
                canReply={canReply}
                canForward={canForward}
                canMutate={capabilities.threadMutations}
                onReplyAll={onReplyAll}
                onForward={onForward}
                onAction={onAction}
              />
            )}
          </ToolbarPill>
        )}
      </header>

      {/* tabIndex lets the surface's Enter shortcut hand keyboard scrolling to
          this pane; data-mail-reader-scroll is its lookup handle. `relative`
          anchors the popLayout exit: the leaving thread is lifted out of flow
          at its measured spot, so the incoming one never waits on it and an
          interrupted enter keeps animating to opacity 1 instead of freezing.
          The edge is the FADE variant — a mask on the scroller, never a
          backdrop layer: the message iframe passes under it and glass may not
          (§13 → the hard rule). No scroll edge in Brain hard-clips. */}
      <ScrollEdge
        variant="fade"
        className="relative min-h-0 flex-1 outline-none"
        scrollerProps={{ tabIndex: -1, "data-mail-reader-scroll": "" }}
      >
        <AnimatePresence mode="popLayout">
          <motion.div
            key={thread.threadId}
            initial={reduce ? { opacity: 0 } : { opacity: 0, y: 2 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
            exit={pageTransition.exit}
            transition={{ duration: DUR.fast, ease: EASE_OUT }}
          >
            {state.kind === "loading" ? (
              <ReaderSkeleton />
            ) : state.kind === "error" ? (
              <div className="px-6 py-16 text-center">
                <p className="text-[14px] font-medium text-ink">Message couldn’t load</p>
                <p className="mt-1 text-[12px] text-ink-3">
                  Your mail is still on the server.
                </p>
                <Button variant="glass" className="mt-4" onClick={onRetry}>
                  Try again
                </Button>
              </div>
            ) : (
              <div>
                {state.detail.messages.length === 0 && (
                  <p className="px-6 py-16 text-center text-[13px] text-ink-3">
                    This conversation has no messages.
                  </p>
                )}
                {state.detail.messages.map((message, index) => (
                  <article
                    key={`${message.accountId}:${message.messageId}`}
                    aria-labelledby={`mail-message-${message.messageId}`}
                    className="px-5 py-5 md:px-8 md:py-6"
                  >
                    {/* The sender and its meta stand on the canvas; the body
                        below gets the sheet. Articles need no rule between
                        them — the sheet's own hairline is the boundary, and a
                        second one under it would double it. */}
                    <header className="flex min-w-0 items-start gap-3">
                      <MailSenderIcon
                        participants={message.from ? [message.from] : []}
                        size={32}
                      />
                      <div className="min-w-0 flex-1">
                        <h2
                          id={`mail-message-${message.messageId}`}
                          className="text-table truncate font-semibold text-ink"
                        >
                          {message.from?.name || message.from?.address || "Unknown sender"}
                        </h2>
                        <p className="text-caption truncate text-ink-3">
                          {message.from?.name && message.from.address
                            ? `${message.from.address} · `
                            : ""}
                          to {formatAddresses(message.to)}
                        </p>
                      </div>
                      <time
                        dateTime={
                          message.sentAt === null
                            ? undefined
                            : new Date(message.sentAt).toISOString()
                        }
                        className="text-caption shrink-0 tabular-nums text-ink-3"
                      >
                        {formatMessageTime(message.sentAt)}
                      </time>
                    </header>

                    {capabilities.messageBodies ? (
                      <MailMessageContentView
                        message={message}
                        client={contentClient}
                        priority={message.sentAt ?? index}
                      />
                    ) : (
                      <MailHeaderPreview message={message} />
                    )}
                  </article>
                ))}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </ScrollEdge>
    </section>
  );
}

function MailHeaderPreview({ message }: { message: MailMessageDto }) {
  const preview = sanitizeSnippet(message.snippet);
  return (
    <div className="brain-mail-sheet mx-auto mt-4 max-w-[76ch]">
      {preview && <MailTextBody text={preview} />}
      <p className={`${preview ? "mt-4" : ""} text-[12px] leading-relaxed text-ink-3`}>
        Header preview only. Brain currently syncs the sender, subject, date, and
        attachment status for this account. The message body stays on your mail
        server.
      </p>
    </div>
  );
}

const MAIL_ACTION_ITEM = "brain-menu-item";

function MailActionsMenu({
  mailboxId,
  thread,
  detail,
  disabled,
  canReply,
  canForward,
  canMutate,
  onReplyAll,
  onForward,
  onAction,
}: {
  mailboxId: MailSystemMailbox;
  thread: MailThreadListItem;
  detail: MailThreadDetail | null;
  disabled: boolean;
  canReply: boolean;
  canForward: boolean;
  canMutate: boolean;
  onReplyAll: (detail: MailThreadDetail) => void;
  onForward: (detail: MailThreadDetail) => void;
  onAction: (thread: MailThreadListItem, action: MailReaderAction) => void;
}) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <IconButton
          type="button"
          size={36}
          aria-label="More mail actions"
          title="More actions"
          className="brain-touch-hit"
          disabled={disabled}
        >
          <Icon name="menu-dots-bold" size={18} />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={8}
          className="brain-menu z-[var(--z-modal)] w-[190px]"
        >
            {(canReply || canForward) && (
              <>
                {canReply && (
                  <Dropdown.Item
                    className={MAIL_ACTION_ITEM}
                    disabled={detail === null}
                    onSelect={() => detail && onReplyAll(detail)}
                  >
                    Reply all
                  </Dropdown.Item>
                )}
                {canForward && (
                  <Dropdown.Item
                    className={MAIL_ACTION_ITEM}
                    disabled={detail === null}
                    onSelect={() => detail && onForward(detail)}
                  >
                    Forward
                  </Dropdown.Item>
                )}
              </>
            )}
            {(canReply || canForward) && canMutate && (
              <Dropdown.Separator className="brain-menu-sep" />
            )}
            {canMutate && (
              <Dropdown.Item
                className={MAIL_ACTION_ITEM}
                onSelect={() => onAction(thread, "toggle-read")}
              >
                {thread.unread ? "Mark read" : "Mark unread"}
              </Dropdown.Item>
            )}
            {canMutate && thread.starred ? (
              <Dropdown.Item
                className={MAIL_ACTION_ITEM}
                onSelect={() => onAction(thread, "unstar")}
              >
                Remove star
              </Dropdown.Item>
            ) : canMutate && mailboxId !== "spam" && mailboxId !== "trash" ? (
              <Dropdown.Item
                className={MAIL_ACTION_ITEM}
                onSelect={() => onAction(thread, "star")}
              >
                Star
              </Dropdown.Item>
            ) : null}
            {canMutate &&
              mailboxId !== "spam" &&
              mailboxId !== "trash" &&
              mailboxId !== "sent" && (
              <Dropdown.Item
                className={MAIL_ACTION_ITEM}
                onSelect={() => onAction(thread, "mark-spam")}
              >
                Mark as spam
              </Dropdown.Item>
            )}
            {canMutate && mailboxId !== "trash" && (
              <Dropdown.Item
                className={MAIL_ACTION_ITEM}
                onSelect={() => onAction(thread, "trash")}
              >
                Move to trash
              </Dropdown.Item>
            )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function directActionForMailbox(
  mailboxId: MailSystemMailbox,
): { readonly action: MailReaderAction; readonly label: string } | null {
  if (mailboxId === "inbox") return { action: "archive", label: "Archive" };
  if (mailboxId === "spam") {
    return { action: "unmark-spam", label: "Not spam" };
  }
  if (mailboxId === "trash") return { action: "restore", label: "Restore" };
  return null;
}

function mailboxLabel(mailboxId: MailSystemMailbox): string {
  if (mailboxId === "all") return "All Mail";
  return `${mailboxId.slice(0, 1).toUpperCase()}${mailboxId.slice(1)}`;
}

type ContentViewState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly content: Extract<MailMessageContent, { state: "ready" }> }
  | { readonly kind: "error" };

export const CONTENT_POLL_DEADLINE_MS = 30_000;
export const CONTENT_POLL_BASE_DELAY_MS = 300;
export const CONTENT_POLL_MAX_DELAY_MS = 2_400;
export const CONTENT_MAX_REQUESTS = 3;
/** Consecutive `transient` polls before the reader asks again instead of
 *  watching: the service retries a transient failure four times, 1s, 2s,
 *  4s apart, and after that nothing is queued, so a spent entry never
 *  becomes ready by being polled. */
export const CONTENT_TRANSIENT_POLLS_BEFORE_REQUEST = 3;
const MAIL_FRAME_MAX_AUTO_HEIGHT = 16_000;

function SanitizedHtmlMessageFrame({ documentHtml }: { readonly documentHtml: string }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const cleanupRef = useRef<() => void>(() => {});
  const [height, setHeight] = useState(1);
  const [scrollable, setScrollable] = useState(false);

  useEffect(() => {
    cleanupRef.current();
    cleanupRef.current = () => {};
    return () => {
      cleanupRef.current();
      cleanupRef.current = () => {};
    };
  }, [documentHtml]);

  const handleLoad = useCallback(() => {
    cleanupRef.current();
    const frame = frameRef.current;
    const frameDocument = frame?.contentDocument;
    const content = frameDocument?.getElementById("brain-mail-content");
    if (!frame || !frameDocument || !content) return;
    const documentElement = frameDocument.documentElement;

    const resize = () => {
      const frameChrome = Math.max(0, frame.offsetHeight - frame.clientHeight);
      const contentHeight = Math.max(
        content.scrollHeight,
        content.getBoundingClientRect().height,
      );
      const uncappedHeight = Math.max(1, Math.ceil(contentHeight + frameChrome));
      const nextScrollable = uncappedHeight > MAIL_FRAME_MAX_AUTO_HEIGHT;
      const nextHeight = Math.min(uncappedHeight, MAIL_FRAME_MAX_AUTO_HEIGHT);
      documentElement.style.overflowY = nextScrollable ? "auto" : "hidden";
      setHeight((current) => (current === nextHeight ? current : nextHeight));
      setScrollable((current) =>
        current === nextScrollable ? current : nextScrollable,
      );
    };
    resize();

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(content);
    const images = [...content.querySelectorAll("img")];
    for (const image of images) {
      image.addEventListener("load", resize);
      image.addEventListener("error", resize);
    }
    frame.contentWindow?.addEventListener("resize", resize);
    const animationFrame = frame.contentWindow?.requestAnimationFrame(resize) ?? null;

    cleanupRef.current = () => {
      observer?.disconnect();
      for (const image of images) {
        image.removeEventListener("load", resize);
        image.removeEventListener("error", resize);
      }
      frame.contentWindow?.removeEventListener("resize", resize);
      if (animationFrame !== null) {
        frame.contentWindow?.cancelAnimationFrame(animationFrame);
      }
    };
  }, []);

  return (
    <iframe
      ref={frameRef}
      title="Sanitized HTML message"
      sandbox={MAIL_READER_IFRAME_SANDBOX}
      referrerPolicy="no-referrer"
      srcDoc={documentHtml}
      scrolling={scrollable ? "yes" : "no"}
      onLoad={handleLoad}
      style={{ height: `${height}px`, overflow: "hidden" }}
      /* The sheet around it carries the radius and the hairline now, so the
         frame draws neither — a ring inside a ring is two edges for one
         boundary. The sandbox, the srcDoc and the referrer policy above are
         the security model and are untouched. */
      className="block w-full bg-paper"
    />
  );
}

function MailMessageContentView({
  message,
  client,
  priority,
}: {
  message: MailMessageDto;
  client: Pick<MailSurfaceClient, "getMessageContent" | "requestMessageContent">;
  priority: number;
}) {
  const reduce = useReducedMotion();
  const [state, setState] = useState<ContentViewState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  // One counter for the open: the body's requests and the images' re-asks
  // are the same message-content POST, and CONTENT_MAX_REQUESTS bounds
  // their total.
  const contentRequests = useRef(0);
  const readyContent = state.kind === "ready" ? state.content : null;
  const readableHtml = readableSanitizedMailHtml(readyContent?.htmlBody ?? null);
  const readableText = readableMailBody(readyContent?.textBody ?? null);
  const renderHtml = preferSanitizedHtmlAlternative(readableText, readableHtml);
  const renderedHtml = renderHtml ? readableHtml : null;
  const cidSources = useInlineCidSources(
    message,
    readyContent,
    renderedHtml,
  );
  const remoteSources = useRemoteImageSources(
    message,
    renderedHtml,
    client,
    contentRequests,
  );

  useEffect(() => {
    const controller = new AbortController();
    const input = { accountId: message.accountId, messageId: message.messageId };
    let disposed = false;
    let deadline: number | null = null;
    const load = async () => {
      try {
        await mailContentFetchGate.run(
          controller.signal,
          async () => {
            deadline = window.setTimeout(() => {
              if (disposed || controller.signal.aborted) return;
              controller.abort();
              setState({ kind: "error" });
            }, CONTENT_POLL_DEADLINE_MS);
            try {
              contentRequests.current = 1;
              let content = await client.requestMessageContent(input, controller.signal);
              let pollAttempt = 0;
              let transientPolls = 0;
              while (!controller.signal.aborted) {
                if (content.state === "ready") {
                  setState({ kind: "ready", content });
                  return;
                }
                if (content.state === "permanent") {
                  setState({ kind: "error" });
                  return;
                }
                const canPoll = await waitForContentPoll(
                  controller.signal,
                  pollDelayMs(pollAttempt),
                );
                if (!canPoll) return;
                // "fetching" means the service still has work in hand.
                // "not_requested" means the entry is gone — a dropped cache
                // row never becomes ready on its own, and polling it just
                // shows the preview until the deadline. "transient" means the
                // service is between retries, and its budget is short: a run
                // of transient polls is the sign it has been spent. In both
                // cases ask again, a bounded number of times: a request is
                // what enqueues the work, and on an entry still retrying the
                // service answers "fetching" harmlessly.
                const spent =
                  content.state === "not_requested" ||
                  transientPolls >= CONTENT_TRANSIENT_POLLS_BEFORE_REQUEST;
                if (spent && contentRequests.current < CONTENT_MAX_REQUESTS) {
                  contentRequests.current += 1;
                  transientPolls = 0;
                  content = await client.requestMessageContent(input, controller.signal);
                } else {
                  content = await client.getMessageContent(input, controller.signal);
                  transientPolls =
                    content.state === "transient" ? transientPolls + 1 : 0;
                }
                pollAttempt += 1;
              }
            } finally {
              if (deadline !== null) window.clearTimeout(deadline);
              deadline = null;
            }
          },
          priority,
        );
      } catch {
        if (!controller.signal.aborted) setState({ kind: "error" });
      } finally {
        if (deadline !== null) window.clearTimeout(deadline);
      }
    };
    void load();
    return () => {
      disposed = true;
      if (deadline !== null) window.clearTimeout(deadline);
      controller.abort();
    };
  }, [attempt, client, message.accountId, message.messageId, priority]);

  if (state.kind === "loading") {
    const fallback = fallbackBody(message);
    if (fallback) {
      return (
        <div className="mx-auto mt-6 max-w-[76ch]">
          <MailTextBody text={fallback} />
          <p aria-live="polite" className="sr-only">Loading full message…</p>
        </div>
      );
    }
    return (
      <p aria-live="polite" className="mx-auto mt-6 max-w-[76ch] text-[13px] text-ink-3">
        Loading message…
      </p>
    );
  }

  if (state.kind === "error") {
    const fallback = fallbackBody(message);
    return (
      <div className="mx-auto mt-6 max-w-[76ch]">
        {fallback && <MailTextBody text={fallback} />}
        <p className={`${fallback ? "mt-4" : ""} text-[13px] text-ink-3`}>
          Message content couldn’t load.
        </p>
        <Button
          type="button"
          variant="ghost"
          className="mt-2"
          onClick={() => {
            setState({ kind: "loading" });
            setAttempt((value) => value + 1);
          }}
        >
          Try again
        </Button>
      </div>
    );
  }

  const { content } = state;
  const fallback = fallbackBody(message);
  const htmlDocument =
    renderHtml && readableHtml
      ? createMailHtmlDocument({
          sanitizedHtml: readableHtml,
          attachments: content.attachments,
          cidSources,
          remoteSources,
        })
      : null;
  // Opacity only: the frame height is owned by its ResizeObserver and must
  // never be animated. The skeleton-to-body swap reads as a fade, not a pop.
  return (
    <motion.div
      className="brain-mail-sheet mx-auto mt-4 max-w-[76ch]"
      initial={reduce ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: DUR.base, ease: EASE_OUT }}
    >
      {htmlDocument ? (
        <SanitizedHtmlMessageFrame documentHtml={htmlDocument} />
      ) : readableText ? (
        <MailTextBody text={readableText} />
      ) : fallback ? (
        <MailTextBody text={fallback} />
      ) : (
        <p className="text-[13px] text-ink-3">This message has no readable body.</p>
      )}
      {content.attachments.length > 0 && (
        <ul aria-label="Attachments" className="mt-6 flex flex-wrap gap-2 border-t border-hair-soft pt-4">
          {content.attachments.map((attachment) => (
            <li key={attachment.attachmentId} className="min-w-0">
              <a
                href={attachmentUrl(message.accountId, attachment.attachmentId)}
                download={attachment.filename ?? undefined}
                className="brain-mail-chip"
              >
                <Icon name="paperclip-linear" size={14} className="shrink-0 text-ink-2" />
                <span className="min-w-0 truncate">
                  {attachment.filename || "Attachment"}
                </span>
                <span className="text-caption shrink-0 tabular-nums text-ink-2">
                  {formatBytes(attachment.bytes)}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </motion.div>
  );
}

function useInlineCidSources(
  message: MailMessageDto,
  content: Extract<MailMessageContent, { state: "ready" }> | null,
  sanitizedHtml: string | null,
): ReadonlyMap<string, string> {
  const key = inlineCidContentKey(message, content, sanitizedHtml);
  const [state, setState] = useState<{
    readonly key: string;
    readonly sources: ReadonlyMap<string, string>;
  }>(() => ({ key: "", sources: new Map() }));

  useEffect(() => {
    const controller = new AbortController();
    const objectUrls: string[] = [];
    let disposed = false;
    if (content === null || sanitizedHtml === null) {
      return () => controller.abort();
    }
    const attachments = referencedInlineCidAttachments(
      sanitizedHtml,
      content.attachments,
    );
    if (attachments.length === 0) return () => controller.abort();

    const load = async () => {
      const loaded: Array<readonly [string, string]> = [];
      for (const attachment of attachments) {
        try {
          const blob = await mailCidFetchGate.run(
            controller.signal,
            async () => {
              const response = await fetch(
                attachmentUrl(message.accountId, attachment.attachmentId),
                {
                  signal: controller.signal,
                  credentials: "same-origin",
                  cache: "no-store",
                  referrerPolicy: "no-referrer",
                  redirect: "error",
                },
              );
              if (!isVerifiedInlineResponse(response, attachment)) {
                await response.body?.cancel().catch(() => undefined);
                return null;
              }
              const candidate = await response.blob();
              return candidate.size === attachment.bytes &&
                candidate.type === attachment.mimeType
                ? candidate
                : null;
            },
          );
          if (disposed || controller.signal.aborted || blob === null) {
            if (disposed || controller.signal.aborted) return;
            continue;
          }
          const source = URL.createObjectURL(blob);
          if (disposed || controller.signal.aborted) {
            URL.revokeObjectURL(source);
            return;
          }
          objectUrls.push(source);
          loaded.push([attachment.contentId!, source] as const);
        } catch {
          // A broken inline part leaves its inert alt text in the message.
        }
        if (disposed || controller.signal.aborted) return;
      }
      if (!disposed && !controller.signal.aborted) {
        setState({ key, sources: new Map(loaded) });
      }
    };
    void load();

    return () => {
      disposed = true;
      controller.abort();
      for (const source of objectUrls) URL.revokeObjectURL(source);
    };
  }, [content, key, message.accountId, sanitizedHtml]);

  return state.key === key ? state.sources : EMPTY_CID_SOURCES;
}

function useRemoteImageSources(
  message: MailMessageDto,
  sanitizedHtml: string | null,
  client: Pick<MailSurfaceClient, "requestMessageContent">,
  requests: { current: number },
): ReadonlyMap<string, string> {
  const remoteImageIds = sanitizedHtml === null
    ? []
    : referencedRemoteImageIds(sanitizedHtml);
  const key = `${message.accountId}:${message.messageId}:${remoteImageIds.join(":")}`;
  const [state, setState] = useState<{
    readonly key: string;
    readonly sources: ReadonlyMap<string, string>;
  }>(() => ({ key: "", sources: new Map() }));

  useEffect(() => {
    const controller = new AbortController();
    const objectUrls = new Set<string>();
    let disposed = false;
    let deadline: number | null = null;
    const clearDeadline = () => {
      if (deadline === null) return;
      window.clearTimeout(deadline);
      deadline = null;
    };
    // The deadline is for a cache that has gone quiet, not one that is
    // still answering: every answer re-arms it. The request budget below is
    // what bounds a cache that keeps answering "not yet".
    const armDeadline = () => {
      clearDeadline();
      deadline = window.setTimeout(
        () => controller.abort(),
        REMOTE_IMAGE_LOAD_DEADLINE_MS,
      );
    };
    const revokeAll = () => {
      for (const source of objectUrls) URL.revokeObjectURL(source);
      objectUrls.clear();
    };
    const ids = sanitizedHtml === null
      ? []
      : referencedRemoteImageIds(sanitizedHtml);
    if (ids.length === 0) {
      return () => {
        disposed = true;
        controller.abort();
        revokeAll();
      };
    }
    armDeadline();
    // The cache fills these images on the server's own schedule, and the
    // reader endpoint only ever reads it. A message-content POST re-records
    // the owner's demand and starts that fill again. It is the same request
    // the body path makes, counted on the same counter, so body and images
    // together never exceed CONTENT_MAX_REQUESTS per open; runs that arrive
    // together fold into one request.
    const input = { accountId: message.accountId, messageId: message.messageId };
    let asking: Promise<boolean> | null = null;
    const askAgain = (): Promise<boolean> => {
      if (asking !== null) return asking;
      if (requests.current >= CONTENT_MAX_REQUESTS) return Promise.resolve(false);
      requests.current += 1;
      asking = client
        .requestMessageContent(input, controller.signal)
        .then(
          () => true,
          () => false,
        )
        .finally(() => {
          asking = null;
        });
      return asking;
    };
    const loadOne = async (
      remoteImageId: string,
    ): Promise<readonly [string, string] | null> => {
      let attempt = 0;
      let misses = 0;
      let seenAsks = requests.current;
      let askedForMissing = false;
      while (!disposed && !controller.signal.aborted) {
        try {
          const result = await mailCidFetchGate.run(
            controller.signal,
            async () => {
              const response = await fetch(
                remoteImageUrl(message.accountId, remoteImageId),
                {
                  signal: controller.signal,
                  credentials: "same-origin",
                  cache: "no-store",
                  referrerPolicy: "no-referrer",
                  redirect: "error",
                },
              );
              const metadata = verifiedRemoteImageResponse(response);
              if (metadata === null) {
                await response.body?.cancel().catch(() => undefined);
                if (response.status === 503) {
                  return Object.freeze({ kind: "retry" as const });
                }
                if (response.status === 404) {
                  return Object.freeze({ kind: "missing" as const });
                }
                return Object.freeze({ kind: "stop" as const });
              }
              const candidate = await response.blob();
              return candidate.size === metadata.bytes &&
                candidate.type === metadata.mimeType
                ? Object.freeze({ kind: "ready" as const, blob: candidate })
                : Object.freeze({ kind: "stop" as const });
            },
          );
          if (result.kind === "stop") return null;
          if (result.kind === "retry" || result.kind === "missing") {
            armDeadline();
            if (result.kind === "missing") {
              // A 404 is an image the cache has no live row for. One re-ask
              // covers a row that was dropped and re-created; a second 404
              // after it is the final answer. An image the cache has refused
              // for good answers 410 and stops above without an ask.
              if (askedForMissing) return null;
              askedForMissing = true;
            } else {
              misses += 1;
            }
            if (
              result.kind === "missing" ||
              misses >= CONTENT_TRANSIENT_POLLS_BEFORE_REQUEST
            ) {
              // An ask by another image since this run began counts here.
              if (requests.current === seenAsks && !(await askAgain())) {
                return null;
              }
              seenAsks = requests.current;
              misses = 0;
            }
            const canRetry = await waitForContentPoll(
              controller.signal,
              remoteImagePollDelayMs(attempt),
            );
            attempt += 1;
            if (!canRetry) return null;
            continue;
          }
          if (disposed || controller.signal.aborted) return null;
          const source = URL.createObjectURL(result.blob);
          if (disposed || controller.signal.aborted) {
            URL.revokeObjectURL(source);
            return null;
          }
          objectUrls.add(source);
          setState((previous) => {
            if (disposed || controller.signal.aborted) return previous;
            const sources = previous.key === key
              ? new Map(previous.sources)
              : new Map<string, string>();
            sources.set(remoteImageId, source);
            return { key, sources };
          });
          return [remoteImageId, source] as const;
        } catch {
          return null;
        }
      }
      return null;
    };
    const load = async () => {
      try {
        await Promise.all(ids.map(loadOne));
        clearDeadline();
        if (disposed) {
          revokeAll();
        }
      } catch {
        clearDeadline();
        revokeAll();
      }
    };
    void load();
    return () => {
      disposed = true;
      clearDeadline();
      controller.abort();
      revokeAll();
    };
  }, [client, key, message.accountId, message.messageId, requests, sanitizedHtml]);

  return state.key === key ? state.sources : EMPTY_REMOTE_SOURCES;
}

function verifiedRemoteImageResponse(
  response: Response,
): { readonly mimeType: string; readonly bytes: number } | null {
  const mimeType = response.headers.get("Content-Type");
  const contentLength = response.headers.get("Content-Length");
  const bytes = contentLength !== null && /^\d+$/.test(contentLength)
    ? Number(contentLength)
    : Number.NaN;
  if (
    !response.ok ||
    response.status !== 200 ||
    response.redirected ||
    (mimeType !== "image/gif" &&
      mimeType !== "image/jpeg" &&
      mimeType !== "image/png" &&
      mimeType !== "image/webp") ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > MAIL_INLINE_IMAGE_MAX_BYTES ||
    response.headers.get("X-Content-Type-Options") !== "nosniff" ||
    response.headers.get("Cross-Origin-Resource-Policy") !== "same-origin" ||
    response.headers.get("Cache-Control") !== "private, no-store" ||
    response.headers.get("Content-Security-Policy") !==
      MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY ||
    !/^attachment;/i.test(response.headers.get("Content-Disposition") ?? "")
  ) {
    return null;
  }
  return Object.freeze({ mimeType, bytes });
}

function isVerifiedInlineResponse(
  response: Response,
  attachment: MailContentAttachmentDto,
): boolean {
  return (
    response.ok &&
    response.status === 200 &&
    !response.redirected &&
    response.headers.get("Content-Type") === attachment.mimeType &&
    response.headers.get("Content-Length") === String(attachment.bytes) &&
    response.headers.get("X-Content-Type-Options") === "nosniff" &&
    response.headers.get("Cross-Origin-Resource-Policy") === "same-origin" &&
    response.headers.get("Cache-Control") === "private, no-store" &&
    response.headers.get("Content-Security-Policy") ===
      MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY &&
    /^attachment;/i.test(response.headers.get("Content-Disposition") ?? "")
  );
}

const EMPTY_CID_SOURCES: ReadonlyMap<string, string> = new Map();
const EMPTY_REMOTE_SOURCES: ReadonlyMap<string, string> = new Map();
/** Silence, not waiting: it runs from the last answer, not from the open. */
export const REMOTE_IMAGE_LOAD_DEADLINE_MS = 90_000;

function inlineCidContentKey(
  message: MailMessageDto,
  content: Extract<MailMessageContent, { state: "ready" }> | null,
  sanitizedHtml: string | null,
): string {
  if (content === null || sanitizedHtml === null) {
    return `${message.accountId}:${message.messageId}:none`;
  }
  return [
    message.accountId,
    message.messageId,
    ...referencedInlineCidAttachments(
      sanitizedHtml,
      content.attachments,
    ).map((attachment) => `ref:${attachment.attachmentId}`),
    ...content.attachments.map((attachment) =>
      [
        attachment.attachmentId,
        attachment.contentId ?? "",
        attachment.mimeType,
        attachment.disposition,
        attachment.bytes,
      ].join(":"),
    ),
  ].join("|");
}

function MailTextBody({ text }: { text: string }) {
  return (
    <div className="whitespace-pre-wrap break-words text-[15px] leading-[1.7] text-ink">
      {text}
    </div>
  );
}

/**
 * What the reader shows while the real body is still on its way. The plain
 * text part wins when it is readable; otherwise the provider snippet stands
 * in, under the same rule the list row applies — a snippet arrives escaped,
 * so an unsanitised one shows the reader `&#39;` where the list shows `'`.
 */
function fallbackBody(message: MailMessageDto): string | null {
  const text = readableMailBody(message.textBody);
  if (text !== null) return text;
  return sanitizeSnippet(message.snippet) || null;
}

export function pollDelayMs(attempt: number): number {
  if (attempt === 0) return 0;
  return Math.min(
    CONTENT_POLL_BASE_DELAY_MS * 2 ** (attempt - 1),
    CONTENT_POLL_MAX_DELAY_MS,
  );
}

export function remoteImagePollDelayMs(attempt: number): number {
  return Math.min(500 * 2 ** attempt, 10_000);
}

/**
 * Resolves true after `delayMs` of visible-tab time, false on abort. A hidden
 * tab parks the wait until the page is visible again, so a background tab
 * never polls. Also drives the send-operation watcher in mail-surface.
 */
export function waitForContentPoll(
  signal: AbortSignal,
  delayMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let timeout: number | null = null;
    let settled = false;
    const finish = (canPoll: boolean) => {
      if (settled) return;
      settled = true;
      if (timeout !== null) window.clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      document.removeEventListener("visibilitychange", schedule);
      resolve(canPoll);
    };
    const onAbort = () => finish(false);
    const schedule = () => {
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = null;
      if (signal.aborted) {
        finish(false);
        return;
      }
      if (document.visibilityState !== "visible") return;
      timeout = window.setTimeout(() => finish(true), delayMs);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    document.addEventListener("visibilitychange", schedule);
    schedule();
  });
}

function attachmentUrl(accountId: string, attachmentId: string): string {
  const query = new URLSearchParams({ accountId });
  return `/api/mail/attachments/${encodeURIComponent(attachmentId)}?${query}`;
}

function remoteImageUrl(accountId: string, remoteImageId: string): string {
  const query = new URLSearchParams({ accountId });
  return `/api/mail/remote-images/${encodeURIComponent(remoteImageId)}?${query}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${Math.ceil(bytes / 1_024)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function ReaderSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading message" className="px-5 py-6 md:px-8">
      <div className="flex items-center gap-3">
        <Skeleton className="size-8 rounded-full" />
        <div className="flex-1">
          <Skeleton className="h-3 w-36" />
          <Skeleton className="mt-2 h-2.5 w-56" />
        </div>
      </div>
      <div className="mx-auto mt-8 max-w-[76ch]">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="mt-3 h-3 w-11/12" />
        <Skeleton className="mt-3 h-3 w-4/5" />
      </div>
    </div>
  );
}

function formatAddresses(addresses: readonly { name: string | null; address: string }[]): string {
  if (addresses.length === 0) return "undisclosed recipients";
  return addresses
    .slice(0, 3)
    .map((address) => address.name || address.address)
    .join(", ");
}

function formatMessageTime(value: number | null): string {
  if (value === null) return "";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
