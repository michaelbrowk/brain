import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  readBoundedMailJson,
  runMailThreadApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";
import type { MailThreadBatchInput } from "@/lib/mail/message-types";

export const dynamic = "force-dynamic";

/**
 * A section's Done for one account: up to fifty threads archived, and marked
 * read with `read`, in one request. The same door as a single thread's PATCH:
 * same origin, JSON, and the account-request body bound, which fifty of the
 * longest thread ids fit inside. The client and the service validate the
 * shape; this route only carries it.
 */
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
    createBrainMailClient().archiveThreads(
      input as MailThreadBatchInput,
      request.signal,
    ),
  );
}
