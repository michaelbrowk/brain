import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ALL_MODULES_ON,
  OWNER_SETTINGS_FILE,
  captureTimeZone,
  isTimeZone,
  ownerSettingsDirectory,
  peekModules,
  readModules,
  readOwnerSettings,
  readTimeZone,
  resetOwnerSettingsCache,
  setModules,
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
    expect(await readOwnerSettings(dir)).toEqual({
      schema: 2,
      timeZone: null,
      modules: { mail: true, tasks: true },
    });
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

  // THE FIRST WRITER WINS, AND TWO ARRIVING TOGETHER ARE STILL TWO WRITERS.
  // The capture reads, checks the zone is unset and then awaits a write, and
  // two list requests from devices in different zones both used to read null,
  // both write, and the later one land. The function's own sentence says
  // "captured once and never overwritten", so the read and the write happen
  // under one queue and the second caller sees what the first left.
  it("keeps the first of two captures that arrive together", async () => {
    const [first, second] = await Promise.all([
      captureTimeZone("Europe/Lisbon", dir),
      captureTimeZone("Asia/Dubai", dir),
    ]);
    expect(first).toBe("Europe/Lisbon");
    expect(second).toBe("Europe/Lisbon");
    expect(await readTimeZone(dir)).toBe("Europe/Lisbon");
    resetOwnerSettingsCache();
    expect(await readTimeZone(dir)).toBe("Europe/Lisbon");
  });

  it("runs the owner's own set after a capture that arrived first", async () => {
    const [captured] = await Promise.all([
      captureTimeZone("Europe/Lisbon", dir),
      setTimeZone("Asia/Dubai", dir),
    ]);
    // The capture saw an unset file and captured; the set then overwrote it,
    // which is what a set is for. Neither read a file the other was part way
    // through writing.
    expect(captured).toBe("Europe/Lisbon");
    resetOwnerSettingsCache();
    expect(await readTimeZone(dir)).toBe("Asia/Dubai");
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

describe("the module switches", () => {
  it("reads both modules as on before anything has been written", async () => {
    expect(await readModules(dir)).toEqual({ mail: true, tasks: true });
  });

  // A schema 1 file is every installation before 0.14.0. It says nothing
  // about modules, and the honest reading of silence is "nothing is off".
  it("reads a schema 1 file as both modules on", async () => {
    await fs.writeFile(
      path.join(dir, OWNER_SETTINGS_FILE),
      `${JSON.stringify({ schema: 1, timeZone: "Europe/Lisbon" })}\n`,
      "utf8",
    );
    resetOwnerSettingsCache(dir);
    expect(await readModules(dir)).toEqual({ mail: true, tasks: true });
    expect(await readTimeZone(dir)).toBe("Europe/Lisbon");
  });

  it("reads a missing key as on, and a key that is not a boolean as on", async () => {
    await fs.writeFile(
      path.join(dir, OWNER_SETTINGS_FILE),
      `${JSON.stringify({ schema: 2, timeZone: null, modules: { mail: false, tasks: "yes" } })}\n`,
      "utf8",
    );
    resetOwnerSettingsCache(dir);
    expect(await readModules(dir)).toEqual({ mail: false, tasks: true });
  });

  it("round trips a switch through the file", async () => {
    expect(await setModules({ mail: false }, dir)).toEqual({
      modules: { mail: false, tasks: true },
      changed: true,
    });
    resetOwnerSettingsCache(dir);
    expect(await readModules(dir)).toEqual({ mail: false, tasks: true });
    expect(await setModules({ mail: true, tasks: false }, dir)).toEqual({
      modules: { mail: true, tasks: false },
      changed: true,
    });
    resetOwnerSettingsCache(dir);
    expect(await readModules(dir)).toEqual({ mail: true, tasks: false });
  });

  // A PUT that changes nothing writes nothing: the file's mtime is the proof,
  // because a rewrite of the same bytes is still a rewrite.
  it("writes nothing when a switch is set to what it already is", async () => {
    await setModules({ mail: false }, dir);
    const before = await fs.stat(path.join(dir, OWNER_SETTINGS_FILE));
    expect(await setModules({ mail: false }, dir)).toEqual({
      modules: { mail: false, tasks: true },
      changed: false,
    });
    const after = await fs.stat(path.join(dir, OWNER_SETTINGS_FILE));
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("refuses a value that is not a boolean", async () => {
    await expect(setModules({ mail: "off" as unknown as boolean }, dir)).rejects.toThrow(
      "module switch must be a boolean",
    );
    expect(await readModules(dir)).toEqual({ mail: true, tasks: true });
  });

  it("keeps the zone when a module is switched, and the modules when a zone is set", async () => {
    await setTimeZone("Asia/Dubai", dir);
    await setModules({ tasks: false }, dir);
    await setTimeZone("Europe/Lisbon", dir);
    resetOwnerSettingsCache(dir);
    expect(await readOwnerSettings(dir)).toEqual({
      schema: 2,
      timeZone: "Europe/Lisbon",
      modules: { mail: true, tasks: false },
    });
  });

  // THE SYNCHRONOUS READING, for the store's page-save guard. It answers only
  // what the memoised read already holds, never the disk.
  it("peeks nothing before a read and the live answer after one", async () => {
    expect(peekModules(dir)).toBeNull();
    await readModules(dir);
    expect(peekModules(dir)).toEqual({ mail: true, tasks: true });
    await setModules({ tasks: false }, dir);
    // The write updates the same cell, so the peek is current with no read.
    expect(peekModules(dir)).toEqual({ mail: true, tasks: false });
    resetOwnerSettingsCache(dir);
    expect(peekModules(dir)).toBeNull();
  });

  // `pnpm check` runs vitest with a shared globalThis across workers, so a
  // blanket clear from one file would drop another file's entry mid-run.
  it("clears one directory without touching another", async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "brain-owner-settings-b-"));
    try {
      await setModules({ mail: false }, dir);
      await setModules({ tasks: false }, other);
      resetOwnerSettingsCache(dir);
      expect(peekModules(dir)).toBeNull();
      expect(peekModules(other)).toEqual({ mail: true, tasks: false });
    } finally {
      resetOwnerSettingsCache(other);
      await fs.rm(other, { recursive: true, force: true });
    }
  });

  it("exports the default every caller uses for an unreadable file", () => {
    expect(ALL_MODULES_ON).toEqual({ mail: true, tasks: true });
  });
});
