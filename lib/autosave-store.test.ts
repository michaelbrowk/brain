// saveMarkdown against the real Store, through a fetcher that hands each
// request to it the way the page route does. These are the shapes where the
// client's choice of rev and base decides whether the server merges, refuses
// or writes, so a fake server is not good enough evidence.

import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "./store/store";
import { isRevConflict } from "./store";
import { bodyHash, diffBodyPatch } from "./body-patch";
import { saveMarkdown, SaveSupersededError, type OwnSaves } from "./autosave";

async function tmpStore() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-autosave-store-"));
  const s = new Store(root);
  await s.init();
  return s;
}

const patch = (from: string, to: string) => ({ base: bodyHash(from), ...diffBodyPatch(from, to) });

/** The page route, minus HTTP: PUT writes through `writePage`, GET reads. */
function route(s: Store, id: string, failFirstPut = false) {
  let puts = 0;
  return async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method !== "PUT") {
      return new Response(JSON.stringify(await s.readPage(id)), { status: 200 });
    }
    puts += 1;
    if (failFirstPut && puts === 1) throw new TypeError("Failed to fetch");
    const body = JSON.parse(String(init.body)) as {
      markdown: string;
      rev?: string;
      baseMarkdown?: string;
    };
    try {
      const page = await s.writePage(id, body.markdown, body.rev, "me", undefined, body.baseMarkdown);
      return new Response(JSON.stringify(page), { status: 200 });
    } catch (error) {
      if (isRevConflict(error)) {
        return new Response(JSON.stringify({ error: "conflict" }), { status: 409 });
      }
      throw error;
    }
  };
}

describe("saveMarkdown against the store", () => {
  it("a stale save retried after a network error keeps its first rev, and never writes over the newer save", async () => {
    const s = await tmpStore();
    const page = await s.createPage(null, "T", { markdown: "Base" });
    const loaded = await s.readPage(page.id);
    const state = { rev: loaded.rev, base: "Base" as string | undefined };
    const own: OwnSaves = {
      newer: "Base one two",
      older: undefined,
      olders: [],
      bodies: ["Base one two"],
    };

    const save = saveMarkdown({
      id: page.id,
      markdown: "Base one",
      fetcher: route(s, page.id, true),
      getRevision: () => state.rev,
      setRevision: (next) => {
        state.rev = next;
      },
      getBaseMarkdown: () => state.base,
      setBaseMarkdown: (next) => {
        state.base = next;
      },
      ownSaves: () => own,
      // During the backoff the closing save lands and the tab adopts it.
      wait: async () => {
        const written = await s.writePageBodyPatch(
          page.id,
          [patch("Base", "Base one two")],
          loaded.rev,
          "me",
        );
        state.rev = written.rev;
        state.base = written.markdown;
      },
    });

    await expect(save).rejects.toBeInstanceOf(SaveSupersededError);
    expect((await s.readPage(page.id)).markdown).toBe("Base one two");
  });

  it("over two own closing saves, finds the one the server holds under a tick", async () => {
    const s = await tmpStore();
    const page = await s.createPage(null, "T", { markdown: "- [ ] task\n\ntext" });
    const loaded = await s.readPage(page.id);
    // The first closing save landed and somebody ticked; the second never
    // arrived.
    await s.writePageBodyPatch(
      page.id,
      [patch("- [ ] task\n\ntext", "- [ ] task\n\ntext one")],
      loaded.rev,
      "me",
    );
    const landed = await s.readPage(page.id);
    await s.writePage(page.id, "- [x] task\n\ntext one", landed.rev, "claude");
    const state = { rev: loaded.rev, base: "- [ ] task\n\ntext" as string | undefined };
    const own: OwnSaves = {
      newer: undefined,
      older: "- [ ] task\n\ntext one two",
      olders: ["- [ ] task\n\ntext one two", "- [ ] task\n\ntext one"],
      bodies: ["- [ ] task\n\ntext one", "- [ ] task\n\ntext one two"],
    };

    await saveMarkdown({
      id: page.id,
      markdown: "- [ ] task\n\ntext one two three",
      fetcher: route(s, page.id),
      getRevision: () => state.rev,
      setRevision: (next) => {
        state.rev = next;
      },
      getBaseMarkdown: () => state.base,
      setBaseMarkdown: (next) => {
        state.base = next;
      },
      ownSaves: () => own,
      wait: async () => {},
    });

    expect((await s.readPage(page.id)).markdown).toBe("- [x] task\n\ntext one two three");
  });
});
