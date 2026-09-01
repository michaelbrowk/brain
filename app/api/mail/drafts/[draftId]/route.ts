import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  readBoundedMailJson,
  runMailApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";
import { readAccountQuery } from "@/lib/mail/message-api-route";
import type {
  MailDraftDeleteInput,
  MailDraftMutationInput,
} from "@/lib/mail/draft-types";
import { MAIL_SERVICE_HTTP_LIMITS } from "@/lib/mail/service/limits";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ draftId: string }> };

export async function GET(request: Request, { params }: Context) {
  return runMailApiAction(async () => {
    const { draftId } = await params;
    return createBrainMailClient().getDraft(
      readAccountQuery(request, "mail_draft_request_invalid"),
      draftId,
      request.signal,
    );
  }, 1);
}

export async function PATCH(request: Request, { params }: Context) {
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
      createBrainMailClient().updateDraft(
        draftId,
        input as MailDraftMutationInput,
        request.signal,
      ),
    1,
  );
}

export async function DELETE(request: Request, { params }: Context) {
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
    input = await readBoundedMailJson(request);
  } catch (error) {
    return mailApiBodyError(error, "mail_draft_request_invalid", 1);
  }
  const { draftId } = await params;
  return runMailApiAction(
    () =>
      createBrainMailClient().deleteDraft(
        draftId,
        input as MailDraftDeleteInput,
        request.signal,
      ),
    1,
  );
}
