// A body is text the person wrote, whatever it starts with. A note that opens
// with its own `---` block (pasted YAML, a Jekyll post, a horizontal rule
// pair) or with a byte-order mark has to come back from an ordinary save
// byte for byte, and must never be read as the page's own frontmatter.

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "./store";
import { parsePage, serializePage } from "./frontmatter";
import type { PageMeta } from "./types";

const BODIES = [
  "---\nfoo: 1\n---\nbody",
  "---\ntitle: Not the title\n---\n\nreal text",
  "---\n---\nbetween two rules",
  "﻿a body that starts with a byte-order mark",
];

const meta = {
  id: "page-a",
  title: "The title",
  order: "a0",
  created: "2026-10-07T00:00:00.000Z",
  updated: "2026-10-07T00:00:00.000Z",
} as PageMeta;

describe("a body that looks like frontmatter", () => {
  it("survives serializePage → parsePage unchanged, and the meta with it", () => {
    for (const body of BODIES) {
      const parsed = parsePage(serializePage(meta, body));
      expect(parsed.markdown).toBe(body);
      expect(parsed.meta.title).toBe("The title");
      expect(parsed.meta).not.toHaveProperty("foo");
    }
  });

  it("writes an ordinary body byte for byte as before", () => {
    // The file format of every other page must not move, or every rev would.
    expect(serializePage(meta, "# Heading\n\ntext\n")).toBe(
      "---\nid: page-a\ntitle: The title\norder: a0\ncreated: '2026-10-07T00:00:00.000Z'\nupdated: '2026-10-07T00:00:00.000Z'\n---\n# Heading\n\ntext\n",
    );
    expect(serializePage(meta, "")).toMatch(/\n---\n\n$/);
  });

  it("comes back from an ordinary save and from a fresh store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-body-block-"));
    const s = new Store(root);
    await s.init();
    for (const body of BODIES) {
      const page = await s.createPage(null, "Kept", { markdown: "seed" });
      const loaded = await s.readPage(page.id);
      const written = await s.writePage(page.id, body, loaded.rev, "me");
      expect(written.markdown).toBe(body);
      const read = await s.readPage(page.id);
      expect(read.markdown).toBe(body);
      expect(read.meta.title).toBe("Kept");
    }
    const fresh = new Store(root);
    await fresh.init();
    const titles = fresh.getTree().map((node) => node.title);
    expect(titles.every((title) => title === "Kept")).toBe(true);
  });
});
