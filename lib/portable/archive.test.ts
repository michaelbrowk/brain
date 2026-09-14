import { gunzipSync, gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  createPortableArchive,
  readPortableArchive,
} from "./archive";

describe("portable tar.gz archive", () => {
  it("round-trips manifest, markdown, and assets", () => {
    const archive = createPortableArchive([
      {
        path: "manifest.json",
        data: new TextEncoder().encode('{"format":"brain-portable"}'),
      },
      {
        path: "pages/p000001.md",
        data: new TextEncoder().encode("# Hello\n"),
      },
      {
        path: "assets/ABCDEF_asset.png",
        data: new Uint8Array([137, 80, 78, 71]),
      },
    ]);
    const entries = readPortableArchive(archive);
    expect(new TextDecoder().decode(entries.get("pages/p000001.md"))).toBe(
      "# Hello\n",
    );
    expect(entries.get("assets/ABCDEF_asset.png")).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );
  });

  it("rejects duplicate or traversal paths", () => {
    expect(() =>
      createPortableArchive([
        { path: "manifest.json", data: new Uint8Array() },
        { path: "../secret", data: new Uint8Array() },
      ]),
    ).toThrow(/invalid path/);
    expect(() =>
      createPortableArchive([
        { path: "manifest.json", data: new Uint8Array() },
        { path: "manifest.json", data: new Uint8Array() },
      ]),
    ).toThrow(/invalid path/);
  });

  it("rejects corrupt or non-gzip input", () => {
    expect(() => readPortableArchive(new Uint8Array([1, 2, 3]))).toThrow(
      /valid gzip/,
    );
  });

  it("accepts tasks/t000001.md", () => {
    const archive = createPortableArchive([
      { path: "manifest.json", data: new TextEncoder().encode("{}") },
      { path: "tasks/t000001.md", data: new TextEncoder().encode("one\n") },
    ]);
    const entries = readPortableArchive(archive);
    expect(new TextDecoder().decode(entries.get("tasks/t000001.md"))).toBe(
      "one\n",
    );
  });

  it("refuses tasks/t1.md, tasks/anything.md, tasks/../secret and _tasks/t000001.md", () => {
    for (const path of [
      "tasks/t1.md",
      "tasks/anything.md",
      "tasks/../secret",
      "_tasks/t000001.md",
      "tasks/t0000001.md",
      "tasks/t000001.md.md",
      "tasks/sub/t000001.md",
    ]) {
      expect(() =>
        createPortableArchive([
          { path: "manifest.json", data: new Uint8Array() },
          { path, data: new Uint8Array() },
        ]),
      ).toThrow(/invalid path/);
    }
  });

  it("refuses a task path with a prefix field set in the tar header", () => {
    const archive = createPortableArchive([
      { path: "manifest.json", data: new TextEncoder().encode("{}") },
      { path: "tasks/t000001.md", data: new TextEncoder().encode("one\n") },
    ]);
    const raw = gunzipSync(Buffer.from(archive));
    // The manifest takes one 512 byte header plus one padded data block, so
    // the task entry header starts at 1024 and its prefix field at 345.
    raw.write("/etc", 1024 + 345, 4, "ascii");
    expect(() => readPortableArchive(gzipSync(raw))).toThrow(/unsafe entry/);
  });
});
