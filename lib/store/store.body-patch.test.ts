// The body patch is the save a closing tab sends: a span against a body the
// tab knows, keyed by that body's hash. It writes only when the page's body
// is exactly one of those bodies, so a newer version from anywhere else is a
// 409 and never a silent overwrite.

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "./store";
import { serializeLivePage } from "./frontmatter";
import { RevConflictError } from "./types";
import { bodyHash, diffBodyPatch } from "../body-patch";

async function tmpStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-patch-"));
  const s = new Store(root);
  await s.init();
  return s;
}

function patchFrom(base: string, next: string) {
  return { base: bodyHash(base), ...diffBodyPatch(base, next) };
}

describe("writePageBodyPatch", () => {
  it("applies the span when the page holds the body it was cut from", async () => {
    const s = await tmpStore();
    const page = await s.createPage(null, "A", { markdown: "Saved text" });
    const loaded = await s.readPage(page.id);

    const written = await s.writePageBodyPatch(
      page.id,
      [patchFrom(loaded.markdown, "Saved text and the last words")],
      loaded.rev,
      "me",
    );

    expect(written.markdown).toBe("Saved text and the last words");
    expect((await s.readPage(page.id)).markdown).toBe(
      "Saved text and the last words",
    );
  });

  it("picks whichever known body the page holds now", async () => {
    const s = await tmpStore();
    const page = await s.createPage(null, "A", { markdown: "Base" });
    const loaded = await s.readPage(page.id);
    // The tab's earlier save landed first, so the page moved on to it.
    await s.writePage(page.id, "Base plus a line", loaded.rev, "me");

    const newest = "Base plus a line plus the newest words";
    const written = await s.writePageBodyPatch(
      page.id,
      [patchFrom("Base", newest), patchFrom("Base plus a line", newest)],
      loaded.rev,
      "me",
    );

    expect(written.markdown).toBe(newest);
  });

  it("refuses with a conflict when the page holds a body the tab never saw", async () => {
    const s = await tmpStore();
    const page = await s.createPage(null, "A", { markdown: "Base" });
    const loaded = await s.readPage(page.id);
    await s.writePage(page.id, "Written in another tab", loaded.rev, "me");

    await expect(
      s.writePageBodyPatch(
        page.id,
        [patchFrom("Base", "Base and the closing tab's words")],
        loaded.rev,
        "me",
      ),
    ).rejects.toBeInstanceOf(RevConflictError);
    expect((await s.readPage(page.id)).markdown).toBe("Written in another tab");
  });

  it("does not merge ticks: anything but an exact known body is a conflict", async () => {
    const s = await tmpStore();
    const page = await s.createPage(null, "A", {
      markdown: "- [ ] one\n- [ ] two",
    });
    const loaded = await s.readPage(page.id);
    await s.writePage(page.id, "- [x] one\n- [ ] two", loaded.rev, "me");

    await expect(
      s.writePageBodyPatch(
        page.id,
        [patchFrom(loaded.markdown, "- [ ] one\n- [ ] two\n- [ ] three")],
        loaded.rev,
        "me",
      ),
    ).rejects.toBeInstanceOf(RevConflictError);
  });

  it("keeps the structure barrier: a matching body with a stale rev is refused", async () => {
    const s = await tmpStore();
    const page = await s.createPage(null, "A", { markdown: "Moved body" });
    const before = await s.readPage(page.id);
    await fs.writeFile(
      path.join(s.resolve(page.id), "index.md"),
      serializeLivePage(
        { ...before.meta, structureWriteBarrier: true },
        before.markdown,
      ),
    );

    await expect(
      s.writePageBodyPatch(
        page.id,
        [patchFrom(before.markdown, "Moved body, edited")],
        before.rev,
        "me",
      ),
    ).rejects.toBeInstanceOf(RevConflictError);

    const fenced = await s.readPage(page.id);
    const written = await s.writePageBodyPatch(
      page.id,
      [patchFrom(fenced.markdown, "Moved body, edited")],
      fenced.rev,
      "me",
    );
    expect(written.markdown).toBe("Moved body, edited");
    expect(written.meta.structureWriteBarrier).toBeUndefined();
  });

  it("answers an unchanged body without writing it", async () => {
    const s = await tmpStore();
    const page = await s.createPage(null, "A", { markdown: "Same" });
    const loaded = await s.readPage(page.id);

    const written = await s.writePageBodyPatch(
      page.id,
      [patchFrom("Same", "Same")],
      loaded.rev,
      "me",
    );

    expect(written.rev).toBe(loaded.rev);
  });
});
