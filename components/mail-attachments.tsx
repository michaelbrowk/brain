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

/** A tile starts its download once it is this close, above or below, to the
 *  visible part of the reader's scroller. The scroller is the observer's root:
 *  measured against the window instead, a tile below the fold is clipped by
 *  the scroller first and the margin never reaches it. */
const TILE_LOAD_MARGIN = "200px 0px";

/** The bounds of a thumbnail's side, in device pixels. The tile is square, so
 *  the thumbnail is the picture's centred square, decoded at the tile's own
 *  size (twice its CSS width on a 2x screen) and never above the picture's
 *  own: a 12-megapixel photo held for a 112px square is 48 MB of pixels, its
 *  thumbnail a fraction of one. */
const THUMBNAIL_MIN_SIDE = 112;
const THUMBNAIL_MAX_SIDE = 448;

/** Past this ratio either way a picture is a strip, not a photo: its centred
 *  square is a sliver of it, so the tile shows the blob in an `<img>` cropped
 *  by `object-fit` instead of a decoded square. */
const THUMBNAIL_MAX_RATIO = 8;

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
 * The picture in a tile: its centred square decoded at thumbnail size into a
 * small canvas, so the canvas is never larger than 448 × 448 whatever shape
 * the sender's file is. The download is the letter's shared blob, at the
 * tile's priority, started when the tile nears the reader's visible part. The
 * picture's own size is read from an `<img>` load of the blob URL, which parses
 * the header without decoding the pixels. A strip past 8:1, or an engine
 * without a cropping and resizing decoder, shows the blob through an `<img>`
 * instead, and a picture that loads in neither turns the tile back into a
 * chip.
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
    const { signal } = controller;
    const load = async () => {
      let blob: Blob;
      let source: string;
      let size: { readonly width: number; readonly height: number };
      try {
        blob = await store.blob(attachment, ATTACHMENT_FETCH_PRIORITY.tile, signal);
        source = await store.url(attachment, ATTACHMENT_FETCH_PRIORITY.tile, signal);
        size = await naturalSize(source, signal);
      } catch {
        if (!signal.aborted) onBrokenRef.current();
        return;
      }
      const square = Math.min(size.width, size.height);
      const ratio = Math.max(size.width, size.height) / square;
      if (ratio > THUMBNAIL_MAX_RATIO || typeof createImageBitmap !== "function") {
        setFallback(source);
        return;
      }
      const side = Math.min(thumbnailSide(canvas), square);
      let bitmap: ImageBitmap;
      try {
        bitmap = await createImageBitmap(
          blob,
          Math.floor((size.width - square) / 2),
          Math.floor((size.height - square) / 2),
          square,
          square,
          { resizeWidth: side, resizeHeight: side, resizeQuality: "medium" },
        );
      } catch {
        if (!signal.aborted) setFallback(source);
        return;
      }
      if (!signal.aborted) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
      }
      bitmap.close();
    };
    void load();
    return () => {
      controller.abort();
      // A canvas keeps its pixels until its size changes, in the document or
      // not, so the release is written out.
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [attachment, near, store]);

  if (fallback !== null) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- a verified blob of an authenticated attachment, not a static asset next/image could optimise
      <img src={fallback} alt={name} decoding="async" onError={() => onBrokenRef.current()} />
    );
  }
  return <canvas ref={canvasRef} role="img" aria-label={name} />;
}

/** True once the element has come within `TILE_LOAD_MARGIN` of the reader's
 *  visible part (the window, outside the reader), and from then on. Without
 *  an IntersectionObserver it is true at once. */
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
      {
        root: element.closest<HTMLElement>("[data-mail-reader-scroll]"),
        rootMargin: TILE_LOAD_MARGIN,
      },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [near, ref]);
  return near;
}

/** The picture's own size, from an `<img>` load of its blob URL. The load
 *  parses the header; an image never painted is never decoded. */
function naturalSize(
  source: string,
  signal: AbortSignal,
): Promise<{ readonly width: number; readonly height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const settle = () => {
      image.onload = null;
      image.onerror = null;
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      settle();
      image.src = "";
      reject(Object.assign(new Error("thumbnail aborted"), { name: "AbortError" }));
    };
    image.onload = () => {
      settle();
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      } else {
        reject(new Error("The picture has no size"));
      }
    };
    image.onerror = () => {
      settle();
      reject(new Error("The picture did not load"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    image.src = source;
  });
}

/** The side to decode to: the tile's own width in device pixels, with the
 *  ratio capped at 2 like the PDF's pages. */
function thumbnailSide(element: Element): number {
  const width = element.getBoundingClientRect().width;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  return Math.min(
    THUMBNAIL_MAX_SIDE,
    Math.max(THUMBNAIL_MIN_SIDE, Math.ceil(width * ratio)),
  );
}
