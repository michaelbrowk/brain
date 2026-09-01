import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiError,
  runMailAttachmentApiAction,
} from "@/lib/mail/account-api-route";
import { readAccountQuery } from "@/lib/mail/message-api-route";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ remoteImageId: string }> };

export async function GET(request: Request, { params }: Context) {
  if (request.headers.has("Range")) {
    return mailApiError(416, "mail_attachment_range_unsupported", 1);
  }
  return runMailAttachmentApiAction(async () => {
    const { remoteImageId } = await params;
    return createBrainMailClient().downloadRemoteImage(
      readAccountQuery(request),
      remoteImageId,
      request.signal,
    );
  });
}
