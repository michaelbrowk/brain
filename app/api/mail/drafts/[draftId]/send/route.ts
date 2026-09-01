import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  readBoundedMailJson,
  runMailApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";
import type { MailDraftMutationInput } from "@/lib/mail/draft-types";
import { MAIL_SERVICE_HTTP_LIMITS } from "@/lib/mail/service/limits";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ draftId: string }> };

export async function POST(request: Request, { params }: Context) {
  const rejected = validateMailMutationRequest(
    request,
    true,
    false,
    "mail_draft_request_invalid",
    1,
  );
  if (rejected) return rejected;
  let input: unknown;
  try {
    input = await readBoundedMailJson(
      request,
      MAIL_SERVICE_HTTP_LIMITS.maxDraftBodyBytes,
    );
  } catch (error) {
    return mailApiBodyError(error, "mail_draft_request_invalid", 1);
  }
  const { draftId } = await params;
  return runMailApiAction(
    () =>
      createBrainMailClient().sendDraft(
        draftId,
        input as MailDraftMutationInput,
        request.signal,
      ),
    1,
    202,
  );
}
