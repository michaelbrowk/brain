import type {
  AbortNotionImportInput,
  AbortNotionImportResult,
  AdoptNotionImportInput,
  AdoptNotionImportResult,
  FinalizeNotionImportInput,
  FinalizeNotionImportResult,
  NotionCandidateBaseline,
  NotionImportStatus,
  ReserveNotionImportInput,
  ReserveNotionImportResult,
  SavedAttachment,
  VerifiedNotionAttachment,
  VerifyFinalizedNotionAttachmentInput,
  VerifyNotionAttachmentInput,
} from "../store/types.ts";
import { z } from "zod";
import {
  collectionDefinitionSchema,
  collectionRowSchema,
  type CollectionDefinition,
  type CollectionRow,
} from "../collections/model.ts";
import {
  MAX_NOTION_ASSET_BYTES,
  type ResolvedNotionAsset,
} from "./notion-assets.ts";

export const BRAIN_MCP_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/136.0.0.0 Safari/537.36 BrainNotionPilot/1";
export const MAX_MCP_BASE64_ASSET_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MCP_REQUEST_TIMEOUT_MS = 70_000;
const MCP_PROTOCOL_VERSION = "2024-11-05";
const PRODUCTION_BRAIN_ORIGIN = "https://brain.example.com";

const REMOTE_ERROR_CODES = new Set([
  "abort_ack_required",
  "already_imported",
  "attachment_not_owned",
  "attachment_store_unavailable",
  "blocked_mime",
  "busy",
  "conversion_issues",
  "conversion_mismatch",
  "has_import_children",
  "hash_mismatch",
  "incompatible_cover",
  "incompatible_icon",
  "invalid_mime",
  "invalid_notion_id",
  "invalid_source_hash",
  "mime_mismatch",
  "missing_attachment",
  "not_found",
  "page_deleted",
  "parent_import_pending",
  "parent_not_found",
  "quota_exceeded",
  "remote_error",
  "reservation_mismatch",
  "rev_conflict",
  "sibling_import_pending",
  "sibling_not_found",
  "source_changed",
  "staging_unavailable",
  "too_large",
  "untracked_existing",
  "upload_busy",
]);

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const brainIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const compatibleNotionIdSchema = z
  .string()
  .regex(/^(?:[A-Fa-f0-9]{32}|[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12})$/)
  .transform((value) => value.replaceAll("-", "").toLowerCase());
const exactAttachmentUrlSchema = z
  .string()
  .regex(/^\/_attachments-v2\/[a-f0-9]{64}\.[A-Za-z0-9_-]{1,32}$/);
const placementSchema = z
  .object({ parentId: brainIdSchema.nullable(), beforeId: brainIdSchema.nullable() })
  .strict();
const notionStatusSchema = z
  .object({
    id: brainIdSchema,
    title: z.string(),
    icon: z.string().optional(),
    notionId: compatibleNotionIdSchema,
    sourceHash: hashSchema.optional(),
    conversionHash: hashSchema.optional(),
    current: placementSchema,
    trackedBaseline: placementSchema
      .extend({ order: z.string().min(1) })
      .strict()
      .optional(),
    importing: z
      .object({
        sourceHash: hashSchema,
        started: z.string(),
        leaseFresh: z.boolean(),
        retryAfterMs: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    integrity: z
      .object({
        trackedTargetIntact: z.boolean().optional(),
        trackedAttachmentIntact: z.boolean().optional(),
        importBaselineIntact: z.boolean().optional(),
        abortBaselineIntact: z.boolean().optional(),
        reservationOwned: z.boolean().optional(),
      })
      .strict()
      .optional(),
    pendingAbort: z
      .object({
        pageId: brainIdSchema,
        sourceHash: hashSchema,
        status: z.enum(["detached", "aborted"]),
        cleanup: z
          .object({
            stagingRemoved: z.boolean(),
            notionBindingRemoved: z.boolean(),
            placeholderPreserved: z.literal(true),
          })
          .strict(),
      })
      .strict()
      .optional(),
    deleted: z.boolean(),
  })
  .strict();
const pageMetaSchema = z
  .object({
    id: brainIdSchema,
    title: z.string(),
    icon: z.string().optional(),
    cover: z.string().optional(),
    order: z.string(),
    created: z.string(),
    updated: z.string(),
    public: z.boolean().optional(),
    shareVersion: z.number().int().nonnegative().optional(),
    category: z.string().optional(),
    pinned: z.boolean().optional(),
    updatedBy: z.enum(["me", "claude"]).optional(),
    status: z.string().optional(),
    view: z.enum(["board", "sections"]).optional(),
    sections: z.array(z.string()).optional(),
    collection: collectionDefinitionSchema.optional(),
    collectionRow: collectionRowSchema.optional(),
    stickers: z
      .array(
        z.object({ id: z.string(), x: z.number(), y: z.number(), text: z.string() }).strict(),
      )
      .optional(),
    notionId: compatibleNotionIdSchema.optional(),
    notionSourceHash: hashSchema.optional(),
    notionConversionHash: hashSchema.optional(),
    notionTargetRev: hashSchema.optional(),
    notionTargetParentId: brainIdSchema.nullable().optional(),
    notionTargetBeforeId: brainIdSchema.nullable().optional(),
    notionTargetOrder: z.string().optional(),
    deleted: z.string().optional(),
    tags: z.array(z.string()).optional(),
    // Accepted, never applied. redactPageMeta is a denylist, so a note
    // captured before the Inbox was removed still carries `inbox` into this
    // strict response. Nothing reads it — do not wire it to anything.
    inbox: z.boolean().optional(),
  })
  .strict();
const readPageSchema = z
  .object({ meta: pageMetaSchema, markdown: z.string(), rev: z.string().min(1) })
  .strict();
const savedAttachmentSchema = z
  .object({
    url: exactAttachmentUrlSchema,
    name: z.string(),
    size: z.number().int().nonnegative(),
    type: z.string(),
  })
  .strict();
const verifiedAttachmentSchema = z
  .object({ url: exactAttachmentUrlSchema, size: z.number().int().nonnegative(), sha256: hashSchema })
  .strict();
const cleanupSchema = z.object({ stagingRemoved: z.boolean() }).strict();
const reserveResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unchanged"), page: notionStatusSchema }).strict(),
  z.object({ status: z.literal("conversion_required"), page: notionStatusSchema }).strict(),
  z.object({ status: z.literal("busy"), page: notionStatusSchema, retryAfterMs: z.number().int().nonnegative() }).strict(),
  z.object({ status: z.literal("reserved"), page: notionStatusSchema, reservationToken: z.string().min(16).max(128), created: z.boolean() }).strict(),
]);
const finalizeResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("unchanged"), page: notionStatusSchema, rev: z.string().min(1), cleanup: cleanupSchema }).strict(),
  z.object({ status: z.literal("finalized"), page: notionStatusSchema, rev: z.string().min(1), cleanup: cleanupSchema }).strict(),
]);
const abortResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("detached"),
      pageId: brainIdSchema,
      cleanup: z
        .object({
          stagingRemoved: z.boolean(),
          notionBindingRemoved: z.literal(true),
          placeholderPreserved: z.literal(true),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      status: z.literal("aborted"),
      pageId: brainIdSchema,
      cleanup: z
        .object({
          stagingRemoved: z.boolean(),
          notionBindingRemoved: z.literal(false),
          placeholderPreserved: z.literal(true),
        })
        .strict(),
    })
    .strict(),
]);
const adoptResultSchema = z
  .object({ status: z.literal("adopted"), page: notionStatusSchema, rev: z.string().min(1) })
  .strict();
const findResultSchema = z.object({ page: notionStatusSchema.nullable() }).strict();
const candidateBaselineSchema = z
  .object({
    id: brainIdSchema,
    rev: z.string().min(1).max(128),
    current: placementSchema,
    deleted: z.boolean(),
    bindingState: z.enum([
      "unbound",
      "tracked",
      "bound_untracked",
      "import_pending",
      "abort_pending",
    ]),
    notionId: compatibleNotionIdSchema.optional(),
    sourceHash: hashSchema.optional(),
    conversionHash: hashSchema.optional(),
    trackedTargetIntact: z.boolean().optional(),
    trackedAttachmentIntact: z.boolean().optional(),
    legacyBindingUpgradeable: z.boolean().optional(),
  })
  .strict();
const inspectCandidateResultSchema = z
  .object({ candidate: candidateBaselineSchema.nullable() })
  .strict();
const toolErrorSchema = z
  .object({
    error: z.string(),
    code: z.string().optional(),
    retryAfterMs: z.number().int().nonnegative().optional(),
    currentRev: z.string().optional(),
    parentId: brainIdSchema.nullable().optional(),
    beforeId: brainIdSchema.nullable().optional(),
  })
  .strict();
const callToolResultSchema = z
  .object({
    content: z.array(z.object({ type: z.literal("text"), text: z.string() }).strict()).length(1),
    isError: z.boolean().optional(),
  })
  .strict();
const initializeResultSchema = z
  .object({
    protocolVersion: z.literal(MCP_PROTOCOL_VERSION),
    capabilities: z.record(z.unknown()),
    serverInfo: z
      .object({ name: z.string(), version: z.string() })
      .strict()
      .optional(),
    instructions: z.string().optional(),
  })
  .strict();
const rpcSuccessSchema = z
  .object({ jsonrpc: z.literal("2.0"), id: z.number().int(), result: z.unknown() })
  .strict();
const rpcErrorSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.number().int(),
    error: z
      .object({ code: z.number().int(), message: z.string(), data: z.unknown().optional() })
      .strict(),
  })
  .strict();
const rpcNotificationSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    method: z.string(),
    params: z.unknown().optional(),
  })
  .strict();

interface SsePayload {
  kind: "sse";
  values: unknown[];
}

export interface BrainReadPage {
  meta: {
    id: string;
    title: string;
    icon?: string;
    cover?: string;
    parentId?: string | null;
    collection?: CollectionDefinition;
    collectionRow?: CollectionRow;
    notionId?: string;
    notionSourceHash?: string;
    notionConversionHash?: string;
    notionTargetRev?: string;
    notionTargetParentId?: string | null;
    notionTargetBeforeId?: string | null;
    notionTargetOrder?: string;
    [key: string]: unknown;
  };
  markdown: string;
  rev: string;
}

export interface UploadNotionAssetInput {
  notionId: string;
  sourceHash: string;
  reservationToken: string;
  asset: ResolvedNotionAsset;
}

export interface BrainImportClient {
  findPage(
    notionId: string,
    reservationToken?: string,
  ): Promise<NotionImportStatus | null>;
  inspectCandidate(pageId: string): Promise<NotionCandidateBaseline | null>;
  adoptPage(input: AdoptNotionImportInput): Promise<AdoptNotionImportResult>;
  reservePage(input: ReserveNotionImportInput): Promise<ReserveNotionImportResult>;
  uploadAttachment(input: UploadNotionAssetInput): Promise<SavedAttachment>;
  verifyAttachment(
    input: VerifyNotionAttachmentInput,
  ): Promise<VerifiedNotionAttachment>;
  verifyFinalizedAttachment(
    input: VerifyFinalizedNotionAttachmentInput,
  ): Promise<VerifiedNotionAttachment>;
  finalizePage(input: FinalizeNotionImportInput): Promise<FinalizeNotionImportResult>;
  abortPage(input: AbortNotionImportInput): Promise<AbortNotionImportResult>;
  readPage(id: string): Promise<BrainReadPage>;
}

export class BrainMcpError extends Error {
  readonly code?: string;
  readonly retryAfterMs?: number;

  constructor(message: string, code?: string, retryAfterMs?: number) {
    super(message);
    this.name = "BrainMcpError";
    this.code = safeRemoteErrorCode(code);
    this.retryAfterMs = retryAfterMs;
  }
}

function safeRemoteErrorCode(code: unknown): string | undefined {
  if (code === undefined) return undefined;
  return typeof code === "string" && REMOTE_ERROR_CODES.has(code)
    ? code
    : "remote_error";
}

export class BrainMcpClient implements BrainImportClient {
  readonly #endpoint: URL;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  #requestId = 0;
  #sessionId: string | undefined;
  #initializePromise: Promise<void> | undefined;

  constructor(options: {
    endpoint: string;
    token: string;
    fetchImpl?: typeof fetch;
    allowedOrigin?: string;
  }) {
    const endpoint = checkedEndpoint(options.endpoint, options.allowedOrigin);
    if (!/^[A-Za-z0-9._~+\/=-]{16,512}$/.test(options.token)) {
      throw new Error("Brain MCP token is invalid");
    }
    this.#endpoint = endpoint;
    this.#token = options.token;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async findPage(
    notionId: string,
    reservationToken?: string,
  ): Promise<NotionImportStatus | null> {
    const result = await this.#tool(
      "notion_find_page",
      reservationToken ? { notionId, reservationToken } : { notionId },
      findResultSchema,
    );
    return result.page;
  }

  async inspectCandidate(
    pageId: string,
  ): Promise<NotionCandidateBaseline | null> {
    const result = await this.#tool(
      "notion_inspect_candidate",
      { pageId },
      inspectCandidateResultSchema,
    );
    return result.candidate;
  }

  adoptPage(input: AdoptNotionImportInput): Promise<AdoptNotionImportResult> {
    return this.#tool("notion_adopt_page", input, adoptResultSchema);
  }

  reservePage(
    input: ReserveNotionImportInput,
  ): Promise<ReserveNotionImportResult> {
    return this.#tool("notion_reserve_page", input, reserveResultSchema);
  }

  finalizePage(
    input: FinalizeNotionImportInput,
  ): Promise<FinalizeNotionImportResult> {
    return this.#tool("notion_finalize_page", input, finalizeResultSchema);
  }

  abortPage(input: AbortNotionImportInput): Promise<AbortNotionImportResult> {
    return this.#tool("notion_abort_page", input, abortResultSchema);
  }

  verifyAttachment(
    input: VerifyNotionAttachmentInput,
  ): Promise<VerifiedNotionAttachment> {
    return this.#tool("notion_verify_attachment", input, verifiedAttachmentSchema);
  }

  verifyFinalizedAttachment(
    input: VerifyFinalizedNotionAttachmentInput,
  ): Promise<VerifiedNotionAttachment> {
    return this.#tool(
      "notion_verify_finalized_attachment",
      input,
      verifiedAttachmentSchema,
    );
  }

  readPage(id: string): Promise<BrainReadPage> {
    return this.#tool("read_page", { id }, readPageSchema) as Promise<BrainReadPage>;
  }

  async uploadAttachment(
    input: UploadNotionAssetInput,
  ): Promise<SavedAttachment> {
    if (input.asset.bytes.byteLength > MAX_NOTION_ASSET_BYTES) {
      throw new BrainMcpError("Brain MCP attachment exceeds byte limit");
    }
    if (input.asset.bytes.byteLength <= MAX_MCP_BASE64_ASSET_BYTES) {
      return this.#tool("notion_upload_attachment", {
        notionId: input.notionId,
        sourceHash: input.sourceHash,
        expectedSha256: input.asset.sha256,
        reservationToken: input.reservationToken,
        originalName: input.asset.name,
        mimeType: input.asset.mimeType,
        dataBase64: Buffer.from(input.asset.bytes).toString("base64"),
      }, savedAttachmentSchema);
    }
    const upload = new URL(
      this.#endpoint.pathname.replace(/\/$/, "") + "/notion-upload",
      this.#endpoint.origin,
    );
    const encodedName = Buffer.from(input.asset.name, "utf8").toString("base64");
    if (encodedName.length > 2048) {
      throw new BrainMcpError("Brain MCP attachment filename exceeds byte limit");
    }
    const sensitiveValues = collectSensitiveValues(this.#token, {
      reservationToken: input.reservationToken,
      sourceHash: input.sourceHash,
      expectedSha256: input.asset.sha256,
    });
    const response = await this.#fetch(upload, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
      headers: {
        Authorization: "Bearer " + this.#token,
        "User-Agent": BRAIN_MCP_USER_AGENT,
        Accept: "application/json",
        "Content-Type": input.asset.mimeType,
        "Content-Length": String(input.asset.bytes.byteLength),
        "x-notion-id": input.notionId,
        "x-source-hash": input.sourceHash,
        "x-expected-sha256": input.asset.sha256,
        "x-reservation-token": input.reservationToken,
        "x-file-name-b64": encodedName,
      },
      body: Buffer.from(input.asset.bytes),
    });
    const value = await readResponseValue(response, !response.ok);
    if (!response.ok) throw responseError(response, value, sensitiveValues);
    return parseToolValue(value, sensitiveValues, savedAttachmentSchema);
  }

  async #tool<T>(name: string, args: unknown, schema: z.ZodType<T>): Promise<T> {
    await this.#initialize();
    const id = ++this.#requestId;
    const sensitiveValues = collectSensitiveValues(this.#token, args);
    const response = await this.#rpc({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }, false, id, sensitiveValues);
    const result = callToolResultSchema.safeParse(
      unwrapRpcResult(response, sensitiveValues, id),
    );
    if (!result.success || result.data.isError === true) {
      throw new BrainMcpError("Brain MCP returned an invalid tool result");
    }
    const textPart = result.data.content[0];
    let value: unknown;
    try {
      value = JSON.parse(textPart.text);
    } catch {
      throw new BrainMcpError("Brain MCP returned invalid JSON content");
    }
    return parseToolValue(value, sensitiveValues, schema);
  }

  #initialize(): Promise<void> {
    if (!this.#initializePromise) {
      this.#initializePromise = this.#performInitialize().catch((error) => {
        this.#initializePromise = undefined;
        throw error;
      });
    }
    return this.#initializePromise;
  }

  async #performInitialize(): Promise<void> {
    const id = ++this.#requestId;
    const response = await this.#rpc({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "brain-notion-pilot", version: "1.0.0" },
      },
    }, false, id);
    const initialized = initializeResultSchema.safeParse(
      unwrapRpcResult(response, [this.#token], id),
    );
    if (!initialized.success) {
      throw new BrainMcpError("Brain MCP initialize result is invalid");
    }
    await this.#rpc(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      },
      true,
      undefined,
    );
  }

  async #rpc(
    payload: Record<string, unknown>,
    allowEmpty = false,
    expectedId?: number,
    sensitiveValues: readonly string[] = [this.#token],
  ): Promise<unknown> {
    const headers = new Headers({
      Authorization: "Bearer " + this.#token,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": BRAIN_MCP_USER_AGENT,
    });
    if (this.#sessionId) headers.set("mcp-session-id", this.#sessionId);
    const response = await this.#fetch(this.#endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
      headers,
      body: JSON.stringify(payload),
    });
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId) {
      if (!/^[A-Za-z0-9._~-]{1,256}$/.test(sessionId)) {
        throw new BrainMcpError("Brain MCP returned an invalid session id");
      }
      this.#sessionId = sessionId;
    }
    const value = await readResponseValue(response, !response.ok);
    if (!response.ok) throw responseError(response, value, sensitiveValues);
    if (value === undefined && allowEmpty) return undefined;
    if (value === undefined) {
      throw new BrainMcpError("Brain MCP returned an empty response");
    }
    if (expectedId === undefined) {
      throw new BrainMcpError("Brain MCP notification returned an unexpected body");
    }
    return selectRpcResponse(value, expectedId);
  }
}

function checkedEndpoint(input: string, allowedOriginInput?: string): URL {
  const allowedOrigin = checkedAllowedOrigin(
    allowedOriginInput ?? PRODUCTION_BRAIN_ORIGIN,
  );
  let endpoint: URL;
  try {
    endpoint = new URL(input);
  } catch {
    throw new Error("Brain MCP endpoint is invalid");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.hash ||
    endpoint.search ||
    endpoint.pathname.replace(/\/$/, "") !== "/api/mcp" ||
    endpoint.origin !== allowedOrigin
  ) {
    throw new Error("Brain MCP endpoint must be an exact HTTPS /api/mcp URL");
  }
  endpoint.pathname = "/api/mcp";
  return endpoint;
}

function checkedAllowedOrigin(input: string): string {
  let origin: URL;
  try {
    origin = new URL(input);
  } catch {
    throw new Error("Brain MCP allowed origin is invalid");
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.hostname.includes("*") ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    input !== origin.origin
  ) {
    throw new Error("Brain MCP allowed origin must be an exact HTTPS origin");
  }
  return origin.origin;
}

async function readResponseValue(
  response: Response,
  allowNonJsonError = false,
): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel("MCP response too large");
      throw new BrainMcpError("Brain MCP response exceeded byte limit");
    }
    chunks.push(value);
  }
  if (total === 0) return undefined;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new BrainMcpError("Brain MCP returned invalid UTF-8");
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/event-stream")) {
    try {
      return parseSse(text);
    } catch (error) {
      if (!allowNonJsonError) throw error;
      // Redaction needs the complete bounded response. Truncating first can
      // cut a capability in half and defeat exact-value replacement.
      return { error: text };
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    if (allowNonJsonError) return { error: text };
    throw new BrainMcpError("Brain MCP returned invalid JSON");
  }
}

function parseSse(input: string): SsePayload {
  const values: unknown[] = [];
  for (const event of input.replace(/\r\n?/g, "\n").split("\n\n")) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      values.push(JSON.parse(data));
    } catch {
      throw new BrainMcpError("Brain MCP returned invalid SSE JSON");
    }
  }
  if (values.length === 0) throw new BrainMcpError("Brain MCP returned empty SSE");
  return { kind: "sse", values };
}

function selectRpcResponse(
  value: unknown,
  expectedId: number,
): unknown {
  if (!isSsePayload(value)) {
    parseRpcEnvelope(value, expectedId);
    return value;
  }
  const responses: unknown[] = [];
  for (const candidate of value.values) {
    if (rpcNotificationSchema.safeParse(candidate).success) continue;
    parseRpcEnvelope(candidate, expectedId);
    responses.push(candidate);
  }
  if (responses.length !== 1) {
    throw new BrainMcpError("Brain MCP SSE returned duplicate or missing responses");
  }
  return responses[0];
}

function unwrapRpcResult(
  value: unknown,
  sensitiveValues: readonly string[],
  expectedId: number,
): unknown {
  const envelope = parseRpcEnvelope(value, expectedId);
  if ("error" in envelope) {
    throw new BrainMcpError(
      sanitizeMessage(
        envelope.error.message,
        sensitiveValues,
        "Brain MCP RPC error",
      ),
      String(envelope.error.code),
    );
  }
  return envelope.result;
}

function parseRpcEnvelope(
  value: unknown,
  expectedId: number,
): z.infer<typeof rpcSuccessSchema> | z.infer<typeof rpcErrorSchema> {
  const success = rpcSuccessSchema.safeParse(value);
  const failure = rpcErrorSchema.safeParse(value);
  const envelope = success.success
    ? success.data
    : failure.success
      ? failure.data
      : undefined;
  if (!envelope || envelope.id !== expectedId) {
    throw new BrainMcpError("Brain MCP returned an invalid JSON-RPC envelope or id");
  }
  return envelope;
}

function isSsePayload(value: unknown): value is SsePayload {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { kind?: unknown }).kind === "sse" &&
    Array.isArray((value as { values?: unknown }).values)
  );
}

function parseToolValue<T>(
  value: unknown,
  sensitiveValues: readonly string[],
  schema: z.ZodType<T>,
): T {
  const toolError = toolErrorSchema.safeParse(value);
  if (toolError.success) {
    throw new BrainMcpError(
      sanitizeMessage(
        toolError.data.error,
        sensitiveValues,
        "Brain MCP tool failed",
      ),
      toolError.data.code,
      toolError.data.retryAfterMs,
    );
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new BrainMcpError("Brain MCP tool returned an invalid strict result");
  }
  return parsed.data;
}

function responseError(
  response: Response,
  value: unknown,
  sensitiveValues: readonly string[],
): BrainMcpError {
  const object =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as { error?: unknown; code?: unknown; retryAfterMs?: unknown })
      : {};
  return new BrainMcpError(
    sanitizeMessage(
      object.error,
      sensitiveValues,
      "Brain MCP request failed with status " + response.status,
    ),
    typeof object.code === "string"
      ? object.code
      : response.status === 429
        ? "busy"
        : undefined,
    retryAfterMs(object.retryAfterMs, response.headers.get("retry-after")),
  );
}

function retryAfterMs(value: unknown, header: string | null): number | undefined {
  const bodyDelay =
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.ceil(value)
      : undefined;
  if (!header) return bodyDelay;
  const seconds = Number(header);
  const headerDelay = Number.isFinite(seconds) && seconds >= 0
    ? Math.ceil(seconds * 1_000)
    : Math.max(0, Date.parse(header) - Date.now());
  if (!Number.isFinite(headerDelay)) return bodyDelay;
  return Math.max(bodyDelay ?? 0, Math.min(headerDelay, 60 * 60 * 1_000));
}

function sanitizeMessage(
  value: unknown,
  sensitiveValues: readonly string[],
  fallback: string,
): string {
  if (typeof value !== "string") return fallback;
  let sanitized = value;
  for (const secret of [...new Set(sensitiveValues)].sort(
    (left, right) => right.length - left.length,
  )) {
    if (secret) sanitized = sanitized.replaceAll(secret, "[redacted]");
  }
  sanitized = sanitized
    .replace(/\b[a-f0-9]{64}\b/gi, "[redacted-sha256]")
    .replace(/https?:\/\/[^\s\"']+/gi, "[redacted-url]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .slice(0, 300);
  return sanitized || fallback;
}

function collectSensitiveValues(
  bearerToken: string,
  input: unknown,
): string[] {
  const values = new Set<string>([bearerToken]);
  collectSensitiveInputValues(input, values, new WeakSet<object>());
  return [...values];
}

function collectSensitiveInputValues(
  value: unknown,
  values: Set<string>,
  seen: WeakSet<object>,
): void {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) collectSensitiveInputValues(child, values, seen);
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      typeof child === "string" &&
      new Set([
        "reservationtoken",
        "sourcehash",
        "conversionhash",
        "expectedsha256",
        "sha256",
        "database64",
      ]).has(normalizedKey)
    ) {
      values.add(child);
    }
    collectSensitiveInputValues(child, values, seen);
  }
}
