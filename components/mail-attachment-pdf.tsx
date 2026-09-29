"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { MailContentAttachmentDto } from "@/lib/mail/content-types";
import { ATTACHMENT_FETCH_PRIORITY, type AttachmentBlobStore } from "@/lib/mail/attachment-blobs";
import { ATTACHMENT_PDF_PREVIEW_MAX_BYTES } from "@/lib/mail/attachment-preview";
import { MailFetchGate } from "@/lib/mail/inline-fetch-gate";
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

/** The longest side a page's canvas may have: past it browsers refuse the
 *  canvas outright, so a page is scaled down to fit it too. */
export const PDF_CANVAS_MAX_SIDE = 16_384;

/** Pages drawn to canvases at once, and the pixels all of them may hold
 *  together (256 MB of RGBA). The canvases go to the pages nearest the one
 *  being read; the rest stay placeholders until the reader comes closer. */
export const PDF_LIVE_CANVASES = 8;
export const PDF_LIVE_PIXELS = 2 ** 26;

/** Pages pdf.js paints at the same time. Each render holds its own working
 *  memory until it finishes, so the rest wait their turn, nearest first. */
export const PDF_RENDERS_AT_ONCE = 4;

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

/** A page's size in PDF points, as pdf.js reports it at scale 1. */
interface PageSize {
  readonly width: number;
  readonly height: number;
}

type PdfState =
  | { readonly kind: "loading" }
  | {
      readonly kind: "ready";
      readonly pdf: PDFDocumentProxy;
      /** The first page's size: every page box takes its shape until that
       *  page has been measured. */
      readonly first: PageSize;
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
        if (!disposed) setState({ kind: "ready", pdf, first: { width, height } });
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
      first={state.first}
      url={url}
      filename={attachment.filename}
    />
  );
}

function PdfPages({
  pdf,
  first,
  url,
  filename,
}: {
  pdf: PDFDocumentProxy;
  first: PageSize;
  url: string;
  filename: string | null;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [near, setNear] = useState<ReadonlySet<number>>(() => new Set());
  const [reading, setReading] = useState(1);
  /** Page sizes read so far. A page is measured (no pixels, only its size)
   *  as it comes near, and gets a canvas only once its size is known, so the
   *  budget below counts what a canvas will really cost. */
  const [sizes, setSizes] = useState<ReadonlyMap<number, PageSize>>(
    () => new Map([[1, first]]),
  );
  const measuringRef = useRef(new Set<number>());
  const [renderGate] = useState(() => new MailFetchGate(PDF_RENDERS_AT_ONCE));
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
        setNear((previous) => {
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
        setNear((previous) => {
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

  useEffect(() => {
    let cancelled = false;
    for (const pageNumber of near) {
      if (sizes.has(pageNumber) || measuringRef.current.has(pageNumber)) continue;
      measuringRef.current.add(pageNumber);
      pdf
        .getPage(pageNumber)
        .then((page) => {
          const { width: pageWidth, height: pageHeight } = page.getViewport({ scale: 1 });
          if (cancelled) return;
          setSizes((previous) =>
            new Map(previous).set(pageNumber, { width: pageWidth, height: pageHeight }),
          );
        })
        .catch(() => {
          // A page the parser cannot read keeps the first page's shape and
          // never gets a canvas.
        })
        .finally(() => measuringRef.current.delete(pageNumber));
    }
    return () => {
      cancelled = true;
    };
  }, [near, pdf, sizes]);

  const ratio = pixelRatio();
  const granted = grantCanvases(near, sizes, reading, width, ratio);

  return (
    <div className="brain-viewer-pdf">
      <div
        ref={scrollerRef}
        tabIndex={0}
        aria-label={filename ? `Pages of ${filename}` : "PDF pages"}
        className="brain-viewer-pdf-scroll focus-inset"
      >
        <div ref={columnRef} className="brain-viewer-pdf-column">
          {Array.from({ length: shown }, (_, index) => {
            const pageNumber = index + 1;
            const size = sizes.get(pageNumber) ?? first;
            return (
              <div
                key={pageNumber}
                data-page={pageNumber}
                className="brain-viewer-pdf-page"
                style={{ aspectRatio: `1 / ${pageAspect(size.width, size.height)}` }}
              >
                {granted.has(pageNumber) && (
                  <PdfCanvas
                    pdf={pdf}
                    pageNumber={pageNumber}
                    width={width}
                    gate={renderGate}
                    priority={-Math.abs(pageNumber - reading)}
                  />
                )}
              </div>
            );
          })}
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

function PdfCanvas({
  pdf,
  pageNumber,
  width,
  gate,
  priority,
}: {
  pdf: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  gate: MailFetchGate;
  /** How near the page is to the one being read: its place in the queue for
   *  a render slot, read when it joins the queue. */
  priority: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const priorityRef = useRef(priority);
  useEffect(() => {
    priorityRef.current = priority;
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const controller = new AbortController();
    let page: PDFPageProxy | null = null;
    let task: RenderTask | null = null;
    const draw = async () => {
      try {
        await gate.run(
          controller.signal,
          async () => {
            page = await pdf.getPage(pageNumber);
            if (controller.signal.aborted) return;
            const natural = page.getViewport({ scale: 1 });
            const size = canvasSize(natural, width, pixelRatio());
            if (size === null) return;
            const viewport = page.getViewport({ scale: size.scale });
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            task = page.render({ canvas, viewport });
            await task.promise;
          },
          priorityRef.current,
        );
      } catch {
        // A cancelled render rejects, and a page the parser cannot draw
        // leaves its box empty rather than failing the whole document.
      }
    };
    void draw();
    return () => {
      controller.abort();
      task?.cancel();
      // A canvas holds its pixels until its size changes, whether or not it
      // is still in the document, so the release is written out.
      canvas.width = 0;
      canvas.height = 0;
      page?.cleanup();
    };
  }, [gate, pageNumber, pdf, width]);

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

function pixelRatio(): number {
  return Math.min(window.devicePixelRatio || 1, PDF_PIXEL_RATIO_CAP);
}

/** The scale a page is drawn at and the canvas it needs: fitted to the
 *  column at the pixel ratio, then lowered until the canvas holds at most
 *  `PDF_CANVAS_MAX_PIXELS` and neither side passes `PDF_CANVAS_MAX_SIDE`.
 *  Null for a page with no usable size. */
function canvasSize(
  page: PageSize,
  columnWidth: number,
  ratio: number,
): { readonly scale: number; readonly pixels: number } | null {
  if (!(page.width > 0 && page.height > 0 && columnWidth > 0)) return null;
  let scale = (columnWidth / page.width) * ratio;
  const area = page.width * page.height * scale * scale;
  if (area > PDF_CANVAS_MAX_PIXELS) scale *= Math.sqrt(PDF_CANVAS_MAX_PIXELS / area);
  scale = Math.min(scale, PDF_CANVAS_MAX_SIDE / page.width, PDF_CANVAS_MAX_SIDE / page.height);
  return {
    scale,
    pixels: Math.floor(page.width * scale) * Math.floor(page.height * scale),
  };
}

/** The pages that hold canvases: of the near pages whose size is known, the
 *  ones nearest the page being read, while there are fewer than
 *  `PDF_LIVE_CANVASES` and their canvases together stay within
 *  `PDF_LIVE_PIXELS`. It stops at the first page that does not fit, so a
 *  farther page never takes the place of a nearer one. */
function grantCanvases(
  near: ReadonlySet<number>,
  sizes: ReadonlyMap<number, PageSize>,
  reading: number,
  columnWidth: number,
  ratio: number,
): ReadonlySet<number> {
  const granted = new Set<number>();
  let pixels = 0;
  const nearest = [...near]
    .filter((pageNumber) => sizes.has(pageNumber))
    .sort(
      (left, right) =>
        Math.abs(left - reading) - Math.abs(right - reading) || left - right,
    );
  for (const pageNumber of nearest) {
    if (granted.size >= PDF_LIVE_CANVASES) break;
    const size = canvasSize(sizes.get(pageNumber)!, columnWidth, ratio);
    if (size === null) continue;
    if (pixels + size.pixels > PDF_LIVE_PIXELS) break;
    granted.add(pageNumber);
    pixels += size.pixels;
  }
  return granted;
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
