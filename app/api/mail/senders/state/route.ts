import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  mailApiError,
  readBoundedMailJson,
  runMailApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";
import { validateMailSenderScreenInput } from "@/lib/mail/message-codec";

export const dynamic = "force-dynamic";

/** The new-senders switch. Settings reads it; turning it on is the moment the
 *  service computes who is already known, and off lets every letter through
 *  as it always did. */
export async function GET(request: Request) {
  return runMailApiAction(
    () => createBrainMailClient().getSenderScreenState(request.signal),
    1,
  );
}

export async function PUT(request: Request) {
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
  let input: { readonly enabled: boolean };
  try {
    input = validateMailSenderScreenInput(body);
  } catch {
    return mailApiError(400, "mail_request_invalid", 1);
  }
  return runMailApiAction(
    () => createBrainMailClient().setSenderScreenEnabled(input.enabled, request.signal),
    1,
  );
}
