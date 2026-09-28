import { BrainMailClientError } from "./brain-mail-client";

/** THE WORDS EVERY MAIL CALLER REFUSES IN.
 *
 *  The MCP reads, the triage, the sends and the attachment save each met the
 *  same service codes and each kept their own copy of the table that turns one
 *  into a sentence. The copies drifted: `mail_account_reauth_required` told an
 *  agent to reconnect the account in one tool and said nothing in another,
 *  for the same code off the same socket. One table is the fix, so a code
 *  reads the same wherever it is met.
 *
 *  It lives under `lib/mail` rather than beside the MCP tools because the
 *  every-account search (`search-all.ts`) writes these words into its
 *  per-account statuses, and that search answers the browser's palette as
 *  well as the agent. A refusal the palette shows and a refusal an agent reads
 *  for the same account down are the same sentence.
 *
 *  The table is the union of what the callers can be handed. A read never
 *  sees a `mail_send_*` code and a send never sees a draft's, so naming them
 *  all here costs a branch that cannot be taken rather than a behaviour.
 */

/** The service's own code, handed over as a reason a caller can act on. The
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
