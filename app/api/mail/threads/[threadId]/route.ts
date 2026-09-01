import {
  createBrainMailClient,
} from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  readBoundedMailJson,
  runMailThreadApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";
import { readAccountQuery } from "@/lib/mail/message-api-route";
import type { MailThreadMutationInput } from "@/lib/mail/message-types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ threadId: string }> };

export async function GET(request: Request, { params }: Context) {
  return runMailThreadApiAction(request, async () => {
    const { threadId } = await params;
    return createBrainMailClient().getThread(
      readAccountQuery(request),
      threadId,
      request.signal,
    );
  });
}

export async function PATCH(request: Request, { params }: Context) {
  const rejected = validateMailMutationRequest(
    request,
    true,
    false,
    "mail_request_invalid",
    1,
  );
  if (rejected) return rejected;
  let mutation: unknown;
  try {
    mutation = await readBoundedMailJson(request);
  } catch (error) {
    return mailApiBodyError(error, "mail_request_invalid", 1);
  }
  const { threadId } = await params;
  return runMailThreadApiAction(
    request,
    () =>
      createBrainMailClient().updateThread(
        threadId,
        mutation as MailThreadMutationInput,
        request.signal,
      ),
  );
}
