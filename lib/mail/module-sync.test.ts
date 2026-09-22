import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetOwnerSettingsCache, setModules } from "@/lib/owner-settings";
import { tellMailServiceAboutModules } from "./module-sync";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-module-sync-"));
  process.env.BRAIN_SETTINGS_STATE_DIR = dir;
  resetOwnerSettingsCache(dir);
});

afterEach(async () => {
  delete process.env.BRAIN_SETTINGS_STATE_DIR;
  resetOwnerSettingsCache(dir);
  await fs.rm(dir, { recursive: true, force: true });
});

describe("telling the mail service what the switch says", () => {
  it("sends enabled false when Mail is off", async () => {
    await setModules({ mail: false }, dir);
    const setSyncEnabled = vi.fn(async () => ({ paused: true }));
    expect(await tellMailServiceAboutModules({ setSyncEnabled })).toBe(true);
    expect(setSyncEnabled).toHaveBeenCalledWith(false);
  });

  it("sends enabled true when Mail is on", async () => {
    const setSyncEnabled = vi.fn(async () => ({ paused: false }));
    expect(await tellMailServiceAboutModules({ setSyncEnabled })).toBe(true);
    expect(setSyncEnabled).toHaveBeenCalledWith(true);
  });

  // The service is another process with its own outage, and a switch the
  // owner flipped must land in the settings file whether or not it answered.
  it("answers false and throws nothing when the service does not answer", async () => {
    const setSyncEnabled = vi.fn(async () => {
      throw new Error("socket refused");
    });
    expect(await tellMailServiceAboutModules({ setSyncEnabled })).toBe(false);
  });

  // The Tasks switch is not this service's business, and the sentence it is
  // told is the mail half of the pair alone.
  it("ignores the Tasks switch", async () => {
    await setModules({ tasks: false }, dir);
    const setSyncEnabled = vi.fn(async () => ({ paused: false }));
    expect(await tellMailServiceAboutModules({ setSyncEnabled })).toBe(true);
    expect(setSyncEnabled).toHaveBeenCalledWith(true);
  });
});
