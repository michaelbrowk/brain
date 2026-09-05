import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { localAttachmentName } from "../attachments";
import {
  attachmentGrantsRoot,
  attachmentScopePath,
  forgetUploads,
  readAttachmentScope,
  recordBaseline,
  recordUpload,
  rootIsScoped,
  rootUploadBytes,
  writeAttachmentScope,
} from "./attachment-scope";

const EMPTY = { roots: [], uploads: {}, baseline: {} };
const AT = "2026-09-05T10:00:00.000Z";

describe("attachment scope index", () => {
  it("reads an empty scope from a missing or malformed file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-scope-"));
    await expect(readAttachmentScope(root)).resolves.toEqual(EMPTY);

    await fs.mkdir(path.dirname(attachmentScopePath(root)), { recursive: true });
    await fs.writeFile(attachmentScopePath(root), "not json at all");
    await expect(readAttachmentScope(root)).resolves.toEqual(EMPTY);

    await fs.writeFile(attachmentScopePath(root), '{"roots":"x","uploads":3}');
    await expect(readAttachmentScope(root)).resolves.toEqual(EMPTY);
  });

  it("round-trips through the notes folder", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-scope-"));
    const scope = recordUpload(EMPTY, "abc123456789.png", "root-1", 2048, AT);
    await writeAttachmentScope(root, scope);
    await expect(readAttachmentScope(root)).resolves.toEqual(scope);
    expect(attachmentScopePath(root)).toBe(
      path.join(root, "_attachments", "scope.json"),
    );
  });

  it("grants an upload to its own root and to no other", () => {
    const scope = recordUpload(EMPTY, "abc123456789.png", "root-1", 10, AT);
    expect(attachmentGrantsRoot(scope, "abc123456789.png", "root-1")).toBe(true);
    expect(attachmentGrantsRoot(scope, "abc123456789.png", "root-2")).toBe(false);
  });

  it("grants a baseline name only to the roots that already referenced it", () => {
    const scope = recordBaseline(EMPTY, "root-1", ["old000000001.png"]);
    expect(attachmentGrantsRoot(scope, "old000000001.png", "root-1")).toBe(true);
    expect(attachmentGrantsRoot(scope, "old000000001.png", "root-2")).toBe(false);
    expect(rootIsScoped(scope, "root-1")).toBe(true);
    expect(rootIsScoped(scope, "root-2")).toBe(false);
  });

  it("refuses a name the index has never heard of", () => {
    const scope = recordBaseline(EMPTY, "root-1", []);
    expect(attachmentGrantsRoot(scope, "unknown00001.png", "root-1")).toBe(false);
  });

  it("sums a root's uploaded bytes and ignores another root's", () => {
    let scope = recordUpload(EMPTY, "a00000000001.png", "root-1", 100, AT);
    scope = recordUpload(scope, "b00000000002.png", "root-1", 250, AT);
    scope = recordUpload(scope, "c00000000003.png", "root-2", 900, AT);
    expect(rootUploadBytes(scope, "root-1")).toBe(350);
    expect(rootUploadBytes(scope, "root-2")).toBe(900);
    expect(rootUploadBytes(scope, "root-3")).toBe(0);
  });

  it("records a baseline once and never widens it on a second call", () => {
    const first = recordBaseline(EMPTY, "root-1", ["old000000001.png"]);
    const second = recordBaseline(first, "root-1", ["different0001.png"]);
    expect(second).toBe(first);
  });

  it("lets two roots share one baseline name without either widening the other", () => {
    const one = recordBaseline(EMPTY, "root-1", ["shared000001.png"]);
    const two = recordBaseline(one, "root-2", ["shared000001.png", "only2000001.png"]);
    expect(attachmentGrantsRoot(two, "shared000001.png", "root-1")).toBe(true);
    expect(attachmentGrantsRoot(two, "shared000001.png", "root-2")).toBe(true);
    expect(attachmentGrantsRoot(two, "only2000001.png", "root-1")).toBe(false);
    expect(attachmentGrantsRoot(two, "only2000001.png", "root-2")).toBe(true);
  });

  it("forgets swept uploads and hands back the same object when there is nothing to forget", () => {
    let scope = recordUpload(EMPTY, "a00000000001.png", "root-1", 100, AT);
    scope = recordUpload(scope, "b00000000002.png", "root-1", 250, AT);
    const after = forgetUploads(scope, ["a00000000001.png", "never000001.png"]);
    expect(Object.keys(after.uploads)).toEqual(["b00000000002.png"]);
    expect(rootUploadBytes(after, "root-1")).toBe(250);
    expect(after.roots).toEqual(scope.roots);
    expect(forgetUploads(after, ["never000001.png"])).toBe(after);
  });

  it("refuses to write the index through a symlinked _attachments directory", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-scope-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "brain-scope-outside-"));
    await fs.symlink(outside, path.join(root, "_attachments"), "dir");
    await expect(
      writeAttachmentScope(root, recordBaseline(EMPTY, "root-1", [])),
    ).rejects.toThrow();
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it("reads an empty scope through a symlinked index file or directory", async () => {
    const granted = recordBaseline(EMPTY, "root-1", ["old000000001.png"]);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "brain-scope-outside-"));
    await fs.writeFile(path.join(outside, "scope.json"), JSON.stringify(granted));

    const linkedFile = await fs.mkdtemp(path.join(os.tmpdir(), "brain-scope-"));
    await fs.mkdir(path.join(linkedFile, "_attachments"));
    await fs.symlink(
      path.join(outside, "scope.json"),
      attachmentScopePath(linkedFile),
    );
    await expect(readAttachmentScope(linkedFile)).resolves.toEqual(EMPTY);

    const linkedDir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-scope-"));
    await fs.symlink(outside, path.join(linkedDir, "_attachments"), "dir");
    await expect(readAttachmentScope(linkedDir)).resolves.toEqual(EMPTY);
  });

  it("keeps the index file out of the attachment namespace", () => {
    // The sweep in Store removes any well-formed attachment name no page
    // references, and /api/media serves any well-formed name a page grants.
    // "scope" is one character short of the six the name rule demands, which
    // is the only thing keeping the index from being collected or served.
    // Pin it, so a rename of the file cannot silently cross that line.
    const file = path.basename(attachmentScopePath("/notes"));
    expect(localAttachmentName(`/_attachments-v2/${file}`)).toBeNull();
  });
});
