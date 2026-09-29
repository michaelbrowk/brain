"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { AnimatePresence } from "framer-motion";
import type { MailContentAttachmentDto } from "@/lib/mail/content-types";
import {
  attachmentUrl,
  classifyAttachment,
  formatBytes,
  listedAttachments,
} from "@/lib/mail/attachment-preview";
import { ATTACHMENT_FETCH_PRIORITY, AttachmentBlobStore } from "@/lib/mail/attachment-blobs";
import { Icon } from "./ui/icon";
import {
  MailAttachmentViewer,
  type AttachmentPreview,
  type AttachmentSource,
} from "./mail-attachment-viewer";

/** A tile starts its download once it is this close to the visible part of
 *  the window, the way `loading="lazy"` would have. */
const TILE_LOAD_MARGIN = "200px";

/** The bounds of a thumbnail's short side, in device pixels. It is decoded at
 *  the tile's own size (twice its CSS width on a 2x screen) and not at the
 *  camera's: a 12-megapixel photo held for a 112px square is 48 MB of pixels,
 *  its thumbnail a fraction of one. */
const THUMBNAIL_MIN_SIDE = 112;
const THUMBNAIL_MAX_SIDE = 448;

/**
 * A letter's attachments, under its body. Pictures and PDFs the reader can
 * draw are square tiles that open the viewer; everything else keeps the chip
 * that downloads it. An inline image the body already draws is not listed
 * again (`listedAttachments`), and a picture whose tile will not load goes
 * back to being a chip rather than an empty square.
 *
 * Every download goes through the letter's `AttachmentBlobStore`, which waits
 * its turn in the same two-slot gate as the body's inline images: the mail
 * service streams two downloads at once and refuses a third. Tile and viewer
 * share one verified blob per attachment, and the store is let go (downloads
 * aborted, blob URLs revoked) when the letter leaves.
 */
export function MailAttachments({
  accountId,
  attachments,
  renderedHtml,
  onViewerOpenChange,
}: {
  accountId: string;
  attachments: readonly MailContentAttachmentDto[];
  /** The sanitized HTML on screen, or null when the reader shows text. */
  renderedHtml: string | null;
  /** The viewer takes the window, so the shell has to step back from it. */
  onViewerOpenChange?: (open: boolean) => void;
}) {
  const [store] = useState(() => new AttachmentBlobStore(accountId));
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const [viewing, setViewing] = useState<string | null>(null);
  /** The attachment the viewer showed last: its tile gets the focus back. */
  const returnToRef = useRef<string | null>(null);
  const tilesRef = useRef(new Map<string, HTMLButtonElement>());

  useEffect(() => () => store.dispose(), [store]);

  const listed = listedAttachments(attachments, renderedHtml);
  const previews: AttachmentPreview[] = [];
  const files: MailContentAttachmentDto[] = [];
  for (const attachment of listed) {
    const kind = broken.has(attachment.attachmentId) ? "file" : classifyAttachment(attachment);
    if (kind === "file") files.push(attachment);
    else {
      previews.push({
        attachment,
        kind,
        url: attachmentUrl(accountId, attachment.attachmentId),
      });
    }
  }
  const index =
    viewing === null
      ? -1
      : previews.findIndex((preview) => preview.attachment.attachmentId === viewing);
  const open = index !== -1;

  useEffect(() => {
    if (!open || !onViewerOpenChange) return;
    onViewerOpenChange(true);
    // Also on unmount: a letter that leaves with the viewer up must not
    // leave the shell inert behind it.
    return () => onViewerOpenChange(false);
  }, [open, onViewerOpenChange]);

  if (listed.length === 0) return null;

  const show = (attachmentId: string) => {
    returnToRef.current = attachmentId;
    setViewing(attachmentId);
  };

  return (
    <div
      role="group"
      aria-label="Attachments"
      className="mt-6 flex flex-col gap-4 border-t border-hair-soft pt-4"
    >
      {previews.length > 0 && (
        <ul className="brain-mail-tiles">
          {previews.map((preview) => {
            const id = preview.attachment.attachmentId;
            return (
              <li key={id} className="min-w-0">
                <AttachmentTile
                  preview={preview}
                  store={store}
                  tileRef={(element) => {
                    if (element) tilesRef.current.set(id, element);
                    else tilesRef.current.delete(id);
                  }}
                  onOpen={() => show(id)}
                  onBroken={() =>
                    setBroken((previous) => new Set(previous).add(id))
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {files.map((attachment) => (
            <li key={attachment.attachmentId} className="min-w-0">
              <a
                href={attachmentUrl(accountId, attachment.attachmentId)}
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
      <AnimatePresence>
        {open && (
          <MailAttachmentViewer
            previews={previews}
            store={store}
            index={index}
            onIndexChange={(next) => {
              const target = previews[next];
              if (target) show(target.attachment.attachmentId);
            }}
            onClose={() => setViewing(null)}
            returnFocus={() => tilesRef.current.get(returnToRef.current ?? "") ?? null}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function AttachmentTile({
  preview,
  store,
  tileRef,
  onOpen,
  onBroken,
}: {
  preview: AttachmentPreview;
  store: AttachmentSource;
  tileRef: (element: HTMLButtonElement | null) => void;
  onOpen: () => void;
  onBroken: () => void;
}) {
  const name = preview.attachment.filename || "Attachment";
  const size = formatBytes(preview.attachment.bytes);
  return (
    <button
      ref={tileRef}
      type="button"
      aria-label={`${name}, ${size}`}
      className="brain-mail-tile"
      onClick={onOpen}
    >
      <span className="brain-mail-tile-thumb">
        {preview.kind === "image" ? (
          <TileThumbnail
            attachment={preview.attachment}
            name={name}
            store={store}
            onBroken={onBroken}
          />
        ) : (
          <>
            <Icon name="document-text-linear" size={24} />
            <span className="text-label">PDF</span>
          </>
        )}
      </span>
      <span className="brain-mail-tile-name text-caption">{name}</span>
      <span className="brain-mail-tile-size text-caption">{size}</span>
    </button>
  );
}

/**
 * The picture in a tile, decoded at thumbnail size into a small canvas. The
 * download is the letter's shared blob, at the tile's priority, started when
 * the tile comes near the window. An engine without a resizing decoder shows
 * the blob through an `<img>` instead, and a picture that decodes in neither
 * turns the tile back into a chip.
 */
function TileThumbnail({
  attachment,
  name,
  store,
  onBroken,
}: {
  attachment: MailContentAttachmentDto;
  name: string;
  store: AttachmentSource;
  onBroken: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const near = useNearWindow(canvasRef);
  const [fallback, setFallback] = useState<string | null>(null);
  // Read through a ref: the parent hands a fresh closure every render, and a
  // new one must not restart the download.
  const onBrokenRef = useRef(onBroken);
  useEffect(() => {
    onBrokenRef.current = onBroken;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!near || !canvas) return;
    const controller = new AbortController();
    const load = async () => {
      let blob: Blob;
      try {
        blob = await store.blob(attachment, ATTACHMENT_FETCH_PRIORITY.tile, controller.signal);
      } catch {
        if (!controller.signal.aborted) onBrokenRef.current();
        return;
      }
      try {
        const bitmap = await decodeThumbnail(blob, thumbnailSide(canvas));
        if (controller.signal.aborted) {
          bitmap.close();
          return;
        }
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
      } catch {
        if (controller.signal.aborted) return;
        try {
          setFallback(
            await store.url(attachment, ATTACHMENT_FETCH_PRIORITY.tile, controller.signal),
          );
        } catch {
          if (!controller.signal.aborted) onBrokenRef.current();
        }
      }
    };
    void load();
    return () => controller.abort();
  }, [attachment, near, store]);

  if (fallback !== null) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a verified blob of an authenticated attachment, not a static asset next/image could optimise
      <img src={fallback} alt={name} decoding="async" onError={() => onBrokenRef.current()} />
    );
  }
  return <canvas ref={canvasRef} role="img" aria-label={name} />;
}

/** True once the element has come within `TILE_LOAD_MARGIN` of the window,
 *  and from then on. Without an IntersectionObserver it is true at once. */
function useNearWindow(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    const element = ref.current;
    if (near || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setNear(true);
      },
      { rootMargin: TILE_LOAD_MARGIN },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

/** The short side to decode to: the tile's own width in device pixels, with
 *  the ratio capped at 2 like the PDF's pages. */
function thumbnailSide(element: Element): number {
  const width = element.getBoundingClientRect().width;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  return Math.min(
    THUMBNAIL_MAX_SIDE,
    Math.max(THUMBNAIL_MIN_SIDE, Math.ceil(width * ratio)),
  );
}

/** Decodes the picture with its short side at `side` pixels, so the square
 *  crop that `object-fit: cover` takes of it is sharp and nothing larger is
 *  ever held. A decoder without resizing (or a file it refuses) throws. */
async function decodeThumbnail(blob: Blob, side: number): Promise<ImageBitmap> {
  if (typeof createImageBitmap !== "function") {
    throw new Error("No image decoder that resizes");
  }
  const byWidth = await createImageBitmap(blob, { resizeWidth: side, resizeQuality: "medium" });
  if (byWidth.height >= side) return byWidth;
  // Wider than tall: decode again so the height is the side that fills.
  byWidth.close();
  return createImageBitmap(blob, { resizeHeight: side, resizeQuality: "medium" });
}
