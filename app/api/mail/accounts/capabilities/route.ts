import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import { runMailApiAction } from "@/lib/mail/account-api-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runMailApiAction(() =>
    createBrainMailClient().listAccountCapabilities(request.signal),
  );
}
