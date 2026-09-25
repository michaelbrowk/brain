import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Store } from "./store";

/** THE READ LEAF A PAGE'S OWN FILE LEAVES THE NOTES FOLDER THROUGH.
 *
 *  `readAttachment` is the only way bytes under `_attachments` reach a caller
 *  that is not the media route, and an MCP send is its first user. Four
 *  properties matter enough to pin: the name is matched before any path is
 *  joined, a name that is not one answers `missing` rather than reaching the
 *  filesystem, the type is read off the extension the store itself minted,
 *  and a file above the caller's budget is answered without being read.
 */

const ROOTS: string[] = [];

async function tmpStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-read-attachment-"));
  ROOTS.push(root);
  const store = new Store(root);
  await store.init();
  return { store, root };
}

afterEach(async () => {
  for (const root of ROOTS.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

/** Nine bytes a PDF reader would accept, because the store checks the first bytes
 *  against the type a file claims. */
const PDF_BYTES = new Uint8Array([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a,
]);

const TEXT_BYTES = new Uint8Array([0x61, 0x62, 0x63]);

function nameOf(url: string): string {
  return url.slice("/_attachments-v2/".length);
}

describe("Store.readAttachment", () => {
  it("answers the bytes and the type the extension records", async () => {
    const { store } = await tmpStore();
    const saved = await store.saveAttachment({
      data: PDF_BYTES,
      originalName: "invoice.pdf",
      mimeType: "application/pdf",
    });

    const read = await store.readAttachment(nameOf(saved.url), 1024);

    expect(read).toEqual({
      kind: "file",
      name: nameOf(saved.url),
      mimeType: "application/pdf",
      data: PDF_BYTES,
    });
  });

  it("answers application/octet-stream for an extension it does not know", async () => {
    const { store } = await tmpStore();
    const saved = await store.saveAttachment({
      data: TEXT_BYTES,
      originalName: "notes.rtf",
      mimeType: "application/rtf",
    });

    const read = await store.readAttachment(nameOf(saved.url), 1024);

    expect(read).toMatchObject({
      kind: "file",
      mimeType: "application/octet-stream",
    });
  });

  it("answers too_large off the file's size, without reading it", async () => {
    const { store } = await tmpStore();
    const saved = await store.saveAttachment({
      data: TEXT_BYTES,
      originalName: "notes.txt",
      mimeType: "text/plain",
    });

    expect(await store.readAttachment(nameOf(saved.url), 2)).toEqual({
      kind: "too_large",
    });
    expect(await store.readAttachment(nameOf(saved.url), 3)).toMatchObject({
      kind: "file",
    });
  });

  /** NOTHING WAS MIGRATED WHEN THE NAMING CHANGED.
   *
   *  Files saved before the store named them by content carry a `nanoid(12)`,
   *  and their urls sit in bodies nothing rewrote. They read exactly as they
   *  always did: the name rule in `lib/attachments.ts` admits both shapes, and
   *  nothing on this path asks a name what shape it is. */
  it("answers a file saved under the older nanoid name", async () => {
    const { store, root } = await tmpStore();
    const directory = path.join(root, "_attachments");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "MX6Z4uQ4-5X1.pdf"), PDF_BYTES);

    expect(await store.readAttachment("MX6Z4uQ4-5X1.pdf", 1024)).toEqual({
      kind: "file",
      name: "MX6Z4uQ4-5X1.pdf",
      mimeType: "application/pdf",
      data: PDF_BYTES,
    });
  });

  it("answers missing for a name that is not an attachment name", async () => {
    const { store, root } = await tmpStore();
    await fs.writeFile(path.join(root, "secret.md"), "not yours", "utf8");

    for (const name of ["../secret.md", "/etc/passwd", "a/b.txt", ".."]) {
      expect(await store.readAttachment(name, 1024)).toEqual({ kind: "missing" });
    }
  });

  it("answers missing for a name the folder does not hold", async () => {
    const { store } = await tmpStore();

    expect(await store.readAttachment("file-alpha-1.pdf", 1024)).toEqual({
      kind: "missing",
    });
  });
});
