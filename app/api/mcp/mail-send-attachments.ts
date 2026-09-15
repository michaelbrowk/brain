import { z } from "zod";
import { referencedAttachmentNames } from "@/lib/attachments";
import { MAIL_RESOURCE_LIMITS } from "@/lib/mail/security";
import {
  isSafeAttachmentFilename,
  isSafeAttachmentMimeType,
  MAIL_SEND_ATTACHMENT_LIMITS,
  type MailSendAttachment,
} from "@/lib/mail/send-attachment-codec";
import type { McpActivityEntry } from "@/lib/mcp/activity-log";
import {
  getStore,
  isNotFound,
  type ReadAttachmentResult,
} from "@/lib/store";
import { refusal, STORE_FAILED } from "./tool-kit";

/** A PAGE'S OWN FILES ONTO A MESSAGE, AND NOTHING ELSE.
 *
 *  An agent names a file the way the note it is looking at names it: a page
 *  id and the file's own name in that page's Markdown. Never a path. The
 *  bytes are read through `lib/store`, which is the only module that touches
 *  the notes filesystem, and they reach the mail service as base64 inside the
 *  send input Task 4 defined.
 *
 *  The rule that makes this safe is that the page's body is the authority.
 *  An agent may send what the note it named already shows, which is what a
 *  person could forward by opening that note. A name the body does not hold
 *  is refused even when the file exists, because otherwise any page id the
 *  agent can read becomes a key to every file in the notes folder.
 *
 *  `referencedAttachmentNames` is a pure function over Markdown from
 *  `lib/attachments`, the same one the media route authorizes a shared page
 *  with. Calling it here reads no file and breaches nothing.
 */

export interface OutgoingAttachmentRef {
  readonly page: string;
  readonly name: string;
}

/** The store mints an attachment's name itself: twelve characters for an
 *  upload, a sha256 for an imported file, and in both cases the extension it
 *  chose from the type the file was accepted under. This is the media route's
 *  own pattern with the extension made mandatory, because every name the
 *  store has ever minted has one. A path, a URL or a traversal fails it, and
 *  so it never reaches the store. */
const ATTACHMENT_NAME_RE = /^[A-Za-z0-9_-]{6,}\.[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/** The one outgoing number, from the codec both sides share, said in the
 *  unit an owner reads a refusal in. */
const TOTAL_CAP_MIB = MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes / (1024 * 1024);
const RELAY_CAP_MIB =
  MAIL_RESOURCE_LIMITS.egressTunnelAttachmentBytes / (1024 * 1024);

/** What this account may carry in files.
 *
 *  A Gmail account hands its message to a provider API and carries the whole
 *  outgoing cap. An IMAP account's SMTP session leaves through the Cloudflare
 *  relay, whose tunnel holds `egressTunnelClientBytes` of finished message,
 *  and `egressTunnelAttachmentBytes` is what that ceiling leaves for files.
 *  Without this the difference is learned as a relay failure, after the bytes
 *  are read, the MIME is built and the message is in the outbox, and the
 *  answer names neither the account nor a size. */
export function attachmentBudgetOf(providerKind: "gmail" | "imap"): number {
  return providerKind === "imap"
    ? MAIL_RESOURCE_LIMITS.egressTunnelAttachmentBytes
    : MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes;
}

export const attachmentRefSchema = z
  .object({
    page: z
      .string()
      .describe("The page whose Markdown already shows this file."),
    name: z
      .string()
      .describe(
        "The file's own name as that page's Markdown names it, the part after /_attachments-v2/. Not a path.",
      ),
  })
  .strict();

type AttachmentRefusal = {
  readonly refused: ReturnType<typeof refusal>;
  readonly outcome: string;
};

export type ResolvedAttachments =
  | AttachmentRefusal
  | { readonly attachments: readonly MailSendAttachment[] };

function refuse(
  error: string,
  reason: string,
  outcome: string,
): AttachmentRefusal {
  return { refused: refusal(error, reason), outcome };
}

/** The checks that cost nothing, so they run beside the other pre-flight
 *  refusals and before the mail client is built. A name that is not a name is
 *  the agent's own mistake and needs neither the notes folder nor a round
 *  trip to answer. */
export function admitAttachmentRefs(
  refs: readonly OutgoingAttachmentRef[],
): AttachmentRefusal | null {
  if (refs.length > MAIL_SEND_ATTACHMENT_LIMITS.maxCount) {
    return refuse(
      "too many attachments",
      `${MAIL_SEND_ATTACHMENT_LIMITS.maxCount} files is the limit for one message`,
      "too_many_attachments",
    );
  }
  for (const ref of refs) {
    // `isSafeAttachmentFilename` is the codec's own rule, the one the MIME
    // writer relies on. The pattern above is narrower; checking both is what
    // keeps one list deciding what may reach a header.
    if (!ATTACHMENT_NAME_RE.test(ref.name) || !isSafeAttachmentFilename(ref.name)) {
      return refuse(
        "that is not an attachment name",
        ref.name.slice(0, 80),
        "invalid_attachment_name",
      );
    }
  }
  return null;
}

/** The files themselves, once the account is admitted and before anything is
 *  put on the wire. Two passes: every file is read against what is left of
 *  the message's budget, and only a set that fits whole is encoded. So a set
 *  over the cap costs no base64 at all, and a file above the budget is turned
 *  down off its size without being read. */
export async function resolveOutgoingAttachments(
  refs: readonly OutgoingAttachmentRef[],
  budget: number = MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes,
): Promise<ResolvedAttachments> {
  if (refs.length === 0) return { attachments: [] };
  let store: Awaited<ReturnType<typeof getStore>>;
  try {
    store = await getStore();
  } catch {
    // Same failure as the page and attachment reads below: a Node `fs` error
    // naming the notes folder's absolute path. Left unguarded, the send
    // tool's own catch folds this into `mail_service_unavailable`, naming a
    // subsystem that was never asked for anything.
    return refuse(
      "the notes folder could not answer",
      STORE_FAILED,
      STORE_FAILED,
    );
  }
  const shownBy = new Map<string, Set<string>>();
  const files: { name: string; mimeType: string; data: Uint8Array }[] = [];
  let remaining = budget;

  for (const ref of refs) {
    let shown = shownBy.get(ref.page);
    if (!shown) {
      try {
        const page = await store.readPage(ref.page);
        shown = referencedAttachmentNames(page.markdown);
      } catch (error) {
        if (isNotFound(error)) {
          return refuse("page not found", ref.page, "page_not_found");
        }
        // The notes folder failed, and the mail service has not been asked
        // for anything. Letting this throw put it in the send tool's own
        // catch, which answers `mail_service_unavailable` and writes that
        // code into the owner's log, naming a subsystem that was never
        // involved.
        return refuse(
          "that page could not be read",
          "page_read_failed",
          "page_read_failed",
        );
      }
      shownBy.set(ref.page, shown);
    }
    if (!shown.has(ref.name)) {
      return refuse(
        "that page does not hold that file",
        `${ref.page} has no ${ref.name}`,
        "attachment_not_on_page",
      );
    }
    let read: ReadAttachmentResult;
    try {
      read = await store.readAttachment(ref.name, remaining);
    } catch {
      // The store throws when a file changed between its size being measured
      // and its bytes being read, which a person editing a note while an
      // agent sends it can cause. Same reasoning as above: the notes folder
      // is what failed, so that is what the answer and the line say.
      return refuse(
        "that file could not be read from the notes folder",
        "attachment_read_failed",
        "attachment_read_failed",
      );
    }
    if (read.kind === "missing") {
      return refuse("that file is gone", ref.name, "attachment_missing");
    }
    if (read.kind === "too_large") {
      // Which ceiling was hit is the whole point of the answer: a message the
      // outgoing cap would have carried, refused because this account sends
      // through the relay, has to say so and name both figures, or the agent
      // reads a 5 MiB limit in the tool reference and cannot tell why 2 MiB
      // of files was turned down.
      return budget < MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes
        ? refuse(
            "those attachments are too large for this account",
            `${RELAY_CAP_MIB} MiB is the limit for one message from an IMAP account, whose relay carries ${MAIL_RESOURCE_LIMITS.egressTunnelClientBytes / (1024 * 1024)} MiB of finished message, against ${TOTAL_CAP_MIB} MiB from a Gmail account`,
            "attachments_too_large_for_account",
          )
        : refuse(
            "those attachments are too large",
            `${TOTAL_CAP_MIB} MiB is the limit for one message`,
            "attachments_too_large",
          );
    }
    if (!isSafeAttachmentMimeType(read.mimeType)) {
      return refuse(
        "that file cannot be sent",
        "its type is not one a message can carry",
        "attachment_type_blocked",
      );
    }
    remaining -= read.data.byteLength;
    files.push(read);
  }

  return {
    attachments: files.map((file) => ({
      filename: file.name,
      mimeType: file.mimeType,
      dataBase64: Buffer.from(file.data).toString("base64"),
    })),
  };
}

/** What the activity line says about the files. The count always, and the
 *  names once they have passed the shape check, because the store minted
 *  those names itself: they say which file left the notes folder without
 *  carrying a title, a filename a person chose or a word anybody wrote. The
 *  log bounds both fields again on its own. */
export function attachmentActivityFields(
  refs: readonly OutgoingAttachmentRef[],
  options: { named: boolean },
): Pick<McpActivityEntry, "attachmentId" | "change"> {
  if (refs.length === 0) return {};
  const change = `attachments ${refs.length}`;
  if (!options.named) return { change };
  return { change, attachmentId: refs.map((ref) => ref.name).join(",") };
}
