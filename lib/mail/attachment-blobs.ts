import {
  MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY,
  type MailContentAttachmentDto,
} from "./content-types";
import { attachmentUrl } from "./attachment-preview";
import { mailCidFetchGate, type MailFetchGate } from "./inline-fetch-gate";

/**
 * Where a preview's download stands in the browser's attachment gate. The mail
 * service streams at most two downloads at once (`concurrentFetchStreams`) and
 * answers a third with 409 `capacity_exceeded` rather than queueing it, so
 * every attachment download in the reader waits its turn in `mailCidFetchGate`
 * with the body's own inline images. Those run at the gate's default 0; a
 * picture the reader has asked to see goes ahead of them, and a tile under the
 * letter goes behind.
 */
export const ATTACHMENT_FETCH_PRIORITY = { tile: -1, viewer: 1 } as const;

/** Waits before asking again after a 409. The slot can be held by something
 *  this page's gate cannot see: another tab, an agent saving an attachment,
 *  or the service still releasing a download whose last byte already
 *  arrived. */
const CAPACITY_RETRY_DELAYS_MS = [250, 750] as const;

/** The download route's exact answer for this attachment, header by header. */
export function isVerifiedAttachmentResponse(
  response: Response,
  attachment: MailContentAttachmentDto,
): boolean {
  return (
    response.ok &&
    response.status === 200 &&
    !response.redirected &&
    response.headers.get("Content-Type") === attachment.mimeType &&
    response.headers.get("Content-Length") === String(attachment.bytes) &&
    response.headers.get("X-Content-Type-Options") === "nosniff" &&
    response.headers.get("Cross-Origin-Resource-Policy") === "same-origin" &&
    response.headers.get("Cache-Control") === "private, no-store" &&
    response.headers.get("Content-Security-Policy") ===
      MAIL_ATTACHMENT_CONTENT_SECURITY_POLICY &&
    /^attachment;/i.test(response.headers.get("Content-Disposition") ?? "")
  );
}

interface Entry {
  readonly promise: Promise<Blob>;
  readonly resolve: (blob: Blob) => void;
  readonly reject: (error: unknown) => void;
  settled: boolean;
  /** The gate has let the download start; its place can no longer change. */
  started: boolean;
  priority: number;
  controller: AbortController;
  /** Callers still waiting on an unsettled download. */
  interest: number;
  url: string | null;
}

/**
 * One letter's attachment downloads, each fetched once and verified the way
 * the body's inline images are, then shared: the tile's thumbnail, the
 * viewer's picture and the PDF all read the same blob, so a picture crosses
 * the network once per letter. A download nobody is waiting for any more is
 * aborted; `dispose()` aborts the rest and revokes every blob URL when the
 * letter leaves. The store stays usable after `dispose()`, which is what a
 * remount in React's development double-render needs.
 */
export class AttachmentBlobStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly accountId: string,
    private readonly gate: MailFetchGate = mailCidFetchGate,
  ) {}

  blob(
    attachment: MailContentAttachmentDto,
    priority: number,
    signal: AbortSignal,
  ): Promise<Blob> {
    if (signal.aborted) return Promise.reject(abortError());
    const id = attachment.attachmentId;
    let entry = this.entries.get(id);
    if (entry === undefined) {
      entry = this.create(attachment, priority);
      this.entries.set(id, entry);
    } else if (!entry.settled && !entry.started && priority > entry.priority) {
      // Still queued behind other tiles: take its place again at the
      // viewer's priority rather than wait out the letter.
      this.enqueue(entry, attachment, priority);
    }
    if (entry.settled) return entry.promise;
    const current = entry;
    current.interest += 1;
    return new Promise<Blob>((resolve, reject) => {
      const onAbort = () => {
        current.interest -= 1;
        if (current.interest === 0 && !current.settled) {
          current.controller.abort();
          if (this.entries.get(id) === current) this.entries.delete(id);
        }
        reject(abortError());
      };
      signal.addEventListener("abort", onAbort, { once: true });
      current.promise.then(
        (blob) => {
          signal.removeEventListener("abort", onAbort);
          resolve(blob);
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  /** The shared blob URL for an attachment, made once and revoked by
   *  `dispose()`. */
  async url(
    attachment: MailContentAttachmentDto,
    priority: number,
    signal: AbortSignal,
  ): Promise<string> {
    const blob = await this.blob(attachment, priority, signal);
    const entry = this.entries.get(attachment.attachmentId);
    if (entry === undefined || signal.aborted) throw abortError();
    entry.url ??= URL.createObjectURL(blob);
    return entry.url;
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.controller.abort();
      if (entry.url !== null) URL.revokeObjectURL(entry.url);
    }
    this.entries.clear();
  }

  private create(attachment: MailContentAttachmentDto, priority: number): Entry {
    let resolve!: (blob: Blob) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<Blob>((settle, fail) => {
      resolve = settle;
      reject = fail;
    });
    // Callers hold their own handlers; this one only keeps a download that
    // failed after everyone left from surfacing as an unhandled rejection.
    promise.catch(() => undefined);
    const entry: Entry = {
      promise,
      resolve,
      reject,
      settled: false,
      started: false,
      priority,
      controller: new AbortController(),
      interest: 0,
      url: null,
    };
    this.enqueue(entry, attachment, priority);
    return entry;
  }

  private enqueue(entry: Entry, attachment: MailContentAttachmentDto, priority: number): void {
    entry.controller.abort();
    const controller = new AbortController();
    entry.controller = controller;
    entry.priority = priority;
    this.gate
      .run(
        controller.signal,
        () => {
          entry.started = true;
          return this.download(attachment, controller.signal);
        },
        priority,
      )
      .then(
        (blob) => {
          if (entry.controller !== controller) return;
          entry.settled = true;
          entry.resolve(blob);
        },
        (error: unknown) => {
          // A waiter replaced by a higher-priority one is not a failure.
          if (entry.controller !== controller) return;
          entry.settled = true;
          // A failed download is forgotten, so a later open tries again.
          if (this.entries.get(attachment.attachmentId) === entry) {
            this.entries.delete(attachment.attachmentId);
          }
          entry.reject(error);
        },
      );
  }

  private async download(
    attachment: MailContentAttachmentDto,
    signal: AbortSignal,
  ): Promise<Blob> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(attachmentUrl(this.accountId, attachment.attachmentId), {
        signal,
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
        redirect: "error",
      });
      const retryAfter = CAPACITY_RETRY_DELAYS_MS[attempt];
      if (response.status === 409) {
        // Only a full set of download slots is worth another ask; any other
        // conflict is an answer, and it fails the download now.
        if (retryAfter === undefined || (await refusalCode(response)) !== "capacity_exceeded") {
          throw new Error("The attachment's download was refused");
        }
        await wait(retryAfter, signal);
        continue;
      }
      if (!isVerifiedAttachmentResponse(response, attachment)) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`The attachment answered ${response.status} unverified`);
      }
      const blob = await response.blob();
      if (blob.size !== attachment.bytes || blob.type !== attachment.mimeType) {
        throw new Error("The attachment's bytes are not the ones it declared");
      }
      return blob;
    }
  }
}

/** The `error.code` of a mail API refusal (`{ apiVersion, error: { code } }`),
 *  or null for a body that is not one. */
async function refusalCode(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("error" in body)) return null;
    const { error } = body;
    if (typeof error !== "object" || error === null || !("code" in error)) return null;
    return typeof error.code === "string" ? error.code : null;
  } catch {
    return null;
  }
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortError(): Error {
  return Object.assign(new Error("attachment download aborted"), { name: "AbortError" });
}
