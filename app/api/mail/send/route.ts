import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  readBoundedMailJson,
  runMailApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";
import type { MailSendInput } from "@/lib/mail/message-types";

export const dynamic = "force-dynamic";

// Kept in step with MAIL_SERVICE_HTTP_LIMITS.maxSendBodyBytes so the browser's
// own route admits the same message the service does.
const MAX_SEND_REQUEST_BYTES = 16 * 1024 * 1024;

export async function POST(request: Request) {
  const rejected = validateMailMutationRequest(
    request,
    true,
    false,
    "mail_send_request_invalid",
    1,
  );
  if (rejected) return rejected;
  let input: unknown;
  try {
    input = await readBoundedMailJson(request, MAX_SEND_REQUEST_BYTES);
  } catch (error) {
    return mailApiBodyError(error, "mail_send_request_invalid", 1);
  }
  /*
    `origin` is Brain's own record of who wrote a message: "mcp" is what earns
    the outbound MIME its `X-Brain-Agent` header, and it is what a person
    filters an agent's mail on. It is not the caller's to claim. Everything
    that reaches this route came through `hasExactSameOrigin`, so it is the
    owner's own browser, and the route stamps "app" itself whatever the body
    said. `agentLine` needs an "mcp" origin to do anything service-side, so
    the recipient-visible line goes with it.

    A body that is not an object is passed on untouched: the codec is the one
    place that says what a send request is, and its refusal names the request
    rather than an origin this route invented for it.
  */
  const owned: unknown =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? { ...(input as Record<string, unknown>), origin: "app" }
      : input;
  return runMailApiAction(
    () => createBrainMailClient().sendMessage(owned as MailSendInput, request.signal),
    1,
  );
}
