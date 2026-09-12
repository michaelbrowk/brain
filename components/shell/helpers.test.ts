// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/client";
import type { ShareScopeSnapshot } from "@/lib/store/types";
import { captureThought, isShareScopeSnapshot } from "./helpers";

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
    apiFetchMock.mockResolvedValue(response({ id: "Ky7fPq2vR8sT4wX1zB6nD" }, 200));

    await expect(
      captureThought("a thought", "capture_operation_1234567890"),
    ).resolves.toBe("Ky7fPq2vR8sT4wX1zB6nD");

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
        { error: "quick capture conflict", id: "Ky7fPq2vR8sT4wX1zB6nD" },
        409,
      ),
    );

    await expect(
      captureThought("a thought", "capture_operation_1234567890"),
    ).resolves.toBe("Ky7fPq2vR8sT4wX1zB6nD");
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

describe("isShareScopeSnapshot", () => {
  /** What the owner's routes return. Every field is checked, because this
   *  guard is what stands between a malformed body and a read-back the shell
   *  reports as a success. */
  const snapshot = (
    values: Partial<Record<keyof ShareScopeSnapshot, unknown>> = {},
  ) => ({
    rootId: "page-a",
    descendantCount: 0,
    overlappingRoots: [],
    scopeToken: "a".repeat(64),
    public: true,
    shareLocked: false,
    shareEdit: false,
    shareExpiresAt: null,
    shareVersion: 1,
    ...values,
  });

  it("accepts a complete snapshot", () => {
    expect(isShareScopeSnapshot(snapshot())).toBe(true);
    expect(isShareScopeSnapshot(snapshot({ shareEdit: true }))).toBe(true);
  });

  it("refuses a body with no edit flag, so the read-back cannot compare undefined", () => {
    const { shareEdit: _omitted, ...withoutEdit } = snapshot();
    expect(isShareScopeSnapshot(withoutEdit)).toBe(false);
  });

  it("refuses a non-boolean edit flag", () => {
    for (const shareEdit of ["true", 1, null, {}]) {
      expect(isShareScopeSnapshot(snapshot({ shareEdit }))).toBe(false);
    }
  });
});
