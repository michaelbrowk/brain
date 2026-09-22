import { beforeEach, describe, expect, it, vi } from "vitest";

/** THE ONE PLACE THE TOOL TABLE'S HINTS ARE PINNED.
 *
 *  MCP's four annotations are what a host reads before it decides whether to
 *  confirm a call. Brain declared none of them, so `delete_page` and
 *  `send_mail` arrived at a host looking exactly like `read_page`. They are
 *  declared now, all four on every tool and never left to a default, and this
 *  is the file that keeps them that way: the table below is the contract, the
 *  walk asserts the server's own `tools/list` against it, and a tool
 *  registered without a hint or without a title fails here rather than
 *  reaching a host as a silent default.
 *
 *  It asks the real server rather than reading the source, for the reason
 *  `route.test.ts` already gives about the tool table: the source is where a
 *  forgotten registration still looks right.
 */

const mocks = vi.hoisted(() => ({ verifyMcpBearerToken: vi.fn() }));

vi.mock("@/lib/oauth/server", () => ({
  verifyMcpBearerToken: mocks.verifyMcpBearerToken,
}));

import { POST } from "./route";

/** The four hints as four words, so one tool is one line and a change to one
 *  of its hints is a one-word diff. Every token is checked against the
 *  vocabulary below, so a misspelling fails the test rather than reading as
 *  the other value. */
type Hints = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

const VOCABULARY = {
  readOnlyHint: { read: true, write: false },
  destructiveHint: { keeps: false, destroys: true },
  idempotentHint: { idempotent: true, repeats: false },
  openWorldHint: { local: false, outside: true },
} as const;

function hintsOf(row: string): Hints {
  const [access, loss, repeat, reach] = row.split(/\s+/);
  const pick = <K extends keyof typeof VOCABULARY>(
    hint: K,
    word: string | undefined,
  ): boolean => {
    const table = VOCABULARY[hint] as Record<string, boolean | undefined>;
    const value = word === undefined ? undefined : table[word];
    if (value === undefined) {
      throw new Error(
        `"${word}" is not a ${hint} word: ${Object.keys(table).join(" | ")}`,
      );
    }
    return value;
  };
  return {
    readOnlyHint: pick("readOnlyHint", access),
    destructiveHint: pick("destructiveHint", loss),
    idempotentHint: pick("idempotentHint", repeat),
    openWorldHint: pick("openWorldHint", reach),
  };
}

/** name → `access loss repeat reach`. `docs/mcp-tools.md` publishes the same
 *  table in the same words. */
const TRUTH_TABLE: Record<string, string> = {
  // Notes, read
  connection_check: "read keeps idempotent local",
  list_tree: "read keeps idempotent local",
  read_page: "read keeps idempotent local",
  search: "read keeps idempotent local",
  // Notes, written. Every save is a git commit, so none of them destroys
  // what was there; `delete_page` goes to Trash and is the one that does.
  create_page: "write keeps repeats local",
  write_page: "write keeps idempotent local",
  append_page: "write keeps repeats local",
  update_meta: "write keeps idempotent local",
  move_page: "write keeps idempotent local",
  delete_page: "write destroys idempotent local",
  // Tasks
  list_tasks: "read keeps idempotent local",
  get_task: "read keeps idempotent local",
  create_task: "write keeps repeats local",
  promote_task_line: "write keeps repeats local",
  update_task: "write keeps idempotent local",
  complete_task: "write keeps idempotent local",
  reopen_task: "write keeps idempotent local",
  delete_task: "write destroys idempotent local",
  // Mail. Every one of these reaches the mail service, so all of them are
  // `outside` whatever else they are.
  list_mail_accounts: "read keeps idempotent outside",
  list_mail_threads: "read keeps idempotent outside",
  search_mail: "read keeps idempotent outside",
  get_mail_thread: "read keeps idempotent outside",
  read_mail_message: "read keeps idempotent outside",
  get_mail_send_status: "read keeps idempotent outside",
  update_mail_thread: "write destroys idempotent outside",
  // `repeats`, not `idempotent`: the same attachment saved twice is a second
  // file, because the general save names a file `nanoid(12)` rather than by
  // its content. Not adding a second copy of a line the page already carries
  // is a different property, and it is the only one this tool has.
  save_mail_attachment: "write keeps repeats outside",
  send_mail: "write destroys idempotent outside",
  reply_mail: "write destroys idempotent outside",
  // Notion import
  notion_find_page: "read keeps idempotent outside",
  notion_inspect_candidate: "read keeps idempotent outside",
  notion_verify_attachment: "read keeps idempotent outside",
  notion_verify_finalized_attachment: "read keeps idempotent outside",
  notion_adopt_page: "write keeps idempotent outside",
  notion_reserve_page: "write keeps idempotent outside",
  notion_upload_attachment: "write keeps idempotent outside",
  notion_finalize_page: "write keeps idempotent outside",
  notion_abort_page: "write destroys idempotent outside",
  // Apps. A build makes a new page every time it is called, so `repeats`; a
  // rebuild replaces the same page's files, so `idempotent`. Neither
  // destroys: the page and its children stay, and every file set is
  // committed to the notes folder's own git history.
  create_app_page: "write keeps repeats local",
  write_app_page: "write keeps idempotent local",
  read_app_page: "read keeps idempotent local",
};

interface ListedTool {
  name: string;
  title?: string;
  annotations?: Partial<Hints> & { title?: string };
}

async function listTools(): Promise<ListedTool[]> {
  const response = await POST(
    new Request("https://brain.example.test/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: "Bearer test-machine-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
  expect(response.status).toBe(200);
  const body = await response.text();
  const dataLine = body.split("\n").find((line) => line.startsWith("data: "));
  const envelope = JSON.parse(dataLine?.slice(6) ?? body) as {
    result?: { tools?: ListedTool[] };
  };
  return envelope.result?.tools ?? [];
}

describe("every MCP tool declares the spec's annotations", () => {
  beforeEach(() => {
    mocks.verifyMcpBearerToken.mockReset();
    mocks.verifyMcpBearerToken.mockResolvedValue({
      token: "test-machine-token",
      clientId: "legacy-client",
      scopes: [
        "brain:read",
        "brain:write",
        "brain:import",
        "brain:mail",
        "brain:mail:send",
      ],
      resource: new URL("https://brain.example.test/api/mcp"),
    });
    vi.stubEnv("MCP_TOKEN", "test-machine-token");
    vi.stubEnv("AUTH_SECRET", "test-auth-secret-with-at-least-32-bytes");
    vi.stubEnv("BRAIN_PUBLIC_ORIGIN", "https://brain.example.test");
  });

  it("advertises the whole tool table and nothing outside it", async () => {
    const names = (await listTools()).map((tool) => tool.name).sort();
    expect(names).toEqual(Object.keys(TRUTH_TABLE).sort());
  });

  it("gives every tool a title and all four hints, never a default", async () => {
    const missing: string[] = [];
    for (const tool of await listTools()) {
      const annotations = tool.annotations;
      if (typeof (tool.title ?? annotations?.title) !== "string") {
        missing.push(`${tool.name}: title`);
      }
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        if (typeof annotations?.[hint] !== "boolean") {
          missing.push(`${tool.name}: ${hint}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("matches the published truth table exactly", async () => {
    const served: Record<string, Hints> = {};
    for (const tool of await listTools()) {
      const { readOnlyHint, destructiveHint, idempotentHint, openWorldHint } =
        tool.annotations ?? {};
      served[tool.name] = {
        readOnlyHint,
        destructiveHint,
        idempotentHint,
        openWorldHint,
      } as Hints;
    }
    const expected = Object.fromEntries(
      Object.entries(TRUTH_TABLE).map(([name, row]) => [name, hintsOf(row)]),
    );
    expect(served).toEqual(expected);
  });

  it("marks every tool that cannot be taken back", async () => {
    const destructive = (await listTools())
      .filter((tool) => tool.annotations?.destructiveHint === true)
      .map((tool) => tool.name)
      .sort();
    // A host confirming only these is confirming the right ones: the two
    // deletes, the triage move that can put a thread in trash or spam, the
    // two sends whose message cannot be recalled, and the import abort that
    // discards a reservation's work.
    expect(destructive).toEqual([
      "delete_page",
      "delete_task",
      "notion_abort_page",
      "reply_mail",
      "send_mail",
      "update_mail_thread",
    ]);
  });

  it("marks every tool that reaches past the notes folder", async () => {
    const local = (await listTools())
      .filter((tool) => tool.annotations?.openWorldHint === false)
      .map((tool) => tool.name);
    // Nothing that talks to the mail service or carries a Notion import is
    // allowed to claim the folder is all it touches.
    expect(local.some((name) => name.includes("mail"))).toBe(false);
    expect(local.some((name) => name.startsWith("notion_"))).toBe(false);
  });
});
