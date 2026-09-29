import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  readBoundedMailJson,
  refuseMailAttachments,
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
  // The compose sheet's files ride on the send, never on the draft, and the
  // body carrying them was cut off by its bytes above (24 MiB, the service's
  // own draft body cap). What the codec refuses is answered here.
  const refused = refuseMailAttachments(input);
  if (refused) return refused;
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
