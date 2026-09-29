import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import { runMailApiAction } from "@/lib/mail/account-api-route";

export const dynamic = "force-dynamic";

/** Settings › Mail › Blocked senders: every blocked address and domain, newest
 *  first, with how many threads each block has archived. */
export async function GET(request: Request) {
  return runMailApiAction(
    () => createBrainMailClient().listBlockedSenders(request.signal),
    1,
  );
}
