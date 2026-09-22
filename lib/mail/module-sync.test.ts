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
  delete process.env.BRAIN_MAIL_SOCKET_PATH;
  resetOwnerSettingsCache(dir);
  await fs.rm(dir, { recursive: true, force: true });
});

describe("telling the mail service what the switch says", () => {
  it("sends enabled false when Mail is off", async () => {
    await setModules({ mail: false }, dir);
    const setSyncEnabled = vi.fn(async () => ({ paused: true }));
    expect(await tellMailServiceAboutModules({ client: { setSyncEnabled } })).toBe(
      true,
    );
    expect(setSyncEnabled).toHaveBeenCalledWith(false);
  });

  it("sends enabled true when Mail is on", async () => {
    const setSyncEnabled = vi.fn(async () => ({ paused: false }));
    expect(await tellMailServiceAboutModules({ client: { setSyncEnabled } })).toBe(
      true,
    );
    expect(setSyncEnabled).toHaveBeenCalledWith(true);
  });

  // The service is another process with its own outage, and a switch the
  // owner flipped must land in the settings file whether or not it answered.
  it("answers false and throws nothing when the service does not answer", async () => {
    const setSyncEnabled = vi.fn(async () => {
      throw new Error("socket refused");
    });
    expect(await tellMailServiceAboutModules({ client: { setSyncEnabled } })).toBe(
      false,
    );
  });

  // The Tasks switch is not this service's business, and the sentence it is
  // told is the mail half of the pair alone.
  it("ignores the Tasks switch", async () => {
    await setModules({ tasks: false }, dir);
    const setSyncEnabled = vi.fn(async () => ({ paused: false }));
    expect(await tellMailServiceAboutModules({ client: { setSyncEnabled } })).toBe(
      true,
    );
    expect(setSyncEnabled).toHaveBeenCalledWith(true);
  });

  /** WHAT THE CALLER WROTE BEATS WHAT THE FILE SAYS. The route hands over the
   *  pair it just saved, so the value on the wire is that write rather than a
   *  second read racing it. */
  it("sends the pair it was handed without reading the file", async () => {
    await setModules({ mail: true }, dir);
    const setSyncEnabled = vi.fn(async () => ({ paused: true }));
    await tellMailServiceAboutModules({
      modules: { mail: false, tasks: true },
      client: { setSyncEnabled },
    });
    expect(setSyncEnabled).toHaveBeenCalledWith(false);
  });

  /** THE CLIENT IS BUILT INSIDE THE TRY.
   *
   *  `createBrainMailClient` throws on a socket path that is not absolute,
   *  and an empty variable is how an operator unsets one in a systemd
   *  drop-in: `??` falls through on nullish alone, so `""` reaches the
   *  validator. As a default parameter that throw ran before the function
   *  body and escaped the catch, which turned one wrong environment variable
   *  into a 500 on a switch that had already been written. */
  it.each(["", "run/brain-mail.sock", "relative/path"])(
    "answers false for the malformed socket path %j",
    async (socketPath) => {
      process.env.BRAIN_MAIL_SOCKET_PATH = socketPath;
      await expect(tellMailServiceAboutModules()).resolves.toBe(false);
      await expect(
        tellMailServiceAboutModules({ modules: { mail: false, tasks: true } }),
      ).resolves.toBe(false);
    },
  );
});
