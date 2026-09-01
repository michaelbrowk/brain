import { mailAddressesEquivalent } from "./address-identity";
import type { MailAddressProviderKind } from "./address-identity";
import type { MailAddress, MailMessageDto } from "./message-types";

const MAX_REPLY_RECIPIENTS = 100;
const MAX_FORWARDED_CONTEXT_BYTES = 256 * 1024;

export interface MailAccountIdentity {
  /** Provider-verified primary mailbox address. */
  readonly emailAddress: string;
  readonly providerKind: MailAddressProviderKind;
}

export interface ReplyRecipients {
  readonly to: readonly MailAddress[];
  readonly cc: readonly MailAddress[];
}

/**
 * Reply uses Reply-To when the sender supplied it. A sent message falls back to
 * its original recipients, while the active account and provider-equivalent
 * aliases are never copied back onto the draft.
 */
export function deriveReplyRecipients(
  message: MailMessageDto,
  account: MailAccountIdentity,
  knownCorrespondents: readonly MailAddress[] = [],
): ReplyRecipients {
  const primary = primaryReplyAddresses(message, knownCorrespondents);
  const recipient = [...primary, ...message.to, ...message.cc].find(
    (candidate) => !isSelf(candidate, account),
  );
  return Object.freeze({
    to: Object.freeze(recipient ? [recipient] : []),
    cc: Object.freeze([]),
  });
}

/**
 * Reply All preserves To/Cc roles after placing Reply-To (or From) first. The
 * provider-equivalent forms of the verified active account are excluded. Other
 * recipients are deduplicated only by exact case-insensitive mailbox address:
 * the active account's provider cannot prove how an external domain treats
 * dots or plus tags.
 */
export function deriveReplyAllRecipients(
  message: MailMessageDto,
  account: MailAccountIdentity,
  knownCorrespondents: readonly MailAddress[] = [],
): ReplyRecipients {
  const seen = new Set<string>();
  const add = (target: MailAddress[], candidate: MailAddress) => {
    const key = exactAddressKey(candidate.address);
    if (
      seen.size >= MAX_REPLY_RECIPIENTS ||
      isSelf(candidate, account) ||
      seen.has(key)
    ) {
      return;
    }
    target.push(candidate);
    seen.add(key);
  };

  const to: MailAddress[] = [];
  const cc: MailAddress[] = [];
  for (const candidate of [
    ...primaryReplyAddresses(message, knownCorrespondents),
    ...message.to,
  ]) {
    add(to, candidate);
  }
  for (const candidate of message.cc) add(cc, candidate);
  return Object.freeze({ to: Object.freeze(to), cc: Object.freeze(cc) });
}

export function forwardedSubject(subject: string | null): string {
  const normalized = sanitizeHeader(subject ?? "");
  if (normalized.length === 0) return "Fwd:";
  return /^(?:fwd?|fw):/i.test(normalized) ? normalized : `Fwd: ${normalized}`;
}

/**
 * Produces inert, bounded plain text only. It deliberately carries no provider
 * thread identifier and no attachment promise; the caller sends it as compose.
 */
export function forwardedPlainText(
  message: MailMessageDto,
  readableBody: string | null,
): string {
  const lines = [
    "---------- Forwarded message ----------",
    `From: ${formatAddresses(message.from ? [message.from] : [])}`,
    ...(message.sentAt === null
      ? []
      : [`Date: ${new Date(message.sentAt).toUTCString()}`]),
    `Subject: ${sanitizeHeader(message.subject ?? "")}`,
    `To: ${formatAddresses(message.to)}`,
    ...(message.cc.length === 0 ? [] : [`Cc: ${formatAddresses(message.cc)}`]),
    "",
    sanitizeBody(readableBody ?? message.snippet ?? "[Message content unavailable]"),
  ];
  return truncateUtf8(`\n\n${lines.join("\n")}`, MAX_FORWARDED_CONTEXT_BYTES);
}

function primaryReplyAddresses(
  message: MailMessageDto,
  knownCorrespondents: readonly MailAddress[],
): readonly MailAddress[] {
  if (message.replyTo.length > 0) return message.replyTo;
  if (message.from === null) return [];
  if (knownCorrespondents.length === 0) return [message.from];
  const knownKeys = new Set(
    knownCorrespondents.map((candidate) => exactAddressKey(candidate.address)),
  );
  const fromIsKnown = knownKeys.has(exactAddressKey(message.from.address));
  const hasKnownRecipient = [...message.to, ...message.cc].some((recipient) =>
    knownKeys.has(exactAddressKey(recipient.address)),
  );
  return fromIsKnown || !hasKnownRecipient ? [message.from] : [];
}

function isSelf(candidate: MailAddress, account: MailAccountIdentity): boolean {
  return mailAddressesEquivalent(
    candidate.address,
    account.emailAddress,
    account.providerKind,
  );
}

function exactAddressKey(value: string): string {
  return value.trim().toLowerCase();
}

function formatAddresses(addresses: readonly MailAddress[]): string {
  return addresses
    .map((value) => {
      const address = sanitizeHeader(value.address);
      const name = sanitizeHeader(value.name ?? "");
      return name.length === 0 ? address : `${name} <${address}>`;
    })
    .join(", ");
}

function sanitizeHeader(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

function sanitizeBody(value: string): string {
  return value.replaceAll("\u0000", "�").replace(/\r\n?/g, "\n");
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  const suffix = "…";
  const suffixBytes = encoder.encode(suffix).byteLength;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const size = encoder.encode(character).byteLength;
    if (bytes + size > maxBytes - suffixBytes) break;
    result += character;
    bytes += size;
  }
  return `${result}${suffix}`;
}
