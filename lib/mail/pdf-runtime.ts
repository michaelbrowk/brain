import {
  getDocument,
  PDFWorker,
  VerbosityLevel,
  type PDFDocumentProxy,
} from "pdfjs-dist";

/**
 * pdf.js for the attachment viewer. Nothing imports this module statically:
 * the viewer reaches it with a dynamic `import()` when a PDF opens, so neither
 * pdf.js nor its worker is part of the app's own bundle.
 *
 * EACH DOCUMENT GETS ITS OWN WORKER. pdf.js keeps one `PDFWorker` per port,
 * and destroying a document destroys that `PDFWorker` with it. On one shared
 * port (`GlobalWorkerOptions.workerPort`) the next PDF, which the viewer
 * mounts while the last one is still animating out, would pick up the shared
 * worker and then lose it to the last one's teardown, or refuse to start
 * because that teardown is still pending. A worker per document is torn down
 * with its document and nothing else, and terminating it hands the parser's
 * copy of the file back as soon as the viewer moves on.
 *
 * The worker is a same-origin module worker the bundler emits from the
 * package's own file, so it runs under the app's CSP like any other script.
 * The document is opened with the smallest surface pdf.js offers: no XFA, no
 * WebAssembly decoders, no `FontFace` added to the page (glyphs are drawn as
 * paths), an embedded image refused past `PDF_MAX_IMAGE_PIXELS`, and only
 * errors in the console. pdf.js 6 no longer has an eval path to switch off
 * (`isEvalSupported` is gone), and the viewer draws pages to a canvas only,
 * with no annotation, form, link or text layer.
 */

/** The largest image inside a PDF the parser will decode, in pixels: 2^26 is
 *  an 8192 × 8192 scan, and an image a sender declares past it is skipped
 *  rather than allocated. */
export const PDF_MAX_IMAGE_PIXELS = 2 ** 26;

export interface OpenedPdf {
  /** Settles with the parsed document, or rejects with pdf.js's own error
   *  (`PasswordException`, `InvalidPDFException`) or a worker that never
   *  started. */
  readonly document: Promise<PDFDocumentProxy>;
  /** Destroys the document, then the worker. Safe to call more than once. */
  destroy(): Promise<void>;
}

export function openPdf(data: Uint8Array): OpenedPdf {
  const port = new Worker(
    new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url),
    { type: "module" },
  );
  const worker = PDFWorker.create({ port });
  // pdf.js only listens for messages on a port it was handed, so a worker
  // file that failed to load would leave the document pending for good.
  const workerFailed = new Promise<never>((_, reject) => {
    port.addEventListener(
      "error",
      () => reject(new Error("The PDF worker did not start")),
      { once: true },
    );
  });
  const task = getDocument({
    data,
    worker,
    enableXfa: false,
    useWasm: false,
    disableFontFace: true,
    maxImageSize: PDF_MAX_IMAGE_PIXELS,
    verbosity: VerbosityLevel.ERRORS,
  });
  let destroyed: Promise<void> | null = null;
  return {
    document: Promise.race([task.promise, workerFailed]),
    destroy() {
      destroyed ??= task
        .destroy()
        .catch(() => undefined)
        .finally(() => {
          worker.destroy();
          port.terminate();
        });
      return destroyed;
    },
  };
}
