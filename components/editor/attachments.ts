"use client";

import { apiFetch, CLIENT_ID } from "@/lib/client";

export interface UploadedAttachment {
  url: string;
  name: string;
  size: number;
  type: string;
}

/** Where an upload goes and what it carries. The owner posts to `/api/upload`
 *  with the tab's client id; a link visitor posts to `/api/share-edit/upload`
 *  with the access pair on the query and the `x-brain-share-vid` double
 *  submit in the headers. `fetcher` wraps the fetch path; `headers` is the
 *  same statement for the XMLHttpRequest path, which cannot take a fetcher. */
export interface AttachmentUploadTarget {
  /** Absolute path including any query the route needs. */
  endpoint?: string;
  /** A visitor upload adds `x-brain-share-vid`; the owner adds `x-brain-client`. */
  fetcher?: typeof fetch;
  /** Sent by the progress upload in place of the owner's `x-brain-client`. */
  headers?: Record<string, string>;
}

export interface AttachmentUploadProgressOptions
  extends Pick<AttachmentUploadTarget, "endpoint" | "headers"> {
  signal?: AbortSignal;
  onProgress?: (progress: number) => void;
}

export const IMAGE_UPLOAD_TIMEOUT_MS = 60_000;

function uploadedAttachment(value: unknown, file: File): UploadedAttachment | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<UploadedAttachment>;
  if (typeof data.url !== "string" || typeof data.name !== "string") return null;
  return {
    url: data.url,
    name: data.name,
    size: typeof data.size === "number" ? data.size : file.size,
    type: typeof data.type === "string" ? data.type : file.type,
  };
}

export async function uploadAttachment(
  file: File,
  target: AttachmentUploadTarget = {},
): Promise<UploadedAttachment | null> {
  const fd = new FormData();
  fd.append("file", file);
  const send = target.fetcher ?? apiFetch;
  const r = await send(target.endpoint ?? "/api/upload", {
    method: "POST",
    body: fd,
  });
  if (!r.ok) return null;
  return uploadedAttachment(await r.json(), file);
}

/** XMLHttpRequest is intentional here: fetch does not expose browser upload
 * byte progress. The API and response stay identical to uploadAttachment. */
export function uploadAttachmentWithProgress(
  file: File,
  options: AttachmentUploadProgressOptions = {},
): Promise<UploadedAttachment> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", abortFromSignal);
      callback();
    };
    const fail = (message: string) =>
      finish(() => reject(new Error(message)));
    const abortError = () => {
      const error = new Error("Image upload cancelled");
      error.name = "AbortError";
      return error;
    };
    const abortFromSignal = () => {
      request.abort();
      finish(() => reject(abortError()));
    };

    request.open("POST", options.endpoint ?? "/api/upload");
    request.responseType = "json";
    request.timeout = IMAGE_UPLOAD_TIMEOUT_MS;
    for (const [name, value] of Object.entries(
      options.headers ?? { "x-brain-client": CLIENT_ID },
    )) {
      request.setRequestHeader(name, value);
    }
    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      options.onProgress?.(
        Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100))),
      );
    });
    request.addEventListener("load", () => {
      if (request.status < 200 || request.status >= 300) {
        fail("Image upload failed");
        return;
      }
      const attachment = uploadedAttachment(request.response, file);
      if (!attachment) {
        fail("Image upload returned an invalid response");
        return;
      }
      options.onProgress?.(100);
      finish(() => resolve(attachment));
    });
    request.addEventListener("error", () => fail("Image upload failed"));
    request.addEventListener("timeout", () => fail("Image upload timed out"));
    request.addEventListener("abort", () => finish(() => reject(abortError())));

    if (options.signal?.aborted) {
      abortFromSignal();
      return;
    }
    options.signal?.addEventListener("abort", abortFromSignal, { once: true });

    const body = new FormData();
    body.append("file", file);
    request.send(body);
  });
}

export function isSpreadsheetFile(file: File): boolean {
  return /\.(xlsx|xls|csv)$/i.test(file.name);
}

function escapeLinkLabel(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

export function attachmentMarkdown(file: Pick<UploadedAttachment, "url" | "name">): string {
  const name = escapeLinkLabel(file.name) || "attachment";
  return `[📎 ${name}](${file.url})`;
}
