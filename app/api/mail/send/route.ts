import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  readBoundedMailJson,
  runMailApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";
import type { MailSendInput } from "@/lib/mail/message-types";

export const dynamic = "force-dynamic";

const MAX_SEND_REQUEST_BYTES = 1_200_000;

export async function POST(request: Request) {
  const rejected = validateMailMutationRequest(
    request,
    true,
    false,
    "mail_send_request_invalid",
    1,
  );
  if (rejected) return rejected;
  let input: unknown;
  try {
    input = await readBoundedMailJson(request, MAX_SEND_REQUEST_BYTES);
  } catch (error) {
    return mailApiBodyError(error, "mail_send_request_invalid", 1);
  }
  return runMailApiAction(
    () => createBrainMailClient().sendMessage(input as MailSendInput, request.signal),
    1,
  );
}
