import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  readBoundedMailJson,
  runMailApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";

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
  return runMailApiAction(
    () =>
      createBrainMailClient().syncAccount(
        input as { readonly accountId: string; readonly maxItems: number },
        request.signal,
      ),
    1,
  );
}
