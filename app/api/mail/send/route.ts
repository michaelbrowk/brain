import { createBrainMailClient } from "@/lib/mail/brain-mail-client";
import {
  mailApiBodyError,
  mailApiError,
  readBoundedMailJson,
  runMailApiAction,
  validateMailMutationRequest,
} from "@/lib/mail/account-api-route";
import type { MailSendInput } from "@/lib/mail/message-types";
import {
  MAIL_SEND_ATTACHMENT_LIMITS,
  mailSendAttachmentBytes,
  validateMailSendAttachments,
} from "@/lib/mail/send-attachment-codec";

export const dynamic = "force-dynamic";

// Kept in step with MAIL_SERVICE_HTTP_LIMITS.maxSendBodyBytes so the browser's
// own route admits the same message the service does.
const MAX_SEND_REQUEST_BYTES = 24 * 1024 * 1024;

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
  /*
    The compose sheet's files arrive here as base64 inside the JSON, on the
    MCP tool's own wire and under its own codec. The body was cut off by its
    bytes above, before a character of it was parsed; what is left to ask is
    the codec's question, and it is asked here rather than a socket away so
    a refused file never travels on to the service and the sheet gets an
    answer it can word. A set over the total cap is a 413, the size the
    sheet says; anything else the codec refuses is the files' own 400. A
    body with no `attachments` at all is the codec's too, and the service's
    refusal of it names the request.
  */
  if (
    typeof input === "object" &&
    input !== null &&
    !Array.isArray(input) &&
    Object.prototype.hasOwnProperty.call(input, "attachments")
  ) {
    const refused = refuseAttachments((input as Record<string, unknown>).attachments);
    if (refused) return refused;
  }
  const owned: unknown =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? { ...(input as Record<string, unknown>), origin: "app" }
      : input;
  return runMailApiAction(
    () => createBrainMailClient().sendMessage(owned as MailSendInput, request.signal),
    1,
  );
}

function refuseAttachments(value: unknown): Response | null {
  try {
    validateMailSendAttachments(value);
    return null;
  } catch {
    // Which refusal it was is read off the sizes the codec measures, without
    // decoding a byte: a set whose payloads add up past the cap is too large
    // whatever else is wrong with it.
    const total = Array.isArray(value)
      ? value.reduce<number>((sum, entry: unknown) => {
          const data =
            typeof entry === "object" && entry !== null
              ? (entry as Record<string, unknown>).dataBase64
              : undefined;
          return typeof data === "string" ? sum + mailSendAttachmentBytes(data) : sum;
        }, 0)
      : 0;
    return total > MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes
      ? mailApiError(413, "mail_send_attachments_too_large", 1)
      : mailApiError(400, "mail_send_attachments_invalid", 1);
  }
}
