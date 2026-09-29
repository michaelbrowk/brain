import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiError,
  runMailApiAction,
  validateEmptyMailMutationRequest,
} from "@/lib/mail/account-api-route";
import { validateMailSenderDecisionId } from "@/lib/mail/message-codec";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ decisionId: string }> };

/** Removes a decision. Without a query it is the toast's Undo, and a block's
 *  archived threads go back to the Inbox. `?restore=false` is the Blocked
 *  list's Unblock: future letters stop being archived and old ones stay put. */
export async function DELETE(request: Request, { params }: Context) {
  const rejected = await validateEmptyMailMutationRequest(
    request,
    "mail_request_invalid",
    1,
  );
  if (rejected) return rejected;
  const { decisionId } = await params;
  const restore = readRestore(new URL(request.url).searchParams);
  let safeDecisionId: string;
  try {
    safeDecisionId = validateMailSenderDecisionId(decisionId);
  } catch {
    return mailApiError(400, "mail_request_invalid", 1);
  }
  if (restore === null) return mailApiError(400, "mail_request_invalid", 1);
  return runMailApiAction(
    () =>
      createBrainMailClient().undoSenderDecision(
        safeDecisionId,
        { restore },
        request.signal,
      ),
    1,
  );
}

function readRestore(query: URLSearchParams): boolean | null {
  const keys = [...query.keys()];
  if (keys.length === 0) return true;
  if (keys.length !== 1 || keys[0] !== "restore") return null;
  const value = query.get("restore");
  return value === "false" ? false : value === "true" ? true : null;
}
