import { describe, expect, it } from "vitest";
import {
  attachmentMimeTypeForName,
  canonicalAttachmentExtension,
  canonicalAttachmentMimeType,
  isExecutableAttachmentExtension,
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

describe("the extensions a message may not hand an agent", () => {
  it.each([
    "exe",
    "dll",
    "com",
    "scr",
    "bat",
    "cmd",
    "ps1",
    "msi",
    "jar",
    "sh",
    "app",
    "dmg",
    "pkg",
  ])("names .%s as one a person has to choose for themselves", (extension) => {
    expect(isExecutableAttachmentExtension(`.${extension}`)).toBe(true);
    // The store lowercases the extension it mints, and a sender can write a
    // name in any case at all.
    expect(isExecutableAttachmentExtension(`.${extension.toUpperCase()}`)).toBe(
      true,
    );
  });

  it.each([".pdf", ".png", ".txt", ".zip", ".bin", "", ".exealike"])(
    "leaves %s alone",
    (extension) => {
      expect(isExecutableAttachmentExtension(extension)).toBe(false);
    },
  );
});

describe("the type a stored file is served and sent as", () => {
  it.each([
    ["shot-alpha.png", "image/png"],
    ["shot-alpha.JPEG", "image/jpeg"],
    ["paper-alpha.pdf", "application/pdf"],
    // The media route has never served an SVG as an image, and this is that
    // route's own list.
    ["drawing-alpha.svg", "application/octet-stream"],
    ["setup-alpha.exe", "application/octet-stream"],
    ["no-extension", "application/octet-stream"],
  ])("reads %s as %s", (name, mimeType) => {
    expect(attachmentMimeTypeForName(name)).toBe(mimeType);
  });
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
