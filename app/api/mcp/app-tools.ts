import type { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  getStore,
  isAppSize,
  isAttachmentValidation,
  isNotFound,
  isRevConflict,
  type AppAssetInput,
} from "@/lib/store";
import { appMetaSchema, APP_MAX_OWNED } from "@/lib/apps/model";
import { lintAppEntry, type AppLintRule } from "@/lib/apps/lint";
import { appendMcpActivity } from "@/lib/mcp/activity-log";
import {
  clientNameOf,
  hasScope,
  hints,
  insufficientScope,
  refusal,
  STORE_FAILED,
  storeFailed,
  text,
} from "./tool-kit";

/** THE THREE APP TOOLS: ONE BUILD, ONE REBUILD, ONE READ.
 *
 *  An app page is a page whose body the owner reads and whose `app/` folder
 *  the shell runs in a sandboxed frame. Nothing here knows how that frame is
 *  served: it hands the store an entry, its assets and its children, and the
 *  store is the one writer of all of them, exactly as the page tools do.
 *
 *  THE LINT RUNS BEFORE THE STORE IS TOUCHED, always. Two of its three rules
 *  are about a theme the owner will see go wrong, and the third is about a
 *  resource the frame's policy blocks with nothing in any console the owner
 *  will ever open. A refused entry therefore costs a round trip and leaves no
 *  page, no children and no files behind.
 */

type McpToolServer = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

type ToolExtra = { authInfo?: { scopes: string[]; clientId?: string } };

/** The last-resort rule, verbatim from spec §8. It is in the description
 *  rather than in a doc the agent may not read, because the description is
 *  the one text every client puts in front of the model before it decides.
 *  `docs/apps.md` says the same thing at length. */
const CREATE_DESCRIPTION =
  "Build a page whose body is an HTML application the owner runs inside Brain. " +
  "An app is the last resort, not a shortcut: build an app only when the owner asked for one, " +
  "or when what they asked for cannot be done with the notebook's own means " +
  "(a page, a table, a checklist, tasks, mail, a collection view), and say so before building. " +
  "Do not build an app to work around a missing Brain feature without naming the gap; " +
  "the right move then is a page plus a note to the owner. " +
  "reason is required and is the owner's own request in one line, kept on the page so they can see why an app appeared. " +
  "Read docs/apps.md before the first one.";

/** What each lint rule means, in the sentence an agent reads. The rule token
 *  travels beside it as `rule`, so a client branches on the token and a model
 *  reads the sentence, and neither has to parse the other. */
const LINT_SENTENCE: Readonly<Record<AppLintRule, string>> = {
  color_scheme: "it declares no colour scheme, so it will not follow the dark theme",
  hard_coded_colour:
    "it writes a colour instead of reading a token, so it will not follow the theme",
  external_resource: "it loads something from another site, which the app frame blocks",
};

/** The bound `app.reason` itself carries (`appMetaSchema`), applied here so a
 *  reason that is only whitespace is refused with a sentence rather than
 *  stored as an empty line the owner reads as a blank field. */
const MAX_REASON = 280;

/** A tool's answer and the one word the activity line records beside it. An
 *  outcome is a code a person scanning Connections can group on, never the
 *  sentence the answer carries. */
interface AppAnswer {
  answer: ReturnType<typeof text> & { isError?: boolean };
  outcome: string;
}

const ok = (data: unknown): AppAnswer => ({ answer: text(data), outcome: "ok" });

const no = (outcome: string, error: string, reason: string): AppAnswer => ({
  answer: refusal(error, reason),
  outcome,
});

/** The lint's refusal, with the rule and the line beside the two fields every
 *  refusal on this endpoint carries. The same shape `rev_conflict` uses for
 *  `currentRev`: what the caller needs to fix it rides alongside rather than
 *  inside the sentence, where it would have to be parsed back out. */
function lintRefused(rule: AppLintRule, line: number): AppAnswer {
  return {
    answer: {
      ...text({
        error: `that entry cannot be served: ${LINT_SENTENCE[rule]}`,
        reason: "lint_failed",
        rule,
        line,
      }),
      isError: true as const,
    },
    outcome: "lint_failed",
  };
}

/** The store's app errors as answers an agent can act on, and anything else
 *  as the one code the notes folder failing answers under. The tail never
 *  rethrows: a throw escapes the wrapper below, which skips the activity line
 *  as well as the shape, and the store's message names the absolute path of
 *  the notes folder. */
function appRefusal(error: unknown): AppAnswer {
  if (isAppSize(error)) {
    return no(
      "too_large",
      `that app's ${error.what} is over the size Brain keeps for one`,
      "too_large",
    );
  }
  if (isAttachmentValidation(error)) {
    return no(error.code, "that asset is not a file an app may hold", error.code);
  }
  if (isRevConflict(error)) {
    return {
      answer: {
        ...text({
          error: "that page changed since you read it",
          reason: "rev_conflict",
          currentRev: error.currentRev,
        }),
        isError: true as const,
      },
      outcome: "rev_conflict",
    };
  }
  if (isNotFound(error)) {
    return no("not_found", "there is no app page with that id", "not_found");
  }
  return { answer: storeFailed("that app could not be saved"), outcome: STORE_FAILED };
}

/** What one write marks on its activity line. `label` is the page's own title
 *  read back out of the store for the bell's row, passed BESIDE the entry:
 *  the line's shape is the redaction and a title has no field to enter it
 *  through. `reason` never appears here at all, in either place. It is the
 *  owner's own sentence and it lives on the page, where they read it under
 *  "Built by Claude". */
interface AppMarks {
  page?: string;
  change?: string;
  label?: string;
}

async function appWrite(
  extra: ToolExtra,
  tool: string,
  work: (marks: AppMarks) => Promise<AppAnswer>,
) {
  const marks: AppMarks = {};
  let result: AppAnswer;
  try {
    result = await work(marks);
  } catch (error) {
    result = appRefusal(error);
  }
  await logAppWrite(extra, tool, marks, result.outcome);
  return result.answer;
}

async function logAppWrite(
  extra: ToolExtra,
  tool: string,
  marks: AppMarks,
  outcome: string,
): Promise<void> {
  // The grant's name is a nicety and the line is the record, so a state store
  // that cannot be read costs the name rather than the line.
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
  } catch {
    // The write already landed. A line that cannot be appended must not turn
    // a successful build into a failure the agent retries.
  }
}

/** The one line of the owner's own request, or null for a caller that sent
 *  none. Collapsed and cut the way `appMetaSchema` will store it, so what the
 *  tool accepts and what the page keeps are the same string. */
function oneLineReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/\s+/g, " ").trim();
  return line.length === 0 ? null : line.slice(0, MAX_REASON);
}

/** An asset as an agent can send one over JSON. The MIME type is NOT taken
 *  from the caller: `appAssetMimeType` derives it from the name, and the
 *  store refuses a name it cannot derive one for, so a declared type would be
 *  a field nothing reads and a caller could believe in. */
const assetSchema = z.object({
  name: z.string().describe("relative name under the app's assets folder, e.g. cards/front.png"),
  base64: z.string(),
});

/** BASE64, STRICTLY, BECAUSE `Buffer` WILL NOT SAY NO.
 *
 *  `Buffer.from(value, "base64")` never throws. It skips what it cannot read
 *  and answers whatever is left, so `data:image/png;base64,iVBORw0K` comes
 *  back as twenty bytes of noise, gets written into the notes folder under
 *  the name of a PNG, and the agent is told the build worked. Passing a data
 *  URL is the likeliest mistake of all, because the frame's own policy makes
 *  a data URL the right answer everywhere else.
 *
 *  So: the alphabet, the padding, and then the round trip. The round trip is
 *  what catches the rest, url-safe base64 and a final quantum whose spare
 *  bits are not zero included, both of which decode to bytes that are not the
 *  bytes the caller meant. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decodeBase64(value: string): Uint8Array | null {
  if (value.length === 0) return new Uint8Array();
  if (value.length % 4 !== 0) return null;
  if (!BASE64.test(value)) return null;
  const buffer = Buffer.from(value, "base64");
  if (buffer.toString("base64") !== value) return null;
  return new Uint8Array(buffer);
}

type DecodedAssets =
  | { readonly ok: true; readonly assets: AppAssetInput[] | undefined }
  | { readonly ok: false; readonly name: string };

function decodeAssets(
  assets: readonly { name: string; base64: string }[] | undefined,
): DecodedAssets {
  if (assets === undefined) return { ok: true, assets: undefined };
  const decoded: AppAssetInput[] = [];
  for (const asset of assets) {
    const data = decodeBase64(asset.base64);
    if (data === null) return { ok: false, name: asset.name };
    decoded.push({ name: asset.name, data });
  }
  return { ok: true, assets: decoded };
}

function badBase64(name: string): AppAnswer {
  return no(
    "bad_request",
    `that asset is not base64: ${name}. Send the padded bytes on their own, with no data: prefix, no whitespace and no url-safe characters`,
    "bad_request",
  );
}

const ownedSchema = z.object({
  title: z.string(),
  icon: z.string().optional(),
  markdown: z.string().optional(),
});

export function registerAppTools(server: McpToolServer): void {
  server.registerTool(
    "create_app_page",
    {
      title: "Build an app page",
      description: CREATE_DESCRIPTION,
      inputSchema: {
        parentId: z.string().nullable().optional().describe("the page it sits under, or null for a root page"),
        title: z.string(),
        icon: z.string().optional(),
        description: z
          .string()
          .describe("the page body the owner reads: what the app does and how to use it"),
        entryHtml: z
          .string()
          .describe(
            'one self-contained HTML file. Ask for the design system with <link rel="brain-kit">, read colours as var(--token), and load nothing from another site',
          ),
        assets: z.array(assetSchema).optional(),
        owns: z
          .array(ownedSchema)
          .max(APP_MAX_OWNED)
          .optional()
          .describe("child pages the app is allowed to write, created with it"),
        state: z.unknown().optional().describe("the app's first memory, as JSON"),
        reason: z.string().describe("the owner's own request, in one line"),
      },
      annotations: hints("write keeps repeats local"),
    },
    async (
      {
        parentId,
        title,
        icon,
        description,
        entryHtml,
        assets,
        owns,
        state,
        reason,
      }: {
        parentId?: string | null;
        title: string;
        icon?: string;
        description: string;
        entryHtml: string;
        assets?: { name: string; base64: string }[];
        owns?: { title: string; icon?: string; markdown?: string }[];
        state?: unknown;
        reason?: string;
      },
      extra: ToolExtra,
    ) =>
      appWrite(extra, "create_app_page", async (marks) => {
        if (!hasScope(extra, "brain:write")) {
          return {
            answer: insufficientScope("brain:write"),
            outcome: "insufficient_scope",
          };
        }
        const line = oneLineReason(reason);
        if (line === null) {
          return no(
            "bad_request",
            "reason is required: one line saying what the owner asked for, which is kept on the page",
            "bad_request",
          );
        }
        const finding = lintAppEntry(entryHtml);
        if (finding !== null) return lintRefused(finding.rule, finding.line);
        const decoded = decodeAssets(assets);
        if (!decoded.ok) return badBase64(decoded.name);

        const store = await getStore();
        const { meta, owned } = await store.createAppPage(parentId ?? null, title, {
          icon,
          description,
          entryHtml,
          assets: decoded.assets,
          owns,
          ...(state === undefined ? {} : { state }),
          builtBy: await clientNameOf(extra),
          reason: line,
          src: "mcp",
        });
        marks.page = meta.id;
        marks.change = "create_app";
        marks.label = meta.title;
        return ok({
          id: meta.id,
          title: meta.title,
          app: meta.app,
          owns: owned.map((child) => ({ id: child.id, title: child.title })),
        });
      }),
  );

  server.registerTool(
    "write_app_page",
    {
      title: "Rebuild an app page",
      description:
        "Replace an app page's entry and assets, keeping the children it owns and the state it has kept. " +
        "Pass the rev from read_app_page. The version it replaces is kept: every file set is committed to the notes folder's own git history. " +
        "Leave entryHtml out to keep the entry and change only the assets, and leave assets out to keep the ones already there. " +
        "Use write_page to change the description the owner reads.",
      inputSchema: {
        id: z.string(),
        entryHtml: z.string().optional(),
        assets: z
          .array(assetSchema)
          .optional()
          .describe("replaces the whole assets folder; an empty array clears it"),
        rev: z.string().describe("rev from read_app_page"),
      },
      annotations: hints("write keeps idempotent local"),
    },
    async (
      {
        id,
        entryHtml,
        assets,
        rev,
      }: { id: string; entryHtml?: string; assets?: { name: string; base64: string }[]; rev: string },
      extra: ToolExtra,
    ) =>
      appWrite(extra, "write_app_page", async (marks) => {
        if (!hasScope(extra, "brain:write")) {
          return {
            answer: insufficientScope("brain:write"),
            outcome: "insufficient_scope",
          };
        }
        marks.page = id;
        marks.change = "write_app";
        if (entryHtml !== undefined) {
          const finding = lintAppEntry(entryHtml);
          if (finding !== null) return lintRefused(finding.rule, finding.line);
        }
        const decoded = decodeAssets(assets);
        if (!decoded.ok) return badBase64(decoded.name);

        const store = await getStore();
        // A page that is not an app reads as missing rather than as a page
        // this tool refused: an agent that asked the wrong id needs to go and
        // find the right one, and "not an app" would invite it to try again.
        const app = store.readAppMeta(id);
        if (app === null) {
          return no("not_found", "there is no app page with that id", "not_found");
        }
        const live = await store.readPage(id);
        if (live.rev !== rev) {
          return {
            answer: {
              ...text({
                error: "that page changed since you read it",
                reason: "rev_conflict",
                currentRev: live.rev,
              }),
              isError: true as const,
            },
            outcome: "rev_conflict",
          };
        }

        await store.writeAppFiles(id, {
          ...(entryHtml === undefined ? {} : { entryHtml }),
          ...(decoded.assets === undefined ? {} : { assets: decoded.assets }),
        });
        // `owns` and `state` come off the LIVE map inside the store's own
        // lock, never off `app`, which was read before the file rewrite above
        // copied the whole set and committed it. The frame runs throughout
        // that: a `create.page` in the window appends to `owns` and a first
        // `state.set` flips `state`, and spreading the pre-write snapshot
        // back would drop both, leaving a page the app made and can no longer
        // write. Neither is ever taken from the caller either, so an agent
        // cannot widen what the frame may write by sending a list.
        const builtBy = await clientNameOf(extra);
        const builtAt = new Date().toISOString();
        const meta = await store.setAppMeta(
          id,
          (current) =>
            appMetaSchema.parse({
              ...current,
              version: current.version + 1,
              builtBy,
              builtAt,
            }),
          "claude",
        );
        marks.label = meta.title;
        return ok({ id: meta.id, title: meta.title, app: meta.app });
      }),
  );

  server.registerTool(
    "read_app_page",
    {
      title: "Read an app page",
      description:
        "Read an app page's entry, its asset names and its app metadata, for an agent about to rebuild it. " +
        "The assets come back as names, not as bytes. Pass the rev it answers to write_app_page.",
      inputSchema: { id: z.string() },
      annotations: hints("read keeps idempotent local"),
    },
    async ({ id }: { id: string }) => {
      try {
        const store = await getStore();
        const app = store.readAppMeta(id);
        if (app === null) {
          return refusal("there is no app page with that id", "not_found");
        }
        const entry = await store.readAppFile(id, app.entry);
        const [assets, live] = await Promise.all([
          store.listAppAssets(id),
          store.readPage(id),
        ]);
        return text({
          id,
          title: live.meta.title,
          rev: live.rev,
          app,
          // An app whose files are gone is a real state the canvas already
          // draws ("App files are missing"), so it reads as an empty entry
          // rather than as a refusal: the agent's next move is a rebuild
          // either way, and it needs the rev and the owns list to make one.
          entryHtml:
            entry.kind === "file" ? new TextDecoder().decode(entry.data) : "",
          assets,
        });
      } catch (error) {
        if (isNotFound(error)) {
          return refusal("there is no app page with that id", "not_found");
        }
        return storeFailed();
      }
    },
  );
}
