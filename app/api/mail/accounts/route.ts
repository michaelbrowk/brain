import {
  createBrainMailClient,
  type MailAccountCreateInputV2,
} from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  readBoundedMailJson,
  runMailApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return runMailApiAction(() =>
    createBrainMailClient().listAccounts(request.signal),
  );
}

export async function POST(request: Request) {
  const rejected = validateMailMutationRequest(request, true);
  if (rejected) return rejected;
  let input: MailAccountCreateInputV2;
  try {
    input = (await readBoundedMailJson(request)) as MailAccountCreateInputV2;
  } catch (error) {
    return mailApiBodyError(error);
  }
  return runMailApiAction(() =>
    createBrainMailClient().createAccount(input, request.signal),
  );
}
