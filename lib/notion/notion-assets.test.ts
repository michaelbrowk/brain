import { describe, expect, it, vi } from "vitest";
import {
  fetchNotionPngAsset,
  NOTION_ASSET_USER_AGENT,
  stableNotionAssetId,
  verifyPng,
} from "./notion-assets";

const PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
const ASSET_A = "https://file.notion.so/f/workspace/synthetic.png?token=one";
const ASSET_B = "https://file.notion.so/f/workspace/synthetic.png?token=two";

describe("Notion pilot assets", () => {
  it("derives a query-free stable id", () => {
    expect(stableNotionAssetId(ASSET_A)).toBe(stableNotionAssetId(ASSET_B));
    expect(stableNotionAssetId(ASSET_A)).toMatch(/^asset_[a-f0-9]{32}$/);
  });

  it("accepts a verified PNG with a browser-like user agent", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      expect(new Headers(init?.headers).get("user-agent")).toBe(
        NOTION_ASSET_USER_AGENT,
      );
      return new Response(PNG, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(PNG.byteLength),
        },
      });
    });
    const asset = await fetchNotionPngAsset(
      { url: ASSET_A, name: "synthetic.png" },
      { fetchImpl },
    );
    expect(asset).toMatchObject({
      sourceId: stableNotionAssetId(ASSET_A),
      mimeType: "image/png",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(asset.bytes).toEqual(PNG);
  });

  it("follows only exact allowlisted redirects", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: {
            location:
              "https://prod-files-secure.s3.us-west-2.amazonaws.com/synthetic.png?token=next",
          },
        }),
      )
      .mockResolvedValueOnce(
        new Response(PNG, {
          status: 200,
          headers: { "content-type": "image/png" },
        }),
      );
    await expect(
      fetchNotionPngAsset(
        { url: ASSET_A, name: "synthetic.png" },
        { fetchImpl },
      ),
    ).resolves.toMatchObject({ mimeType: "image/png" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const hostile = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "https://file.notion.so.evil.test/f/a.png" },
      }),
    );
    await expect(
      fetchNotionPngAsset(
        { url: ASSET_A, name: "synthetic.png" },
        { fetchImpl: hostile },
      ),
    ).rejects.toThrow(/exact allowlist/);
  });

  it("fails closed on host, size, type, and PNG corruption", async () => {
    await expect(
      fetchNotionPngAsset({
        url: "https://evil.test/f/synthetic.png",
        name: "synthetic.png",
      }),
    ).rejects.toThrow(/allowlist/);

    const oversized = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": String(25 * 1024 * 1024 + 1),
        },
      }),
    );
    await expect(
      fetchNotionPngAsset(
        { url: ASSET_A, name: "synthetic.png" },
        { fetchImpl: oversized },
      ),
    ).rejects.toThrow(/25 MiB/);

    const wrongType = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(PNG, {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      }),
    );
    await expect(
      fetchNotionPngAsset(
        { url: ASSET_A, name: "synthetic.png" },
        { fetchImpl: wrongType },
      ),
    ).rejects.toThrow(/image\/png/);

    const corrupt = PNG.slice();
    corrupt[corrupt.length - 1] ^= 0xff;
    expect(() => verifyPng(corrupt)).toThrow();
  });
});
