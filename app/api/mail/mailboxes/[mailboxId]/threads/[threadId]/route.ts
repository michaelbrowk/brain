import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import { runMailThreadApiAction } from "@/lib/mail/account-api-route";
import { readAccountQuery } from "@/lib/mail/message-api-route";
import type { MailSystemMailbox } from "@/lib/mail/message-types";

export const dynamic = "force-dynamic";

type Context = {
  params: Promise<{ mailboxId: string; threadId: string }>;
};

export async function GET(request: Request, { params }: Context) {
  return runMailThreadApiAction(request, async () => {
    const { mailboxId, threadId } = await params;
    return createBrainMailClient().getMailboxThread(
      readAccountQuery(request),
      mailboxId as MailSystemMailbox,
      threadId,
      request.signal,
    );
  });
}
