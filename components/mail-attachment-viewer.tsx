"use client";

import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { DUR, EASE_OUT, SHEET_ENTER_Y, SPRING_SHEET } from "@/lib/motion";
import type { MailContentAttachmentDto } from "@/lib/mail/content-types";
import { IconButton } from "./ui/button";
import { Icon } from "./ui/icon";
import { useSheetGesture } from "./use-sheet-gesture";
import { AttachmentFailure, MailAttachmentPdf } from "./mail-attachment-pdf";

export interface AttachmentPreview {
  readonly attachment: MailContentAttachmentDto;
  readonly kind: "image" | "pdf";
  /** The authenticated download route, which both draws and downloads it. */
  readonly url: string;
}

/** How far a finger must travel sideways, in px, before a release moves to
 *  the next attachment rather than counting as a tap. */
const SWIPE_DISTANCE = 48;
/** How far a slide-in starts from its place, in px. */
const SLIDE_X = 32;

/**
 * THE ATTACHMENT VIEWER. A letter's pictures and PDFs, one at a time, over the
 * whole window. It is the compose sheet's kind of surface: a Radix Dialog in a
 * portal at the body on `--z-modal`, the shell inert and receding under it
 * (the reader reports it through `onAttachmentViewerOpenChange`), Radix's
 * focus trap and Esc, and the focus handed back to a tile when it goes.
 *
 * It is dark in both themes, because a picture is judged against black and
 * not against paper: the root carries `.dark`, so the bar and its controls
 * take the dark theme's tokens, over `--scrim-viewer`.
 *
 * ← and → move through the letter's previews in list order and stop at both
 * ends; so do the arrows in the bar and, on a phone, a sideways swipe.
 */
export function MailAttachmentViewer({
  previews,
  index,
  onIndexChange,
  onClose,
  returnFocus,
}: {
  previews: readonly AttachmentPreview[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** The tile to give the focus back to, read when the viewer has gone. */
  returnFocus: () => HTMLElement | null;
}) {
  const reduce = useReducedMotion();
  const sheet = useSheetGesture();
  const rootRef = useRef<HTMLDivElement>(null);
  const swipeRef = useRef<{ id: number; x: number; y: number } | null>(null);
  /** 0 until the first move: the first preview arrives with the sheet, the
   *  later ones slide in from the side they were asked for. */
  const [direction, setDirection] = useState<-1 | 0 | 1>(0);
  const current = previews[index];
  if (!current) return null;
  const name = current.attachment.filename || "Attachment";
  const several = previews.length > 1;

  const move = (step: -1 | 1) => {
    const next = index + step;
    if (next < 0 || next >= previews.length) return;
    setDirection(step);
    onIndexChange(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      move(event.key === "ArrowLeft" ? -1 : 1);
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    swipeRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = swipeRef.current;
    swipeRef.current = null;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    // Sideways and on purpose: a scroll through a PDF drifts a little.
    if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    move(dx < 0 ? 1 : -1);
  };

  /** The surface fades in over the page duration while the shell recedes, and
   *  leaves fast; reduced motion is the same fade over `DUR.fast`. */
  const surface = reduce
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0, transition: { duration: DUR.fast } },
        transition: { duration: DUR.fast },
      }
    : {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0, transition: { duration: DUR.fast, ease: "easeIn" as const } },
        transition: { duration: DUR.page, ease: EASE_OUT },
      };
  /** The preview itself arrives the way the compose sheet does (12px up on a
   *  desktop, `SHEET_ENTER_Y` on the sheet spring on a phone), and a move
   *  slides the next one in from the side it came from while the last one
   *  fades out in place. Reduced motion: opacity only. */
  const stage = reduce
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        transition: { duration: DUR.fast },
      }
    : direction === 0
      ? {
          initial: { opacity: 0, y: sheet ? SHEET_ENTER_Y : 12 },
          animate: { opacity: 1, y: 0 },
          transition: sheet ? SPRING_SHEET : { duration: DUR.page, ease: EASE_OUT },
        }
      : {
          initial: { opacity: 0, x: direction * SLIDE_X },
          animate: { opacity: 1, x: 0 },
          transition: { duration: DUR.base, ease: EASE_OUT },
        };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Content
          asChild
          aria-modal="true"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // The surface itself takes the focus, not its first button: the
            // arrows work at once and no control stands pre-selected.
            event.preventDefault();
            rootRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            const tile = returnFocus();
            const target =
              tile?.isConnected && tile.closest("[inert]") === null
                ? tile
                : document.querySelector<HTMLElement>("[data-dialog-focus-fallback]");
            target?.focus({ preventScroll: true });
          }}
          // The viewer is the whole window: a toast over it is not outside.
          onInteractOutside={(event) => event.preventDefault()}
          onKeyDown={onKeyDown}
        >
          <motion.div
            ref={rootRef}
            tabIndex={-1}
            className="dark brain-viewer"
            initial={surface.initial}
            animate={surface.animate}
            exit={surface.exit}
            transition={surface.transition}
          >
            <div className="brain-viewer-bar">
              <IconButton
                type="button"
                size={36}
                aria-label="Close"
                className="brain-touch-hit"
                onClick={onClose}
              >
                <Icon name="close-linear" size={18} />
              </IconButton>
              <Dialog.Title className="brain-viewer-name text-h3">{name}</Dialog.Title>
              {several && (
                <div className="brain-viewer-nav">
                  <IconButton
                    type="button"
                    size={36}
                    aria-label="Previous attachment"
                    className="brain-touch-hit"
                    disabled={index === 0}
                    onClick={() => move(-1)}
                  >
                    <Icon name="alt-arrow-left-linear" size={18} />
                  </IconButton>
                  <span data-viewer-counter="" className="brain-viewer-counter text-control">
                    {index + 1} of {previews.length}
                  </span>
                  <IconButton
                    type="button"
                    size={36}
                    aria-label="Next attachment"
                    className="brain-touch-hit"
                    disabled={index === previews.length - 1}
                    onClick={() => move(1)}
                  >
                    <Icon name="alt-arrow-right-linear" size={18} />
                  </IconButton>
                </div>
              )}
              <a
                href={current.url}
                download={current.attachment.filename ?? ""}
                aria-label={`Download ${name}`}
                title="Download"
                data-size="36"
                className="brain-touch-min brain-touch-hit icon-btn focus-inset"
              >
                <Icon name="download-minimalistic-linear" size={18} />
              </a>
            </div>
            {/* Said once per move, so a screen reader hears where it went. */}
            <p aria-live="polite" className="sr-only">
              {direction === 0 ? "" : `${name}, ${index + 1} of ${previews.length}`}
            </p>
            <div
              data-viewer-stage=""
              className="brain-viewer-stage"
              onPointerDown={onPointerDown}
              onPointerUp={onPointerUp}
              onPointerCancel={() => {
                swipeRef.current = null;
              }}
            >
              <AnimatePresence initial={false}>
                <motion.div
                  key={current.attachment.attachmentId}
                  className="brain-viewer-item"
                  initial={stage.initial}
                  animate={stage.animate}
                  exit={{ opacity: 0, transition: { duration: DUR.exit } }}
                  transition={stage.transition}
                >
                  {current.kind === "image" ? (
                    <ViewerImage preview={current} name={name} />
                  ) : (
                    <MailAttachmentPdf url={current.url} filename={current.attachment.filename} />
                  )}
                </motion.div>
              </AnimatePresence>
            </div>
          </motion.div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ViewerImage({ preview, name }: { preview: AttachmentPreview; name: string }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <AttachmentFailure
        message="Couldn’t open this file"
        href={preview.url}
        filename={preview.attachment.filename}
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- an authenticated attachment route, not a static asset next/image could optimise
    <img
      src={preview.url}
      alt={name}
      decoding="async"
      data-loaded={loaded ? "" : undefined}
      className="brain-viewer-image"
      onLoad={() => setLoaded(true)}
      onError={() => setFailed(true)}
    />
  );
}
