import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import { runMailApiAction } from "@/lib/mail/account-api-route";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ operationId: string }> };

export async function GET(request: Request, { params }: Context) {
  const { operationId } = await params;
  return runMailApiAction(
    () => createBrainMailClient().getSendOperation(operationId, request.signal),
    1,
  );
}
