import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  readBoundedMailJson,
  runMailApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";
import type { MailSendInput } from "@/lib/mail/message-types";

export const dynamic = "force-dynamic";

// Kept in step with MAIL_SERVICE_HTTP_LIMITS.maxSendBodyBytes so the browser's
// own route admits the same message the service does.
const MAX_SEND_REQUEST_BYTES = 24 * 1024 * 1024;

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
