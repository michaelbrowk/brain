import { createHash } from "node:crypto";
import type { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  createBrainMailClient,
  type BrainMailClient,
  type PublicMailAccountV3,
} from "@/lib/mail/brain-mail-client";
import type {
  MailAddress,
  MailMessageDto,
  MailSendInput,
  MailSendResult,
} from "@/lib/mail/message-types";
import {
  deriveReplyAllRecipients,
  deriveReplyRecipients,
} from "@/lib/mail/reply-forward";
import {
  recordAgentSend,
  recordAgentSendIfAbsent,
  resolveAgentSendThread,
} from "@/lib/mcp/agent-sends";
import {
  readAgentSettingsState,
  type McpAgentSettings,
} from "@/lib/mcp/agent-settings";
import {
  admitAttachmentRefs,
  attachmentActivityFields,
  attachmentBudgetOf,
  attachmentRefSchema,
  resolveOutgoingAttachments,
  type OutgoingAttachmentRef,
} from "./mail-send-attachments";
import {
  isAmbiguousSendFailure,
  logMailActivity,
  mailOutcome,
  mailRefusal,
  sendBlockedReasonOf,
  type McpActivityTarget,
} from "./mail-tool-kit";
import {
  clientNameOf,
  hasScope,
  hints,
  insufficientScope,
  refusal,
  text,
} from "./tool-kit";

/** PUTTING A MESSAGE ON THE WIRE, AND ASKING WHAT BECAME OF ONE.
 *
 *  Three tools under `brain:mail:send`: a new message, a reply whose
 *  recipients the agent does not choose, and the state of a send already
 *  made. They call `createBrainMailClient()` in process over the mail
 *  service's Unix socket, the way every other mail tool does.
 *
 *  Four things mark an agent's message, and three of them are set here:
 *  `origin: "mcp"` on the send input (which is what earns the
 *  `X-Brain-Agent: mcp` header in the outbound MIME, service-side), one line
 *  in the activity log, and one send mark in the state directory that gives
 *  the Sent row its caption. The fourth, the recipient-visible line, is the
 *  owner's toggle and reaches the service as `agentLine`.
 *
 *  The owner's other toggle is a kill switch: with `allowSending` off, both
 *  write tools refuse before the mail client is built, so a grant that can
 *  still read mail cannot put anything on the wire.
 */

type McpToolServer = Parameters<Parameters<typeof createMcpHandler>[0]>[0];

const SEND_TOOL = "send_mail";
const REPLY_TOOL = "reply_mail";
const STATUS_TOOL = "get_mail_send_status";

/** The client's own shapes (`lib/mail/message-codec.ts`), repeated here so a
 *  malformed id is refused by Brain, naming the field, rather than reaching
 *  the client only to come back as a request the service never saw. */
const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_MAIL_RESOURCE_ID = /^[A-Za-z0-9_-]{1,255}$/;
const SAFE_OPERATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The agent's own key, in the shape `validateMailSendInput` wants. A key
 *  outside it is a schema error rather than a refusal, so the agent learns
 *  the shape from the tool definition and not from a round trip. */
const idempotencyKeySchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{16,128}$/)
  .describe(
    "The agent's own key, 16 to 128 of A-Z a-z 0-9 _ -. Sending twice with one key replays the first result instead of sending twice.",
  );

/** The rule `validateRecipients` applies in the codec (`message-codec.ts`),
 *  which is the first gate an MCP send crosses: a dotted domain, no spaces,
 *  no control characters, and no angle brackets, because a display name is
 *  never part of an address here. Validating twice with one rule is the
 *  point. The agent gets a refusal naming the field, and the codec and the
 *  service still refuse on their own if anything slips past. */
const ADDRESS_RE = /^[^<>@\s\u0000-\u0020\u007f]+@[^<>@.\s\u0000-\u0020\u007f]+(?:\.[^<>@.\s\u0000-\u0020\u007f]+)+$/;
// The service's own figure (`outbound-message.ts`). It used to be 320 here, so
// an address between the two was admitted by the gate that names the field and
// refused three layers down in the words of a generic service failure.
const MAX_ADDRESS_BYTES = 254;
const MAX_RECIPIENTS = 100;
const MAX_SUBJECT_BYTES = 998;
const MAX_TEXT_BYTES = 1024 * 1024;

/** The characters a header line cannot carry. `validateSubject`
 *  (`lib/mail/service/outbound-message.ts`) bans exactly these before the
 *  MIME is built, and until now it was the only thing between an agent's
 *  subject and `Subject: x` followed by a `Bcc:` line of the agent's own.
 *  Brain holds its own lock on the one input where a miss would be
 *  catastrophic, so the refusal names the field rather than arriving as an
 *  opaque `mail_send_request_invalid` three layers down. `repliedSubject`
 *  already strips these from a subject the provider wrote, which is why only
 *  a composed message needs this. */
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

/** The fields a send's own line names, out of everything a mail line may
 *  carry. One line per send attempt, whatever became of it, because the owner
 *  reading the log wants the attempt as much as the message. Ids only: never
 *  a subject, an address or a body. The two attachment fields are the store's
 *  own names and a count, which say which file left the notes folder and
 *  nothing about what is in it. */
type SendActivityTarget = Pick<
  McpActivityTarget,
  "accountId" | "threadId" | "operationId" | "attachmentId" | "change"
>;

/** The line an id refusal writes: the tool and the code, and no target at
 *  all. A state directory that cannot be written must never turn a tool call
 *  into a transport error, so this swallows its own failure like every other
 *  call site here. */
const logBadId = (
  extra: { authInfo?: { clientId?: string } },
  tool: string,
  outcome: string,
) => logMailActivity(extra, tool, {}, outcome).catch(() => undefined);

type SendingGate =
  | { readonly refused: ReturnType<typeof refusal>; readonly outcome: string }
  | { readonly refused: null; readonly settings: McpAgentSettings };

/** The owner's kill switch, and what to do when the file holding it cannot be
 *  read. The switch exists to stop an agent, so a file this process cannot
 *  parse refuses the send rather than falling back to the on-by-default: the
 *  owner is pointed at the screen that rewrites the file. A file nobody has
 *  written yet is the first run, and the defaults are the answer. */
async function admitSending(): Promise<SendingGate> {
  const state = await readAgentSettingsState();
  // The code goes in `reason`, which is the field `docs/mcp-tools.md` tells an
  // agent to branch on, and the sentence carries the instruction. Prose in
  // `reason` left the two refusals looking like two different kinds of thing
  // while the log beside them already held one clean code each.
  if (state.unreadable) {
    return {
      refused: refusal(
        "agent sending is off, the switch could not be read, so set it again in Settings, Connections",
        "agent_settings_unreadable",
      ),
      outcome: "agent_settings_unreadable",
    };
  }
  if (!state.settings.allowSending) {
    return {
      refused: refusal(
        "agent sending is off, turn it on in Settings, Connections",
        "agent_sending_off",
      ),
      outcome: "agent_sending_off",
    };
  }
  return { refused: null, settings: state.settings };
}

/** One attachment-carrying send at a time in this process.
 *
 *  An attachment costs about six times its own size in resident memory while
 *  it is on its way: the file itself, its base64, the JSON string of the whole
 *  send input and the Buffer of that string, so about 60 MiB at the 10 MiB cap.
 *  Four at once measured +144 MiB at that same 10 MiB cap, against the unit's
 *  `MemoryHigh=512M`, and the mail
 *  service builds one MIME message at a time, so a second caller that had
 *  already read its bytes
 *  would hold them for the whole of the first send rather than getting rid of
 *  them. Task 4 answered the same question service-side with a queue, and
 *  this is its Brain-side half.
 *
 *  The turn is taken before a byte is read and given up once the send has
 *  answered, so at most one encoded body exists here. A send waits, it is
 *  never refused: an agent that asked for two messages wants two messages.
 *  A message with no files is not gated, because its body is capped at 1 MiB
 *  and the wait would cost an agent a turn for nothing. */
let attachmentSendTurn: Promise<unknown> = Promise.resolve();

function inAttachmentSendTurn<T>(
  attachmentCount: number,
  work: () => Promise<T>,
): Promise<T> {
  if (attachmentCount === 0) return work();
  const run = attachmentSendTurn.then(work, work);
  attachmentSendTurn = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

type CarriedSend =
  | { readonly refused: ReturnType<typeof refusal>; readonly outcome: string }
  | { readonly unknown: unknown }
  | { readonly result: MailSendResult };

/** The files and the wire, inside one turn of the gate above.
 *
 *  Everything before this either never reached the service or told it nothing
 *  to send. The wire starts at `sendMessage`, and a failure from there on can
 *  mean the message went out anyway, which is why it has its own catch and
 *  its own answer. A failure the resolver decided on is a refusal the notes
 *  folder named, and it comes back as one. */
async function carrySend(
  client: BrainMailClient,
  refs: readonly OutgoingAttachmentRef[],
  account: PublicMailAccountV3,
  build: (attachments: MailSendInput["attachments"]) => MailSendInput,
): Promise<CarriedSend> {
  return inAttachmentSendTurn(refs.length, async () => {
    const resolved = await resolveOutgoingAttachments(
      refs,
      attachmentBudgetOf(account.providerKind),
    );
    if ("refused" in resolved) return resolved;
    try {
      return { result: await client.sendMessage(build(resolved.attachments)) };
    } catch (error) {
      if (!isAmbiguousSendFailure(error)) throw error;
      return { unknown: error };
    }
  });
}

/** Not a refusal: the message may be on its way. `/v1/send` enqueues durably
 *  before it delivers, so a send whose answer never came back is as likely to
 *  have gone out as not, and "the mail service refused this request" is the
 *  one sentence an agent reads as "nothing happened, try again". The agent is
 *  given the state, its own key back, and the one retry that cannot send a
 *  second copy. `operationId` is null because the tool never learned one:
 *  replaying the key is what answers it. */
function unknownSend(idempotencyKey: string, error: unknown) {
  return text({
    state: "unknown",
    idempotencyKey,
    operationId: null,
    retry: "same-key",
    reason: mailOutcome(error),
    detail:
      "The mail service did not answer, and it holds the message already, so it may still go out. Ask again with this same idempotencyKey: that replays the first send instead of making a second one, and answers its operationId, which get_mail_send_status then reports on. A fresh key sends the message twice.",
  });
}

interface Recipients {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
}

/** Brain's own read of the recipient lists, in the order a refusal names
 *  them. Every rule here is one the codec applies a moment later: the answer
 *  is the same, and this one says which field and which index. */
function admitRecipients(recipients: Recipients) {
  const fields = [
    ["to", recipients.to],
    ["cc", recipients.cc],
    ["bcc", recipients.bcc],
  ] as const;
  const total =
    recipients.to.length + recipients.cc.length + recipients.bcc.length;
  if (total > MAX_RECIPIENTS) {
    return refusal(
      "that is too many recipients",
      `at most ${MAX_RECIPIENTS} across to, cc and bcc`,
    );
  }
  const seen = new Set<string>();
  for (const [field, list] of fields) {
    for (const [index, value] of list.entries()) {
      if (
        Buffer.byteLength(value) > MAX_ADDRESS_BYTES ||
        !ADDRESS_RE.test(value)
      ) {
        return refusal("that is not an address", `${field}[${index}]`);
      }
      const key = value.toLowerCase();
      if (seen.has(key)) {
        return refusal("that address is listed twice", `${field}[${index}]`);
      }
      seen.add(key);
    }
  }
  return null;
}

/** The two body caps the codec holds, checked here so a message one byte
 *  over the line is refused with its own measurement rather than as a
 *  request the service could not read. A NUL is refused for the same
 *  reason: `boundedString` treats it as a broken string.
 *
 *  Each rule hands back its own outcome as well as its refusal. The caller
 *  used to log every one of these as `body_too_long`, so the owner's log
 *  named the wrong cause for the attempt they would most want to read. */
function admitBody(subject: string, body: string) {
  if (subject.includes("\u0000") || body.includes("\u0000")) {
    return {
      refused: refusal(
        "that message holds a null byte",
        "subject and text are plain text",
      ),
      outcome: "null_byte",
    };
  }
  if (CONTROL_CHARACTERS.test(subject)) {
    return {
      refused: refusal(
        "that subject holds a control character",
        "a subject is one line of plain text",
      ),
      outcome: "subject_control_character",
    };
  }
  if (Buffer.byteLength(subject) > MAX_SUBJECT_BYTES) {
    return {
      refused: refusal(
        "that subject is too long",
        `subject is at most ${MAX_SUBJECT_BYTES} bytes`,
      ),
      outcome: "subject_too_long",
    };
  }
  if (Buffer.byteLength(body) > MAX_TEXT_BYTES) {
    return {
      refused: refusal(
        "that message is too long",
        `text is at most ${MAX_TEXT_BYTES} bytes`,
      ),
      outcome: "body_too_long",
    };
  }
  return null;
}

/** HOW LONG AN UNKNOWN SEND IS REMEMBERED, AND WHY IT IS REMEMBERED AT ALL.
 *
 *  A send that answered `state: "unknown"` may be on its way. The answer says
 *  to ask again with the same key, which replays the first send instead of
 *  making a second one, and that sentence was the whole of the protection: an
 *  agent that reached for a fresh key instead put a second copy of the
 *  message in somebody's inbox, with nothing in Brain to notice.
 *
 *  Ten minutes covers the retry an agent makes after reading the answer, and
 *  is short enough that a person deliberately sending the same message twice
 *  is not held up. The memory is this process's own: it is a guard rail on a
 *  mistake made in one conversation, not a durable record. */
const UNKNOWN_SEND_MEMORY_MS = 10 * 60 * 1000;

/** One entry per unknown send in the window. Bounded so that an agent
 *  producing them cannot grow the map without end. */
const UNKNOWN_SEND_MEMORY_MAX = 50;

interface UnknownSend {
  readonly idempotencyKey: string;
  readonly at: number;
}

const unknownSends = new Map<string, UnknownSend>();

/** The message rather than the call: the account, the three recipient lists,
 *  the subject, the body and the files it carries. Two sends agreeing on all
 *  of those are the same message however each was composed. The files are in
 *  because a second send of the same words with a different file attached is a
 *  different message, and leaving them out held it for ten minutes as a
 *  duplicate of the first. The refs are what the tool was given, page and
 *  name: the bytes are not read here and are not this guard rail's business.
 *  Only the digest is kept, so nothing written stays in this process's memory
 *  after the send. */
function sendFingerprint(
  accountId: string,
  recipients: Recipients,
  subject: string,
  body: string,
  refs: readonly OutgoingAttachmentRef[],
): string {
  const hash = createHash("sha256");
  for (const part of [
    accountId,
    recipients.to.join(","),
    recipients.cc.join(","),
    recipients.bcc.join(","),
    subject,
    body,
    refs.map((ref) => `${ref.page}/${ref.name}`).join(","),
  ]) {
    hash.update(part);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

/** A fresh key on a message whose first attempt may already be on its way.
 *  Refused, naming the one key that answers the first send rather than making
 *  a second. The same key is exactly the retry the unknown answer asked for,
 *  so it is never held up. */
function admitNotDuplicate(fingerprint: string, idempotencyKey: string) {
  const now = Date.now();
  for (const [held, send] of unknownSends) {
    if (now - send.at >= UNKNOWN_SEND_MEMORY_MS) unknownSends.delete(held);
  }
  const held = unknownSends.get(fingerprint);
  if (!held || held.idempotencyKey === idempotencyKey) return null;
  return refusal(
    `that message may already be on its way under idempotencyKey ${held.idempotencyKey}, so ask again with that key or read get_mail_send_status rather than sending a second copy`,
    "possible_duplicate",
  );
}

/** The first unknown attempt is the one whose key can replay, so a later one
 *  never overwrites it. */
function rememberUnknownSend(fingerprint: string, idempotencyKey: string): void {
  if (unknownSends.has(fingerprint)) return;
  if (unknownSends.size >= UNKNOWN_SEND_MEMORY_MAX) {
    const oldest = unknownSends.keys().next();
    if (!oldest.done) unknownSends.delete(oldest.value);
  }
  unknownSends.set(fingerprint, { idempotencyKey, at: Date.now() });
}

/** A send that answered is a send whose fate is known, whichever key it went
 *  under, so there is nothing left to warn the next call about. */
function forgetUnknownSend(fingerprint: string): void {
  unknownSends.delete(fingerprint);
}

type AdmittedAccount =
  | { readonly refused: ReturnType<typeof refusal>; readonly outcome: string }
  | { readonly account: PublicMailAccountV3 };

/** The one round trip a refusal is allowed to cost, which is why it comes
 *  after every check Brain can make on its own. An account this host does
 *  not hold and an account the provider will not send from are both answered
 *  before the message is built. */
async function admitAccount(
  client: BrainMailClient,
  accountId: string,
): Promise<AdmittedAccount> {
  const status = await client.listAccountCapabilities();
  const account = status.accounts.find(
    (held) => held.accountId === accountId,
  );
  if (!account) {
    return {
      refused: refusal("account not found", accountId),
      outcome: "account_not_found",
    };
  }
  if (!account.capabilities.send) {
    const reason = sendBlockedReasonOf(account);
    return {
      refused: refusal("cannot send from this account", reason),
      outcome: reason,
    };
  }
  return { account };
}

/** The rule the composer applies, and the shape `forwardedSubject` uses for
 *  a forward. A subject that already answers is not prefixed a second time,
 *  and a message with no subject at all still answers something. */
function repliedSubject(subject: string | null): string {
  const normalized = (subject ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length === 0) return "Re:";
  return /^re:/i.test(normalized) ? normalized : `Re: ${normalized}`;
}

const addressesOf = (addresses: readonly MailAddress[]): string[] =>
  addresses.map((address) => address.address);

/** The message the reply answers, out of the thread the caller named. A
 *  message id from another thread is refused rather than replied to: the
 *  threading headers the service writes come from this message, and a
 *  message from somewhere else would put the reply in the wrong place. */
function messageInThread(
  messages: readonly MailMessageDto[],
  messageId: string,
): MailMessageDto | null {
  return messages.find((message) => message.messageId === messageId) ?? null;
}

export function registerMailSendTools(server: McpToolServer): void {
  server.registerTool(
    SEND_TOOL,
    {
      title: "Send a message",
      // `destroys`: a message that has left cannot be recalled. Nothing in
      // Brain is lost, and that is not what the hint is asking — it asks
      // whether the effect can be undone, and this one cannot.
      // `idempotent`: the idempotency key every send carries. Reusing it
      // replays the same result rather than sending a second message.
      annotations: hints("write destroys idempotent outside"),
      description:
        "Send a new message from one connected account. The account is yours to name and every send needs an idempotency key. Text only, no HTML. The message is marked as an agent's inside Brain: the owner sees it in Settings, Connections. A sent message cannot be recalled.",
      inputSchema: z
        .object({
          accountId: z.string(),
          to: z.array(z.string()),
          cc: z.array(z.string()).optional(),
          bcc: z.array(z.string()).optional(),
          subject: z.string(),
          text: z.string(),
          idempotencyKey: idempotencyKeySchema,
          attachments: z
            .array(attachmentRefSchema)
            .optional()
            .describe(
              "Files a page of yours already shows, each named by that page and the file's own name in it. Nothing else can be attached.",
            ),
        })
        .strict(),
    },
    async (
      {
        accountId,
        to,
        cc,
        bcc,
        subject,
        text: body,
        idempotencyKey,
        attachments: attachmentRefs,
      },
      extra,
    ) => {
      if (!hasScope(extra, "brain:mail:send")) {
        return insufficientScope("brain:mail:send");
      }
      const refs: readonly OutgoingAttachmentRef[] = attachmentRefs ?? [];
      // The count from the first line, the names only once they are names.
      let marks = attachmentActivityFields(refs, { named: false });
      // A state directory that cannot be written must never turn a completed
      // send into a failed tool call, so every call site swallows its own
      // failure.
      const log = (outcome: string, operationId?: string) => {
        const target: SendActivityTarget = {
          accountId,
          ...marks,
          ...(operationId ? { operationId } : {}),
        };
        return logMailActivity(extra, SEND_TOOL, target, outcome).catch(
          () => undefined,
        );
      };

      // The id's shape first, and its line names no target: an id Brain never
      // issued names nothing, and no line this call writes may carry a string
      // that was never checked.
      if (!SAFE_ACCOUNT_ID.test(accountId)) {
        await logBadId(extra, SEND_TOOL, "invalid_account_id");
        return refusal("that account id is not valid", "invalid_account_id");
      }
      // The owner's kill switch, read before anything that could put a
      // message on the wire, so a grant that can still read mail reaches no
      // part of the send path.
      const gate = await admitSending();
      if (gate.refused) {
        await log(gate.outcome);
        return gate.refused;
      }
      const settings = gate.settings;
      if (to.length === 0) {
        await log("empty_to");
        return refusal("to is empty", "name at least one recipient");
      }
      const recipients: Recipients = { to, cc: cc ?? [], bcc: bcc ?? [] };
      const badRecipient = admitRecipients(recipients);
      if (badRecipient) {
        await log("invalid_recipients");
        return badRecipient;
      }
      const badBody = admitBody(subject, body);
      if (badBody) {
        await log(badBody.outcome);
        return badBody.refused;
      }
      const badRefs = admitAttachmentRefs(refs);
      if (badRefs) {
        await log(badRefs.outcome);
        return badRefs.refused;
      }
      marks = attachmentActivityFields(refs, { named: true });

      // The last check before anything is built: a message this process has
      // already put on the wire once, under a key that cannot replay it.
      const fingerprint = sendFingerprint(
        accountId,
        recipients,
        subject,
        body,
        refs,
      );
      const duplicate = admitNotDuplicate(fingerprint, idempotencyKey);
      if (duplicate) {
        await log("possible_duplicate");
        return duplicate;
      }

      try {
        const client = createBrainMailClient();
        const admitted = await admitAccount(client, accountId);
        if ("refused" in admitted) {
          await log(admitted.outcome);
          return admitted.refused;
        }
        // The notes folder is read last, after every refusal that costs
        // nothing and after the account is known to be able to send, so the
        // bytes are held for as short a time as the path allows.
        const carried = await carrySend(
          client,
          refs,
          admitted.account,
          (attachments) => ({
            accountId,
            idempotencyKey,
            mode: "compose",
            to: recipients.to,
            cc: recipients.cc,
            bcc: recipients.bcc,
            subject,
            text: body,
            replyToMessageId: null,
            attachments,
            origin: "mcp",
            agentLine: settings.tellRecipients,
          }),
        );
        if ("refused" in carried) {
          await log(carried.outcome);
          return carried.refused;
        }
        if ("unknown" in carried) {
          rememberUnknownSend(fingerprint, idempotencyKey);
          await log("unknown");
          return unknownSend(idempotencyKey, carried.unknown);
        }
        const result = carried.result;
        forgetUnknownSend(fingerprint);
        await recordSend(extra, accountId, result.operationId);
        await log("ok", result.operationId);
        return text({
          operationId: result.operationId,
          created: result.created,
          status: result.status,
        });
      } catch (error) {
        await log(mailOutcome(error));
        return mailRefusal(error);
      }
    },
  );

  server.registerTool(
    REPLY_TOOL,
    {
      title: "Reply to a message",
      // The same two as `send_mail`, for the same two reasons.
      annotations: hints("write destroys idempotent outside"),
      description:
        "Reply to one message in a thread. The recipients are derived from the message being answered, Reply-To over From, with this account's own addresses dropped; there is no `to` here. To write to someone else, send a new message. Text only, no HTML. A sent reply cannot be recalled.",
      inputSchema: z
        .object({
          accountId: z.string(),
          threadId: z.string(),
          messageId: z.string(),
          replyAll: z
            .boolean()
            .optional()
            .describe("true keeps the To and Cc of the message being answered"),
          text: z.string(),
          idempotencyKey: idempotencyKeySchema,
          attachments: z
            .array(attachmentRefSchema)
            .optional()
            .describe(
              "Files a page of yours already shows, each named by that page and the file's own name in it. Nothing else can be attached.",
            ),
        })
        .strict(),
    },
    async (
      {
        accountId,
        threadId,
        messageId,
        replyAll,
        text: body,
        idempotencyKey,
        attachments: attachmentRefs,
      },
      extra,
    ) => {
      if (!hasScope(extra, "brain:mail:send")) {
        return insufficientScope("brain:mail:send");
      }
      const refs: readonly OutgoingAttachmentRef[] = attachmentRefs ?? [];
      let marks = attachmentActivityFields(refs, { named: false });
      const log = (outcome: string, operationId?: string) => {
        const target: SendActivityTarget = {
          accountId,
          threadId,
          ...marks,
          ...(operationId ? { operationId } : {}),
        };
        return logMailActivity(extra, REPLY_TOOL, target, outcome).catch(
          () => undefined,
        );
      };

      // The three ids' shapes first, and their lines name no target: an id
      // Brain never issued names nothing, and no line this call writes may
      // carry a string that was never checked.
      if (!SAFE_ACCOUNT_ID.test(accountId)) {
        await logBadId(extra, REPLY_TOOL, "invalid_account_id");
        return refusal("that account id is not valid", "invalid_account_id");
      }
      if (!SAFE_MAIL_RESOURCE_ID.test(threadId)) {
        await logBadId(extra, REPLY_TOOL, "invalid_thread_id");
        return refusal("that thread id is not valid", "invalid_thread_id");
      }
      if (!SAFE_MAIL_RESOURCE_ID.test(messageId)) {
        await logBadId(extra, REPLY_TOOL, "invalid_message_id");
        return refusal("that message id is not valid", "invalid_message_id");
      }
      const gate = await admitSending();
      if (gate.refused) {
        await log(gate.outcome);
        return gate.refused;
      }
      const settings = gate.settings;
      const badBody = admitBody("", body);
      if (badBody) {
        await log(badBody.outcome);
        return badBody.refused;
      }
      const badRefs = admitAttachmentRefs(refs);
      if (badRefs) {
        await log(badRefs.outcome);
        return badRefs.refused;
      }
      marks = attachmentActivityFields(refs, { named: true });

      try {
        const client = createBrainMailClient();
        const admitted = await admitAccount(client, accountId);
        if ("refused" in admitted) {
          await log(admitted.outcome);
          return admitted.refused;
        }
        const { account } = admitted;
        const detail = await client.getThread(accountId, threadId);
        const target = messageInThread(detail.messages, messageId);
        if (!target) {
          await log("reply_target_not_found");
          return refusal("that message is not in that thread", messageId);
        }
        // The account's verified identity, so its own addresses and the
        // provider's equivalent forms of them are never copied back onto the
        // message it is answering.
        const identity = {
          emailAddress: account.emailAddress,
          providerKind: account.providerKind,
        };
        const derived = replyAll
          ? deriveReplyAllRecipients(target, identity)
          : deriveReplyRecipients(target, identity);
        const recipients: Recipients = {
          to: addressesOf(derived.to),
          cc: addressesOf(derived.cc),
          bcc: [],
        };
        if (recipients.to.length === 0) {
          await log("no_reply_recipient");
          return refusal(
            "there is no one to reply to",
            "that message names only this account",
          );
        }
        const badRecipient = admitRecipients(recipients);
        if (badRecipient) {
          await log("invalid_recipients");
          return badRecipient;
        }
        // The subject is the target's, so its length is the provider's doing
        // and not the agent's. The body was measured before the round trip.
        const subject = repliedSubject(target.subject);
        const badSubject = admitBody(subject, "");
        if (badSubject) {
          await log(badSubject.outcome);
          return badSubject.refused;
        }
        // The recipients and the subject are the provider's, so the
        // fingerprint of a reply is only knowable here.
        const fingerprint = sendFingerprint(
          accountId,
          recipients,
          subject,
          body,
          refs,
        );
        const duplicate = admitNotDuplicate(fingerprint, idempotencyKey);
        if (duplicate) {
          await log("possible_duplicate");
          return duplicate;
        }
        const carried = await carrySend(client, refs, account, (attachments) => ({
          accountId,
          idempotencyKey,
          mode: "reply",
          to: recipients.to,
          cc: recipients.cc,
          bcc: recipients.bcc,
          subject,
          text: body,
          replyToMessageId: messageId,
          attachments,
          origin: "mcp",
          agentLine: settings.tellRecipients,
        }));
        if ("refused" in carried) {
          await log(carried.outcome);
          return carried.refused;
        }
        if ("unknown" in carried) {
          rememberUnknownSend(fingerprint, idempotencyKey);
          await log("unknown");
          return unknownSend(idempotencyKey, carried.unknown);
        }
        const result = carried.result;
        forgetUnknownSend(fingerprint);
        await recordSend(extra, accountId, result.operationId);
        await log("ok", result.operationId);
        return text({
          operationId: result.operationId,
          created: result.created,
          status: result.status,
        });
      } catch (error) {
        await log(mailOutcome(error));
        return mailRefusal(error);
      }
    },
  );

  server.registerTool(
    STATUS_TOOL,
    {
      title: "Check what became of a send",
      // `read` in the sense the hint is asked for: no mail moves, nothing the
      // owner can see changes, and calling it twice shows the same thing. It
      // is not literally side-effect free — the handler fills in the Sent
      // caption's mark and resolves its thread, because this call is the one
      // moment the operation id and the thread are both known. Both writes
      // are write-once, both are swallowed on failure, and neither is
      // reachable by the caller. Declaring this a write would put a
      // confirmation in front of a status poll, which is the opposite of what
      // the hint is for.
      annotations: hints("read keeps idempotent outside"),
      description:
        "Report what became of one send: its status, and the thread its Sent copy landed in once the provider has one. A send whose account has no Sent folder keeps a null thread for good. Name the account as well after a send answered `state` unknown, so the owner's Sent row can still say which app wrote the message.",
      inputSchema: z
        .object({
          operationId: z.string(),
          accountId: z
            .string()
            .optional()
            .describe(
              "the account the send was made from. Naming an account that is not the operation's is refused, and the mark is always written against the operation's own account",
            ),
        })
        .strict(),
    },
    async ({ operationId, accountId }, extra) => {
      if (!hasScope(extra, "brain:mail:send")) {
        return insufficientScope("brain:mail:send");
      }
      if (!SAFE_OPERATION_ID.test(operationId)) {
        return refusal(
          "that operation id is not valid",
          "invalid_operation_id",
        );
      }
      if (accountId !== undefined && !SAFE_ACCOUNT_ID.test(accountId)) {
        return refusal("that account id is not valid", "invalid_account_id");
      }
      try {
        const operation = await createBrainMailClient().getSendOperation(
          operationId,
        );
        // The mark names the account the operation lives in, never the one the
        // caller typed. A caller naming another account is guessing, and a
        // guess that wrote would caption a Sent row in the wrong mailbox, so
        // it is refused before anything is written.
        if (accountId !== undefined && accountId !== operation.accountId) {
          return refusal(
            "that send belongs to a different account",
            "mail_operation_account_mismatch",
          );
        }
        // A send whose answer never arrived wrote no mark, because the tool
        // never learned an operation id. This is where that id first exists,
        // so the mark is filled in here, once the service says the send was
        // accepted. A failed send never reached a Sent folder and earns no
        // caption. A mark already there keeps what it holds.
        if (operation.status !== "failed") {
          await recordAgentSendIfAbsent({
            operationId,
            accountId: operation.accountId,
            clientName: await clientNameOf(extra),
          }).catch(() => undefined);
        }
        // The Sent row is the provider's own row and carries no operation
        // id, so the caption Settings shows is a Brain-side join. This is
        // the one moment the thread is knowable, and filling the mark here
        // costs one write on a status an agent was asking for anyway. A mark
        // that cannot be written costs a caption, never the answer.
        if (operation.threadId !== null) {
          await resolveAgentSendThread(operationId, operation.threadId).catch(
            () => undefined,
          );
        }
        // Reading a status changes no mail, so it writes no activity line.
        return text({
          operationId: operation.operationId,
          status: operation.status,
          threadId: operation.threadId,
        });
      } catch (error) {
        return mailRefusal(error);
      }
    },
  );
}

/** The mark the Sent caption is built from: which operation, which account,
 *  which app, and the thread once something resolves it. Three ids and a
 *  name, and nothing about what was written. Losing it costs a caption, so
 *  it never fails a send that already happened. */
async function recordSend(
  extra: { authInfo?: { clientId?: string } },
  accountId: string,
  operationId: string,
): Promise<void> {
  try {
    await recordAgentSend({
      operationId,
      accountId,
      clientName: await clientNameOf(extra),
    });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    console.warn(`[brain/mcp] send mark not written: ${reason}`);
  }
}
