// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));
vi.mock("./mail-attachment-pdf", () => ({
  MailAttachmentPdf: ({ url }: { url: string }) => <div data-pdf-stage={url} />,
  AttachmentFailure: ({ message }: { message: string }) => <p role="alert">{message}</p>,
}));

import type { MailContentAttachmentDto } from "@/lib/mail/content-types";
import { MailAttachments } from "./mail-attachments";

const ACCOUNT_ID = "account-a0123456789abcdef0123456789abcdef";

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
    bytes: 2_048,
    ...overrides,
  };
}

const first = attachment("attachment-first", "first.png", "image/png");
const second = attachment("attachment-second", "second.jpg", "image/jpeg", {
  bytes: 2.5 * 1024 * 1024,
});
const agenda = attachment("attachment-agenda", "agenda.pdf", "application/pdf");
const archive = attachment("attachment-archive", "photos.zip", "application/zip");
const logo = attachment("attachment-logo", "image001.png", "image/png", {
  disposition: "inline",
  contentId: "logo@example.test",
});

function url(id: string): string {
  return `/api/mail/attachments/${id}?accountId=${ACCOUNT_ID}`;
}

describe("MailAttachments", () => {
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
      "first.png, 2 KB",
      "second.jpg, 2.5 MB",
      "agenda.pdf, 2 KB",
    ]);
    const image = tiles()[0]!.querySelector("img")!;
    expect(image.getAttribute("src")).toBe(url(first.attachmentId));
    expect(image.getAttribute("alt")).toBe("first.png");
    expect(image.getAttribute("loading")).toBe("lazy");
    expect(image.getAttribute("decoding")).toBe("async");
    expect(tiles()[2]!.querySelector("img")).toBeNull();
    expect(tiles()[2]!.textContent).toContain("PDF");
    expect(tiles()[2]!.querySelector("svg")).not.toBeNull();

    expect(chips()).toHaveLength(1);
    expect(chips()[0]!.getAttribute("href")).toBe(url(archive.attachmentId));
    expect(chips()[0]!.getAttribute("download")).toBe("photos.zip");
  });

  it("leaves out an inline image the letter's HTML already draws", async () => {
    await show([logo, first], '<p>Hi</p><img data-brain-cid="logo@example.test" alt="">');
    expect(tiles().map((tile) => tile.getAttribute("aria-label"))).toEqual(["first.png, 2 KB"]);
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

  it("turns a picture that will not load back into a chip", async () => {
    await show([first, second]);
    act(() => {
      tiles()[0]!.querySelector("img")!.dispatchEvent(new Event("error"));
    });
    expect(tiles()).toHaveLength(1);
    expect(chips().map((chip) => chip.textContent)).toEqual([
      expect.stringContaining("first.png"),
    ]);
  });

  it("opens the viewer on the tile pressed, counting only the previews", async () => {
    const onViewerOpenChange = vi.fn();
    await show([first, archive, second, agenda], null, onViewerOpenChange);
    expect(onViewerOpenChange).not.toHaveBeenCalled();

    act(() => tiles()[1]!.click());
    const viewer = document.body.querySelector('[role="dialog"]');
    expect(viewer?.querySelector("h2")?.textContent).toBe("second.jpg");
    expect(viewer?.querySelector("[data-viewer-counter]")?.textContent).toBe("2 of 3");
    expect(onViewerOpenChange).toHaveBeenLastCalledWith(true);

    act(() => {
      viewer!.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click();
    });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    expect(onViewerOpenChange).toHaveBeenLastCalledWith(false);
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
