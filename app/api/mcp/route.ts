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
import { searchNotes } from "@/lib/search";
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
import {
  exactBearerToken,
  mcpInsufficientScopeResponse,
  withMcpChallengeScopes,
} from "@/lib/oauth/http";
import { verifyMcpBearerToken } from "@/lib/oauth/server";
import { hasScope, insufficientScope, text, toolScopeOf } from "./tool-kit";
import { registerMailTools } from "./mail-tools";
import { registerMailSendTools } from "./mail-send-tools";
import { registerTaskTools } from "./task-tools";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const handler = createMcpHandler(
  (server) => {
    // The mail tools and the task tools live in their own modules because this
    // file is already long enough. Their scope gate is `toolScopeOf` in
    // `tool-kit.ts`, which runs off the tool name before this handler is
    // reached.
    registerMailTools(server);
    registerMailSendTools(server);
    registerTaskTools(server);

    server.tool(
      "list_tree",
      "List the full page tree of the notebook (ids, titles, icons, nesting).",
      {},
      async () => {
        const store = await getStore();
        return text(store.getTree());
      },
    );

    server.tool(
      "connection_check",
      "Verify this MCP connection can authenticate and read Brain without changing any pages. Reports whether write, import, and mail access are authorized, but does not exercise those permissions.",
      {},
      async (_input, extra) => {
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
      },
    );

    server.tool(
      "read_page",
      "Read a page's markdown by id. Returns meta, markdown, and rev (needed for write_page).",
      { id: z.string().describe("page id") },
      async ({ id }) => {
        const store = await getStore();
        return text(redactPage(await store.readPage(id)));
      },
    );

    server.tool(
      "write_page",
      "Replace a page's markdown. Pass the rev from read_page for conflict safety; omit to force.",
      {
        id: z.string(),
        markdown: z.string(),
        rev: z.string().optional().describe("rev from read_page; omit to overwrite"),
      },
      async ({ id, markdown, rev }, extra) => {
        if (!hasScope(extra, "brain:write")) return insufficientScope("brain:write");
        const store = await getStore();
        try {
          return text(
            redactPage(
              await store.writePage(
                id,
                canonicalizeMcpPageMarkdown(markdown, oauthIssuer()),
                rev,
                "claude",
              ),
            ),
          );
        } catch (e) {
          if (isRevConflict(e))
            return text({ error: "rev conflict — re-read the page", currentRev: e.currentRev });
          throw e;
        }
      },
    );

    server.tool(
      "append_page",
      "Append markdown to the end of a page in one atomic call (read + append + " +
        "write server-side) — add to a page without overwriting it, no read_page / " +
        "rev dance needed. Great for logging into a pre-filled agenda or journal.",
      {
        id: z.string(),
        markdown: z.string().describe("markdown to add at the end of the page"),
      },
      async ({ id, markdown }, extra) => {
        if (!hasScope(extra, "brain:write")) return insufficientScope("brain:write");
        const store = await getStore();
        return text(
          redactPage(
            await store.appendPage(
              id,
              canonicalizeMcpPageMarkdown(markdown, oauthIssuer()),
              "claude",
            ),
          ),
        );
      },
    );

    server.tool(
      "create_page",
      "Create a page. parentId null/omitted = top level. Returns the new page's meta (id).",
      {
        title: z.string(),
        parentId: z.string().nullable().optional(),
        markdown: z.string().optional().describe("initial content"),
        icon: z.string().optional().describe("emoji; auto-picked from title if omitted"),
        status: z.string().optional().describe("kanban column, for cards on a board page"),
      },
      async ({ title, parentId, markdown, icon, status }, extra) => {
        if (!hasScope(extra, "brain:write")) return insufficientScope("brain:write");
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
          return text(redactPageMeta(meta));
        } catch (e) {
          // Return a structured error instead of a raw throw: a transport-level
          // 500 reads as id=null to the client, which then re-creates at root.
          if (isNotFound(e))
            return text({
              error: `parent not found: ${parentId} — page NOT created, do not retry at root`,
              parentId,
            });
          throw e;
        }
      },
    );

    server.registerTool(
      "notion_find_page",
      {
        description: "Find the Brain page for one Notion id and report server-computed import baseline, lease, and optional candidate-token ownership integrity without returning the token.",
        inputSchema: notionFindPageInputSchema,
      },
      async ({ notionId, reservationToken }, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await getStore();
        try {
          return text({
            page: await store.inspectNotionPage(notionId, reservationToken),
          });
        } catch (error) {
          if (isNotionImportConflict(error))
            return text({ error: error.message, code: error.code });
          throw error;
        }
      },
    );

    server.registerTool(
      "notion_inspect_candidate",
      {
        description: "Inspect one explicitly selected Brain page for preserve/adopt using only rev, placement, and redacted Notion binding state.",
        inputSchema: notionInspectCandidateInputSchema,
      },
      async ({ pageId }, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await getStore();
        try {
          return text({
            candidate: await store.inspectNotionCandidate(pageId),
          });
        } catch (error) {
          if (isNotFound(error)) return text({ candidate: null });
          if (isNotionImportConflict(error))
            return text({ error: error.message, code: error.code });
          throw error;
        }
      },
    );

    server.registerTool(
      "notion_adopt_page",
      {
        description: "Bind a verified existing Brain page to one Notion source without changing its content or hierarchy. Read the page immediately before adoption and pass its rev plus the conversion hash for that exact target.",
        inputSchema: notionAdoptPageInputSchema,
      },
      async (input, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await getStore();
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
          throw error;
        }
      },
    );

    server.registerTool(
      "notion_reserve_page",
      {
        description: "Atomically find-or-reserve a Notion page before converting content. Pass one maps ids; pass two supplies conversionHash and desired beforeId after every sibling id is known. Never retries at root.",
        inputSchema: notionReservePageInputSchema,
      },
      async ({ notionId, sourceHash, parentId, beforeId, ...rest }, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await getStore();
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
          throw error;
        }
      },
    );

    server.registerTool(
      "notion_upload_attachment",
      {
        description: "Upload one converted Notion attachment under an active page reservation.",
        inputSchema: notionUploadAttachmentInputSchema,
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
        const store = await getStore();
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
          throw error;
        } finally {
          releaseUpload();
        }
      },
    );

    server.registerTool(
      "notion_verify_attachment",
      {
        description: "Read and hash one staged attachment under the matching active Notion reservation.",
        inputSchema: notionVerifyAttachmentInputSchema,
      },
      async (input, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await getStore();
        try {
          return text(await store.verifyNotionAttachment(input));
        } catch (error) {
          if (isNotionImportConflict(error))
            return text({ error: error.message, code: error.code });
          throw error;
        }
      },
    );

    server.registerTool(
      "notion_verify_finalized_attachment",
      {
        description: "Read and hash one permanent attachment owned by an intact finalized Notion target.",
        inputSchema: notionVerifyFinalizedAttachmentInputSchema,
      },
      async (input, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await getStore();
        try {
          return text(await store.verifyFinalizedNotionAttachment(input));
        } catch (error) {
          if (isNotFound(error))
            return text({ error: "notion page not found", code: "not_found" });
          if (isNotionImportConflict(error))
            return text({ error: error.message, code: error.code });
          throw error;
        }
      },
    );

    server.registerTool(
      "notion_finalize_page",
      {
        description: "Finalize a reserved Notion page. Refuses stale tokens and concurrent edits. Finalize parents before children and each sibling group from last to first (the next beforeId target must already be stable).",
        inputSchema: notionFinalizePageInputSchema,
      },
      async (input, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await getStore();
        try {
          return text(await store.finalizeNotionImport(input));
        } catch (error) {
          if (isNotFound(error))
            return text({ error: "notion page not reserved", code: "not_found" });
          if (isNotionImportConflict(error))
            return text({ error: error.message, code: error.code });
          if (isAttachmentValidation(error))
            return text({ error: error.message, code: error.code });
          throw error;
        }
      },
    );

    server.registerTool(
      "notion_abort_page",
      {
        description: "Release a token-owned Notion reservation without overwriting the current page body.",
        inputSchema: notionAbortPageInputSchema,
      },
      async (input, extra) => {
        if (!hasScope(extra, "brain:import")) return insufficientScope("brain:import");
        const store = await getStore();
        try {
          return text(await store.abortNotionImport(input));
        } catch (error) {
          if (isNotFound(error))
            return text({ error: "notion page not reserved", code: "not_found" });
          if (isNotionImportConflict(error))
            return text({ error: error.message, code: error.code });
          throw error;
        }
      },
    );

    server.tool(
      "update_meta",
      "Update page metadata: title, icon, category, kanban status, view ('board' turns a page with children into a kanban board). public:false may revoke sharing; only the owner disclosure flow can enable it.",
      {
        id: z.string(),
        title: z.string().optional(),
        icon: z.string().optional(),
        category: z.string().optional(),
        status: z.string().optional(),
        view: z.enum(["board", "doc"]).optional().describe("'board' or 'doc'"),
        public: z.boolean().optional(),
      },
      async ({ id, view, public: pub, ...rest }, extra) => {
        if (!hasScope(extra, "brain:write")) return insufficientScope("brain:write");
        if (pub === true) {
          return {
            ...text({
              error:
                "public sharing must be enabled by the owner after scope disclosure",
              code: "share_disclosure_required",
            }),
            isError: true,
          };
        }
        const store = await getStore();
        return text(
          redactPageMeta(await store.updateMeta(id, {
            ...rest,
            ...(view !== undefined ? { view: view === "board" ? "board" : null } : {}),
            ...(pub !== undefined ? { public: pub } : {}),
            by: "claude",
          })),
        );
      },
    );

    server.tool(
      "move_page",
      [
        "Move a page under a new parent (null = top level), optionally before a sibling.",
        "A move between parents edits two documents, not only the tree: every",
        "standalone `[label](/p/<id>)` paragraph for the page is removed from",
        "the old parent's body, and one is appended to the new parent's body",
        "unless that body already links the page. A reorder among siblings",
        "edits no body. Both rewritten pages record updatedBy: claude. The",
        "result is the moved page's metadata plus `unlinkedFrom`: the old",
        "parent whose body stopped listing the page, or null when no body",
        "changed.",
      ].join(" "),
      {
        id: z.string(),
        newParentId: z.string().nullable().optional(),
        beforeId: z.string().nullable().optional(),
      },
      async ({ id, newParentId, beforeId }, extra) => {
        if (!hasScope(extra, "brain:write")) return insufficientScope("brain:write");
        const store = await getStore();
        const moved = await store.movePageWithBodyReport(
          id,
          newParentId ?? null,
          beforeId ?? null,
          undefined,
          "claude",
        );
        return text({
          ...redactPageMeta(moved.meta),
          unlinkedFrom: moved.unlinkedFrom,
        });
      },
    );

    server.tool(
      "delete_page",
      "Delete a page and its whole subtree. Soft-delete — recoverable from Trash.",
      { id: z.string() },
      async ({ id }, extra) => {
        if (!hasScope(extra, "brain:write")) return insufficientScope("brain:write");
        const store = await getStore();
        await store.deletePage(id);
        return text({ ok: true });
      },
    );

    server.tool(
      "search",
      "Full-text search across all pages. Returns matching pages with snippets.",
      { query: z.string() },
      async ({ query }) => text(await searchNotes(query)),
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

async function routeHandler(request: Request): Promise<Response> {
  return withMcpChallengeScopes(
    await authenticatedHandler(request),
    MCP_CONNECTION_SCOPES,
  );
}

/** Every scope a batch's tool calls need, not only the last one named. A
 *  request body is either one JSON-RPC message or an array of them, and a
 *  grant must hold every scope any call in the batch needs before the batch
 *  runs at all. Import is still an early return: it is the widest scope in
 *  play, and a batch never mixes an import tool with a mail or write tool in
 *  practice, so returning as soon as one is seen keeps the common case cheap
 *  without changing what a well-formed batch is refused for. */
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
    if (scope === "brain:import") return [scope];
    if (scope && !required.includes(scope)) required.push(scope);
  }
  return required;
}

export { routeHandler as GET, routeHandler as POST, routeHandler as DELETE };
