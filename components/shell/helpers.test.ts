// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/client";
import { captureThought } from "./helpers";

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

function response(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe("captureThought", () => {
  const apiFetchMock = vi.mocked(apiFetch);

  beforeEach(() => {
    apiFetchMock.mockReset();
  });

  it("posts the exact draft under its capture key and returns the page", async () => {
    apiFetchMock.mockResolvedValue(response({ id: "quickcapture_abc" }, 200));

    await expect(
      captureThought("a thought", "capture_operation_1234567890"),
    ).resolves.toBe("quickcapture_abc");

    const [url, init] = apiFetchMock.mock.calls[0];
    expect(url).toBe("/api/page");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      parentId: null,
      title: "a thought",
      idempotencyKey: "capture_operation_1234567890",
    });
  });

  it("opens the page a conflict names — that page is this capture's", async () => {
    // The first answer was lost, the retry crossed a deploy that changed the
    // fingerprint, and the server refused to re-create the page. It named it,
    // and the id is derived from the key, so it is the page the draft made.
    apiFetchMock.mockResolvedValue(
      response(
        { error: "quick capture conflict", id: "quickcapture_abc" },
        409,
      ),
    );

    await expect(
      captureThought("a thought", "capture_operation_1234567890"),
    ).resolves.toBe("quickcapture_abc");
  });

  it("still fails on a conflict that names no page, and on any other failure", async () => {
    apiFetchMock.mockResolvedValueOnce(
      response({ error: "quick capture conflict" }, 409),
    );
    await expect(
      captureThought("a thought", "capture_operation_1234567890"),
    ).rejects.toThrow("409");

    apiFetchMock.mockResolvedValueOnce(response({ error: "boom" }, 502));
    await expect(
      captureThought("a thought", "capture_operation_1234567890"),
    ).rejects.toThrow("502");

    apiFetchMock.mockResolvedValueOnce(response({}, 200));
    await expect(
      captureThought("a thought", "capture_operation_1234567890"),
    ).rejects.toThrow("missing page id");
  });
});
