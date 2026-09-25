import { beforeEach, describe, expect, it, vi } from "vitest";

const createAppPage = vi.fn();
const writeAppFiles = vi.fn();
const setAppMeta = vi.fn();
const readAppMeta = vi.fn();
const readAppFile = vi.fn();
const listAppAssets = vi.fn();
const readPage = vi.fn();
const appendMcpActivity = vi.fn();

vi.mock("@/lib/store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/store/types")>(
    "@/lib/store/types",
  );
  return {
    ...actual,
    getStore: async () => ({
      createAppPage,
      writeAppFiles,
      setAppMeta,
      readAppMeta,
      readAppFile,
      listAppAssets,
      readPage,
    }),
  };
});
vi.mock("@/lib/mcp/activity-log", () => ({ appendMcpActivity }));
/** The grant's own name, without the OAuth state directory underneath it.
 *  `clientNameOf` is the real one: it is what puts `builtBy` on the page, so
 *  a fake for it would leave that field untested. What is faked is the disk
 *  it reads, which no assertion here is about. */
vi.mock("@/lib/oauth/state", () => ({
  getOAuthStateStore: () => ({ getClient: async () => ({ name: "Claude" }) }),
}));

const { registerAppTools } = await import("./app-tools");

interface Registered {
  config: {
    /** Captured because `tool-annotations.test.ts` fails a tool that reaches
     *  a host without one, and that suite asks the real server rather than
     *  this fake. A harness that dropped the field would let a title-less
     *  registration pass here and fail there. */
    title: string;
    description: string;
    annotations: Record<string, boolean>;
    inputSchema: Record<string, unknown>;
  };
  handler: (
    input: Record<string, unknown>,
    extra: unknown,
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

const tools = new Map<string, Registered>();
registerAppTools({
  registerTool: (
    name: string,
    config: Registered["config"],
    handler: Registered["handler"],
  ) => {
    tools.set(name, { config, handler });
  },
} as never);

const writeGrant = { authInfo: { scopes: ["brain:read", "brain:write"], clientId: "c1" } };
const readGrant = { authInfo: { scopes: ["brain:read"], clientId: "c1" } };
const ENTRY = '<!doctype html><meta name="color-scheme" content="light dark"><p>hola</p>';

async function call(
  name: string,
  input: Record<string, unknown>,
  extra: unknown = writeGrant,
) {
  const answer = await tools.get(name)!.handler(input, extra);
  return { ...answer, body: JSON.parse(answer.content[0].text) as Record<string, unknown> };
}

/** The mutator `write_app_page` hands `setAppMeta`, which the store evaluates
 *  inside its own lock. Calling it here with a map of the test's choosing is
 *  how the concurrent-write case is driven: the store's lock is the thing
 *  being relied on, and this asserts what the caller puts inside it. */
function patchOf(): (live: Record<string, unknown>) => Record<string, unknown> {
  return setAppMeta.mock.calls[0][1] as (
    live: Record<string, unknown>,
  ) => Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  createAppPage.mockResolvedValue({
    meta: { id: "app1", title: "Trainer", app: { version: 1, owns: ["words1"], state: true } },
    owned: [{ id: "words1", title: "Words" }],
  });
  readAppMeta.mockReturnValue({
    entry: "app/index.html",
    version: 1,
    builtBy: "Claude",
    builtAt: "2026-09-22T10:00:00.000Z",
    owns: ["words1"],
    state: true,
  });
  readPage.mockResolvedValue({ meta: { id: "app1", title: "Trainer" }, markdown: "d", rev: "r1" });
  readAppFile.mockResolvedValue({
    kind: "file",
    mimeType: "text/html; charset=utf-8",
    data: new TextEncoder().encode(ENTRY),
  });
  listAppAssets.mockResolvedValue(["cards/front.png"]);
  setAppMeta.mockResolvedValue({ id: "app1", title: "Trainer", app: { version: 2 } });
});

describe("the three registrations", () => {
  it("gives every one a human title, which the annotations suite requires", () => {
    expect(tools.get("create_app_page")!.config.title).toBe("Build an app page");
    expect(tools.get("write_app_page")!.config.title).toBe("Rebuild an app page");
    expect(tools.get("read_app_page")!.config.title).toBe("Read an app page");
  });

  it("declares all four hints on each, none left to a default", () => {
    for (const name of ["create_app_page", "write_app_page", "read_app_page"]) {
      const annotations = tools.get(name)!.config.annotations;
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ]) {
        expect(typeof annotations[hint]).toBe("boolean");
      }
    }
  });
});

describe("create_app_page", () => {
  it("carries the last-resort rule in its description, word for word", () => {
    expect(tools.get("create_app_page")!.config.description).toBe(
      "Build a page whose body is an HTML application the owner runs inside Brain. " +
        "An app is the last resort, not a shortcut: build an app only when the owner asked for one, " +
        "or when what they asked for cannot be done with the notebook's own means " +
        "(a page, a table, a checklist, tasks, mail, a collection view), and say so before building. " +
        "Do not build an app to work around a missing Brain feature without naming the gap; " +
        "the right move then is a page plus a note to the owner. " +
        "reason is required and is the owner's own request in one line, kept on the page so they can see why an app appeared. " +
        "Read docs/apps.md before the first one.",
    );
  });

  it("requires a reason", async () => {
    expect(tools.get("create_app_page")!.config.inputSchema).toHaveProperty("reason");
    const answer = await call("create_app_page", {
      parentId: null,
      title: "T",
      description: "d",
      entryHtml: ENTRY,
    });
    expect(answer.isError).toBe(true);
    expect(answer.body.reason).toBe("bad_request");
    expect(createAppPage).not.toHaveBeenCalled();
  });

  it("builds the page, its files and its owned children", async () => {
    const answer = await call("create_app_page", {
      parentId: "spanish",
      title: "Trainer",
      icon: "🃏",
      description: "Trainer for the words under Spanish.",
      entryHtml: ENTRY,
      owns: [{ title: "Words", markdown: "| word |" }],
      state: { seen: 0 },
      reason: "build me a trainer for the Spanish words I am learning",
    });
    expect(answer.body).toMatchObject({ id: "app1" });
    expect(createAppPage).toHaveBeenCalledWith(
      "spanish",
      "Trainer",
      expect.objectContaining({
        reason: "build me a trainer for the Spanish words I am learning",
        builtBy: expect.any(String),
      }),
    );
  });

  it("answers the ids of the children it made, so the app can address them", async () => {
    const answer = await call("create_app_page", {
      parentId: null,
      title: "T",
      description: "d",
      entryHtml: ENTRY,
      owns: [{ title: "Words" }],
      reason: "r",
    });
    expect(answer.body).toMatchObject({ owns: [{ id: "words1", title: "Words" }] });
  });

  it("decodes an asset from base64 and names it for the store", async () => {
    await call("create_app_page", {
      parentId: null,
      title: "T",
      description: "d",
      entryHtml: ENTRY,
      assets: [{ name: "cards/front.png", base64: "AAEC" }],
      reason: "r",
    });
    const input = createAppPage.mock.calls[0][2] as {
      assets: { name: string; data: Uint8Array }[];
    };
    expect(input.assets[0].name).toBe("cards/front.png");
    expect(Array.from(input.assets[0].data)).toEqual([0, 1, 2]);
  });

  it("refuses an entry the lint rejects, naming the rule and the line", async () => {
    const answer = await call("create_app_page", {
      parentId: null,
      title: "T",
      description: "d",
      entryHtml: "<!doctype html>\n<style>body { background: #fff }</style>",
      reason: "r",
    });
    expect(answer.isError).toBe(true);
    expect(answer.body).toMatchObject({
      reason: "lint_failed",
      rule: "color_scheme",
      line: 1,
    });
    expect(createAppPage).not.toHaveBeenCalled();
  });

  it("refuses an oversized entry as too_large", async () => {
    const { AppSizeError } = await import("@/lib/store/types");
    createAppPage.mockRejectedValue(new AppSizeError("entry"));
    const answer = await call("create_app_page", {
      parentId: null,
      title: "T",
      description: "d",
      entryHtml: ENTRY,
      reason: "r",
    });
    expect(answer.body).toMatchObject({ reason: "too_large" });
  });

  it("names the owns cap rather than blaming the notes folder", async () => {
    // `store_failed` is the disk. An app that has minted all the pages it may
    // has a full list, not a broken folder, and an agent told the folder
    // failed goes and checks the mount instead of the one thing it can fix.
    const { AppOwnsFullError } = await import("@/lib/store/types");
    createAppPage.mockRejectedValue(new AppOwnsFullError("app1"));
    const answer = await call("create_app_page", {
      parentId: null,
      title: "T",
      description: "d",
      entryHtml: ENTRY,
      reason: "r",
    });
    expect(answer.isError).toBe(true);
    expect(answer.body.reason).toBe("too_many_owned");
    expect(String(answer.body.error)).toContain("64");
    expect(appendMcpActivity).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "too_many_owned" }),
      undefined,
    );
  });

  it("refuses an asset name an app may not hold as bad_type", async () => {
    const { AttachmentValidationError } = await import("@/lib/store/types");
    createAppPage.mockRejectedValue(
      new AttachmentValidationError("bad_type", "app asset refused: notes.md"),
    );
    const answer = await call("create_app_page", {
      parentId: null,
      title: "T",
      description: "d",
      entryHtml: ENTRY,
      assets: [{ name: "notes.md", base64: "AAEC" }],
      reason: "r",
    });
    expect(answer.body).toMatchObject({ reason: "bad_type" });
  });

  it("refuses a blank owned title before the store has to", async () => {
    // `createAppPage` asks the same question before its first write and
    // throws a bare Error for it, which would reach the agent as
    // `store_failed`: the notes folder is broken, stop writing. The fix is
    // one field of the agent's own call, so it is asked here too.
    const answer = await call("create_app_page", {
      parentId: null,
      title: "T",
      description: "d",
      entryHtml: ENTRY,
      owns: [{ title: "Words" }, { title: "  " }],
      reason: "r",
    });
    expect(answer.isError).toBe(true);
    expect(answer.body.reason).toBe("bad_request");
    expect(createAppPage).not.toHaveBeenCalled();
  });

  it("answers not_found when the store says the page is not an app", async () => {
    const { NotAnAppError } = await import("@/lib/store/types");
    createAppPage.mockRejectedValue(new NotAnAppError());
    const answer = await call("create_app_page", {
      parentId: null,
      title: "T",
      description: "d",
      entryHtml: ENTRY,
      reason: "r",
    });
    expect(answer.body).toMatchObject({ reason: "not_found" });
  });

  describe("an asset that is not base64", () => {
    // `Buffer.from(s, "base64")` never throws. It drops what it cannot read
    // and answers whatever is left, so the likeliest agent mistake of all,
    // passing the data URL the docs recommend elsewhere, wrote twenty bytes
    // of noise into the notes folder under the name of a PNG and answered ok.
    const send = (base64: string) =>
      call("create_app_page", {
        parentId: null,
        title: "T",
        description: "d",
        entryHtml: ENTRY,
        assets: [{ name: "cards/front.png", base64 }],
        reason: "r",
      });

    it.each([
      ["a data URL", "data:image/png;base64,iVBORw0KGgo="],
      ["whitespace between the lines", "AAEC\nAAEC"],
      ["a space", "AAEC AAEC"],
      ["a character outside the alphabet", "AA$C"],
      ["url-safe base64, which decodes to different bytes", "_-EC"],
      ["missing padding", "AAECA"],
      ["padding in the middle", "AA==EC"],
      ["bits that do not survive the round trip", "AB=="],
    ])("refuses %s", async (_name, base64) => {
      const answer = await send(base64);
      expect(answer.isError).toBe(true);
      expect(answer.body.reason).toBe("bad_request");
      expect(String(answer.body.error)).toContain("cards/front.png");
      expect(createAppPage).not.toHaveBeenCalled();
    });

    it.each([
      ["padded bytes", "AA=="],
      ["a full quantum", "AAEC"],
      ["an empty asset", ""],
    ])("takes %s", async (_name, base64) => {
      const answer = await send(base64);
      expect(answer.isError).toBeUndefined();
      expect(createAppPage).toHaveBeenCalled();
    });

    it("refuses on the rebuild path too", async () => {
      const answer = await call("write_app_page", {
        id: "app1",
        rev: "r1",
        assets: [{ name: "cards/back.png", base64: "data:image/png;base64,AA==" }],
      });
      expect(answer.body).toMatchObject({ reason: "bad_request" });
      expect(String(answer.body.error)).toContain("cards/back.png");
      expect(writeAppFiles).not.toHaveBeenCalled();
    });
  });

  describe("a request too large to decode", () => {
    // The store measures the set it is handed, so every asset was already a
    // Buffer by the time it said no: a hundred-megabyte request allocated a
    // hundred megabytes to be told ninety were too many. Base64 says how many
    // bytes it carries without being decoded, so the same refusal is available
    // for the price of a string length, and it has to be the same sentence —
    // an agent must not be able to tell the two checks apart.
    const overAssets = "A".repeat(4 * (3 * 1024 * 1024 + 1));
    const overEntry = "x".repeat(2 * 1024 * 1024 + 1);

    it("refuses an asset set over the cap without decoding it", async () => {
      const answer = await call("create_app_page", {
        parentId: null,
        title: "T",
        description: "d",
        entryHtml: ENTRY,
        assets: [
          { name: "a/one.png", base64: overAssets },
          { name: "a/two.png", base64: overAssets },
          { name: "a/three.png", base64: overAssets },
          { name: "a/four.png", base64: overAssets },
        ],
        reason: "r",
      });
      expect(answer.isError).toBe(true);
      expect(answer.body).toEqual({
        error: "that app's assets is over the size Brain keeps for one",
        reason: "too_large",
      });
      expect(createAppPage).not.toHaveBeenCalled();
    });

    it("refuses an entry over the cap before the lint reads it", async () => {
      const answer = await call("create_app_page", {
        parentId: null,
        title: "T",
        description: "d",
        entryHtml: overEntry,
        reason: "r",
      });
      expect(answer.body).toEqual({
        error: "that app's entry is over the size Brain keeps for one",
        reason: "too_large",
      });
      expect(createAppPage).not.toHaveBeenCalled();
    });

    it("answers the store's own sentence for the same measurement", async () => {
      const { AppSizeError } = await import("@/lib/store/types");
      createAppPage.mockRejectedValue(new AppSizeError("assets"));
      const answer = await call("create_app_page", {
        parentId: null,
        title: "T",
        description: "d",
        entryHtml: ENTRY,
        assets: [{ name: "a/one.png", base64: "AAEC" }],
        reason: "r",
      });
      expect(answer.body).toEqual({
        error: "that app's assets is over the size Brain keeps for one",
        reason: "too_large",
      });
    });

    it("refuses on the rebuild path too, before the store is asked", async () => {
      const answer = await call("write_app_page", {
        id: "app1",
        rev: "r1",
        entryHtml: overEntry,
      });
      expect(answer.body).toMatchObject({ reason: "too_large" });
      expect(writeAppFiles).not.toHaveBeenCalled();
      expect(readAppMeta).not.toHaveBeenCalled();
    });
  });

  it("refuses a grant with no write scope", async () => {
    const answer = await call(
      "create_app_page",
      { parentId: null, title: "T", description: "d", entryHtml: ENTRY, reason: "r" },
      readGrant,
    );
    expect(answer.body.reason).toBe("insufficient_scope");
    expect(createAppPage).not.toHaveBeenCalled();
  });

  it("writes one activity line for the build", async () => {
    await call("create_app_page", {
      parentId: null,
      title: "T",
      description: "d",
      entryHtml: ENTRY,
      reason: "r",
    });
    expect(appendMcpActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "create_app_page",
        page: "app1",
        change: "create_app",
        outcome: "ok",
      }),
      { label: "Trainer" },
    );
  });

  it("keeps the owner's own words off the activity line", async () => {
    await call("create_app_page", {
      parentId: null,
      title: "T",
      description: "d",
      entryHtml: ENTRY,
      reason: "build me a trainer for the Spanish words I am learning",
    });
    const line = appendMcpActivity.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.values(line)).not.toContain(
      "build me a trainer for the Spanish words I am learning",
    );
  });
});

describe("write_app_page", () => {
  it("replaces the app and bumps its version, keeping owns and state", async () => {
    const answer = await call("write_app_page", { id: "app1", entryHtml: ENTRY, rev: "r1" });
    expect(writeAppFiles).toHaveBeenCalledWith(
      "app1",
      expect.objectContaining({ entryHtml: ENTRY }),
    );
    expect(setAppMeta).toHaveBeenCalledWith("app1", expect.any(Function), "claude");
    expect(patchOf()(readAppMeta())).toMatchObject({
      version: 2,
      owns: ["words1"],
      state: true,
    });
    expect(answer.body).toMatchObject({ id: "app1" });
  });

  it("keeps a page the frame created while the rebuild was still writing", async () => {
    // `writeAppFiles` copies the whole file set and commits it, which is long
    // enough for the running frame to call create.page and state.set. Both
    // land on the live map, and neither is in the snapshot this tool read
    // before it started. A rebuild that spread its own copy back would take
    // the new page out of `owns`, leaving a page the app made and can no
    // longer write, which is the exact harm `owns` exists to stop.
    await call("write_app_page", { id: "app1", entryHtml: ENTRY, rev: "r1" });
    const live = { ...readAppMeta(), owns: ["words1", "session1"], state: true };
    expect(patchOf()(live)).toMatchObject({
      version: 2,
      owns: ["words1", "session1"],
      state: true,
    });
  });

  it("stamps the rebuild with who did it and when", async () => {
    await call("write_app_page", { id: "app1", entryHtml: ENTRY, rev: "r1" });
    const next = patchOf()(readAppMeta());
    expect(next.builtBy).toBe("Claude");
    expect(next.builtAt).not.toBe("2026-09-22T10:00:00.000Z");
    expect(Number.isNaN(Date.parse(String(next.builtAt)))).toBe(false);
  });

  it("refuses a stale rev", async () => {
    readPage.mockResolvedValue({
      meta: { id: "app1", title: "Trainer" },
      markdown: "d",
      rev: "live",
    });
    const answer = await call("write_app_page", { id: "app1", entryHtml: ENTRY, rev: "r1" });
    expect(answer.isError).toBe(true);
    expect(answer.body).toMatchObject({ reason: "rev_conflict", currentRev: "live" });
    expect(writeAppFiles).not.toHaveBeenCalled();
  });

  it("refuses a page that is not an app", async () => {
    readAppMeta.mockReturnValue(null);
    const answer = await call("write_app_page", { id: "page1", entryHtml: ENTRY, rev: "r1" });
    expect(answer.body).toMatchObject({ reason: "not_found" });
  });

  it("refuses an entry the lint rejects before it touches the store", async () => {
    const answer = await call("write_app_page", {
      id: "app1",
      entryHtml: "<!doctype html>\n<style>a { color: #fff }</style>",
      rev: "r1",
    });
    expect(answer.body).toMatchObject({ reason: "lint_failed", rule: "color_scheme" });
    expect(writeAppFiles).not.toHaveBeenCalled();
  });

  it("writes its own activity line", async () => {
    await call("write_app_page", { id: "app1", entryHtml: ENTRY, rev: "r1" });
    expect(appendMcpActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "write_app_page",
        page: "app1",
        change: "write_app",
        outcome: "ok",
      }),
      { label: "Trainer" },
    );
  });
});

describe("read_app_page", () => {
  it("answers the entry and the asset list for an agent that wants to edit", async () => {
    const answer = await call("read_app_page", { id: "app1" }, readGrant);
    expect(answer.body).toMatchObject({
      id: "app1",
      entryHtml: ENTRY,
      assets: ["cards/front.png"],
      app: expect.objectContaining({ version: 1, owns: ["words1"] }),
    });
  });

  it("hands back the rev the rewrite needs, so no second call is required", async () => {
    const answer = await call("read_app_page", { id: "app1" }, readGrant);
    expect(answer.body).toMatchObject({ rev: "r1" });
  });

  it("needs no write scope", async () => {
    const answer = await call("read_app_page", { id: "app1" }, readGrant);
    expect(answer.isError).toBeUndefined();
  });

  it("refuses a page that is not an app", async () => {
    readAppMeta.mockReturnValue(null);
    const answer = await call("read_app_page", { id: "page1" }, readGrant);
    expect(answer.body).toMatchObject({ reason: "not_found" });
  });

  it("writes no activity line, because a read is not a change", async () => {
    await call("read_app_page", { id: "app1" }, readGrant);
    expect(appendMcpActivity).not.toHaveBeenCalled();
  });
});
