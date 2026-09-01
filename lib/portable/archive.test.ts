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
});
