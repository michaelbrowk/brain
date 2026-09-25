import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";
import {
  getStore,
  isAttachmentValidation,
  isNotFound,
  isNotionImportConflict,
  isRevConflict,
  redactPage,
  redactPageMeta,
} from "@/lib/store";
import { isSearchBackendError, searchNotes } from "@/lib/search";
import { smartEmoji } from "@/lib/emoji-llm";
import {
  decodeNotionAttachmentBase64,
  notionAbortPageInputSchema,
  notionAdoptPageInputSchema,
  notionFinalizePageInputSchema,
  notionFindPageInputSchema,
  notionInspectCandidateInputSchema,
  notionReservePageInputSchema,
  notionUploadAttachmentInputSchema,
  notionVerifyAttachmentInputSchema,
  notionVerifyFinalizedAttachmentInputSchema,
} from "@/lib/notion/mcp";
import { acquireNotionUploadSlot } from "@/lib/notion/upload-admission";
import {
  MCP_CONNECTION_SCOPES,
  type McpScope,
  oauthIssuer,
} from "@/lib/oauth/config";
import { canonicalizeMcpPageMarkdown } from "@/lib/mcp-page-markdown";
import { appendMcpActivity } from "@/lib/mcp/activity-log";
import {
  exactBearerToken,
  mcpInsufficientScopeResponse,
  withMcpChallengeScopes,
} from "@/lib/oauth/http";
import { verifyMcpBearerToken } from "@/lib/oauth/server";
import {
  clientNameOf,
  hasScope,
  hints,
  insufficientScope,
  searchBackendFailed,
  STORE_FAILED,
  storeFailed,
  text,
  toolScopeOf,
} from "./tool-kit";
import { registerMailAttachmentTools } from "./mail-attachment-tools";
import { registerMailTools } from "./mail-tools";
import { registerMailSendTools } from "./mail-send-tools";
import { registerTaskTools } from "./task-tools";
import { registerAppTools } from "./app-tools";
import { moduleGated } from "./module-gate";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** EVERY PAGE TOOL'S STORE FAILURE, AS AN ANSWER.
 *
 *  The notes folder can fail on any of these, and the store's message for
 *  that is a Node `fs` one carrying its absolute path. The SDK hands a thrown
 *  error's message to the agent verbatim, so a rethrow published the path and
 *  arrived as the transport error `docs/mcp-tools.md` calls a bug.
 *
 *  `NotFoundError` is passed through rather than folded in: an id that is not
 *  a page is the caller's own mistake, it names no path, and the tool
 *  reference documents what each tool does with one. */
function pageTool<Args extends unknown[], Answer>(
  work: (...args: Args) => Promise<Answer>,
): (...args: Args) => Promise<Answer | ReturnType<typeof storeFailed>> {
  return async (...args: Args) => {
    try {
      return await work(...args);
    } catch (error) {
      if (isNotFound(error)) throw error;
      return storeFailed();
    }
  };
}

/** WHAT A PAGE WRITE LEAVES BEHIND, BESIDE THE PAGE.
 *
 *  The six writes here were the one family of mutations that recorded nothing:
 *  an agent could rewrite every note in the folder and the owner's Connections
 *  list stayed empty. They write one line each now, through the same
 *  `appendMcpActivity` the mail and task tools use, which is also what puts a
 *  row in the notification centre.
 *
 *  `change` is the tool's own mutation token, the way a triage line names which
 *  field moved: `markdown`, `append`, `create`, `move`, `delete`, and for
 *  `update_meta` the field names its patch carried. `label` is the page's own
 *  title, for the bell's body and never for the line.
 *
 *  `notion_*` stays out. It has its own ledger, its own batch and its own
 *  scope, and one import would otherwise fill the list it is meant to be read
 *  from.
 */
interface PageMarks {
  page?: string;
  change?: string;
  label?: string;
}

/** A tool's answer and the one word the log records beside it, the shape
 *  `task-tools.ts` already answers in. */
interface PageAnswer<Answer> {
  answer: Answer;
  outcome: string;
}

type PageToolExtra = { authInfo?: { scopes?: string[]; clientId?: string } };

async function logPageWrite(
  extra: PageToolExtra,
  tool: string,
  marks: PageMarks,
  outcome: string,
): Promise<void> {
  // The grant's name is a nicety and the line is the record, so a state store
  // that cannot be read costs the name rather than the line. The whole append
  // is swallowed for the same reason: a write that has already landed must not
  // reach the agent as a failure, or it will do it again.
  let client = "Unknown app";
  try {
    client = await clientNameOf(extra);
  } catch {
    client = "Unknown app";
  }
  try {
    await appendMcpActivity(
      {
        at: new Date().toISOString(),
        client,
        tool,
        ...(marks.page !== undefined ? { page: marks.page } : {}),
        ...(marks.change !== undefined ? { change: marks.change } : {}),
        outcome,
      },
      marks.label === undefined ? undefined : { label: marks.label },
    );
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    console.warn(`[brain/mcp] page activity line dropped: ${reason}`);
  }
}

/** Every page write runs through here instead of `pageTool`: the same store
 *  failure answered in Brain's own words, and one line whatever the outcome,
 *  the refusals included. Awaited rather than fired and forgotten, the way the
 *  mail tools' line is: it is one bounded append, and a line that outlived its
 *  own turn is what made the task tools grow a flush helper for their tests.
 *
 *  The `insufficient_scope` each of the six answers is the second lock, not
 *  the first: all six are in `WRITE_TOOLS`, so the route's own gate refuses a
 *  grant without `brain:write` before any handler runs. There is no test for
 *  that branch because there is no request that reaches it; it is here so a
 *  scope check removed one layer up cannot quietly let a mail grant write a
 *  note. */
async function pageWrite<Answer>(
  extra: PageToolExtra,
  tool: string,
  work: (marks: PageMarks) => Promise<PageAnswer<Answer>>,
): Promise<Answer | ReturnType<typeof storeFailed>> {
  const marks: PageMarks = {};
  try {
    const { answer, outcome } = await work(marks);
    await logPageWrite(extra, tool, marks, outcome);
    return answer;
  } catch (error) {
    if (isNotFound(error)) {
      await logPageWrite(extra, tool, marks, "not_found");
      throw error;
    }
    await logPageWrite(extra, tool, marks, STORE_FAILED);
    return storeFailed();
  }
}

/** A page's own title out of whatever the store just answered with, for the
 *  bell's body. Typed for the shape rather than the class so a value that has
 *  no meta is `undefined` and never a throw. */
function titleIn(value: { meta?: { title?: string } }): string | undefined {
  return value.meta?.title;
}

/** The title of a page about to go, for the bell's body. Swallowed on purpose:
 *  a row's body is a nicety and the delete is the record, so a note whose
 *  `index.md` cannot be read is still deleted and still announced, without its
 *  name. */
async function pageTitleFor(
  store: Awaited<ReturnType<typeof getStore>>,
  id: string,
): Promise<string | undefined> {
  try {
    return (await store.readPage(id)).meta.title;
  } catch {
    return undefined;
  }
}

/** WHAT A NOTION_* RETHROW CARRIES, ONCE EVERY NAMED REFUSAL ABOVE HAS
 *  ALREADY RETURNED.
 *
 *  The nine `notion_*` tools answer `{ error, code }` for the failures they
 *  named and rethrow everything else, because the import driver reads a
 *  throw as abort-and-retry and reads a return as a refusal to reason about.
 *  What reaches this by the time control falls through is the store itself
 *  failing, the same Node `fs` message that carries the absolute path of the
 *  notes folder `pageTool` keeps from the other tools. The driver only cares
 *  that the call threw, never what the message said, so the wording changes
 *  here and the throw-vs-return protocol does not. */
function notionStoreFailure(error: unknown): Error {
  return Object.assign(new Error("Brain could not read the notes folder"), {
    code: STORE_FAILED,
    cause: error,
  });
}

/** GETSTORE(), FOR THE NINE NOTION TOOLS ALONE.
 *
 *  Every one of the nine calls `getStore()` before its own try block, so a
 *  rejection from `getStore()` itself used to skip `notionStoreFailure`
 *  entirely and reach the agent as the store's raw Node `fs` message, naming
 *  the notes folder's absolute path. This wraps the acquisition in the same
 *  sentence and code the try block's own catch already answers with, so the
 *  nine tools stay uniform: whichever step fails, the throw carries Brain's
 *  own wording, never the store's. */
async function acquireStoreForImport() {
  try {
    return await getStore();
  } catch (error) {
    throw notionStoreFailure(error);
  }
}

const handler = createMcpHandler(
  (server) => {
    // The mail tools and the task tools live in their own modules because this
    // file is already long enough. Their scope gate is `toolScopeOf` in
    // `tool-kit.ts`, which runs off the tool name before this handler is
    // reached; their module gate is the wrapper below, which runs before each
    // handler and leaves the registration alone, so a tool out of a module
    // that is off is listed and refused rather than missing.
    registerMailTools(moduleGated(server, "mail"));
    registerMailAttachmentTools(moduleGated(server, "mail"));
    registerMailSendTools(moduleGated(server, "mail"));
    registerTaskTools(moduleGated(server, "tasks"));
    registerAppTools(server);

    server.registerTool(
      "list_tree",
      {
        title: "List the page tree",
        description:
          "List the full page tree of the notebook (ids, titles, icons, nesting).",
        inputSchema: {},
        annotations: hints("read keeps idempotent local"),
      },
      pageTool(async () => {
        const store = await getStore();
        return text(store.getTree());
      }),
    );

    server.registerTool(
      "connection_check",
      {
        title: "Check this connection",
        description:
          "Verify this MCP connection can authenticate and read Brain without changing any pages. Reports whether write, import, and mail access are authorized, but does not exercise those permissions.",
        inputSchema: {},
        annotations: hints("read keeps idempotent local"),
      },
      pageTool(async (_input, extra) => {
        const store = await getStore();
        const tree = store.getTree();
        const scopes = extra.authInfo?.scopes ?? [];
        return text({
          status: "connected",
          checks: {
            authentication: "ok",
            notes: "ok",
          },
          access: {
            read: "ready",
            write: scopes.includes("brain:write")
              ? "authorized"
              : "not_authorized",
            import: scopes.includes("brain:import")
              ? "authorized"
              : "not_authorized",
            mail: scopes.includes("brain:mail") ? "authorized" : "not_authorized",
            mailSend: scopes.includes("brain:mail:send")
              ? "authorized"
              : "not_authorized",
          },
          rootPageCount: tree.length,
          scopes,
          changedPages: 0,
        });
      }),
    );

    server.registerTool(
      "read_page",
      {
        title: "Read a page",
        description:
          "Read a page's markdown by id. Returns meta, markdown, and rev (needed for write_page).",
        inputSchema: { id: z.string().describe("page id") },
        annotations: hints("read keeps idempotent local"),
      },
      pageTool(async ({ id }) => {
        const store = await getStore();
        return text(redactPage(await store.readPage(id)));
      }),
    );

    server.registerTool(
      "write_page",
      {
        title: "Replace a page's markdown",
        description:
          "Replace a page's markdown. Pass the rev from read_page for conflict safety; omit to force. The version it replaces is kept: every save is committed to the notes folder's own git history.",
        inputSchema: {
          id: z.string(),
          markdown: z.string(),
          rev: z.string().optional().describe("rev from read_page; omit to overwrite"),
        },
        annotations: hints("write keeps idempotent local"),
      },
      async ({ id, markdown, rev }, extra) =>
        pageWrite(extra, "write_page", async (marks) => {
          if (!hasScope(extra, "brain:write")) {
            return {
              answer: insufficientScope("brain:write"),
              outcome: "insufficient_scope",
            };
          }
          marks.page = id;
          marks.change = "markdown";
          const store = await getStore();
          try {
            const written = await store.writePage(
              id,
              canonicalizeMcpPageMarkdown(markdown, oauthIssuer()),
              rev,
              "claude",
            );
            marks.label = titleIn(written);
            return { answer: text(redactPage(written)), outcome: "ok" };
          } catch (e) {
            // A refusal Brain decided on, in the shape every other one answers
            // in. It used to answer with no `isError` and no `reason`, so an
            // agent branching on either took a conflict for a write.
            if (isRevConflict(e))
              return {
                answer: {
                  ...text({
                    error: "rev conflict — re-read the page",
                    reason: "rev_conflict",
                    currentRev: e.currentRev,
                  }),
                  isError: true as const,
                },
                outcome: "rev_conflict",
              };
            throw e;
          }
        }),
    );

    server.registerTool(
      "append_page",
      {
        title: "Append to a page",
        description:
          "Append markdown to the end of a page in one atomic call (read + append + " +
          "write server-side): add to a page without overwriting it, no read_page / " +
          "rev dance needed. Great for logging into a pre-filled agenda or journal. " +
          "Calling it twice adds the text twice, and each save is committed to the " +
          "notes folder's own git history.",
        inputSchema: {
          id: z.string(),
          markdown: z.string().describe("markdown to add at the end of the page"),
        },
        annotations: hints("write keeps repeats local"),
      },
      async ({ id, markdown }, extra) =>
        pageWrite(extra, "append_page", async (marks) => {
          if (!hasScope(extra, "brain:write")) {
            return {
              answer: insufficientScope("brain:write"),
              outcome: "insufficient_scope",
            };
          }
          marks.page = id;
          marks.change = "append";
          const store = await getStore();
          const appended = await store.appendPage(
            id,
            canonicalizeMcpPageMarkdown(markdown, oauthIssuer()),
            "claude",
          );
          marks.label = titleIn(appended);
          return { answer: text(redactPage(appended)), outcome: "ok" };
        }),
    );

    server.registerTool(
      "create_page",
      {
        title: "Create a page",
        description:
          "Create a page. parentId null/omitted = top level. Returns the new page's meta (id). Calling it twice makes two pages, and each save is committed to the notes folder's own git history.",
        inputSchema: {
          title: z.string(),
          parentId: z.string().nullable().optional(),
          markdown: z.string().optional().describe("initial content"),
          icon: z.string().optional().describe("emoji; auto-picked from title if omitted"),
          status: z.string().optional().describe("kanban column, for cards on a board page"),
        },
        annotations: hints("write keeps repeats local"),
      },
      async ({ title, parentId, markdown, icon, status }, extra) =>
        pageWrite(extra, "create_page", async (marks) => {
          if (!hasScope(extra, "brain:write")) {
            return {
              answer: insufficientScope("brain:write"),
              outcome: "insufficient_scope",
            };
          }
          marks.change = "create";
          const store = await getStore();
          try {
            const meta = await store.createPage(parentId ?? null, title, {
              markdown:
                markdown === undefined
                  ? undefined
                  : canonicalizeMcpPageMarkdown(markdown, oauthIssuer()),
              icon: icon || (await smartEmoji(title)),
              status,
              by: "claude",
            });
            // The id is the store's, not the caller's: this is the one write
            // whose page did not exist when the call came in.
            marks.page = meta.id;
            marks.label = meta.title;
            return { answer: text(redactPageMeta(meta)), outcome: "ok" };
          } catch (e) {
            // Return a structured error instead of a raw throw: a transport-level
            // 500 reads as id=null to the client, which then re-creates at root.
            if (isNotFound(e))
              return {
                answer: text({
                  error: `parent not found: ${parentId} — page NOT created, do not retry at root`,
                  parentId,
                }),
                outcome: "parent_not_found",
              };
            throw e;
          }
        }),
    );

    server.registerTool(
      "notion_find_page",
      {
        title: "Find the Brain page for a Notion id",
        description: "Find the Brain page for one Notion id and report server-computed import baseline, lease, and optional candidate-token ownership integrity without returning the token.",
        inputSchema: notionFindPageInputSchema,
        annotations: hints("read keeps idempotent outside"),
      },
      async ({ notionId, reservationToken }, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await acquireStoreForImport();
        try {
          return text({
            page: await store.inspectNotionPage(notionId, reservationToken),
          });
        } catch (error) {
          if (isNotionImportConflict(error))
            return text({ error: error.message, code: error.code });
          throw notionStoreFailure(error);
        }
      },
    );

    server.registerTool(
      "notion_inspect_candidate",
      {
        title: "Inspect an import candidate",
        description: "Inspect one explicitly selected Brain page for preserve/adopt using only rev, placement, and redacted Notion binding state.",
        inputSchema: notionInspectCandidateInputSchema,
        annotations: hints("read keeps idempotent outside"),
      },
      async ({ pageId }, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await acquireStoreForImport();
        try {
          return text({
            candidate: await store.inspectNotionCandidate(pageId),
          });
        } catch (error) {
          if (isNotFound(error)) return text({ candidate: null });
          if (isNotionImportConflict(error))
            return text({ error: error.message, code: error.code });
          throw notionStoreFailure(error);
        }
      },
    );

    server.registerTool(
      "notion_adopt_page",
      {
        title: "Adopt a page into an import",
        description: "Bind a verified existing Brain page to one Notion source without changing its content or hierarchy. Read the page immediately before adoption and pass its rev plus the conversion hash for that exact target.",
        inputSchema: notionAdoptPageInputSchema,
        annotations: hints("write keeps idempotent outside"),
      },
      async (input, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await acquireStoreForImport();
        try {
          return text(await store.adoptNotionImport(input));
        } catch (error) {
          if (isRevConflict(error))
            return text({
              error: "rev conflict — re-read and re-verify the Brain page",
              code: "rev_conflict",
              currentRev: error.currentRev,
            });
          if (isNotFound(error))
            return text({ error: "Brain page not found", code: "not_found" });
          if (isNotionImportConflict(error))
            return text({ error: error.message, code: error.code });
          throw notionStoreFailure(error);
        }
      },
    );

    server.registerTool(
      "notion_reserve_page",
      {
        title: "Reserve a page for an import",
        description: "Atomically find-or-reserve a Notion page before converting content. Pass one maps ids; pass two supplies conversionHash and desired beforeId after every sibling id is known. Never retries at root.",
        inputSchema: notionReservePageInputSchema,
        annotations: hints("write keeps idempotent outside"),
      },
      async ({ notionId, sourceHash, parentId, beforeId, ...rest }, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await acquireStoreForImport();
        try {
          return text(
            await store.reserveNotionImport({
              notionId,
              sourceHash,
              parentId,
              beforeId,
              ...rest,
            }),
          );
        } catch (error) {
          if (isNotFound(error)) {
            if (error.id === parentId)
              return text({
                error: `parent not found: ${parentId} — page NOT reserved, do not retry at root`,
                code: "parent_not_found",
                parentId,
              });
            if (error.id === beforeId)
              return text({
                error: `next sibling not found: ${beforeId} — page NOT reserved`,
                code: "sibling_not_found",
                beforeId,
              });
            return text({ error: "page not found", code: "not_found" });
          }
          if (isNotionImportConflict(error))
            return text({ error: error.message, code: error.code });
          throw notionStoreFailure(error);
        }
      },
    );

    server.registerTool(
      "notion_upload_attachment",
      {
        title: "Upload an imported attachment",
        description: "Upload one converted Notion attachment under an active page reservation.",
        inputSchema: notionUploadAttachmentInputSchema,
        annotations: hints("write keeps idempotent outside"),
      },
      async ({
        notionId,
        sourceHash,
        expectedSha256,
        reservationToken,
        originalName,
        mimeType,
        dataBase64,
      }, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await acquireStoreForImport();
        const releaseUpload = acquireNotionUploadSlot();
        if (!releaseUpload) {
          return text({
            error: "another notion attachment is uploading — retry serially",
            code: "upload_busy",
            retryAfterMs: 1_000,
          });
        }
        try {
          return text(
            await store.saveNotionAttachment(
              notionId,
              sourceHash,
              reservationToken,
              {
                data: decodeNotionAttachmentBase64(dataBase64),
                originalName,
                mimeType,
                expectedSha256,
              },
              "notion-import",
            ),
          );
        } catch (error) {
          if (isNotionImportConflict(error) || isAttachmentValidation(error))
            return text({ error: error.message, code: error.code });
          throw notionStoreFailure(error);
        } finally {
          releaseUpload();
        }
      },
    );

    server.registerTool(
      "notion_verify_attachment",
      {
        title: "Verify a staged attachment",
        description: "Read and hash one staged attachment under the matching active Notion reservation.",
        inputSchema: notionVerifyAttachmentInputSchema,
        annotations: hints("read keeps idempotent outside"),
      },
      async (input, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await acquireStoreForImport();
        try {
          return text(await store.verifyNotionAttachment(input));
        } catch (error) {
          if (isNotionImportConflict(error))
            return text({ error: error.message, code: error.code });
          throw notionStoreFailure(error);
        }
      },
    );

    server.registerTool(
      "notion_verify_finalized_attachment",
      {
        title: "Verify a finalized attachment",
        description: "Read and hash one permanent attachment owned by an intact finalized Notion target.",
        inputSchema: notionVerifyFinalizedAttachmentInputSchema,
        annotations: hints("read keeps idempotent outside"),
      },
      async (input, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await acquireStoreForImport();
        try {
          return text(await store.verifyFinalizedNotionAttachment(input));
        } catch (error) {
          if (isNotFound(error))
            return text({ error: "notion page not found", code: "not_found" });
          if (isNotionImportConflict(error))
            return text({ error: error.message, code: error.code });
          throw notionStoreFailure(error);
        }
      },
    );

    server.registerTool(
      "notion_finalize_page",
      {
        title: "Finalize an imported page",
        description: "Finalize a reserved Notion page. Refuses stale tokens and concurrent edits. Finalize parents before children and each sibling group from last to first (the next beforeId target must already be stable).",
        inputSchema: notionFinalizePageInputSchema,
        annotations: hints("write keeps idempotent outside"),
      },
      async (input, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await acquireStoreForImport();
        try {
          return text(await store.finalizeNotionImport(input));
        } catch (error) {
          if (isNotFound(error))
            return text({ error: "notion page not reserved", code: "not_found" });
          if (isNotionImportConflict(error))
            return text({ error: error.message, code: error.code });
          if (isAttachmentValidation(error))
            return text({ error: error.message, code: error.code });
          throw notionStoreFailure(error);
        }
      },
    );

    server.registerTool(
      "notion_abort_page",
      {
        title: "Abort an import reservation",
        description: "Release a token-owned Notion reservation without overwriting the current page body. The conversion work done under that reservation is discarded, and a placeholder the import created is detached rather than hard-deleted.",
        inputSchema: notionAbortPageInputSchema,
        annotations: hints("write destroys idempotent outside"),
      },
      async (input, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await acquireStoreForImport();
        try {
          return text(await store.abortNotionImport(input));
        } catch (error) {
          if (isNotFound(error))
            return text({ error: "notion page not reserved", code: "not_found" });
          if (isNotionImportConflict(error))
            return text({ error: error.message, code: error.code });
          throw notionStoreFailure(error);
        }
      },
    );

    server.registerTool(
      "update_meta",
      {
        title: "Update a page's details",
        description:
          "Update page metadata: title, icon, category, kanban status, view ('board' turns a page with children into a kanban board). public:false may revoke sharing; only the owner disclosure flow can enable it. The previous metadata is kept: every save is committed to the notes folder's own git history.",
        inputSchema: {
          id: z.string(),
          title: z.string().optional(),
          icon: z.string().optional(),
          category: z.string().optional(),
          status: z.string().optional(),
          view: z.enum(["board", "doc"]).optional().describe("'board' or 'doc'"),
          public: z.boolean().optional(),
        },
        annotations: hints("write keeps idempotent local"),
      },
      async ({ id, view, public: pub, ...rest }, extra) =>
        pageWrite(extra, "update_meta", async (marks) => {
          if (!hasScope(extra, "brain:write")) {
            return {
              answer: insufficientScope("brain:write"),
              outcome: "insufficient_scope",
            };
          }
          marks.page = id;
          if (pub === true) {
            return {
              answer: {
                ...text({
                  error:
                    "public sharing must be enabled by the owner after scope disclosure",
                  reason: "share_disclosure_required",
                }),
                isError: true,
              },
              outcome: "share_disclosure_required",
            };
          }
          const patch = {
            ...rest,
            ...(view !== undefined
              ? { view: view === "board" ? ("board" as const) : null }
              : {}),
            ...(pub !== undefined ? { public: pub } : {}),
          };
          // The field names the patch carried, in the schema's own order, the
          // way `update_task`'s line names its own. A person scanning the log
          // can tell a retitle from a filing without opening the note.
          marks.change = Object.keys(patch).join("+") || "meta";
          const store = await getStore();
          const meta = await store.updateMeta(id, { ...patch, by: "claude" });
          marks.label = meta.title;
          return { answer: text(redactPageMeta(meta)), outcome: "ok" };
        }),
    );

    server.registerTool(
      "move_page",
      {
        title: "Move a page",
        description: [
          "Move a page under a new parent (null = top level), optionally before a sibling.",
          "A move between parents edits two documents, not only the tree: every",
          "standalone `[label](/p/<id>)` paragraph for the page is removed from",
          "the old parent's body, and one is appended to the new parent's body",
          "unless that body already links the page. A reorder among siblings",
          "edits no body. Both rewritten pages record updatedBy: claude. The",
          "result is the moved page's metadata plus `unlinkedFrom`: the old",
          "parent whose body stopped listing the page, or null when no body",
          "changed. Both rewrites are committed to the notes folder's own git",
          "history, so the bodies as they were are kept.",
        ].join(" "),
        inputSchema: {
          id: z.string(),
          newParentId: z.string().nullable().optional(),
          beforeId: z.string().nullable().optional(),
        },
        annotations: hints("write keeps idempotent local"),
      },
      async ({ id, newParentId, beforeId }, extra) =>
        pageWrite(extra, "move_page", async (marks) => {
          if (!hasScope(extra, "brain:write")) {
            return {
              answer: insufficientScope("brain:write"),
              outcome: "insufficient_scope",
            };
          }
          marks.page = id;
          marks.change = "move";
          const store = await getStore();
          const moved = await store.movePageWithBodyReport(
            id,
            newParentId ?? null,
            beforeId ?? null,
            undefined,
            "claude",
          );
          marks.label = titleIn(moved);
          return {
            answer: text({
              ...redactPageMeta(moved.meta),
              unlinkedFrom: moved.unlinkedFrom,
            }),
            outcome: "ok",
          };
        }),
    );

    server.registerTool(
      "delete_page",
      {
        title: "Move a page to Trash",
        description:
          "Delete a page and its whole subtree. A soft delete: the pages go to Trash and are recoverable from there. Nothing is purged, only the owner empties the Trash.",
        inputSchema: { id: z.string() },
        annotations: hints("write destroys idempotent local"),
      },
      async ({ id }, extra) =>
        pageWrite(extra, "delete_page", async (marks) => {
          if (!hasScope(extra, "brain:write")) {
            return {
              answer: insufficientScope("brain:write"),
              outcome: "insufficient_scope",
            };
          }
          marks.page = id;
          marks.change = "delete";
          const store = await getStore();
          // The title before the subtree goes. One `index.md` read against a
          // call that is about to rewrite a whole subtree, and it is swallowed:
          // see `pageTitleFor`.
          marks.label = await pageTitleFor(store, id);
          await store.deletePage(id);
          return { answer: text({ ok: true }), outcome: "ok" };
        }),
    );

    server.registerTool(
      "search",
      {
        title: "Search the notes",
        description:
          "Full-text search across all pages. Returns matching pages with snippets.",
        inputSchema: { query: z.string() },
        annotations: hints("read keeps idempotent local"),
      },
      // THE ENGINE'S OWN FAILURE, BEFORE THE CATCH-ALL SEES IT. `pageTool`
      // answers `store_failed` for everything that is not a `NotFoundError`,
      // which is right for the notes folder and wrong for `rg`: a binary that
      // is not installed, a timed-out search and a query over the output cap
      // all read as an unwritable disk. Named here, so the folder's code
      // still means the folder.
      pageTool(async ({ query }) => {
        try {
          return text(await searchNotes(query));
        } catch (error) {
          if (isSearchBackendError(error)) {
            return searchBackendFailed((error as Error).message);
          }
          throw error;
        }
      }),
    );
  },
  {
    serverInfo: { name: "brain", version: "1.1.0" },
  },
  {
    basePath: "/api",
    maxDuration: 60,
    disableSse: true,
  },
);

const authenticatedHandler = withMcpAuth(
  async (request) => {
    const requiredScopes = await requiredToolScopes(request);
    const auth = (request as Request & { auth?: { scopes: string[] } }).auth;
    const missingScope = requiredScopes.find(
      (scope) => !auth?.scopes.includes(scope),
    );
    if (missingScope) {
      return mcpInsufficientScopeResponse(missingScope);
    }
    return handler(request);
  },
  (request, token) => verifyMcpBearerToken(exactBearerToken(request, token)),
  {
    required: true,
    requiredScopes: ["brain:read"],
    resourceMetadataPath: "/.well-known/oauth-protected-resource/api/mcp",
    resourceUrl: oauthIssuer(),
  },
);

/** THE LARGEST REQUEST THIS ENDPOINT ACCEPTS.
 *
 *  There was no number here at all. `requiredToolScopes` parses the body so it
 *  can pre-gate a batch on every scope every call in it needs, and the handler
 *  parses it again, so a body of any size whatsoever was read into memory twice
 *  before one tool was asked anything. The tools have their own caps — an app
 *  entry is two mebibytes and its assets ten — and none of them was reached.
 *
 *  Sixteen mebibytes is above every one of those, and above a batch of them,
 *  and well under what the request the store would refuse anyway can cost. It
 *  is answered as HTTP rather than as a tool refusal, the way `docs/mcp-tools.md`
 *  says the caps are: the request never reached a tool, so there is no tool to
 *  answer for it, and nothing the model could read and fix.
 *
 *  A declared `Content-Length` over the cap is refused on the header alone,
 *  before a byte is read. Everything else is read here once, stopping the
 *  moment it passes the cap, and handed on as a request carrying the bytes
 *  already in hand — a body cannot be read twice, and a clone cannot be
 *  counted without the other branch of the tee being read in step with it,
 *  which deadlocks. So the endpoint holds at most the cap, whatever the
 *  sender declared. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

type Bounded =
  | { readonly ok: true; readonly request: Request }
  | { readonly ok: false };

async function boundBody(request: Request): Promise<Bounded> {
  if (request.method !== "POST") return { ok: true, request };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return { ok: false };
  }
  if (request.body === null) return { ok: true, request };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel("MCP request too large");
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    ok: true,
    request: new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: bytes,
      // THE SIGNAL IS NOT OPTIONAL. `mcp-handler` hands `request.signal` to
      // `createServerResponseAdapter`, which turns an abort into the `close`
      // the streamable transport tears its session down on. A rebuilt request
      // carrying a fresh signal that can never fire means a client hanging up
      // mid-call emits no `close` at all: the response stream stays open and
      // the per-request state is held until the sixty-second ceiling.
      signal: request.signal,
    }),
  };
}

/** The bounding, for the cases that are about the request rather than about a
 *  tool: the abort signal surviving the rebuild, and the cap's own boundary,
 *  which a `>=` for a `>` would otherwise move by one byte unnoticed. */
export const boundBodyForTests = boundBody;

function tooLargeResponse(): Response {
  return Response.json(
    {
      error: "that request is larger than this endpoint accepts",
      reason: "too_large",
    },
    { status: 413, headers: { "Cache-Control": "no-store" } },
  );
}

async function routeHandler(request: Request): Promise<Response> {
  const bounded = await boundBody(request);
  if (!bounded.ok) return tooLargeResponse();
  return withMcpChallengeScopes(
    await authenticatedHandler(bounded.request),
    MCP_CONNECTION_SCOPES,
  );
}

/** Every scope a batch's tool calls need, not only the last one named. A
 *  request body is either one JSON-RPC message or an array of them, and a
 *  grant must hold every scope any call in the batch needs before the batch
 *  runs at all.
 *
 *  A set over all of them, with no early return. Import used to return as
 *  soon as it was seen, on the reasoning that it is the widest scope in play,
 *  which is true of the scopes it closes onto and false of the two mail ones:
 *  a grant may hold import without holding either. So a batch mixing a
 *  `notion_*` call with a mail call was pre-gated on `brain:import` alone,
 *  and the mail call reached its own handler to refuse itself in body. No
 *  access was given away, because every scoped tool carries its own
 *  `hasScope`, but the property this gate exists for, refused before the
 *  handler, was not held for that one shape. */
async function requiredToolScopes(request: Request): Promise<McpScope[]> {
  if (request.method !== "POST") return [];
  let payload: unknown;
  try {
    payload = await request.clone().json();
  } catch {
    return [];
  }
  const messages = Array.isArray(payload) ? payload : [payload];
  const required: McpScope[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const value = message as {
      method?: unknown;
      params?: { name?: unknown };
    };
    if (value.method !== "tools/call" || typeof value.params?.name !== "string") {
      continue;
    }
    const scope = toolScopeOf(value.params.name);
    if (scope && !required.includes(scope)) required.push(scope);
  }
  return required;
}

export { routeHandler as GET, routeHandler as POST, routeHandler as DELETE };
