import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ readNotesStatus: vi.fn() }));
vi.mock("@/lib/notes-status", () => ({ readNotesStatus: mocks.readNotesStatus }));

import { GET } from "./route";

describe("GET /api/settings/notes", () => {
  it("returns the status with a private no-store header", async () => {
    const status = { apiVersion: 1, root: "/opt/brain/notes", repository: true, head: null, commitDelaySeconds: 4 };
    mocks.readNotesStatus.mockResolvedValue(status);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(status);
  });

  it("answers 503 when the store cannot be read", async () => {
    mocks.readNotesStatus.mockRejectedValue(new Error("boom"));
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "notes status unavailable" });
  });
});
