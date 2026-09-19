import {
  BrainMailClientError,
  type PublicMailAccountV3,
} from "@/lib/mail/brain-mail-client";
import {
  appendMcpActivity,
  type McpActivityEntry,
} from "@/lib/mcp/activity-log";
import { clientNameOf, refusal } from "./tool-kit";

/** THE WORDS EVERY MAIL TOOL REFUSES IN, AND THE ONE LINE EACH OF THEM WRITES.
 *
 *  The reads, the triage, the sends and the attachment save each met the same
 *  service codes and each kept their own copy of the table that turns one into
 *  a sentence. The copies drifted: `mail_account_reauth_required` told an
 *  agent to reconnect the account in one tool and said nothing in another,
 *  for the same code off the same socket. One table is the fix, so a code
 *  reads the same wherever an agent meets it.
 *
 *  The table is the union of what the four tools can be handed. A read never
 *  sees a `mail_send_*` code and a send never sees a draft's, so naming them
 *  all here costs a branch that cannot be taken rather than a behaviour.
 */

/** The service's own code, handed over as a reason an agent can act on. The
 *  ones an agent can do something about are named in words; everything else
 *  keeps its code and says the service refused. */
export function mailRefusalFields(error: unknown): {
  error: string;
  reason: string;
} {
  if (error instanceof BrainMailClientError) {
    if (error.code === "mail_service_unavailable") {
      return { error: "the mail service is unavailable", reason: error.code };
    }
    if (
      error.code === "mail_account_not_found" ||
      error.code === "mail_send_account_not_found"
    ) {
      return { error: "account not found", reason: error.code };
    }
    if (error.code === "mail_thread_not_found") {
      return { error: "thread not found", reason: error.code };
    }
    if (
      error.code === "mail_account_reauth_required" ||
      error.code === "mail_send_account_reauth_required"
    ) {
      return {
        error: "this account needs to be reconnected",
        reason: error.code,
      };
    }
    if (error.code === "mail_send_request_invalid") {
      // The service names its figures when it has them — what the finished
      // message weighed and the ceiling it crossed — and that is the difference
      // between an agent trying again with a smaller file and an agent retrying
      // the same one for ever. A refusal with no figures still reads as a
      // refusal of this request rather than as an outage.
      return {
        error: "the mail service refused this message",
        reason:
          error.detail === null ? error.code : `${error.code}: ${error.detail}`,
      };
    }
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
    if (error.code === "mail_send_reply_target_not_found") {
      return {
        error: "the message being replied to is gone",
        reason: error.code,
      };
    }
    if (error.code === "mail_send_operation_not_found") {
      return { error: "no send with that id", reason: error.code };
    }
    if (error.code === "mail_service_timeout") {
      return {
        error: "the mail service did not answer in time",
        reason: error.code,
      };
    }
    if (error.code === "mail_request_cancelled") {
      return {
        error: "that request was cancelled before the service answered",
        reason: error.code,
      };
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
export function mailRefusal(error: unknown) {
  const fields = mailRefusalFields(error);
  return refusal(fields.error, fields.reason);
}

/** The same error as one code, for the log. An error that is not the client's
 *  own is an outage on this side of the boundary, and the log says so rather
 *  than naming a cause it guessed. */
export function mailOutcome(error: unknown): string {
  return error instanceof BrainMailClientError
    ? error.code
    : "mail_service_unavailable";
}

/** The codes a message may have gone out under. `/v1/send` builds the
 *  proposal, enqueues it durably and only then delivers
 *  (`lib/mail/service/outbound.ts`), so a client that stopped waiting has no
 *  idea which side of the enqueue it stopped on, and the outbox will deliver
 *  what it holds.
 *
 *  `mail_service_invalid_response` is here because every path that raises it
 *  runs after the request was written in full: the service answered with a
 *  body this client could not validate, or the response was cut off part way
 *  (`lib/mail/brain-mail-client.ts`). That is no less ambiguous than a
 *  timeout. */
const AMBIGUOUS_SEND_CODES: ReadonlySet<string> = new Set([
  "mail_service_timeout",
  "mail_request_cancelled",
  "mail_service_invalid_response",
]);

/** Whether a failure from the send call itself leaves the message's fate
 *  unknown. Only a throw from `sendMessage` may be asked: a failure before it
 *  told the service nothing to send.
 *
 *  Four things read as unknown. One of the codes above. A failure the service
 *  marked `enqueued`, which is the one case where the socket looks perfectly
 *  healthy from here: the request was answered, the code is the same one an
 *  outage carries, and the outbox is holding the message. Any client error
 *  raised once the request body had reached the socket, which is what
 *  `requestSent` carries: `mail_service_unavailable` is one code for a socket
 *  that never connected and one that died with the message already written,
 *  and only the client knows which happened. And anything that is not the
 *  client's own error at all, because for a message in the owner's name the
 *  safe reading of a failure nobody has a code for is "it may have gone out".
 *
 *  What stays a refusal is a failure before anything was sent: a connection
 *  refused, a validation Brain made itself, the owner's kill switch. */
export function isAmbiguousSendFailure(error: unknown): boolean {
  if (!(error instanceof BrainMailClientError)) return true;
  return (
    AMBIGUOUS_SEND_CODES.has(error.code) || error.enqueued || error.requestSent
  );
}

/** Every field a mail or task line may name. All of them are optional on
 *  `McpActivityEntry` and every caller passes the ones its own tool has, so
 *  one `Pick` serves the triage, the sends, the attachment save and the task
 *  writes without being widened again per caller. */
export type McpActivityTarget = Pick<
  McpActivityEntry,
  | "accountId"
  | "threadId"
  | "messageId"
  | "attachmentId"
  | "page"
  | "task"
  | "operationId"
  | "change"
>;

/** Every tool call that CHANGES something writes one line. Reads write none:
 *  an agent reading mail is the ordinary case and a log that recorded it
 *  would bury the sends. */
export async function logMailActivity(
  extra: { authInfo?: { clientId?: string } },
  tool: string,
  target: McpActivityTarget,
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
 *  Brain's own read. Reconnection comes first because it is the one the owner
 *  can act on today; an IMAP account with no SMTP endpoint was never set up to
 *  send; anything left is the relay this host cannot reach. Callers that
 *  answer `null` for an account that can send check `capabilities.send`
 *  themselves: this names the reason, and says nothing about whether one is
 *  wanted. */
export function sendBlockedReasonOf(account: PublicMailAccountV3): string {
  if (account.status === "reauth_required") return "account_reauth_required";
  if (account.providerKind === "imap" && account.smtp === undefined) {
    return "smtp_not_configured";
  }
  return "smtp_relay_unavailable";
}
