import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Buffer } from "node:buffer";

import {
  readCachedIcon,
  senderIconDirectory,
  sweepIcons,
  writeIcon,
  writeMiss,
} from "./sender-icon-store";

const ICO = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10]);

function entryPath(directory: string, domain: string, extension: string): string {
  const hash = createHash("sha256").update(domain).digest("hex");
  return path.join(directory, "v1", `${hash}.${extension}`);
}

describe("sender-icon store", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "sender-icon-store-"));
    vi.stubEnv("BRAIN_SENDER_ICON_DIR", directory);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("honours the BRAIN_SENDER_ICON_DIR override", () => {
    expect(senderIconDirectory()).toBe(directory);
  });

  it("round-trips an icon and clears any prior miss marker", async () => {
    await writeMiss("example.com");
    await writeIcon("example.com", ICO, "image/x-icon");

    const cached = await readCachedIcon("example.com");
    expect(cached.kind).toBe("icon");
    if (cached.kind !== "icon") throw new Error("expected icon");
    expect(cached.bytes.equals(ICO)).toBe(true);
    expect(cached.contentType).toBe("image/x-icon");

    await expect(
      fs.stat(entryPath(directory, "example.com", "miss")),
    ).rejects.toThrow();
  });

  it("reports a fresh miss marker and expires it after seven days", async () => {
    await writeMiss("gone.example.com");
    expect((await readCachedIcon("gone.example.com")).kind).toBe("miss");

    // Rewrite the marker with a stale timestamp — layout is part of the spec.
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    await fs.writeFile(
      entryPath(directory, "gone.example.com", "miss"),
      JSON.stringify({ v: 1, domain: "gone.example.com", fetchedAt: eightDaysAgo }),
    );
    expect((await readCachedIcon("gone.example.com")).kind).toBe("absent");
  });

  it("returns absent for unknown domains and corrupt sidecars", async () => {
    expect((await readCachedIcon("never-seen.example.com")).kind).toBe("absent");

    await fs.mkdir(path.join(directory, "v1"), { recursive: true });
    await fs.writeFile(entryPath(directory, "corrupt.example.com", "json"), "not json");
    expect((await readCachedIcon("corrupt.example.com")).kind).toBe("absent");
  });

  it("leaves no partial or temporary files when a write fails", async () => {
    // Occupy the final .icon path with a directory so the atomic rename fails.
    const iconPath = entryPath(directory, "blocked.example.com", "icon");
    await fs.mkdir(iconPath, { recursive: true });

    await expect(
      writeIcon("blocked.example.com", ICO, "image/x-icon"),
    ).rejects.toThrow();

    const names = await fs.readdir(path.join(directory, "v1"));
    expect(names.filter((name) => name.includes(".tmp"))).toEqual([]);
    // The sidecar is written after the bytes, so a failed byte write must not
    // leave metadata pointing at nothing.
    expect(names.filter((name) => name.endsWith(".json"))).toEqual([]);
    expect((await readCachedIcon("blocked.example.com")).kind).toBe("absent");
  });

  it("sweeps the oldest entries beyond the cap, keeping the newest", async () => {
    const domains = ["a.example", "b.example", "c.example", "d.example", "e.example"];
    for (const [index, domain] of domains.entries()) {
      await writeIcon(domain, ICO, "image/x-icon");
      const age = new Date(Date.now() - (domains.length - index) * 60_000);
      for (const extension of ["icon", "json"]) {
        await fs.utimes(entryPath(directory, domain, extension), age, age);
      }
    }

    await sweepIcons(3);

    expect((await readCachedIcon("a.example")).kind).toBe("absent");
    expect((await readCachedIcon("b.example")).kind).toBe("absent");
    expect((await readCachedIcon("c.example")).kind).toBe("icon");
    expect((await readCachedIcon("d.example")).kind).toBe("icon");
    expect((await readCachedIcon("e.example")).kind).toBe("icon");
  });
});
