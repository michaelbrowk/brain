import { NextRequest } from "next/server";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  captureTimeZone,
  readTimeZone,
  resetOwnerSettingsCache,
} from "@/lib/owner-settings";
import { GET, PUT } from "./route";

// The real store against a temp state directory rather than a mock: the route
// is three lines of validation over it, and what matters is that the name the
// owner picked is the name the next read answers.
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-zone-route-"));
  process.env.BRAIN_SETTINGS_STATE_DIR = dir;
  resetOwnerSettingsCache();
});

afterEach(async () => {
  delete process.env.BRAIN_SETTINGS_STATE_DIR;
  await fs.rm(dir, { recursive: true, force: true });
  resetOwnerSettingsCache();
});

async function put(body: string) {
  return PUT(
    new NextRequest("https://brain.test/api/settings/zone", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  );
}

describe("GET /api/settings/zone", () => {
  it("answers the captured zone", async () => {
    await captureTimeZone("Europe/Lisbon", dir);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ timeZone: "Europe/Lisbon" });
  });

  it("answers null before anything is captured", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ timeZone: null });
  });
});

describe("PUT /api/settings/zone", () => {
  it("sets a zone the owner picked", async () => {
    const response = await put(JSON.stringify({ timeZone: "Asia/Dubai" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ timeZone: "Asia/Dubai" });
    expect(await readTimeZone(dir)).toBe("Asia/Dubai");
  });

  it("overwrites a zone a client captured, because the owner said so", async () => {
    await captureTimeZone("Europe/Lisbon", dir);
    await put(JSON.stringify({ timeZone: "Asia/Dubai" }));
    expect(await readTimeZone(dir)).toBe("Asia/Dubai");
  });

  it("refuses a zone the platform does not know", async () => {
    const response = await put(JSON.stringify({ timeZone: "Mars/Olympus" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; reason?: string };
    expect(body.error).toBe("bad_zone");
    expect(typeof body.reason).toBe("string");
    expect(await readTimeZone(dir)).toBeNull();
  });

  it("refuses a fixed offset, which carries no summer-time rule", async () => {
    const response = await put(JSON.stringify({ timeZone: "+03:00" }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("bad_zone");
  });

  it("refuses a body that is not an object", async () => {
    const response = await put("[]");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_body" });
  });

  it("refuses a body that is not JSON", async () => {
    const response = await put("not json");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_body" });
  });
});
