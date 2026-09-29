"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { OpenedPdf } from "@/lib/mail/pdf-runtime";

/** A page is drawn at the screen's pixel ratio, but never past 2x: a 3x
 *  phone would spend 2.25 times the memory of 2x on every page for detail the
 *  eye cannot find at reading distance. */
export const PDF_PIXEL_RATIO_CAP = 2;

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
      readonly document: PDFDocumentProxy;
      /** The first page's height over its width: every page box takes it
       *  until that page is drawn and knows its own. */
      readonly aspect: number;
    }
  | { readonly kind: "failed"; readonly reason: "broken" | "password" };

/**
 * A PDF attachment in the viewer: every page drawn to a `<canvas>` in one
 * vertical scroll, fitted to the column. Canvas only, on purpose: no text,
 * annotation, form or link layer, so a stranger's PDF can show its pages and
 * do nothing else. pdf.js is fetched by a dynamic import on the first PDF,
 * the bytes by the same authenticated route the Download link uses, and both
 * the request and the parsed document go away with the component.
 */
export function MailAttachmentPdf({
  url,
  filename,
}: {
  url: string;
  filename: string | null;
}) {
  const [state, setState] = useState<PdfState>({ kind: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    let opened: OpenedPdf | null = null;
    let disposed = false;
    const load = async () => {
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          credentials: "same-origin",
          cache: "no-store",
          referrerPolicy: "no-referrer",
          redirect: "error",
        });
        if (!response.ok) throw new Error(`The PDF answered ${response.status}`);
        const data = new Uint8Array(await response.arrayBuffer());
        if (disposed) return;
        const { openPdf } = await import("@/lib/mail/pdf-runtime");
        if (disposed) return;
        opened = openPdf(data);
        const document = await opened.document;
        const first = await document.getPage(1);
        const { width, height } = first.getViewport({ scale: 1 });
        if (!disposed) setState({ kind: "ready", document, aspect: height / width });
      } catch (error) {
        if (disposed) return;
        setState({ kind: "failed", reason: passwordProtected(error) ? "password" : "broken" });
      }
    };
    void load();
    return () => {
      disposed = true;
      controller.abort();
      void opened?.destroy();
    };
  }, [url]);

  if (state.kind === "failed") {
    return (
      <AttachmentFailure
        message={
          state.reason === "password"
            ? "This PDF is password protected"
            : "Couldn’t open this file"
        }
        href={url}
        filename={filename}
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
  return <PdfPages document={state.document} aspect={state.aspect} />;
}

function PdfPages({
  document,
  aspect,
}: {
  document: PDFDocumentProxy;
  aspect: number;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [live, setLive] = useState<ReadonlySet<number>>(() => new Set());
  const [reading, setReading] = useState(1);
  const total = document.numPages;

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
  }, [total]);

  return (
    <div className="brain-viewer-pdf">
      <div ref={scrollerRef} className="brain-viewer-pdf-scroll">
        <div ref={columnRef} className="brain-viewer-pdf-column">
          {Array.from({ length: total }, (_, index) => (
            <PdfPage
              key={index + 1}
              document={document}
              pageNumber={index + 1}
              aspect={aspect}
              width={width}
              live={live.has(index + 1)}
            />
          ))}
        </div>
      </div>
      <p className="brain-viewer-page-pill text-control">
        Page {reading} of {total}
      </p>
    </div>
  );
}

function PdfPage({
  document,
  pageNumber,
  aspect,
  width,
  live,
}: {
  document: PDFDocumentProxy;
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
          document={document}
          pageNumber={pageNumber}
          width={width}
          onAspect={setOwnAspect}
        />
      )}
    </div>
  );
}

function PdfCanvas({
  document,
  pageNumber,
  width,
  onAspect,
}: {
  document: PDFDocumentProxy;
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
        page = await document.getPage(pageNumber);
        if (cancelled) return;
        const natural = page.getViewport({ scale: 1 });
        onAspect(natural.height / natural.width);
        const ratio = Math.min(window.devicePixelRatio || 1, PDF_PIXEL_RATIO_CAP);
        const viewport = page.getViewport({ scale: (width / natural.width) * ratio });
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
  }, [document, onAspect, pageNumber, width]);

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

function passwordProtected(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "PasswordException"
  );
}
