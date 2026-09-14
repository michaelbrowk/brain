// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTimeZone } from "@/lib/owner-settings";
import { deviceZone, onDayChange, resetTasksStore } from "./tasks-client";

describe("deviceZone", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("answers a zone the server will accept", () => {
    // The one reading of the browser's own zone. The server validates the name
    // it is handed, so a name this platform reports has to pass that gate.
    expect(isTimeZone(deviceZone())).toBe(true);
  });

  it("answers the empty string when the platform cannot say", () => {
    vi.stubGlobal("Intl", {
      DateTimeFormat: () => {
        throw new Error("no calendar here");
      },
    });
    expect(deviceZone()).toBe("");
  });
});

describe("the list request", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resetTasksStore();
    fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ tasks: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    resetTasksStore();
    vi.unstubAllGlobals();
  });

  it("offers the device's zone, so the server can capture it once", async () => {
    // Nothing else on the client asks for the zone: a reminder fires from a
    // server timer, and this is the request every client already makes.
    const stop = onDayChange(() => {});
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    stop();

    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain(`zone=${encodeURIComponent(deviceZone())}`);
    expect(url).toContain("today=");
    expect(url).toContain("offset=");
  });
});
