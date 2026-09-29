// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));
vi.mock("./mail-attachment-pdf", () => ({
  MailAttachmentPdf: ({ url }: { url: string }) => <div data-pdf-stage={url} />,
  AttachmentFailure: ({ message }: { message: string }) => <p role="alert">{message}</p>,
}));

import { MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY } from "@/lib/mail/content-types";
import type { MailContentAttachmentDto } from "@/lib/mail/content-types";
import { ATTACHMENT_FETCH_PRIORITY, AttachmentBlobStore } from "@/lib/mail/attachment-blobs";
import { MailAttachments } from "./mail-attachments";

const ACCOUNT_ID = "account-a0123456789abcdef0123456789abcdef";
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

function attachment(
  attachmentId: string,
  filename: string,
  mimeType: string,
  overrides: Partial<MailContentAttachmentDto> = {},
): MailContentAttachmentDto {
  return {
    attachmentId,
    filename,
    mimeType,
    disposition: "attachment",
    contentId: null,
    bytes: BYTES.byteLength,
    ...overrides,
  };
}

const first = attachment("attachment-first", "first.png", "image/png");
const second = attachment("attachment-second", "second.jpg", "image/jpeg");
const agenda = attachment("attachment-agenda", "agenda.pdf", "application/pdf");
const archive = attachment("attachment-archive", "photos.zip", "application/zip");
const logo = attachment("attachment-logo", "image001.png", "image/png", {
  disposition: "inline",
  contentId: "logo@example.test",
});
const all = [first, second, agenda, archive, logo];

function url(id: string): string {
  return `/api/mail/attachments/${id}?accountId=${ACCOUNT_ID}`;
}

function verified(file: MailContentAttachmentDto): Response {
  return new Response(BYTES as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(BYTES.byteLength),
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY,
    },
  });
}

/** The picture every stubbed `Image` reports once its blob URL loads, or
 *  null for one that fails to load. */
let pictureSize: { width: number; height: number } | null = { width: 600, height: 800 };

class FakeImage {
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    if (!value) return;
    setTimeout(() => {
      if (pictureSize === null) {
        this.onerror?.();
        return;
      }
      this.naturalWidth = pictureSize.width;
      this.naturalHeight = pictureSize.height;
      this.onload?.();
    }, 0);
  }
}

type FakeBitmap = { width: number; height: number; close: ReturnType<typeof vi.fn> };

describe("MailAttachments", () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;
  let createImageBitmapMock: ReturnType<typeof vi.fn>;
  let bitmaps: FakeBitmap[];
  let drawImage: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn<(source: string) => void>>;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    fetchMock = vi.fn(async (request: string) => {
      const file = all.find((candidate) => request === url(candidate.attachmentId));
      return file ? verified(file) : new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    pictureSize = { width: 600, height: 800 };
    vi.stubGlobal("Image", FakeImage);
    // The decoder answers with exactly the size it was asked to resize to.
    bitmaps = [];
    createImageBitmapMock = vi.fn(
      async (
        _source: Blob,
        _sx: number,
        _sy: number,
        _sw: number,
        _sh: number,
        options: ImageBitmapOptions,
      ) => {
        const bitmap = { width: options.resizeWidth!, height: options.resizeHeight!, close: vi.fn() };
        bitmaps.push(bitmap);
        return bitmap;
      },
    );
    vi.stubGlobal("createImageBitmap", createImageBitmapMock);
    drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
      () => ({ drawImage }) as unknown as CanvasRenderingContext2D,
    );
    let next = 0;
    revokeObjectURL = vi.fn();
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:brain/${(next += 1)}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(revokeObjectURL);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function show(
    attachments: readonly MailContentAttachmentDto[],
    renderedHtml: string | null = null,
    onViewerOpenChange?: (open: boolean) => void,
  ) {
    await act(async () => {
      root.render(
        <MailAttachments
          accountId={ACCOUNT_ID}
          attachments={attachments}
          renderedHtml={renderedHtml}
          onViewerOpenChange={onViewerOpenChange}
        />,
      );
    });
    await settle();
  }

  async function settle() {
    for (let step = 0; step < 10; step += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
  }

  function tiles(): HTMLButtonElement[] {
    return [...host.querySelectorAll<HTMLButtonElement>("button.brain-mail-tile")];
  }

  function chips(): HTMLAnchorElement[] {
    return [...host.querySelectorAll<HTMLAnchorElement>("a.brain-mail-chip")];
  }

  it("draws a tile for each picture and PDF and keeps a chip for the rest", async () => {
    await show([first, archive, second, agenda]);
    expect(tiles().map((tile) => tile.getAttribute("aria-label"))).toEqual([
      "first.png, 8 B",
      "second.jpg, 8 B",
      "agenda.pdf, 8 B",
    ]);
    const picture = tiles()[0]!.querySelector("canvas")!;
    expect(picture.getAttribute("role")).toBe("img");
    expect(picture.getAttribute("aria-label")).toBe("first.png");
    expect(tiles()[2]!.querySelector("canvas")).toBeNull();
    expect(tiles()[2]!.textContent).toContain("PDF");
    expect(tiles()[2]!.querySelector("svg")).not.toBeNull();

    expect(chips()).toHaveLength(1);
    expect(chips()[0]!.getAttribute("href")).toBe(url(archive.attachmentId));
    expect(chips()[0]!.getAttribute("download")).toBe("photos.zip");
    // A PDF's tile is a glyph: nothing is downloaded for it until it opens.
    expect(fetchMock.mock.calls.map(([request]) => request)).toEqual([
      url(first.attachmentId),
      url(second.attachmentId),
    ]);
  });

  function largestCanvas(): number {
    return Math.max(
      0,
      ...[...host.querySelectorAll("canvas")].map((canvas) => Math.max(canvas.width, canvas.height)),
    );
  }

  it("decodes the centred square of the photo at tile size, and lets the bitmap go", async () => {
    pictureSize = { width: 600, height: 800 };
    await show([first]);
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    const [blob, sx, sy, sw, sh, options] = createImageBitmapMock.mock.calls[0]!;
    expect(blob.size).toBe(BYTES.byteLength);
    expect([sx, sy, sw, sh]).toEqual([0, 100, 600, 600]);
    expect(options).toMatchObject({ resizeWidth: 112, resizeHeight: 112, resizeQuality: "medium" });
    const canvas = tiles()[0]!.querySelector("canvas")!;
    expect([canvas.width, canvas.height]).toEqual([112, 112]);
    expect(drawImage).toHaveBeenCalledTimes(1);
    expect(bitmaps[0]!.close).toHaveBeenCalledTimes(1);
  });

  it("crops a long picture to its middle square rather than decoding its length", async () => {
    pictureSize = { width: 600, height: 4_000 };
    await show([first]);
    const [, sx, sy, sw, sh] = createImageBitmapMock.mock.calls[0]!;
    expect([sx, sy, sw, sh]).toEqual([0, 1_700, 600, 600]);
    expect(largestCanvas()).toBe(112);
  });

  it("never draws a small picture larger than it is", async () => {
    pictureSize = { width: 40, height: 60 };
    await show([first]);
    const [, sx, sy, sw, sh, options] = createImageBitmapMock.mock.calls[0]!;
    expect([sx, sy, sw, sh]).toEqual([0, 10, 40, 40]);
    expect(options).toMatchObject({ resizeWidth: 40, resizeHeight: 40 });
    expect(largestCanvas()).toBe(40);
  });

  it("shows a picture past 8:1 either way in an <img>, and never sizes a canvas to it", async () => {
    for (const size of [
      { width: 10, height: 1_000 },
      { width: 1_200, height: 2 },
      { width: 1, height: 4_000 },
    ]) {
      pictureSize = size;
      createImageBitmapMock.mockClear();
      await show([first]);
      expect(createImageBitmapMock).not.toHaveBeenCalled();
      expect(tiles()[0]!.querySelector("img")?.getAttribute("src")).toMatch(/^blob:brain\//);
      expect(largestCanvas()).toBeLessThanOrEqual(448);
      await act(async () => root.render(<></>));
    }
  });

  it("gives the tile's canvas memory back when the letter leaves", async () => {
    await show([first]);
    const canvas = tiles()[0]!.querySelector("canvas")!;
    expect(canvas.width).toBe(112);
    act(() => root.render(<></>));
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });

  it("downloads tiles at the tile priority, behind the body's own images", async () => {
    const blob = vi.spyOn(AttachmentBlobStore.prototype, "blob");
    await show([first]);
    expect(ATTACHMENT_FETCH_PRIORITY.tile).toBe(-1);
    expect(blob).toHaveBeenCalledWith(first, -1, expect.any(AbortSignal));
  });

  it("starts a tile from the reader's own scroller, 200px before it shows", async () => {
    const options: IntersectionObserverInit[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(_callback: IntersectionObserverCallback, init: IntersectionObserverInit) {
          options.push(init);
        }
        observe() {}
        disconnect() {}
      },
    );
    const scroller = document.createElement("div");
    scroller.setAttribute("data-mail-reader-scroll", "");
    host.append(scroller);
    const scrollerRoot = createRoot(scroller);
    await act(async () => {
      scrollerRoot.render(
        <MailAttachments accountId={ACCOUNT_ID} attachments={[first]} renderedHtml={null} />,
      );
    });
    expect(options).toEqual([{ root: scroller, rootMargin: "200px 0px" }]);
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => scrollerRoot.unmount());
  });

  it("turns a picture that will not load back into a chip", async () => {
    pictureSize = null;
    await show([first, second]);
    expect(createImageBitmapMock).not.toHaveBeenCalled();
    expect(tiles()).toHaveLength(0);
    expect(chips()).toHaveLength(2);
  });

  it("falls back to the blob in an <img> where the engine cannot decode small", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    await show([first]);
    const image = tiles()[0]!.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("blob:brain/1");
    expect(image.getAttribute("alt")).toBe("first.png");
    expect(image.getAttribute("decoding")).toBe("async");
  });

  it("leaves out an inline image the letter's HTML already draws", async () => {
    await show([logo, first], '<p>Hi</p><img data-brain-cid="logo@example.test" alt="">');
    expect(tiles().map((tile) => tile.getAttribute("aria-label"))).toEqual(["first.png, 8 B"]);
    expect(host.textContent).not.toContain("image001.png");
  });

  it("keeps an inline image nobody references", async () => {
    await show([logo, first], "<p>No pictures</p>");
    expect(tiles()).toHaveLength(2);
  });

  it("renders nothing when everything is already in the body", async () => {
    await show([logo], '<img data-brain-cid="logo@example.test" alt="">');
    expect(host.querySelector('[aria-label="Attachments"]')).toBeNull();
  });

  it("turns a picture whose download fails back into a chip", async () => {
    fetchMock.mockImplementation(async (request: string) =>
      request === url(first.attachmentId) ? new Response("", { status: 503 }) : verified(second),
    );
    await show([first, second]);
    expect(tiles().map((tile) => tile.getAttribute("aria-label"))).toEqual(["second.jpg, 8 B"]);
    expect(chips().map((chip) => chip.textContent)).toEqual([
      expect.stringContaining("first.png"),
    ]);
  });

  it("turns a picture no decoder can read back into a chip", async () => {
    createImageBitmapMock.mockRejectedValue(new DOMException("broken", "InvalidStateError"));
    await show([first, second]);
    act(() => {
      tiles()[0]!.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(tiles()).toHaveLength(1);
    expect(chips().map((chip) => chip.textContent)).toEqual([
      expect.stringContaining("first.png"),
    ]);
  });

  it("opens the viewer on the tile pressed, from the same download", async () => {
    const onViewerOpenChange = vi.fn();
    await show([first, archive, second, agenda], null, onViewerOpenChange);
    expect(onViewerOpenChange).not.toHaveBeenCalled();

    act(() => tiles()[1]!.click());
    await settle();
    const viewer = document.body.querySelector('[role="dialog"]');
    expect(viewer?.querySelector("h2")?.textContent).toBe("second.jpg");
    expect(viewer?.querySelector("[data-viewer-counter]")?.textContent).toBe("2 of 3");
    expect(viewer?.querySelector("img")?.getAttribute("src")).toMatch(/^blob:brain\//);
    expect(onViewerOpenChange).toHaveBeenLastCalledWith(true);
    // The tile's download is the viewer's: nothing was fetched again.
    expect(
      fetchMock.mock.calls.filter(([request]) => request === url(second.attachmentId)),
    ).toHaveLength(1);

    act(() => {
      viewer!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(onViewerOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("lets every blob URL go when the letter leaves", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    await show([first, second]);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    act(() => root.render(<></>));
    expect(revokeObjectURL.mock.calls.map(([source]) => source).sort()).toEqual([
      "blob:brain/1",
      "blob:brain/2",
    ]);
  });

  it("gives the shell back if the letter goes while the viewer is up", async () => {
    const onViewerOpenChange = vi.fn();
    await show([first], null, onViewerOpenChange);
    act(() => tiles()[0]!.click());
    expect(onViewerOpenChange).toHaveBeenLastCalledWith(true);
    act(() => root.render(<></>));
    expect(onViewerOpenChange).toHaveBeenLastCalledWith(false);
  });
});
