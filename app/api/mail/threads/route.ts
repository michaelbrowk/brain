import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import { runMailThreadApiAction } from "@/lib/mail/account-api-route";
import { readThreadListQuery } from "@/lib/mail/message-api-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runMailThreadApiAction(request, async () => {
    const query = readThreadListQuery(request);
    return createBrainMailClient().listThreads(
      query.accountId,
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
