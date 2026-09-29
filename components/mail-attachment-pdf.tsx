"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { MailContentAttachmentDto } from "@/lib/mail/content-types";
import { ATTACHMENT_FETCH_PRIORITY, type AttachmentBlobStore } from "@/lib/mail/attachment-blobs";
import { ATTACHMENT_PDF_PREVIEW_MAX_BYTES } from "@/lib/mail/attachment-preview";
import type { OpenedPdf } from "@/lib/mail/pdf-runtime";

/** A page is drawn at the screen's pixel ratio, but never past 2x: a 3x
 *  phone would spend 2.25 times the memory of 2x on every page for detail the
 *  eye cannot find at reading distance. */
export const PDF_PIXEL_RATIO_CAP = 2;

/** The most pixels one page's canvas may hold, 64 MB of RGBA: the ceiling
 *  pdf.js's own viewer uses (`maxCanvasPixels`). A page a sender made very
 *  tall or very wide is drawn at a lower resolution rather than allocated at
 *  whatever size it declares. */
export const PDF_CANVAS_MAX_PIXELS = 2 ** 24;

/** Page boxes laid out in the scroll. A PDF can declare any page count it
 *  likes; past this the reader is sent to the file itself. */
export const PDF_PAGE_LIMIT = 1_000;

/** How far a page's box may stray from square, either way. A declared page
 *  of 1 × 100,000 points would otherwise be a box tens of millions of pixels
 *  tall in the scroll. */
const PDF_ASPECT_LIMIT = 20;

/** A page is drawn once it is within one viewport of the visible part, and
 *  let go once it is more than two away. The gap between the two is what
 *  keeps a page on the edge from being drawn and dropped on every scroll. */
const PDF_DRAW_MARGIN = "100% 0px";
const PDF_RELEASE_MARGIN = "200% 0px";
/** The page crossing the middle of the scroller is the one being read. */
const PDF_READING_LINE = "-50% 0px -50% 0px";

type PdfState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly pdf: PDFDocumentProxy;
      /** The first page's height over its width: every page box takes it
       *  until that page is drawn and knows its own. */
      readonly aspect: number;
    }
  | { readonly kind: "failed"; readonly reason: "broken" | "password" };

/**
 * A PDF attachment in the viewer: its pages drawn to `<canvas>` elements in
 * one vertical scroll, fitted to the column. Canvas only, on purpose: no
 * text, annotation, form or link layer, so a stranger's PDF can show its pages
 * and do nothing else. The bytes come from the letter's attachment store, the
 * same gated and verified download every preview uses, at the viewer's
 * priority; pdf.js is fetched by a dynamic import on the first PDF. The
 * download and the parsed document both go away with the component, and the
 * document goes as soon as it has failed, too.
 */
export function MailAttachmentPdf({
  attachment,
  url,
  store,
}: {
  attachment: MailContentAttachmentDto;
  /** The download route, for the Download links. */
  url: string;
  store: Pick<AttachmentBlobStore, "blob">;
}) {
  const [state, setState] = useState<PdfState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let opened: OpenedPdf | null = null;
    let disposed = false;
    const load = async () => {
      try {
        const blob = await store.blob(
          attachment,
          ATTACHMENT_FETCH_PRIORITY.viewer,
          controller.signal,
        );
        if (blob.size > ATTACHMENT_PDF_PREVIEW_MAX_BYTES) {
          throw new Error("The PDF is larger than the preview reads");
        }
        const data = new Uint8Array(await blob.arrayBuffer());
        if (disposed) return;
        const { openPdf } = await import("@/lib/mail/pdf-runtime");
        if (disposed) return;
        opened = openPdf(data);
        const pdf = await opened.document;
        const first = await pdf.getPage(1);
        const { width, height } = first.getViewport({ scale: 1 });
        if (!disposed) setState({ kind: "ready", pdf, aspect: pageAspect(width, height) });
      } catch (error) {
        if (disposed) return;
        // Nothing more will be read from a document that failed, so its
        // worker goes now rather than when the viewer closes.
        void opened?.destroy();
        opened = null;
        setState({ kind: "failed", reason: passwordProtected(error) ? "password" : "broken" });
      }
    };
    void load();
    return () => {
      disposed = true;
      controller.abort();
      void opened?.destroy();
    };
  }, [attachment, store]);

  if (state.kind === "failed") {
    return (
      <AttachmentFailure
        message={
          state.reason === "password"
            ? "This PDF is password protected"
            : "Couldn’t open this file"
        }
        href={url}
        filename={attachment.filename}
      />
    );
  }
  if (state.kind === "loading") {
    return (
      <p aria-live="polite" className="brain-viewer-status text-control">
        Opening PDF…
      </p>
    );
  }
  return (
    <PdfPages
      pdf={state.pdf}
      aspect={state.aspect}
      url={url}
      filename={attachment.filename}
    />
  );
}

function PdfPages({
  pdf,
  aspect,
  url,
  filename,
}: {
  pdf: PDFDocumentProxy;
  aspect: number;
  url: string;
  filename: string | null;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [live, setLive] = useState<ReadonlySet<number>>(() => new Set());
  const [reading, setReading] = useState(1);
  const total = pdf.numPages;
  const shown = Math.min(total, PDF_PAGE_LIMIT);

  // The pages take the keyboard as they arrive, so Space, Page Down and the
  // vertical arrows scroll them at once; ← and → still reach the viewer,
  // which moves between attachments.
  useEffect(() => {
    scrollerRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const column = columnRef.current;
    if (!column || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(column);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const root = scrollerRef.current;
    const column = columnRef.current;
    if (!root || !column || typeof IntersectionObserver === "undefined") return;
    const pageOf = (target: Element) => Number((target as HTMLElement).dataset.page);
    const draw = new IntersectionObserver(
      (entries) =>
        setLive((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            if (entry.isIntersecting) next.add(pageOf(entry.target));
          }
          return next.size === previous.size ? previous : next;
        }),
      { root, rootMargin: PDF_DRAW_MARGIN },
    );
    const release = new IntersectionObserver(
      (entries) =>
        setLive((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            if (!entry.isIntersecting) next.delete(pageOf(entry.target));
          }
          return next.size === previous.size ? previous : next;
        }),
      { root, rootMargin: PDF_RELEASE_MARGIN },
    );
    const line = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setReading(pageOf(entry.target));
        }
      },
      { root, rootMargin: PDF_READING_LINE },
    );
    for (const page of column.querySelectorAll("[data-page]")) {
      draw.observe(page);
      release.observe(page);
      line.observe(page);
    }
    return () => {
      draw.disconnect();
      release.disconnect();
      line.disconnect();
    };
  }, [shown]);

  return (
    <div className="brain-viewer-pdf">
      <div
        ref={scrollerRef}
        tabIndex={0}
        aria-label={filename ? `Pages of ${filename}` : "PDF pages"}
        className="brain-viewer-pdf-scroll focus-inset"
      >
        <div ref={columnRef} className="brain-viewer-pdf-column">
          {Array.from({ length: shown }, (_, index) => (
            <PdfPage
              key={index + 1}
              pdf={pdf}
              pageNumber={index + 1}
              aspect={aspect}
              width={width}
              live={live.has(index + 1)}
            />
          ))}
          {total > shown && (
            <p className="brain-viewer-pdf-more text-table">
              <a
                href={url}
                download={filename ?? ""}
                className="brain-touch-min btn btn-glass tint-hover"
              >
                Download to read the rest
              </a>
            </p>
          )}
        </div>
      </div>
      <p className="brain-viewer-page-pill mat-thin text-control">
        Page {reading} of {total}
      </p>
    </div>
  );
}

function PdfPage({
  pdf,
  pageNumber,
  aspect,
  width,
  live,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  aspect: number;
  width: number;
  live: boolean;
}) {
  // A page that is not the first one's shape corrects its own box once it
  // has been drawn, and keeps the correction when it is let go again.
  const [ownAspect, setOwnAspect] = useState<number | null>(null);
  return (
    <div
      data-page={pageNumber}
      className="brain-viewer-pdf-page"
      style={{ aspectRatio: `1 / ${ownAspect ?? aspect}` }}
    >
      {live && width > 0 && (
        <PdfCanvas
          pdf={pdf}
          pageNumber={pageNumber}
          width={width}
          onAspect={setOwnAspect}
        />
      )}
    </div>
  );
}

function PdfCanvas({
  pdf,
  pageNumber,
  width,
  onAspect,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  onAspect: (aspect: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let page: PDFPageProxy | null = null;
    let task: RenderTask | null = null;
    const draw = async () => {
      try {
        page = await pdf.getPage(pageNumber);
        if (cancelled) return;
        const natural = page.getViewport({ scale: 1 });
        if (!(natural.width > 0 && natural.height > 0)) return;
        onAspect(pageAspect(natural.width, natural.height));
        const ratio = Math.min(window.devicePixelRatio || 1, PDF_PIXEL_RATIO_CAP);
        const fitted = (width / natural.width) * ratio;
        const area = natural.width * natural.height * fitted * fitted;
        const scale =
          area > PDF_CANVAS_MAX_PIXELS ? fitted * Math.sqrt(PDF_CANVAS_MAX_PIXELS / area) : fitted;
        const viewport = page.getViewport({ scale });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        task = page.render({ canvas, viewport });
        await task.promise;
      } catch {
        // A cancelled render rejects, and a page the parser cannot draw
        // leaves its box empty rather than failing the whole document.
      }
    };
    void draw();
    return () => {
      cancelled = true;
      task?.cancel();
      // A canvas holds its pixels until its size changes, whether or not it
      // is still in the document, so the release is written out.
      canvas.width = 0;
      canvas.height = 0;
      page?.cleanup();
    };
  }, [onAspect, pageNumber, pdf, width]);

  return <canvas ref={canvasRef} className="brain-viewer-pdf-canvas" />;
}

/** Said in place of a preview that cannot be drawn, with the way out. */
export function AttachmentFailure({
  message,
  href,
  filename,
}: {
  message: string;
  href: string;
  filename: string | null;
}) {
  return (
    <div role="alert" className="brain-viewer-failure">
      <p className="text-table text-ink">{message}</p>
      <a
        href={href}
        download={filename ?? ""}
        className="brain-touch-min btn btn-glass tint-hover"
      >
        Download
      </a>
    </div>
  );
}

/** A page's height over its width, held inside `PDF_ASPECT_LIMIT` either way
 *  and square for a page that declares no usable size. */
function pageAspect(width: number, height: number): number {
  const aspect = height / width;
  if (!Number.isFinite(aspect) || aspect <= 0) return 1;
  return Math.min(PDF_ASPECT_LIMIT, Math.max(1 / PDF_ASPECT_LIMIT, aspect));
}

function passwordProtected(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "PasswordException"
  );
}
