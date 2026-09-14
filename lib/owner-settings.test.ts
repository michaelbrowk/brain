import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  OWNER_SETTINGS_FILE,
  captureTimeZone,
  isTimeZone,
  ownerSettingsDirectory,
  readOwnerSettings,
  readTimeZone,
  resetOwnerSettingsCache,
  setTimeZone,
} from "./owner-settings";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-owner-settings-"));
  resetOwnerSettingsCache();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  resetOwnerSettingsCache();
});

describe("the owner's zone", () => {
  it("reads as unset before anything has been written", async () => {
    expect(await readTimeZone(dir)).toBeNull();
    expect(await readOwnerSettings(dir)).toEqual({ schema: 1, timeZone: null });
  });

  it("captures the first zone it is given", async () => {
    expect(await captureTimeZone("Europe/Lisbon", dir)).toBe("Europe/Lisbon");
    expect(await readTimeZone(dir)).toBe("Europe/Lisbon");
  });

  it("never overwrites a captured zone", async () => {
    await captureTimeZone("Europe/Lisbon", dir);
    // A device in another zone does not change it: the reminder time is the
    // owner's home clock, not the clock of whichever machine asked last.
    expect(await captureTimeZone("Asia/Dubai", dir)).toBe("Europe/Lisbon");
    expect(await readTimeZone(dir)).toBe("Europe/Lisbon");
  });

  it("lets the owner set it themselves, over a captured one", async () => {
    await captureTimeZone("Europe/Lisbon", dir);
    await setTimeZone("Asia/Dubai", dir);
    expect(await readTimeZone(dir)).toBe("Asia/Dubai");
  });

  it("refuses a zone the platform does not know", async () => {
    await expect(setTimeZone("Mars/Olympus", dir)).rejects.toThrow("unknown time zone");
    expect(await readTimeZone(dir)).toBeNull();
  });

  it("captures nothing for a zone the platform does not know", async () => {
    expect(await captureTimeZone("Mars/Olympus", dir)).toBeNull();
  });

  it.each([["Europe/Lisbon"], ["Asia/Dubai"], ["UTC"], ["America/Argentina/Salta"]])(
    "knows %s",
    (zone) => {
      expect(isTimeZone(zone)).toBe(true);
    },
  );

  it.each([[""], ["Mars/Olympus"], ["../../etc/passwd"], ["+03:00"], [42]])(
    "refuses %s",
    (zone) => {
      expect(isTimeZone(zone)).toBe(false);
    },
  );

  it("reads a file somebody broke as unset rather than throwing", async () => {
    await fs.writeFile(path.join(dir, OWNER_SETTINGS_FILE), "{not json", "utf8");
    resetOwnerSettingsCache();
    expect(await readTimeZone(dir)).toBeNull();
  });

  it("keeps the file private to the owner of the process", async () => {
    await captureTimeZone("Europe/Lisbon", dir);
    const file = await fs.stat(path.join(dir, OWNER_SETTINGS_FILE));
    expect(file.mode & 0o777).toBe(0o600);
  });

  it("writes the file in the state directory and not in the notes tree", () => {
    expect(ownerSettingsDirectory({ NODE_ENV: "production" })).toBe("/var/lib/brain/settings");
    expect(
      ownerSettingsDirectory({ NODE_ENV: "production", BRAIN_SETTINGS_STATE_DIR: "/tmp/x" }),
    ).toBe("/tmp/x");
  });
});
