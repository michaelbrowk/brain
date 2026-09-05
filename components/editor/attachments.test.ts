// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IMAGE_UPLOAD_TIMEOUT_MS,
  uploadAttachment,
  uploadAttachmentWithProgress,
} from "./attachments";

class FakeXMLHttpRequest extends EventTarget {
  static current: FakeXMLHttpRequest | null = null;

  readonly upload = new EventTarget();
  readonly headers = new Map<string, string>();
  status = 0;
  response: unknown = null;
  responseType: XMLHttpRequestResponseType = "";
  timeout = 0;
  sent: Document | XMLHttpRequestBodyInit | null = null;
  aborted = false;
  method = "";
  url = "";

  constructor() {
    super();
    FakeXMLHttpRequest.current = this;
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  send(body: Document | XMLHttpRequestBodyInit | null) {
    this.sent = body;
  }

  abort() {
    this.aborted = true;
    this.dispatchEvent(new Event("abort"));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeXMLHttpRequest.current = null;
});

describe("uploadAttachmentWithProgress", () => {
  it("reports browser byte progress and returns the existing upload shape", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const progress: number[] = [];
    const file = new File(["pixels"], "photo.png", { type: "image/png" });

    const result = uploadAttachmentWithProgress(file, {
      onProgress: (value) => progress.push(value),
    });
    const request = FakeXMLHttpRequest.current!;

    request.upload.dispatchEvent(
      new ProgressEvent("progress", {
        lengthComputable: true,
        loaded: 3,
        total: 10,
      }),
    );
    request.status = 201;
    request.response = {
      url: "/_attachments-v2/photo.png",
      name: "photo.png",
      size: 6,
      type: "image/png",
    };
    request.dispatchEvent(new Event("load"));

    await expect(result).resolves.toEqual(request.response);
    expect(progress).toEqual([30, 100]);
    expect([request.method, request.url]).toEqual(["POST", "/api/upload"]);
    expect(request.timeout).toBe(IMAGE_UPLOAD_TIMEOUT_MS);
    expect(request.headers.get("x-brain-client")).toBeTruthy();
    expect(request.sent).toBeInstanceOf(FormData);
  });

  it("rejects failed responses instead of silently losing the image", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const result = uploadAttachmentWithProgress(
      new File(["pixels"], "photo.png", { type: "image/png" }),
    );
    const request = FakeXMLHttpRequest.current!;
    request.status = 413;
    request.dispatchEvent(new Event("load"));

    await expect(result).rejects.toThrow("Image upload failed");
  });

  it("rejects an invalid JSON response", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const result = uploadAttachmentWithProgress(
      new File(["pixels"], "photo.png", { type: "image/png" }),
    );
    const request = FakeXMLHttpRequest.current!;
    request.status = 200;
    request.response = "not-json";
    request.dispatchEvent(new Event("load"));

    await expect(result).rejects.toThrow("invalid response");
  });

  it("rejects a network error", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const result = uploadAttachmentWithProgress(
      new File(["pixels"], "photo.png", { type: "image/png" }),
    );
    FakeXMLHttpRequest.current!.dispatchEvent(new Event("error"));

    await expect(result).rejects.toThrow("Image upload failed");
  });

  it("uses the bounded request timeout and rejects when it fires", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const result = uploadAttachmentWithProgress(
      new File(["pixels"], "photo.png", { type: "image/png" }),
    );
    const request = FakeXMLHttpRequest.current!;
    expect(request.timeout).toBe(IMAGE_UPLOAD_TIMEOUT_MS);
    request.dispatchEvent(new Event("timeout"));

    await expect(result).rejects.toThrow("Image upload timed out");
  });

  it("aborts the request when the editor is disposed", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const controller = new AbortController();
    const result = uploadAttachmentWithProgress(
      new File(["pixels"], "photo.png", { type: "image/png" }),
      { signal: controller.signal },
    );
    const request = FakeXMLHttpRequest.current!;

    controller.abort();

    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(request.aborted).toBe(true);
  });
});

describe("upload targets", () => {
  it("uploadAttachment posts to the endpoint it is given, through the fetcher it is given", async () => {
    const seen: Array<{ url: string; method?: string; headers: Headers }> = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        method: init?.method,
        headers: new Headers(init?.headers),
      });
      return new Response(
        JSON.stringify({ url: "/_attachments-v2/abc123456789.png", name: "photo.png" }),
        { status: 201 },
      );
    }) as unknown as typeof fetch;
    const file = new File(["pixels"], "photo.png", { type: "image/png" });

    const result = await uploadAttachment(file, {
      endpoint: "/api/share-edit/upload?root=root-1&v=2&page=page-9",
      fetcher,
    });

    expect(result).toEqual({
      url: "/_attachments-v2/abc123456789.png",
      name: "photo.png",
      size: file.size,
      type: "image/png",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/share-edit/upload?root=root-1&v=2&page=page-9");
    expect(seen[0].method).toBe("POST");
    // The visitor's fetcher decides the headers; the owner's client id is
    // not added on its behalf.
    expect(seen[0].headers.get("x-brain-client")).toBeNull();
  });

  it("uploadAttachmentWithProgress opens the endpoint it is given and sends the given headers", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
    const result = uploadAttachmentWithProgress(
      new File(["pixels"], "photo.png", { type: "image/png" }),
      {
        endpoint: "/api/share-edit/upload?root=root-1&v=2&page=page-9",
        headers: { "x-brain-share-vid": "vid123456789" },
      },
    );
    const request = FakeXMLHttpRequest.current!;

    expect([request.method, request.url]).toEqual([
      "POST",
      "/api/share-edit/upload?root=root-1&v=2&page=page-9",
    ]);
    expect(request.headers.get("x-brain-share-vid")).toBe("vid123456789");
    expect(request.headers.get("x-brain-client")).toBeUndefined();

    request.status = 201;
    request.response = { url: "/_attachments-v2/abc123456789.png", name: "photo.png" };
    request.dispatchEvent(new Event("load"));
    await expect(result).resolves.toMatchObject({
      url: "/_attachments-v2/abc123456789.png",
    });
  });
});
