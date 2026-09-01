import { describe, expect, it } from "vitest";
import {
  canonicalAttachmentExtension,
  canonicalAttachmentMimeType,
  notionAttachmentUrl,
  referencedAttachmentUrls,
} from "./attachments";

describe("attachment MIME canonicalization", () => {
  it.each([
    {
      alias: "image/jpg",
      canonical: "image/jpeg",
      name: "misleading.png",
      extension: ".jpg",
    },
    {
      alias: "image/pjpeg",
      canonical: "image/jpeg",
      name: "photo",
      extension: ".jpg",
    },
    {
      alias: "image/x-png",
      canonical: "image/png",
      name: "extensionless",
      extension: ".png",
    },
  ])(
    "maps $alias to $canonical and $extension",
    ({ alias, canonical, name, extension }) => {
      expect(canonicalAttachmentMimeType(`${alias}; charset=binary`)).toBe(
        canonical,
      );
      expect(canonicalAttachmentExtension(name, alias)).toBe(extension);
      expect(notionAttachmentUrl("a".repeat(64), name, alias)).toBe(
        `/_attachments-v2/${"a".repeat(64)}${extension}`,
      );
    },
  );
});

describe("exact attachment URL references", () => {
  it("returns Markdown destinations but not plain text, code, or comments", () => {
    const linked = `/_attachments-v2/${"a".repeat(64)}.png`;
    const coded = `/_attachments-v2/${"b".repeat(64)}.png`;
    const plain = `/_attachments-v2/${"c".repeat(64)}.png`;
    const commented = `/_attachments-v2/${"d".repeat(64)}.png`;
    expect(
      referencedAttachmentUrls(
        [
          `![owned](${linked})`,
          `\`${coded}\``,
          plain,
          `<!-- [hidden](${commented}) -->`,
        ].join("\n\n"),
      ),
    ).toEqual(new Set([linked]));
  });
});
