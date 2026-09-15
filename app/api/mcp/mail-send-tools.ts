import type { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  BrainMailClientError,
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
  appendMcpActivity,
  type McpActivityEntry,
} from "@/lib/mcp/activity-log";
import { recordAgentSend, resolveAgentSendThread } from "@/lib/mcp/agent-sends";
import { readAgentSettings } from "@/lib/mcp/agent-settings";
import {
  admitAttachmentRefs,
  attachmentActivityFields,
  attachmentRefSchema,
  resolveOutgoingAttachments,
  type OutgoingAttachmentRef,
} from "./mail-send-attachments";
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

/** The same three shapes `mail-tools.ts` keeps for the read and triage tools.
 *  They are repeated rather than imported while both modules are being
 *  written in the same round; lifting them into `tool-kit.ts` is one move
 *  once the mail modules are quiet. */

/** The service's own code, handed over as a reason an agent can act on. The
 *  send codes come first because they are the ones a send can produce, and
 *  the two an agent can do something about are named in words. */
function sendRefusalFields(error: unknown): { error: string; reason: string } {
  if (error instanceof BrainMailClientError) {
    if (error.code === "mail_send_idempotency_conflict") {
      return {
        error: "that idempotency key was used for a different message",
        reason: error.code,
      };
    }
    if (error.code === "mail_send_rate_limited") {
      return {
        error: "the mail service is rate limiting sends",
        reason: error.code,
      };
    }
    if (error.code === "mail_send_service_unavailable") {
      return { error: "sending is unavailable right now", reason: error.code };
    }
    if (
      error.code === "mail_send_account_reauth_required" ||
      error.code === "mail_account_reauth_required"
    ) {
      return {
        error: "this account needs to be reconnected",
        reason: error.code,
      };
    }
    if (error.code === "mail_send_reply_target_not_found") {
      return {
        error: "the message being replied to is gone",
        reason: error.code,
      };
    }
    if (error.code === "mail_send_operation_not_found") {
      return { error: "no send with that id", reason: error.code };
    }
    if (
      error.code === "mail_send_account_not_found" ||
      error.code === "mail_account_not_found"
    ) {
      return { error: "account not found", reason: error.code };
    }
    if (error.code === "mail_thread_not_found") {
      return { error: "thread not found", reason: error.code };
    }
    if (error.code === "mail_service_unavailable") {
      return { error: "the mail service is unavailable", reason: error.code };
    }
    return {
      error: "the mail service refused this request",
      reason: error.code,
    };
  }
  return {
    error: "the mail service is unavailable",
    reason: "mail_service_unavailable",
  };
}

/** A throw here would arrive at the agent as a transport error with no code
 *  at all, and the agent would retry a permanent refusal forever. Anything
 *  that is not the client's own error is an outage as far as the agent is
 *  concerned, and its wording stays on this side of the boundary. */
function sendRefusal(error: unknown) {
  const fields = sendRefusalFields(error);
  return refusal(fields.error, fields.reason);
}

/** The same error as one code, for the log. */
function sendOutcome(error: unknown): string {
  return error instanceof BrainMailClientError
    ? error.code
    : "mail_service_unavailable";
}

/** One line per send attempt, whatever became of it, because the owner
 *  reading the log wants the attempt as much as the message. The target
 *  carries ids only: never a subject, an address or a body. The two
 *  attachment fields are the store's own names and a count, which say which
 *  file left the notes folder and nothing about what is in it. */
async function logSendActivity(
  extra: { authInfo?: { clientId?: string } },
  tool: string,
  target: Pick<
    McpActivityEntry,
    "accountId" | "threadId" | "operationId" | "attachmentId" | "change"
  >,
  outcome: string,
): Promise<void> {
  await appendMcpActivity({
    at: new Date().toISOString(),
    client: await clientNameOf(extra),
    tool,
    ...target,
    outcome,
  });
}

/** The service reports sending as one boolean, so the reason it is false is
 *  Brain's own read, the same derivation `list_mail_accounts` answers with.
 *  Reconnection comes first because it is the one the owner can act on
 *  today; an IMAP account with no SMTP endpoint was never set up to send;
 *  anything left is the relay this host cannot reach. */
function sendBlockedReasonOf(account: PublicMailAccountV3): string {
  if (account.status === "reauth_required") return "account_reauth_required";
  if (account.providerKind === "imap" && account.smtp === undefined) {
    return "smtp_not_configured";
  }
  return "smtp_relay_unavailable";
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
      const log = (outcome: string, operationId?: string) =>
        logSendActivity(
          extra,
          SEND_TOOL,
          { accountId, ...marks, ...(operationId ? { operationId } : {}) },
          outcome,
        ).catch(() => undefined);

      // The owner's kill switch, read before anything else, so a grant that
      // can still read mail reaches no part of the send path.
      const settings = await readAgentSettings();
      if (!settings.allowSending) {
        await log("agent_sending_off");
        return refusal(
          "agent sending is off",
          "turn it on in Settings, Connections",
        );
      }
      if (!SAFE_ACCOUNT_ID.test(accountId)) {
        await log("invalid_account_id");
        return refusal("that account id is not valid", "invalid_account_id");
      }
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
        const result = await client.sendMessage(input);
        await recordSend(extra, accountId, result.operationId);
        await log("ok", result.operationId);
        return text({
          operationId: result.operationId,
          created: result.created,
          status: result.status,
        });
      } catch (error) {
        await log(sendOutcome(error));
        return sendRefusal(error);
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
      const log = (outcome: string, operationId?: string) =>
        logSendActivity(
          extra,
          REPLY_TOOL,
          {
            accountId,
            threadId,
            ...marks,
            ...(operationId ? { operationId } : {}),
          },
          outcome,
        ).catch(() => undefined);

      const settings = await readAgentSettings();
      if (!settings.allowSending) {
        await log("agent_sending_off");
        return refusal(
          "agent sending is off",
          "turn it on in Settings, Connections",
        );
      }
      if (!SAFE_ACCOUNT_ID.test(accountId)) {
        await log("invalid_account_id");
        return refusal("that account id is not valid", "invalid_account_id");
      }
      if (!SAFE_MAIL_RESOURCE_ID.test(threadId)) {
        await log("invalid_thread_id");
        return refusal("that thread id is not valid", "invalid_thread_id");
      }
      if (!SAFE_MAIL_RESOURCE_ID.test(messageId)) {
        await log("invalid_message_id");
        return refusal("that message id is not valid", "invalid_message_id");
      }
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
        const result = await client.sendMessage(input);
        await recordSend(extra, accountId, result.operationId);
        await log("ok", result.operationId);
        return text({
          operationId: result.operationId,
          created: result.created,
          status: result.status,
        });
      } catch (error) {
        await log(sendOutcome(error));
        return sendRefusal(error);
      }
    },
  );

  server.registerTool(
    STATUS_TOOL,
    {
      description:
        "Report what became of one send: its status, and the thread its Sent copy landed in once the provider has one. A send whose account has no Sent folder keeps a null thread for good.",
      inputSchema: z.object({ operationId: z.string() }).strict(),
    },
    async ({ operationId }, extra) => {
      if (!hasScope(extra, "brain:mail:send")) {
        return insufficientScope("brain:mail:send");
      }
      if (!SAFE_OPERATION_ID.test(operationId)) {
        return refusal(
          "that operation id is not valid",
          "invalid_operation_id",
        );
      }
      try {
        const operation = await createBrainMailClient().getSendOperation(
          operationId,
        );
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
        return sendRefusal(error);
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
