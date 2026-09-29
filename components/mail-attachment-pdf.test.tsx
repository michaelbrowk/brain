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
  PDFWorker: {
    create: ({ port }: { port: unknown }) => {
      const worker = { port, destroy: vi.fn() };
      pdfjs.workers.push(worker);
      return worker;
    },
  },
}));

import { MailAttachmentPdf, PDF_PIXEL_RATIO_CAP } from "./mail-attachment-pdf";

const URL_UNDER_TEST = "/api/mail/attachments/attachment-pdf?accountId=account-a1";

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

type FakePage = {
  getViewport: (options: { scale: number }) => { width: number; height: number };
  render: ReturnType<typeof vi.fn>;
  cleanup: ReturnType<typeof vi.fn>;
};

function fakeDocument(numPages: number) {
  const pages = new Map<number, FakePage>();
  const page = (pageNumber: number): FakePage => {
    const existing = pages.get(pageNumber);
    if (existing) return existing;
    const created: FakePage = {
      getViewport: ({ scale }) => ({ width: 612 * scale, height: 792 * scale }),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
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
  return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), {
    status: 200,
    headers: { "Content-Type": "application/pdf" },
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
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function open(numPages = 7) {
    const { document: pdf, pages } = fakeDocument(numPages);
    const task = loadingTask(Promise.resolve(pdf));
    pdfjs.getDocument.mockReturnValue(task);
    await act(async () => {
      root.render(<MailAttachmentPdf url={URL_UNDER_TEST} filename="agenda.pdf" />);
    });
    await until(() => host.querySelector("[data-page]") !== null);
    return { pdf, pages, task };
  }

  it("fetches the bytes same-origin and parses them with XFA off", async () => {
    await open();
    expect(fetchMock).toHaveBeenCalledWith(
      URL_UNDER_TEST,
      expect.objectContaining({ credentials: "same-origin" }),
    );
    const [params] = pdfjs.getDocument.mock.calls[0]!;
    expect(params).toMatchObject({ enableXfa: false });
    expect(params.data).toBeInstanceOf(Uint8Array);
    // Its own module worker, handed to pdf.js as the port.
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.options).toEqual({ type: "module" });
    expect(String(FakeWorker.instances[0]!.url)).toContain("pdf.worker.min.mjs");
    expect(params.worker).toBe(pdfjs.workers[0]);
    expect(pdfjs.workers[0]!.port).toBe(FakeWorker.instances[0]);
  });

  it("lays out every page but draws a canvas only for the pages near the viewport", async () => {
    const { pages } = await open(7);
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
    const [{ canvas, viewport }] = pages.get(1)!.render.mock.calls[0]!;
    expect(canvas).toBe(canvases[0]);
    expect(viewport.width).toBeCloseTo(600 * 2);
    expect(canvases[0]!.width).toBe(1200);
    expect(canvases[0]!.height).toBe(Math.floor(792 * (600 / 612) * 2));
  });

  it("releases a page that scrolls far away, and draws it again on the way back", async () => {
    const { pages } = await open(7);
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

  it("says which page is being read", async () => {
    await open(7);
    expect(host.textContent).toContain("Page 1 of 7");
    await act(async () => observer("reading").report({ 2: true }));
    expect(host.textContent).toContain("Page 2 of 7");
  });

  it("says a password-protected PDF is one, with Download beside it", async () => {
    pdfjs.getDocument.mockReturnValue(
      loadingTask(
        Promise.reject(Object.assign(new Error("No password given"), { name: "PasswordException" })),
      ),
    );
    await act(async () => {
      root.render(<MailAttachmentPdf url={URL_UNDER_TEST} filename="locked.pdf" />);
    });
    await until(() => host.querySelector('[role="alert"]') !== null);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "This PDF is password protected",
    );
    const download = host.querySelector<HTMLAnchorElement>('[role="alert"] a');
    expect(download?.getAttribute("href")).toBe(URL_UNDER_TEST);
    expect(download?.getAttribute("download")).toBe("locked.pdf");
    expect(download?.textContent).toBe("Download");
  });

  it("says a broken file could not be opened", async () => {
    pdfjs.getDocument.mockReturnValue(
      loadingTask(
        Promise.reject(Object.assign(new Error("Invalid PDF structure"), { name: "InvalidPDFException" })),
      ),
    );
    await act(async () => {
      root.render(<MailAttachmentPdf url={URL_UNDER_TEST} filename="broken.pdf" />);
    });
    await until(() => host.querySelector('[role="alert"]') !== null);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t open this file");
  });

  it("says the same when the download itself fails, and never starts pdf.js", async () => {
    fetchMock.mockResolvedValue(new Response("gone", { status: 404 }));
    await act(async () => {
      root.render(<MailAttachmentPdf url={URL_UNDER_TEST} filename="gone.pdf" />);
    });
    await until(() => host.querySelector('[role="alert"]') !== null);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Couldn’t open this file");
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  it("destroys the document and its worker when it closes", async () => {
    const { task } = await open(3);
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
    await act(async () => {
      root.render(<MailAttachmentPdf url={URL_UNDER_TEST} filename="slow.pdf" />);
    });
    expect(signal?.aborted).toBe(false);
    await act(async () => root.render(<></>));
    expect(signal?.aborted).toBe(true);
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
  });
});
