import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  mailApiError,
  readBoundedMailJson,
  runMailApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";
import { validateMailSenderDecisionInput } from "@/lib/mail/message-codec";
import type { MailSenderDecisionInput } from "@/lib/mail/message-types";

export const dynamic = "force-dynamic";

/** Accept or Block, for one address or everyone at its domain. The decision
 *  holds for every account; a block answers with the Inbox threads it moved
 *  to the archive, which the Undo of the same toast moves back. */
export async function POST(request: Request) {
  const rejected = validateMailMutationRequest(
    request,
    true,
    false,
    "mail_request_invalid",
    1,
  );
  if (rejected) return rejected;
  let body: unknown;
  try {
    body = await readBoundedMailJson(request);
  } catch (error) {
    return mailApiBodyError(error, "mail_request_invalid", 1);
  }
  let input: MailSenderDecisionInput;
  try {
    input = validateMailSenderDecisionInput(body);
  } catch {
    return mailApiError(400, "mail_request_invalid", 1);
  }
  return runMailApiAction(
    () => createBrainMailClient().decideSender(input, request.signal),
    1,
  );
}
