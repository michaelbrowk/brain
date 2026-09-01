import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  readBoundedMailJson,
  runMailThreadApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";
import type { MailSearchInput } from "@/lib/mail/message-types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const rejected = validateMailMutationRequest(
    request,
    true,
    false,
    "mail_request_invalid",
    1,
  );
  if (rejected) return rejected;

  let input: unknown;
  try {
    input = await readBoundedMailJson(request);
  } catch (error) {
    return mailApiBodyError(error, "mail_request_invalid", 1);
  }

  return runMailThreadApiAction(request, () =>
    createBrainMailClient().searchThreads(input as MailSearchInput, request.signal),
  );
}
