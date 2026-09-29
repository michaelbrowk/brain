"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import type { MailContentAttachmentDto } from "@/lib/mail/content-types";
import {
  attachmentUrl,
  classifyAttachment,
  formatBytes,
  listedAttachments,
} from "@/lib/mail/attachment-preview";
import { Icon } from "./ui/icon";
import { MailAttachmentViewer, type AttachmentPreview } from "./mail-attachment-viewer";

/**
 * A letter's attachments, under its body. Pictures and PDFs the reader can
 * draw are square tiles that open the viewer; everything else keeps the chip
 * that downloads it. An inline image the body already draws is not listed
 * again (`listedAttachments`), and a picture whose tile will not load goes
 * back to being a chip rather than an empty square.
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
  const [broken, setBroken] = useState<ReadonlySet<string>>(() => new Set());
  const [viewing, setViewing] = useState<string | null>(null);
  /** The attachment the viewer showed last: its tile gets the focus back. */
  const returnToRef = useRef<string | null>(null);
  const tilesRef = useRef(new Map<string, HTMLButtonElement>());

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
  tileRef,
  onOpen,
  onBroken,
}: {
  preview: AttachmentPreview;
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
          // eslint-disable-next-line @next/next/no-img-element -- an authenticated attachment route, not a static asset next/image could optimise
          <img
            src={preview.url}
            alt={name}
            loading="lazy"
            decoding="async"
            onError={onBroken}
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
