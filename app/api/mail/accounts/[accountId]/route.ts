import {
  createBrainMailClient,
  type MailAccountPatchInputV2,
} from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  readBoundedMailJson,
  runMailApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ accountId: string }> };

export async function PATCH(request: Request, { params }: Context) {
  const rejected = validateMailMutationRequest(request, true);
  if (rejected) return rejected;
  let patch: MailAccountPatchInputV2;
  try {
    patch = (await readBoundedMailJson(request)) as MailAccountPatchInputV2;
  } catch (error) {
    return mailApiBodyError(error);
  }
  const { accountId } = await params;
  return runMailApiAction(() =>
    createBrainMailClient().updateAccount(accountId, patch, request.signal),
  );
}

export async function DELETE(request: Request, { params }: Context) {
  const rejected = validateMailMutationRequest(request, false, true);
  if (rejected) return rejected;
  const { accountId } = await params;
  return runMailApiAction(() =>
    createBrainMailClient().deleteAccount(accountId, request.signal),
  );
}
