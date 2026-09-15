import type { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  canonicalAttachmentExtension,
  isExecutableAttachmentExtension,
  normalizeAttachmentDisplayName,
} from "@/lib/attachments";
import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import { MAIL_RESOURCE_LIMITS } from "@/lib/mail/security";
import {
  getStore,
  isAttachmentValidation,
  isNotFound,
  MAX_ATTACHMENT_BYTES,
  type SavedAttachment,
} from "@/lib/store";
import { logMailActivity, mailOutcome, mailRefusal } from "./mail-tool-kit";
import { hasScope, insufficientScope, refusal, text } from "./tool-kit";

/** ONE INCOMING ATTACHMENT, INTO A NOTE'S OWN FILES.
 *
 *  The bytes come off the mail service's Unix socket and go into the notes
 *  folder through `lib/store`, which is the only thing here that touches the
 *  filesystem: this module holds a buffer and a Markdown line, never a path.
 *
 *  Two owners hold a cap and the smaller one wins. The service refuses to
 *  hand out more than `rawMessageBytes` on the way out of a mailbox, and the
 *  note store refuses more than `MAX_ATTACHMENT_BYTES` on the way in. The
 *  drain below stops at that number, so a file over the cap is abandoned
 *  part-way rather than held whole in memory and then turned down.
 *
 *  The tool answers under `brain:mail`, which is the scope the route's gate
 *  checks off the tool name, and asks for `brain:write` as well, because a
 *  file in the notes folder and a line on a page are a note write whoever
 *  asked for them. A grant that may read mail and not edit notes is refused
 *  here, before the mail client is built.
 */

type McpToolServer = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

const TOOL = "save_mail_attachment";

/** The client's own shapes (`lib/mail/message-codec.ts`), repeated here so a
 *  malformed id is refused by Brain, naming the field, and so nothing
 *  unbounded reaches an activity line. */
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_MAIL_RESOURCE_ID = /^[A-Za-z0-9_-]{1,255}$/;

/** A page id is a nanoid, or the id an import carried. There is no single
 *  alphabet to check it against, so the bound is a length and the absence of
 *  control characters: enough to keep a log line small and a refusal honest,
 *  without guessing at ids the store already knows how to look up. */
const SAFE_PAGE_ID = /^[^\p{Cc}]{1,128}$/u;

/** The note store's cap against the service's, in bytes and in the words the
 *  refusal uses, derived from the same constant so the two cannot drift. */
const SAVE_CAP_BYTES = Math.min(
  MAX_ATTACHMENT_BYTES,
  MAIL_RESOURCE_LIMITS.rawMessageBytes,
);
const SAVE_CAP_REASON = `${Math.floor(SAVE_CAP_BYTES / (1024 * 1024))} MiB is the limit`;
const TOO_LARGE = "that file is too large for a note";

/** The sentence names the field and the reason names the code, the way the
 *  read, triage and send tools name theirs. The shape each id wants is in the
 *  tool's own description and in `docs/mcp-tools.md`: a refusal is where an
 *  agent branches, not where it learns a regular expression. */
function invalidId(label: string, code: string) {
  return refusal(`that ${label} is not valid`, code);
}

/** Drain into memory, but never past the cap: a file over it is abandoned
 *  mid-stream, so an agent naming a 40 MiB attachment cannot make this
 *  process hold 40 MiB to be told the note store wants 25. `null` means the
 *  stream ran past the limit. */
async function drainBounded(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Uint8Array | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) return null;
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

/** A name is display metadata and a link label, so it is bounded here as
 *  well. The header it comes out of is already bounded: the client refuses
 *  any `Content-Disposition` that is not exactly
 *  `attachment; filename="..."; filename*=UTF-8''...`, with no control
 *  characters and at most 180 bytes, in `isSafeContentDisposition`
 *  (`lib/mail/brain-mail-client.ts`). This cap is this module's own, so a
 *  change to that guard cannot quietly put an unbounded string in a note. */
const MAX_FILENAME_BYTES = 255;

function boundedName(name: string): string {
  if (Buffer.byteLength(name) <= MAX_FILENAME_BYTES) return name;
  // One whole character at a time, so a cut never splits a letter into bytes
  // that are not one, and never leaves half of a surrogate pair behind.
  const characters = Array.from(name);
  while (
    characters.length > 0 &&
    Buffer.byteLength(characters.join("")) > MAX_FILENAME_BYTES
  ) {
    characters.pop();
  }
  return characters.join("");
}

/** The name the message gave the file. The extended form comes first because
 *  the download path emits both and only the extended one carries a name
 *  outside ASCII, which is why the quoted branch is a fallback the real
 *  client never reaches rather than a rule anything depends on. With neither,
 *  the name is the word `attachment`; the store re-reads it anyway, mints its
 *  own `<id>.<ext>` and keeps this as display metadata. */
function filenameOf(disposition: string): string {
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (extended) {
    try {
      const decoded = decodeURIComponent(extended[1]).trim();
      if (decoded) return boundedName(decoded);
    } catch {
      // A percent escape the sender mangled. The quoted form is the fallback.
    }
  }
  const quoted = /filename="([^"]*)"/i.exec(disposition);
  if (quoted && quoted[1].trim()) return boundedName(quoted[1].trim());
  return "attachment";
}

/** The type without its parameters, lowercased. The service already answers a
 *  bare type, and the store refuses anything that is not one, so this is the
 *  narrow place to take a `; charset=` off rather than turn it into a refusal
 *  about a file that is fine. */
function mimeTypeOf(contentType: string): string {
  return contentType.split(";")[0].trim().toLowerCase();
}

/** A picture is shown and a document is linked, which is what a person would
 *  have done by hand. The label is escaped because the filename came off a
 *  message somebody else wrote: an unescaped `](` in it closes the link early
 *  and writes the sender's own link into the note. The URL is Brain's own,
 *  minted by the store, so it carries nothing that needs escaping. */
function attachmentLine(saved: SavedAttachment): string {
  const label = saved.name.replace(/[\\[\]]/g, (character) => `\\${character}`);
  const link = `[${label}](${saved.url})`;
  return saved.type.startsWith("image/") ? `!${link}` : link;
}

export function registerMailAttachmentTools(server: McpToolServer): void {
  server.tool(
    TOOL,
    `Save one attachment from a message into a note's own files. The bytes stream from the mail service into the notes folder, where the note store checks them: ${SAVE_CAP_REASON}, no active file type, no executable whatever type the message claims, and bytes that do not match the type they claim are turned down with the store's own reason. With append true, the default, the page is read first and one Markdown line is added to it, an image shown and anything else linked. With append false nothing is written to the page, and a file no page links is swept a day later, so link it yourself.`,
    {
      accountId: z.string(),
      attachmentId: z
        .string()
        .describe("from the attachment list on a message"),
      page: z.string().describe("the page the file is saved into"),
      append: z
        .boolean()
        .optional()
        .describe("add a line linking the file, true by default"),
    },
    async ({ accountId, attachmentId, page, append }, extra) => {
      // The ids first, and a malformed one writes no line: an id Brain never
      // issued names no target, nothing has happened yet, and an unbounded
      // string must not reach a log that counts lines.
      if (!SAFE_ACCOUNT_ID.test(accountId)) {
        return invalidId("account id", "invalid_account_id");
      }
      if (!SAFE_MAIL_RESOURCE_ID.test(attachmentId)) {
        return invalidId("attachment id", "invalid_attachment_id");
      }
      if (!SAFE_PAGE_ID.test(page)) {
        return invalidId("page id", "invalid_page_id");
      }

      // One line per call that got as far as the work, refusals included,
      // because the owner reading the log wants the attempt as much as the
      // save. It names the account, the attachment and the page, and never
      // the filename: that is the sender's own prose.
      const log = (outcome: string) =>
        logMailActivity(
          extra,
          TOOL,
          { accountId, attachmentId, page },
          outcome,
        ).catch(() => undefined);

      // The route's gate already refused a grant without `brain:mail`. This
      // second lock is what stops a mail reader writing a note.
      if (!hasScope(extra, "brain:mail")) {
        await log("insufficient_scope");
        return insufficientScope("brain:mail");
      }
      if (!hasScope(extra, "brain:write")) {
        await log("insufficient_scope");
        return insufficientScope("brain:write");
      }

      const store = await getStore();
      // The page before the bytes. A mistyped page id is the common case, it
      // costs one `index.md` read to answer, and answering it after the
      // download means a whole file over the socket and an orphan in the
      // notes folder for the sweep to collect a day later. The append below
      // keeps its own not-found branch for the page deleted in between.
      // With `append: false` there is no line to write, so the page is not
      // this call's business and is not read at all.
      if (append !== false) {
        try {
          await store.readPage(page);
        } catch (error) {
          if (isNotFound(error)) {
            await log("page_not_found");
            return refusal("page not found", page);
          }
          // A store failure is the store's, answered in Brain's own words:
          // the thrown message is a Node `fs` error and carries the absolute
          // path of the notes folder, which this module holds no part of. It
          // is a refusal like any other, so it writes its line as well; a
          // rethrow reached the agent as a transport error with nothing in
          // the owner's log to say a call had happened at all.
          await log("page_read_failed");
          return refusal("that page could not be read", "page_read_failed");
        }
      }

      let data: Uint8Array;
      let originalName: string;
      let mimeType: string;
      try {
        const payload = await createBrainMailClient().downloadAttachment(
          accountId,
          attachmentId,
        );
        // The declared size is the cheapest bound there is, so spend nothing
        // on a file that says up front it is too big. A declaration that lies
        // low is caught by the drain.
        if (payload.bytes > SAVE_CAP_BYTES) {
          await payload.body.cancel().catch(() => undefined);
          await log("too_large");
          return refusal(TOO_LARGE, SAVE_CAP_REASON);
        }
        const drained = await drainBounded(payload.body, SAVE_CAP_BYTES);
        if (drained === null) {
          await log("too_large");
          return refusal(TOO_LARGE, SAVE_CAP_REASON);
        }
        data = drained;
        originalName = filenameOf(payload.contentDisposition);
        mimeType = mimeTypeOf(payload.contentType);
      } catch (error) {
        await log(mailOutcome(error));
        return mailRefusal(error);
      }

      // The name the file would land under, which is the store's own
      // decision: the canonical extension for the type, or the sender's when
      // the type has none. An executable is refused on that extension alone,
      // whatever the message called the type.
      const extension = canonicalAttachmentExtension(
        normalizeAttachmentDisplayName(originalName),
        mimeType,
      );
      if (isExecutableAttachmentExtension(extension)) {
        await log("blocked_extension");
        return refusal(
          "that file cannot be saved into a note",
          `a message may not hand an agent a ${extension}`,
        );
      }

      let saved: SavedAttachment;
      try {
        saved = await store.saveAttachment(
          { data, originalName, mimeType },
          "claude",
        );
      } catch (error) {
        // The note store owns the type rules and the cap, and it says why in
        // its own words. Repeating them here would mean two places to change
        // when a type is added to the blocklist.
        if (isAttachmentValidation(error)) {
          await log(error.code);
          return refusal(error.message, error.code);
        }
        throw error;
      }

      if (append === false) {
        await log("ok");
        return text(saved);
      }

      // A second `mutate()`, deliberately: `mutate` is not reentrant, and a
      // crash between the two leaves an unreferenced file the attachment
      // sweep collects a day later.
      try {
        await store.appendPage(page, attachmentLine(saved), "claude");
      } catch (error) {
        if (isNotFound(error)) {
          await log("not_found");
          return refusal(
            "page not found",
            `the file is saved at ${saved.url} and no line was added`,
          );
        }
        throw error;
      }
      await log("ok");
      return text(saved);
    },
  );
}
