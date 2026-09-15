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
const ADDRESS_RE = /^[^<>@\s]+@[^<>@.\s]+(?:\.[^<>@.\s]+)+$/;
const MAX_ADDRESS_BYTES = 320;
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
  if (state.unreadable) {
    return {
      refused: refusal(
        "agent sending is off",
        "the switch could not be read, set it again in Settings, Connections",
      ),
      outcome: "agent_settings_unreadable",
    };
  }
  if (!state.settings.allowSending) {
    return {
      refused: refusal(
        "agent sending is off",
        "turn it on in Settings, Connections",
      ),
      outcome: "agent_sending_off",
    };
  }
  return { refused: null, settings: state.settings };
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
 *  reason: `boundedString` treats it as a broken string. */
function admitBody(subject: string, body: string) {
  if (subject.includes("\u0000") || body.includes("\u0000")) {
    return refusal(
      "that message holds a null byte",
      "subject and text are plain text",
    );
  }
  if (CONTROL_CHARACTERS.test(subject)) {
    return refusal(
      "that subject holds a control character",
      "a subject is one line of plain text",
    );
  }
  if (Buffer.byteLength(subject) > MAX_SUBJECT_BYTES) {
    return refusal(
      "that subject is too long",
      `subject is at most ${MAX_SUBJECT_BYTES} bytes`,
    );
  }
  if (Buffer.byteLength(body) > MAX_TEXT_BYTES) {
    return refusal(
      "that message is too long",
      `text is at most ${MAX_TEXT_BYTES} bytes`,
    );
  }
  return null;
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
      description:
        "Send a new message from one connected account. The account is yours to name and every send needs an idempotency key. Text only, no HTML. The message is marked as an agent's inside Brain: the owner sees it in Settings, Connections.",
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
        await log("body_too_long");
        return badBody;
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
        // The notes folder is read last, after every refusal that costs
        // nothing and after the account is known to be able to send, so the
        // bytes are held for as short a time as the path allows.
        const resolved = await resolveOutgoingAttachments(refs);
        if ("refused" in resolved) {
          await log(resolved.outcome);
          return resolved.refused;
        }
        const input: MailSendInput = {
          accountId,
          idempotencyKey,
          mode: "compose",
          to: recipients.to,
          cc: recipients.cc,
          bcc: recipients.bcc,
          subject,
          text: body,
          replyToMessageId: null,
          attachments: resolved.attachments,
          origin: "mcp",
          agentLine: settings.tellRecipients,
        };
        // Everything above either never reached the service or told it
        // nothing to send. The wire starts here, and a failure from here on
        // can mean the message went out anyway.
        let result;
        try {
          result = await client.sendMessage(input);
        } catch (error) {
          if (!isAmbiguousSendFailure(error)) throw error;
          await log("unknown");
          return unknownSend(idempotencyKey, error);
        }
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
      description:
        "Reply to one message in a thread. The recipients are derived from the message being answered, Reply-To over From, with this account's own addresses dropped; there is no `to` here. To write to someone else, send a new message. Text only, no HTML.",
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
        await log("body_too_long");
        return badBody;
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
          await log("subject_too_long");
          return badSubject;
        }
        const resolved = await resolveOutgoingAttachments(refs);
        if ("refused" in resolved) {
          await log(resolved.outcome);
          return resolved.refused;
        }
        const input: MailSendInput = {
          accountId,
          idempotencyKey,
          mode: "reply",
          to: recipients.to,
          cc: recipients.cc,
          bcc: recipients.bcc,
          subject,
          text: body,
          replyToMessageId: messageId,
          attachments: resolved.attachments,
          origin: "mcp",
          agentLine: settings.tellRecipients,
        };
        // The wire starts here, the same way it does on a compose.
        let result;
        try {
          result = await client.sendMessage(input);
        } catch (error) {
          if (!isAmbiguousSendFailure(error)) throw error;
          await log("unknown");
          return unknownSend(idempotencyKey, error);
        }
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
      description:
        "Report what became of one send: its status, and the thread its Sent copy landed in once the provider has one. A send whose account has no Sent folder keeps a null thread for good. Name the account as well after a send answered `state` unknown, so the owner's Sent row can still say which app wrote the message.",
      inputSchema: z
        .object({
          operationId: z.string(),
          accountId: z
            .string()
            .optional()
            .describe(
              "the account the send was made from, which lets Brain mark a send it never got an answer for",
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
        // A send whose answer never arrived wrote no mark, because the tool
        // never learned an operation id. This is where that id first exists,
        // so the mark is filled in here, once the service says the send was
        // accepted. A failed send never reached a Sent folder and earns no
        // caption. A mark already there keeps what it holds.
        if (accountId !== undefined && operation.status !== "failed") {
          await recordAgentSendIfAbsent({
            operationId,
            accountId,
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
