// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));
// The PDF stage has its own suite; here it only has to say which file it is.
vi.mock("./mail-attachment-pdf", () => ({
  MailAttachmentPdf: ({ url }: { url: string }) => <div data-pdf-stage={url} />,
  AttachmentFailure: ({ message }: { message: string }) => <p role="alert">{message}</p>,
}));

import type { MailContentAttachmentDto } from "@/lib/mail/content-types";
import { MailAttachmentViewer, type AttachmentPreview } from "./mail-attachment-viewer";

function preview(
  id: string,
  filename: string,
  kind: AttachmentPreview["kind"],
): AttachmentPreview {
  const attachment: MailContentAttachmentDto = {
    attachmentId: id,
    filename,
    mimeType: kind === "pdf" ? "application/pdf" : "image/png",
    disposition: "attachment",
    contentId: null,
    bytes: 1_024,
  };
  return { attachment, kind, url: `/api/mail/attachments/${id}?accountId=account-a1` };
}

const previews = [
  preview("attachment-1", "first.png", "image"),
  preview("attachment-2", "second.png", "image"),
  preview("attachment-3", "agenda.pdf", "pdf"),
];

/** The letter's store, answering each picture with a blob URL of its own. */
const store = {
  blob: vi.fn(async () => new Blob([])),
  url: vi.fn(async (attachment: MailContentAttachmentDto) => `blob:brain/${attachment.attachmentId}`),
};

function Harness({
  start,
  onClose,
  onIndexChange,
}: {
  start: number;
  onClose: () => void;
  onIndexChange: (index: number) => void;
}) {
  const [index, setIndex] = useState(start);
  return (
    <MailAttachmentViewer
      previews={previews}
      store={store}
      index={index}
      onIndexChange={(next) => {
        onIndexChange(next);
        setIndex(next);
      }}
      onClose={onClose}
      returnFocus={() => null}
    />
  );
}

describe("MailAttachmentViewer", () => {
  let host: HTMLDivElement;
  let root: Root;

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
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  function dialog(): HTMLElement {
    const found = document.body.querySelector<HTMLElement>('[role="dialog"]');
    if (!found) throw new Error("no viewer dialog");
    return found;
  }

  function press(key: string) {
    const target = (document.activeElement as HTMLElement | null) ?? dialog();
    act(() => {
      target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    });
  }

  function counter(): string | null | undefined {
    return dialog().querySelector("[data-viewer-counter]")?.textContent;
  }

  function download(): HTMLAnchorElement {
    const link = dialog().querySelector<HTMLAnchorElement>("a[download]");
    if (!link) throw new Error("no Download link");
    return link;
  }

  it("names itself after the file and says where it stands in the letter", async () => {
    await act(async () => {
      root.render(<Harness start={0} onClose={() => {}} onIndexChange={() => {}} />);
    });
    expect(dialog().getAttribute("aria-modal")).toBe("true");
    expect(dialog().querySelector("h2")?.textContent).toBe("first.png");
    expect(counter()).toBe("1 of 3");
    // The picture is the letter's verified blob, asked for at the viewer's
    // priority; the Download link stays the route itself.
    const image = dialog().querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:brain/attachment-1");
    expect(image?.getAttribute("alt")).toBe("first.png");
    expect(store.url).toHaveBeenCalledWith(previews[0]!.attachment, 1, expect.any(AbortSignal));
    expect(download().getAttribute("href")).toBe(previews[0]!.url);
    expect(download().getAttribute("download")).toBe("first.png");
    expect(download().getAttribute("aria-label")).toBe("Download first.png");
    // The focus is inside the dialog, so the keyboard reaches it at once.
    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it("moves with the arrows and stops at both ends", async () => {
    const onIndexChange = vi.fn();
    await act(async () => {
      root.render(<Harness start={0} onClose={() => {}} onIndexChange={onIndexChange} />);
    });

    press("ArrowLeft");
    expect(onIndexChange).not.toHaveBeenCalled();
    expect(counter()).toBe("1 of 3");

    press("ArrowRight");
    expect(counter()).toBe("2 of 3");
    expect(dialog().querySelector("h2")?.textContent).toBe("second.png");
    expect(download().getAttribute("href")).toBe(previews[1]!.url);

    press("ArrowRight");
    expect(counter()).toBe("3 of 3");
    expect(dialog().querySelector("[data-pdf-stage]")?.getAttribute("data-pdf-stage")).toBe(
      previews[2]!.url,
    );
    expect(dialog().querySelector("img")).toBeNull();

    onIndexChange.mockClear();
    press("ArrowRight");
    expect(onIndexChange).not.toHaveBeenCalled();
    expect(counter()).toBe("3 of 3");

    press("ArrowLeft");
    expect(counter()).toBe("2 of 3");
  });

  it("leaves a modified arrow to the platform", async () => {
    const onIndexChange = vi.fn();
    await act(async () => {
      root.render(<Harness start={0} onClose={() => {}} onIndexChange={onIndexChange} />);
    });
    act(() => {
      dialog().dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", metaKey: true, bubbles: true }),
      );
    });
    expect(onIndexChange).not.toHaveBeenCalled();
  });

  it("draws the previous and next buttons disabled at the ends", async () => {
    await act(async () => {
      root.render(<Harness start={2} onClose={() => {}} onIndexChange={() => {}} />);
    });
    const next = dialog().querySelector<HTMLButtonElement>('button[aria-label="Next attachment"]');
    const previous = dialog().querySelector<HTMLButtonElement>(
      'button[aria-label="Previous attachment"]',
    );
    expect(next?.disabled).toBe(true);
    expect(previous?.disabled).toBe(false);
    act(() => previous!.click());
    expect(counter()).toBe("2 of 3");
  });

  it("closes on Escape and on the close button", async () => {
    const onClose = vi.fn();
    await act(async () => {
      root.render(<Harness start={1} onClose={onClose} onIndexChange={() => {}} />);
    });
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => dialog().querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click());
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("moves on a horizontal swipe and ignores a vertical one", async () => {
    await act(async () => {
      root.render(<Harness start={1} onClose={() => {}} onIndexChange={() => {}} />);
    });
    const stage = dialog().querySelector<HTMLElement>("[data-viewer-stage]")!;
    const swipe = (fromX: number, toX: number, fromY = 300, toY = 300) =>
      act(() => {
        stage.dispatchEvent(pointer("pointerdown", fromX, fromY));
        stage.dispatchEvent(pointer("pointerup", toX, toY));
      });

    swipe(300, 120);
    expect(counter()).toBe("3 of 3");
    swipe(100, 320);
    expect(counter()).toBe("2 of 3");
    swipe(200, 230, 100, 500);
    expect(counter()).toBe("2 of 3");
    // Far enough sideways to count, but more down than across: a scroll
    // through a PDF that drifted, not a swipe.
    swipe(300, 240, 100, 180);
    expect(counter()).toBe("2 of 3");
  });

  it("shows the failure in place of a picture that will not load", async () => {
    await act(async () => {
      root.render(<Harness start={0} onClose={() => {}} onIndexChange={() => {}} />);
    });
    act(() => {
      dialog().querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("Couldn’t open this file");
  });

  it("shows the failure when the picture never arrives", async () => {
    store.url.mockRejectedValueOnce(new Error("refused"));
    await act(async () => {
      root.render(<Harness start={0} onClose={() => {}} onIndexChange={() => {}} />);
    });
    expect(dialog().querySelector("img")).toBeNull();
    expect(dialog().querySelector('[role="alert"]')?.textContent).toBe("Couldn’t open this file");
  });

  it("drops the counter and the arrows for a letter with one preview", async () => {
    await act(async () => {
      root.render(
        <MailAttachmentViewer
          previews={[previews[0]!]}
          store={store}
          index={0}
          onIndexChange={() => {}}
          onClose={() => {}}
          returnFocus={() => null}
        />,
      );
    });
    expect(dialog().querySelector("[data-viewer-counter]")).toBeNull();
    expect(dialog().querySelector('button[aria-label="Next attachment"]')).toBeNull();
  });
});

function pointer(type: string, clientX: number, clientY: number): Event {
  const event = new MouseEvent(type, { bubbles: true, clientX, clientY });
  Object.defineProperties(event, {
    pointerType: { value: "touch" },
    pointerId: { value: 1 },
    isPrimary: { value: true },
  });
  return event;
}
