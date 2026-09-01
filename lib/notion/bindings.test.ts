import { chmod, link, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseNotionBindingsJson,
  readPrivateNotionBindingsFile,
} from "./bindings";

const IDS = Array.from({ length: 4 }, (_, index) => String(index + 1).repeat(32));
const SNAPSHOT = "a".repeat(64);
const tempDirectories: string[] = [];

function bindingsObject() {
  return {
    version: 1,
    snapshotFingerprint: SNAPSHOT,
    entries: [
      { notionId: IDS[0], disposition: "create" },
      { notionId: IDS[1], disposition: "skip", reason: "Already migrated" },
      {
        notionId: IDS[2],
        disposition: "preserve",
        brainPageId: "brain-root",
        expectedRev: "b".repeat(64),
        expectedParentId: null,
        expectedBeforeId: null,
      },
      {
        notionId: IDS[3],
        disposition: "adopt",
        brainPageId: "brain-existing",
        expectedRev: "c".repeat(64),
        expectedParentId: "brain-root",
        expectedBeforeId: null,
      },
    ],
  };
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("private generic Notion bindings", () => {
  it("strictly parses every disposition and has an order-independent fingerprint", () => {
    const input = bindingsObject();
    const parsed = parseNotionBindingsJson(JSON.stringify(input));
    expect(parsed.entries.map((entry) => entry.disposition)).toEqual([
      "create",
      "skip",
      "preserve",
      "adopt",
    ]);
    expect(parsed.entryByNotionId.get(IDS[2])).toMatchObject({
      disposition: "preserve",
      brainPageId: "brain-root",
    });
    expect(parsed.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    const reversed = parseNotionBindingsJson(
      JSON.stringify({ ...input, entries: [...input.entries].reverse() }),
    );
    expect(reversed.fingerprint).toBe(parsed.fingerprint);
  });

  it("rejects unknown fields, duplicate source ids, and duplicate Brain mappings", () => {
    const unknown = bindingsObject();
    (unknown as Record<string, unknown>).noteBody = "must not be accepted";
    expect(() => parseNotionBindingsJson(JSON.stringify(unknown))).toThrow(
      /unknown fields/,
    );

    const duplicateSource = bindingsObject();
    duplicateSource.entries[1].notionId = IDS[0];
    expect(() => parseNotionBindingsJson(JSON.stringify(duplicateSource))).toThrow(
      /duplicate.*source id/,
    );

    const duplicateTarget = bindingsObject();
    const adopt = duplicateTarget.entries[3] as { brainPageId: string };
    adopt.brainPageId = "brain-root";
    (duplicateTarget.entries[3] as { expectedParentId: string | null }).expectedParentId =
      null;
    expect(() => parseNotionBindingsJson(JSON.stringify(duplicateTarget))).toThrow(
      /multiple sources to one Brain page/,
    );
  });

  it("requires complete explicit fixed baselines and rejects self-placement", () => {
    const missing = bindingsObject();
    delete (missing.entries[3] as { expectedBeforeId?: string | null }).expectedBeforeId;
    expect(() => parseNotionBindingsJson(JSON.stringify(missing))).toThrow(
      /missing or unknown fields/,
    );

    const selfPlaced = bindingsObject();
    (selfPlaced.entries[3] as { expectedParentId: string | null }).expectedParentId =
      "brain-existing";
    expect(() => parseNotionBindingsJson(JSON.stringify(selfPlaced))).toThrow(
      /relative to itself/,
    );

    const missingPreserve = bindingsObject();
    delete (missingPreserve.entries[2] as { expectedParentId?: string | null })
      .expectedParentId;
    expect(() =>
      parseNotionBindingsJson(JSON.stringify(missingPreserve)),
    ).toThrow(/missing or unknown fields/);

    const selfPlacedPreserve = bindingsObject();
    (
      selfPlacedPreserve.entries[2] as { expectedBeforeId: string | null }
    ).expectedBeforeId = "brain-root";
    expect(() =>
      parseNotionBindingsJson(JSON.stringify(selfPlacedPreserve)),
    ).toThrow(/relative to itself/);
  });

  it("opens only an owned 0600 regular file under an owned 0700 directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "brain-bindings-test-"));
    tempDirectories.push(directory);
    await chmod(directory, 0o700);
    const file = path.join(directory, "bindings.json");
    await writeFile(file, JSON.stringify(bindingsObject()), { mode: 0o600 });

    await expect(readPrivateNotionBindingsFile(file)).resolves.toMatchObject({
      snapshotFingerprint: SNAPSHOT,
      entries: expect.any(Array),
    });
    await expect(
      readPrivateNotionBindingsFile(file, { forbiddenRoots: [directory] }),
    ).rejects.toThrow(/outside repository, notes, and export roots/);

    await chmod(file, 0o644);
    await expect(readPrivateNotionBindingsFile(file)).rejects.toThrow(/mode.*0600/);
  });

  it("does not follow a bindings symlink", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "brain-bindings-link-"));
    tempDirectories.push(directory);
    await chmod(directory, 0o700);
    const real = path.join(directory, "real.json");
    const linked = path.join(directory, "linked.json");
    await writeFile(real, JSON.stringify(bindingsObject()), { mode: 0o600 });
    await symlink(real, linked);
    await expect(readPrivateNotionBindingsFile(linked)).rejects.toThrow(/regular file/);
  });

  it("rejects a bindings file with another hard link", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "brain-bindings-hardlink-"));
    tempDirectories.push(directory);
    await chmod(directory, 0o700);
    const file = path.join(directory, "bindings.json");
    const alias = path.join(directory, "bindings-alias.json");
    await writeFile(file, JSON.stringify(bindingsObject()), { mode: 0o600 });
    await link(file, alias);

    await expect(readPrivateNotionBindingsFile(file)).rejects.toThrow(
      /multiple hard links/,
    );
  });
});
