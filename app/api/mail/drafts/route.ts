import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  readBoundedMailJson,
  runMailApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";
import { readAccountQuery } from "@/lib/mail/message-api-route";
import type { MailDraftCreateInput } from "@/lib/mail/draft-types";
import { MAIL_SERVICE_HTTP_LIMITS } from "@/lib/mail/service/limits";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runMailApiAction(
    () =>
      createBrainMailClient().listDrafts(
        readAccountQuery(request, "mail_draft_request_invalid"),
        request.signal,
      ),
    1,
  );
}

export async function POST(request: Request) {
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
  return runMailApiAction(
    () =>
      createBrainMailClient().createDraft(
        input as MailDraftCreateInput,
        request.signal,
      ),
    1,
    (value) =>
      typeof value === "object" &&
      value !== null &&
      "created" in value &&
      value.created === true
        ? 201
        : 200,
  );
}
