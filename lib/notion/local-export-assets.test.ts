import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  detectLocalExportMimeType,
  localExportAssetIdentity,
  resolveLocalExportAsset,
} from "./local-export-assets";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function privateFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-local-export-"));
  await fs.chmod(root, 0o700);
  const nested = path.join(root, "Private & Shared", "Page");
  await fs.mkdir(nested, { recursive: true, mode: 0o700 });
  await fs.chmod(path.join(root, "Private & Shared"), 0o700);
  await fs.chmod(nested, 0o700);
  return { root, nested };
}

describe("local Notion export assets", () => {
  it("derives a path-private stable identity", () => {
    const first = localExportAssetIdentity("Private & Shared/Page/image.png");
    const second = localExportAssetIdentity("Private & Shared/Page/image.png");
    expect(first).toEqual(second);
    expect(first.logicalUrl).toMatch(
      /^https:\/\/file\.notion\.so\/f\/brain-export\/[a-f0-9]{64}$/,
    );
    expect(first.logicalUrl).not.toContain("Private");
    expect(first.sourceId).toMatch(/^asset_[a-f0-9]{32}$/);
  });

  it("reads and hashes an owned regular PNG without exposing its path", async () => {
    const { root, nested } = await privateFixture();
    await fs.chmod(path.join(root, "Private & Shared"), 0o755);
    await fs.chmod(nested, 0o755);
    const file = path.join(nested, "image.png");
    await fs.writeFile(file, PNG, { mode: 0o600 });
    await fs.chmod(file, 0o600);

    const asset = await resolveLocalExportAsset({
      root,
      relativePath: "Private & Shared/Page/image.png",
    });

    expect(asset).toMatchObject({
      name: "image.png",
      mimeType: "image/png",
      sourceId: localExportAssetIdentity(
        "Private & Shared/Page/image.png",
      ).sourceId,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Buffer.from(asset.bytes)).toEqual(PNG);
  });

  it("accepts scoped JPEG and JSON types only after byte validation", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 0xff, 0xd9]);
    expect(detectLocalExportMimeType("photo.jpg", jpeg)).toBe("image/jpeg");
    expect(
      detectLocalExportMimeType(
        "data.json",
        new TextEncoder().encode('{"safe":true}'),
      ),
    ).toBe("application/json");
    expect(() =>
      detectLocalExportMimeType("photo.jpg", new Uint8Array([0xff, 0xd8])),
    ).toThrow(/JPEG/);
    expect(() =>
      detectLocalExportMimeType(
        "data.json",
        new TextEncoder().encode("not-json"),
      ),
    ).toThrow(/JSON/);
    expect(() =>
      detectLocalExportMimeType("active.svg", new TextEncoder().encode("<svg/>")),
    ).toThrow(/unsupported/);
  });

  it("rejects traversal, symlinks, public roots, corruption, and oversize", async () => {
    const { root, nested } = await privateFixture();
    const file = path.join(nested, "image.png");
    await fs.writeFile(file, PNG, { mode: 0o600 });
    await fs.chmod(file, 0o600);

    await expect(
      resolveLocalExportAsset({ root, relativePath: "../image.png" }),
    ).rejects.toThrow(/relative path/);

    const link = path.join(nested, "link.png");
    await fs.symlink(file, link);
    await expect(
      resolveLocalExportAsset({
        root,
        relativePath: "Private & Shared/Page/link.png",
      }),
    ).rejects.toThrow(/symlink/);

    await fs.chmod(root, 0o755);
    await expect(
      resolveLocalExportAsset({
        root,
        relativePath: "Private & Shared/Page/image.png",
      }),
    ).rejects.toThrow(/private directory/);
    await fs.chmod(root, 0o700);

    await fs.chmod(file, 0o644);
    await expect(
      resolveLocalExportAsset({
        root,
        relativePath: "Private & Shared/Page/image.png",
      }),
    ).rejects.toThrow(/private regular file/);
    await fs.chmod(file, 0o600);

    const corrupt = path.join(nested, "corrupt.png");
    await fs.writeFile(corrupt, new Uint8Array([1, 2, 3]), { mode: 0o600 });
    await expect(
      resolveLocalExportAsset({
        root,
        relativePath: "Private & Shared/Page/corrupt.png",
      }),
    ).rejects.toThrow(/PNG/);

    await expect(
      resolveLocalExportAsset(
        { root, relativePath: "Private & Shared/Page/image.png" },
        { maxBytes: PNG.byteLength - 1 },
      ),
    ).rejects.toThrow(/byte limit/);
  });
});
