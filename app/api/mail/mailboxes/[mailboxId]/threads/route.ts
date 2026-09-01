import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import { runMailThreadApiAction } from "@/lib/mail/account-api-route";
import { readThreadListQuery } from "@/lib/mail/message-api-route";
import type { MailSystemMailbox } from "@/lib/mail/message-types";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ mailboxId: string }> };

export async function GET(request: Request, { params }: Context) {
  return runMailThreadApiAction(request, async () => {
    const query = readThreadListQuery(request);
    const { mailboxId } = await params;
    return createBrainMailClient().listMailboxThreads(
      query.accountId,
      mailboxId as MailSystemMailbox,
      {
        cursor: query.cursor,
        limit: query.limit,
        view: query.view,
        sort: query.sort,
      },
      request.signal,
    );
  });
}
