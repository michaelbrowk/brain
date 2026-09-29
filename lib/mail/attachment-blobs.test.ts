import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY } from "./content-types";
import type { MailContentAttachmentDto } from "./content-types";
import {
  ATTACHMENT_FETCH_PRIORITY,
  AttachmentBlobStore,
  isVerifiedAttachmentResponse,
} from "./attachment-blobs";
import { MailFetchGate } from "./inline-fetch-gate";

const ACCOUNT_ID = "account-a0123456789abcdef0123456789abcdef";
const BYTES = new Uint8Array([1, 2, 3, 4, 5, 6]);

function attachment(id: string, overrides: Partial<MailContentAttachmentDto> = {}) {
  return {
    attachmentId: id,
    filename: `${id}.png`,
    mimeType: "image/png",
    disposition: "attachment",
    contentId: null,
    bytes: BYTES.byteLength,
    ...overrides,
  } satisfies MailContentAttachmentDto;
}

function verified(
  file: MailContentAttachmentDto,
  body: Uint8Array = BYTES,
  headers: Record<string, string> = {},
): Response {
  return new Response(body as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": file.mimeType,
      "Content-Length": String(body.byteLength),
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Security-Policy": MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY,
      ...headers,
    },
  });
}

function capacityExceeded(): Response {
  return new Response(JSON.stringify({ apiVersion: 1, error: { code: "capacity_exceeded" } }), {
    status: 409,
    headers: { "Content-Type": "application/json" },
  });
}

/** A fetch whose answers the test hands out one at a time. */
function heldFetch() {
  const calls: Array<{ url: string; init: RequestInit; answer: (response: Response) => void }> =
    [];
  const fetchMock = vi.fn(
    (url: string, init: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        calls.push({ url, init, answer: resolve });
        init.signal?.addEventListener("abort", () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        );
      }),
  );
  return { calls, fetchMock };
}

async function flush() {
  for (let step = 0; step < 8; step += 1) await Promise.resolve();
}

describe("AttachmentBlobStore", () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    let next = 0;
    createObjectURL = vi.fn(() => `blob:brain/${(next += 1)}`);
    revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("downloads through the authenticated route with the reader's fetch policy", async () => {
    const file = attachment("attachment-one");
    const fetchMock = vi.fn(async () => verified(file));
    vi.stubGlobal("fetch", fetchMock);
    const store = new AttachmentBlobStore(ACCOUNT_ID, new MailFetchGate(2));

    const blob = await store.blob(file, ATTACHMENT_FETCH_PRIORITY.tile, new AbortController().signal);

    expect(blob.size).toBe(BYTES.byteLength);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/mail/attachments/attachment-one?accountId=${ACCOUNT_ID}`,
      expect.objectContaining({
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        redirect: "error",
      }),
    );
  });

  it("downloads an attachment once and hands the same blob and URL to every caller", async () => {
    const file = attachment("attachment-one");
    const fetchMock = vi.fn(async () => verified(file));
    vi.stubGlobal("fetch", fetchMock);
    const store = new AttachmentBlobStore(ACCOUNT_ID, new MailFetchGate(2));
    const signal = new AbortController().signal;

    const [tile, viewer] = await Promise.all([
      store.blob(file, ATTACHMENT_FETCH_PRIORITY.tile, signal),
      store.url(file, ATTACHMENT_FETCH_PRIORITY.viewer, signal),
    ]);
    const again = await store.url(file, ATTACHMENT_FETCH_PRIORITY.viewer, signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tile.size).toBe(BYTES.byteLength);
    expect(viewer).toBe("blob:brain/1");
    expect(again).toBe(viewer);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("never has more downloads in flight than the gate admits", async () => {
    const { calls, fetchMock } = heldFetch();
    vi.stubGlobal("fetch", fetchMock);
    const store = new AttachmentBlobStore(ACCOUNT_ID, new MailFetchGate(2));
    const files = ["a", "b", "c", "d"].map((id) => attachment(`attachment-${id}`));
    const loads = files.map((file) =>
      store.blob(file, ATTACHMENT_FETCH_PRIORITY.tile, new AbortController().signal),
    );
    await flush();
    expect(calls).toHaveLength(2);
    calls[0]!.answer(verified(files[0]!));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[1]!.answer(verified(files[1]!));
    calls[2]!.answer(verified(files[2]!));
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    calls[3]!.answer(verified(files[3]!));
    await expect(Promise.all(loads)).resolves.toHaveLength(4);
  });

  it("moves a queued tile download up when the viewer asks for the same file", async () => {
    const { calls, fetchMock } = heldFetch();
    vi.stubGlobal("fetch", fetchMock);
    const store = new AttachmentBlobStore(ACCOUNT_ID, new MailFetchGate(1));
    const files = ["a", "b", "c"].map((id) => attachment(`attachment-${id}`));
    for (const file of files) {
      void store.blob(file, ATTACHMENT_FETCH_PRIORITY.tile, new AbortController().signal);
    }
    await flush();
    expect(calls.map((call) => call.url)).toEqual([expect.stringContaining("attachment-a")]);

    const viewer = store.blob(files[2]!, ATTACHMENT_FETCH_PRIORITY.viewer, new AbortController().signal);
    calls[0]!.answer(verified(files[0]!));
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.url).toContain("attachment-c");
    calls[1]!.answer(verified(files[2]!));
    await expect(viewer).resolves.toBeInstanceOf(Blob);
  });

  it("asks again after the service says its download slots are full", async () => {
    vi.useFakeTimers();
    const file = attachment("attachment-one");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(capacityExceeded())
      .mockResolvedValueOnce(capacityExceeded())
      .mockResolvedValueOnce(verified(file));
    vi.stubGlobal("fetch", fetchMock);
    const store = new AttachmentBlobStore(ACCOUNT_ID, new MailFetchGate(2));
    const load = store.blob(file, ATTACHMENT_FETCH_PRIORITY.tile, new AbortController().signal);
    await vi.runAllTimersAsync();
    await expect(load).resolves.toBeInstanceOf(Blob);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after a bounded number of refusals", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => capacityExceeded());
    vi.stubGlobal("fetch", fetchMock);
    const store = new AttachmentBlobStore(ACCOUNT_ID, new MailFetchGate(2));
    const load = store.blob(
      attachment("attachment-one"),
      ATTACHMENT_FETCH_PRIORITY.tile,
      new AbortController().signal,
    );
    const outcome = load.then(
      () => "loaded",
      () => "refused",
    );
    await vi.runAllTimersAsync();
    await expect(outcome).resolves.toBe("refused");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refuses a response that is not the attachment it claims to be", async () => {
    const file = attachment("attachment-one");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => verified(file, BYTES, { "Content-Type": "image/svg+xml" })),
    );
    const store = new AttachmentBlobStore(ACCOUNT_ID, new MailFetchGate(2));
    await expect(
      store.blob(file, ATTACHMENT_FETCH_PRIORITY.tile, new AbortController().signal),
    ).rejects.toThrow();
  });

  it("aborts a download nobody wants any more, and keeps one somebody still does", async () => {
    const { calls, fetchMock } = heldFetch();
    vi.stubGlobal("fetch", fetchMock);
    const store = new AttachmentBlobStore(ACCOUNT_ID, new MailFetchGate(2));
    const file = attachment("attachment-one");
    const tile = new AbortController();
    const viewer = new AbortController();
    const fromTile = store.blob(file, ATTACHMENT_FETCH_PRIORITY.tile, tile.signal);
    const fromViewer = store.blob(file, ATTACHMENT_FETCH_PRIORITY.viewer, viewer.signal);
    await flush();
    expect(calls).toHaveLength(1);

    tile.abort();
    await expect(fromTile).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[0]!.init.signal?.aborted).toBe(false);

    viewer.abort();
    await expect(fromViewer).rejects.toMatchObject({ name: "AbortError" });
    expect(calls[0]!.init.signal?.aborted).toBe(true);
  });

  it("revokes every URL and aborts every download when the letter goes", async () => {
    const { calls, fetchMock } = heldFetch();
    vi.stubGlobal("fetch", fetchMock);
    const store = new AttachmentBlobStore(ACCOUNT_ID, new MailFetchGate(2));
    const ready = attachment("attachment-ready");
    const pending = attachment("attachment-pending");
    const url = store.url(ready, ATTACHMENT_FETCH_PRIORITY.viewer, new AbortController().signal);
    await flush();
    calls[0]!.answer(verified(ready));
    await expect(url).resolves.toBe("blob:brain/1");
    const waiting = store.blob(pending, ATTACHMENT_FETCH_PRIORITY.tile, new AbortController().signal);
    await flush();

    store.dispose();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:brain/1");
    expect(calls[1]!.init.signal?.aborted).toBe(true);
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("isVerifiedAttachmentResponse", () => {
  it("accepts only the route's own exact headers", () => {
    const file = attachment("attachment-one");
    expect(isVerifiedAttachmentResponse(verified(file), file)).toBe(true);
    for (const [name, value] of [
      ["Content-Type", "text/html"],
      ["Content-Length", "7"],
      ["X-Content-Type-Options", ""],
      ["Cross-Origin-Resource-Policy", "cross-origin"],
      ["Cache-Control", "public"],
      ["Content-Security-Policy", "default-src *"],
      ["Content-Disposition", "inline"],
    ] as const) {
      expect(isVerifiedAttachmentResponse(verified(file, BYTES, { [name]: value }), file)).toBe(
        false,
      );
    }
  });
});
