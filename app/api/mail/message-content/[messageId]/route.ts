import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  runMailApiAction,
  validateEmptyMailMutationRequest,
} from "@/lib/mail/account-api-route";
import { readAccountQuery } from "@/lib/mail/message-api-route";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ messageId: string }> };

export async function GET(request: Request, { params }: Context) {
  return runMailApiAction(async () => {
    const { messageId } = await params;
    return createBrainMailClient().getMessageContent(
      readAccountQuery(request),
      messageId,
      request.signal,
    );
  }, 1);
}

export async function POST(request: Request, { params }: Context) {
  const rejected = await validateEmptyMailMutationRequest(
    request,
    "mail_content_request_invalid",
    1,
  );
  if (rejected) return rejected;
  const { messageId } = await params;
  return runMailApiAction(
    () =>
      createBrainMailClient().requestMessageContent(
        readAccountQuery(request),
        messageId,
        request.signal,
      ),
    1,
    202,
  );
}
