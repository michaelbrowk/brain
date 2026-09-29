// @vitest-environment jsdom

// The one moment the main suite cannot hold still: the viewer closing while
// pdf.js is still being fetched. The runtime module is mocked here so its
// import can be held open until the component has gone.

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => {
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { loaded, release, openPdf: vi.fn() };
});

vi.mock("@/lib/mail/pdf-runtime", async () => {
  await runtime.loaded;
  return { openPdf: runtime.openPdf };
});

import type { MailContentAttachmentDto } from "@/lib/mail/content-types";
import { MailAttachmentPdf } from "./mail-attachment-pdf";

const agenda: MailContentAttachmentDto = {
  attachmentId: "attachment-a33333333333333333333333333333333",
  filename: "agenda.pdf",
  mimeType: "application/pdf",
  disposition: "attachment",
  contentId: null,
  bytes: 4,
};

it("starts no worker for a viewer that closed while pdf.js was loading", async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(4));
  const store = { blob: vi.fn(async () => ({ size: 4, arrayBuffer }) as unknown as Blob) };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MailAttachmentPdf attachment={agenda} url="/api/mail/attachments/x" store={store} />);
  });
  await vi.waitFor(() => expect(arrayBuffer).toHaveBeenCalled());

  act(() => root.unmount());
  runtime.release();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  expect(runtime.openPdf).not.toHaveBeenCalled();
  host.remove();
});
