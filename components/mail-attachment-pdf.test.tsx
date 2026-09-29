// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pdfjs = vi.hoisted(() => ({
  getDocument: vi.fn(),
  workers: [] as Array<{ port: unknown; destroy: ReturnType<typeof vi.fn> }>,
}));

vi.mock("pdfjs-dist", () => ({
  getDocument: pdfjs.getDocument,
  VerbosityLevel: { ERRORS: 0, WARNINGS: 1, INFOS: 5 },
  PDFWorker: {
    create: ({ port }: { port: unknown }) => {
      const worker = { port, destroy: vi.fn() };
      pdfjs.workers.push(worker);
      return worker;
    },
  },
}));

import { MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY } from "@/lib/mail/content-types";
import type { MailContentAttachmentDto } from "@/lib/mail/content-types";
import { AttachmentBlobStore } from "@/lib/mail/attachment-blobs";
import { ATTACHMENT_PDF_PREVIEW_MAX_BYTES } from "@/lib/mail/attachment-preview";
import { MailFetchGate } from "@/lib/mail/inline-fetch-gate";
import {
  MailAttachmentPdf,
  PDF_CANVAS_MAX_PIXELS,
  PDF_CANVAS_MAX_SIDE,
  PDF_LIVE_CANVASES,
  PDF_LIVE_PIXELS,
  PDF_PAGE_LIMIT,
  PDF_PIXEL_RATIO_CAP,
  PDF_RENDERS_AT_ONCE,
} from "./mail-attachment-pdf";

const ACCOUNT_ID = "account-a0123456789abcdef0123456789abcdef";
const PDF_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
const agenda: MailContentAttachmentDto = {
  attachmentId: "attachment-a33333333333333333333333333333333",
  filename: "agenda.pdf",
  mimeType: "application/pdf",
  disposition: "attachment",
  contentId: null,
  bytes: PDF_BYTES.byteLength,
};
const URL_UNDER_TEST = `/api/mail/attachments/${agenda.attachmentId}?accountId=${ACCOUNT_ID}`;

class FakeWorker {
  static instances: FakeWorker[] = [];
  terminate = vi.fn();
  listeners = new Map<string, () => void>();
  constructor(
    readonly url: URL | string,
    readonly options: WorkerOptions,
  ) {
    FakeWorker.instances.push(this);
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, listener);
  }
}

/** One IntersectionObserver the test can drive by hand, named by its margin. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  readonly rootMargin: string;
  constructor(
    readonly callback: IntersectionObserverCallback,
    options: IntersectionObserverInit = {},
  ) {
    this.rootMargin = options.rootMargin ?? "0px";
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
  takeRecords() {
    return [];
  }
  report(pages: Record<number, boolean>) {
    const entries = [...this.targets]
      .filter((target) => Number((target as HTMLElement).dataset.page) in pages)
      .map(
        (target) =>
          ({
            target,
            isIntersecting: pages[Number((target as HTMLElement).dataset.page)],
          }) as IntersectionObserverEntry,
      );
    this.callback(entries, this as unknown as IntersectionObserver);
  }
}

class FakeResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ target, contentRect: { width: 600.4 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

function observer(kind: "near" | "far" | "reading"): FakeIntersectionObserver {
  const all = FakeIntersectionObserver.instances;
  const found =
    kind === "reading"
      ? all.find((candidate) => candidate.rootMargin.startsWith("-50%"))
      : kind === "near"
        ? all.find((candidate) => candidate.rootMargin === "100% 0px")
        : all.find((candidate) => candidate.rootMargin === "200% 0px");
  if (!found) throw new Error(`no ${kind} observer`);
  return found;
}

type FakeRender = { promise: Promise<void>; cancel: ReturnType<typeof vi.fn> };
type FakePage = {
  getViewport: (options: { scale: number }) => { width: number; height: number };
  render: ReturnType<typeof vi.fn<(params: { canvas: HTMLCanvasElement }) => FakeRender>>;
  cleanup: ReturnType<typeof vi.fn>;
};

function fakeDocument(
  numPages: number,
  size: (pageNumber: number) => { width: number; height: number } = () => ({
    width: 612,
    height: 792,
  }),
  render: () => FakeRender = () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
) {
  const pages = new Map<number, FakePage>();
  const page = (pageNumber: number): FakePage => {
    const existing = pages.get(pageNumber);
    if (existing) return existing;
    const { width, height } = size(pageNumber);
    const created: FakePage = {
      getViewport: ({ scale }) => ({ width: width * scale, height: height * scale }),
      render: vi.fn(render),
      cleanup: vi.fn(),
    };
    pages.set(pageNumber, created);
    return created;
  };
  return {
    pages,
    document: {
      numPages,
      getPage: vi.fn(async (pageNumber: number) => page(pageNumber)),
    },
  };
}

function loadingTask(result: Promise<unknown>) {
  return { promise: result, destroy: vi.fn(async () => {}) };
}

function pdfResponse(): Response {
  return new Response(PDF_BYTES as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(PDF_BYTES.byteLength),
      "Content-Disposition": 'attachment; filename="agenda.pdf"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY,
    },
  });
}

async function settle() {
  for (let step = 0; step < 6; step += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

/** The first dynamic import of the runtime is a module load, not a
 *  microtask, so the tests wait for what they are about to read. */
async function until(ready: () => boolean) {
  for (let step = 0; step < 100 && !ready(); step += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
  if (!ready()) throw new Error("the PDF never settled");
}

describe("MailAttachmentPdf", () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  let store: AttachmentBlobStore;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    FakeWorker.instances = [];
    FakeIntersectionObserver.instances = [];
    pdfjs.workers.length = 0;
    pdfjs.getDocument.mockReset();
    fetchMock = vi.fn(async () => pdfResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.stubGlobal("devicePixelRatio", 3);
    store = new AttachmentBlobStore(ACCOUNT_ID, new MailFetchGate(2));
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  function show(source: Pick<AttachmentBlobStore, "blob"> = store) {
    return act(async () => {
      root.render(<MailAttachmentPdf attachment={agenda} url={URL_UNDER_TEST} store={source} />);
    });
  }

  async function open(documentUnderTest = fakeDocument(7)) {
    const task = loadingTask(Promise.resolve(documentUnderTest.document));
    pdfjs.getDocument.mockReturnValue(task);
    await show();
    await until(() => host.querySelector("[data-page]") !== null);
    return { ...documentUnderTest, task };
  }

  function alert(): string | null | undefined {
    return host.querySelector('[role="alert"]')?.textContent;
  }

  it("reads the bytes through the verified download and opens them with pdf.js's smallest surface", async () => {
    await open();
    expect(fetchMock).toHaveBeenCalledWith(
      URL_UNDER_TEST,
      expect.objectContaining({ credentials: "same-origin", redirect: "error" }),
    );
    const [params] = pdfjs.getDocument.mock.calls[0]!;
    expect(params).toMatchObject({
      enableXfa: false,
      useWasm: false,
      disableFontFace: true,
      maxImageSize: 2 ** 26,
      verbosity: 0,
    });
    expect(params.data).toBeInstanceOf(Uint8Array);
    expect(params.data.byteLength).toBe(PDF_BYTES.byteLength);
    // Its own module worker, handed to pdf.js as the port.
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.options).toEqual({ type: "module" });
    expect(String(FakeWorker.instances[0]!.url)).toContain("pdf.worker.min.mjs");
    expect(params.worker).toBe(pdfjs.workers[0]);
    expect(pdfjs.workers[0]!.port).toBe(FakeWorker.instances[0]);
  });

  it("lays out every page but draws a canvas only for the pages near the viewport", async () => {
    const { pages } = await open();
    expect(host.querySelectorAll("[data-page]")).toHaveLength(7);
    expect(host.querySelectorAll("canvas")).toHaveLength(0);

    await act(async () => observer("near").report({ 1: true, 2: true }));
    await settle();
    const canvases = host.querySelectorAll("canvas");
    expect(canvases).toHaveLength(2);
    expect(pages.get(1)!.render).toHaveBeenCalledTimes(1);
    expect(pages.get(2)!.render).toHaveBeenCalledTimes(1);
    expect(pages.get(3)).toBeUndefined();

    // Fitted to the column (600 CSS px) at a pixel ratio capped at 2, even
    // on a 3x screen.
    expect(PDF_PIXEL_RATIO_CAP).toBe(2);
    const [{ canvas }] = pages.get(1)!.render.mock.calls[0]!;
    expect(canvas).toBe(canvases[0]);
    expect(canvases[0]!.width).toBe(1200);
    expect(canvases[0]!.height).toBe(Math.floor(792 * (600 / 612) * 2));
  });

  it("keeps a page's canvas under 2^24 pixels, however tall the sender made it", async () => {
    // 1200 × 16,000 at the column's width and 2x: over the area, under the side.
    const { pages } = await open(fakeDocument(1, () => ({ width: 60, height: 800 })));
    await act(async () => observer("near").report({ 1: true }));
    await settle();
    expect(PDF_CANVAS_MAX_PIXELS).toBe(2 ** 24);
    const canvas = host.querySelector("canvas")!;
    expect(pages.get(1)!.render).toHaveBeenCalledTimes(1);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(2 ** 24);
    expect(canvas.width * canvas.height).toBeGreaterThan(0.95 * 2 ** 24);
  });

  it("keeps each side of a page's canvas within 16,384 pixels", async () => {
    await open(fakeDocument(1, () => ({ width: 40, height: 800 })));
    await act(async () => observer("near").report({ 1: true }));
    await settle();
    expect(PDF_CANVAS_MAX_SIDE).toBe(16_384);
    const canvas = host.querySelector("canvas")!;
    expect(canvas.height).toBeLessThanOrEqual(16_384);
    expect(canvas.width).toBeGreaterThan(0);
  });

  function allNear(count: number): Record<number, boolean> {
    return Object.fromEntries(Array.from({ length: count }, (_, index) => [index + 1, true]));
  }

  it("renders at most four pages at a time", async () => {
    const renders: FakeRender[] = [];
    const never = () => {
      const render = { promise: new Promise<void>(() => {}), cancel: vi.fn() };
      renders.push(render);
      return render;
    };
    await open(fakeDocument(12, undefined, never));
    await act(async () => observer("near").report(allNear(12)));
    await settle();
    expect(PDF_RENDERS_AT_ONCE).toBe(4);
    expect(renders).toHaveLength(4);
  });

  it("keeps at most eight canvases, the ones nearest the page being read", async () => {
    await open(fakeDocument(12));
    await act(async () => observer("reading").report({ 6: true }));
    await act(async () => observer("near").report(allNear(12)));
    await settle();
    expect(PDF_LIVE_CANVASES).toBe(8);
    const drawn = [...host.querySelectorAll("[data-page]")]
      .filter((page) => page.querySelector("canvas"))
      .map((page) => Number((page as HTMLElement).dataset.page));
    expect(drawn).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("holds all canvases together to 2^26 pixels when later pages are nothing like the first", async () => {
    // Page one is 20:1 across, so its shape promises small pages; every later
    // page is 1:20 and each of them fills a canvas to its cap.
    const { pages } = await open(
      fakeDocument(12, (pageNumber) =>
        pageNumber === 1 ? { width: 800, height: 40 } : { width: 40, height: 800 },
      ),
    );
    await act(async () => observer("near").report(allNear(12)));
    await settle();
    expect(PDF_LIVE_PIXELS).toBe(2 ** 26);
    const canvases = [...host.querySelectorAll("canvas")];
    const pixels = canvases.reduce((sum, canvas) => sum + canvas.width * canvas.height, 0);
    expect(canvases.length).toBeGreaterThan(1);
    expect(canvases.length).toBeLessThanOrEqual(8);
    expect(pixels).toBeLessThanOrEqual(2 ** 26);
    expect(
      Math.max(...canvases.map((canvas) => Math.max(canvas.width, canvas.height))),
    ).toBeLessThanOrEqual(16_384);
    // The pages left out were never drawn, not drawn and then dropped.
    const rendered = [...pages.values()].filter((page) => page.render.mock.calls.length > 0);
    expect(rendered).toHaveLength(canvases.length);
  });

  it("draws nothing for a page with no size instead of dividing by it", async () => {
    const { pages } = await open(fakeDocument(1, () => ({ width: 0, height: 0 })));
    await act(async () => observer("near").report({ 1: true }));
    await settle();
    expect(pages.get(1)!.render).not.toHaveBeenCalled();
  });

  it("lays out the first 1,000 pages and offers the rest as a download", async () => {
    await open(fakeDocument(4_212));
    expect(PDF_PAGE_LIMIT).toBe(1_000);
    expect(host.querySelectorAll("[data-page]")).toHaveLength(1_000);
    expect(host.textContent).toContain("Page 1 of 4212");
    const rest = [...host.querySelectorAll("a")].find(
      (link) => link.textContent === "Download to read the rest",
    );
    expect(rest?.getAttribute("href")).toBe(URL_UNDER_TEST);
    expect(rest?.getAttribute("download")).toBe("agenda.pdf");
  });

  it("releases a page that scrolls far away, and draws it again on the way back", async () => {
    const { pages } = await open();
    await act(async () => observer("near").report({ 1: true, 2: true }));
    await settle();
    const first = host.querySelector<HTMLCanvasElement>('[data-page="1"] canvas')!;

    await act(async () => observer("far").report({ 1: false }));
    await settle();
    expect(host.querySelector('[data-page="1"] canvas')).toBeNull();
    expect(first.width).toBe(0);
    expect(pages.get(1)!.cleanup).toHaveBeenCalled();
    expect(host.querySelectorAll("canvas")).toHaveLength(1);

    await act(async () => observer("near").report({ 1: true }));
    await settle();
    expect(host.querySelector('[data-page="1"] canvas')).not.toBeNull();
    expect(pages.get(1)!.render).toHaveBeenCalledTimes(2);
  });

  it("cancels a render still drawing when its page is let go, and when the viewer closes", async () => {
    const renders: FakeRender[] = [];
    const never = () => {
      const render = { promise: new Promise<void>(() => {}), cancel: vi.fn() };
      renders.push(render);
      return render;
    };
    await open(fakeDocument(3, undefined, never));
    await act(async () => observer("near").report({ 1: true, 2: true }));
    await settle();
    expect(renders).toHaveLength(2);

    await act(async () => observer("far").report({ 1: false }));
    await settle();
    expect(renders[0]!.cancel).toHaveBeenCalledTimes(1);
    expect(renders[1]!.cancel).not.toHaveBeenCalled();

    await act(async () => root.render(<></>));
    expect(renders[1]!.cancel).toHaveBeenCalledTimes(1);
  });

  it("says which page is being read", async () => {
    await open();
    expect(host.textContent).toContain("Page 1 of 7");
    await act(async () => observer("reading").report({ 2: true }));
    expect(host.textContent).toContain("Page 2 of 7");
  });

  it("hands the keyboard to the page scroller once the pages stand", async () => {
    await open();
    const scroller = host.querySelector<HTMLElement>(".brain-viewer-pdf-scroll");
    expect(scroller?.tabIndex).toBe(0);
    expect(document.activeElement).toBe(scroller);
  });

  it("says a password-protected PDF is one, with Download beside it, and lets pdf.js go", async () => {
    const task = loadingTask(
      Promise.reject(Object.assign(new Error("No password given"), { name: "PasswordException" })),
    );
    pdfjs.getDocument.mockReturnValue(task);
    await show();
    await until(() => host.querySelector('[role="alert"]') !== null);
    expect(alert()).toContain("This PDF is password protected");
    const download = host.querySelector<HTMLAnchorElement>('[role="alert"] a');
    expect(download?.getAttribute("href")).toBe(URL_UNDER_TEST);
    expect(download?.getAttribute("download")).toBe("agenda.pdf");
    expect(download?.textContent).toBe("Download");
    await settle();
    expect(task.destroy).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it("says a broken file could not be opened, and lets pdf.js go", async () => {
    const task = loadingTask(
      Promise.reject(Object.assign(new Error("Invalid PDF structure"), { name: "InvalidPDFException" })),
    );
    pdfjs.getDocument.mockReturnValue(task);
    await show();
    await until(() => host.querySelector('[role="alert"]') !== null);
    expect(alert()).toContain("Couldn’t open this file");
    await settle();
    expect(task.destroy).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it("says so when the worker never starts, instead of waiting for it for good", async () => {
    const task = loadingTask(new Promise(() => {}));
    pdfjs.getDocument.mockReturnValue(task);
    await show();
    await until(() => FakeWorker.instances.length === 1);
    expect(alert()).toBeUndefined();
    await act(async () => FakeWorker.instances[0]!.listeners.get("error")?.());
    await until(() => host.querySelector('[role="alert"]') !== null);
    expect(alert()).toContain("Couldn’t open this file");
    await settle();
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it("says the same when the download itself fails, and never starts pdf.js", async () => {
    fetchMock.mockResolvedValue(new Response("gone", { status: 404 }));
    await show();
    await until(() => host.querySelector('[role="alert"]') !== null);
    expect(alert()).toContain("Couldn’t open this file");
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("never hands pdf.js more than the preview cap", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const oversized = {
      blob: vi.fn(
        async () =>
          ({ size: ATTACHMENT_PDF_PREVIEW_MAX_BYTES + 1, arrayBuffer }) as unknown as Blob,
      ),
    };
    await show(oversized);
    await until(() => host.querySelector('[role="alert"]') !== null);
    expect(alert()).toContain("Couldn’t open this file");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
    // Asked for at the viewer's priority, ahead of the body's own images.
    expect(oversized.blob).toHaveBeenCalledWith(agenda, 1, expect.any(AbortSignal));
  });

  it("destroys the document and its worker when it closes", async () => {
    const { task } = await open(fakeDocument(3));
    await act(async () => root.render(<></>));
    await settle();
    expect(task.destroy).toHaveBeenCalledTimes(1);
    expect(pdfjs.workers[0]!.destroy).toHaveBeenCalledTimes(1);
    expect(FakeWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it("aborts a download still in flight when it closes", async () => {
    let signal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise<Response>(() => {
          signal = init.signal ?? undefined;
        }),
    );
    await show();
    await until(() => signal !== undefined);
    expect(signal?.aborted).toBe(false);
    await act(async () => root.render(<></>));
    expect(signal?.aborted).toBe(true);
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
  });
});
