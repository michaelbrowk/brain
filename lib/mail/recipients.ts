/**
 * The single definition of "a list of recipients".
 *
 * The composer stores raw address text and the Mail service turns that text
 * into an SMTP envelope at send. Every layer in between used to parse it on its
 * own terms, so the composer accepted lists the service refused with an opaque
 * `mail_draft_request_invalid`, and the outbox re-derived a different envelope
 * than the one it had just committed. This module owns the whole contract:
 * splitting, address extraction, normalization, deduplication and bounds.
 *
 * It deliberately depends on no Node global so the browser and the private mail
 * service enforce exactly the same boundary, in the manner of `search-query.ts`.
 *
 * The accept set is the intersection of every validator downstream, so anything
 * accepted here survives `message-codec`, `outbound` and the RFC 2822 builder
 * unchanged. Display names are dropped rather than encoded: the wire format
 * carries bare addr-specs only, and widening that is a separate decision.
 */

const UTF8 = new TextEncoder();

/** Matches `outbound-message.ts`, which caps what may enter an address header. */
export const MAIL_MAX_RECIPIENT_BYTES = 254;

/** Matches the service limit on a single message's total recipients. */
export const MAIL_MAX_RECIPIENTS = 100;

/** An addr-spec safe to fold into a header: one `@`, no space, no brackets. */
const ADDR_SPEC = /^[^<>@\s",;:\\[\]\u0000-\u001f\u007f]+@[^<>@\s",;:\\[\]\u0000-\u001f\u007f]+$/;

/** A deliverable domain has at least one dot and no empty label. */
const DELIVERABLE_DOMAIN = /^[^.]+(?:\.[^.]+)*\.[^.]+$/;

export type MailRecipientField = "to" | "cc" | "bcc";

export type MailRecipientProblem =
  | {
      readonly kind: "invalid_address";
      readonly field: MailRecipientField;
      readonly token: string;
    }
  | { readonly kind: "no_recipients" }
  | { readonly kind: "too_many_recipients"; readonly count: number };

export interface MailRecipientFields {
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
}

export interface MailRecipientLists {
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
}

export type MailRecipientParse =
  | { readonly ok: true; readonly recipients: MailRecipientLists }
  | { readonly ok: false; readonly problem: MailRecipientProblem };

const FIELD_ORDER: readonly MailRecipientField[] = ["to", "cc", "bcc"];

const FIELD_LABEL: Readonly<Record<MailRecipientField, string>> = {
  to: "To",
  cc: "Cc",
  bcc: "Bcc",
};

/**
 * Splits one address field into the tokens a writer meant, honouring quoted
 * display names and angle brackets so `"Smith, Alice" <a@example.test>` stays
 * one recipient. Empty tokens are dropped, which is what a trailing separator
 * means. A newline is never a separator: the draft codec refuses one outright,
 * and treating it as structure would soften a header-injection boundary.
 */
export function splitMailRecipientText(value: string): readonly string[] {
  const tokens: string[] = [];
  let token = "";
  let quoted = false;
  let angled = false;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      token += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      token += character;
      continue;
    }
    if (!quoted && character === "<") angled = true;
    if (!quoted && character === ">") angled = false;
    if (!quoted && !angled && (character === "," || character === ";")) {
      if (token.trim() !== "") tokens.push(token.trim());
      token = "";
      continue;
    }
    token += character;
  }
  if (token.trim() !== "") tokens.push(token.trim());
  return tokens;
}

/**
 * Reduces one token to the addr-spec that may be folded into a header, or null
 * when it is not an address. A display name is discarded, never encoded.
 *
 * A token is one of exactly two shapes: a bare addr-spec, or a display name and
 * a single balanced `<…>` mailbox closing the token. A token carrying a second
 * mailbox is refused, not resolved. Reading the *last* bracket pair silently
 * addressed the last mailbox, so `Alice <alice@example.test> <eve@evil.test>`
 * left for Eve while the writer read Alice's name in the composer. No reading
 * of such a token is safe, because the two mailboxes disagree about intent.
 */
export function normalizeMailRecipient(token: string): string | null {
  const trimmed = token.trim();
  const opened = trimmed.indexOf("<");
  const closed = trimmed.indexOf(">");
  let candidate = trimmed;
  if (opened !== -1 || closed !== -1) {
    // Exactly one mailbox: the first bracket opens it and the last character
    // closes it. A display name holding `@` is a second mailbox, not a name.
    if (opened === -1 || closed !== trimmed.length - 1) return null;
    if (trimmed.slice(0, opened).includes("@")) return null;
    candidate = trimmed.slice(opened + 1, closed).trim();
  }
  if (candidate.includes("<") || candidate.includes(">")) return null;
  const address = candidate.toLowerCase();
  if (!ADDR_SPEC.test(address)) return null;
  if (UTF8.encode(address).byteLength > MAIL_MAX_RECIPIENT_BYTES) return null;
  const domain = address.slice(address.indexOf("@") + 1);
  if (!DELIVERABLE_DOMAIN.test(domain)) return null;
  return address;
}

/**
 * Parses a whole envelope. Recipients are deduplicated across the three fields
 * in To → Cc → Bcc order, so repeating a person in Cc costs them a copy rather
 * than failing the send. Dropping a duplicate can never misdeliver a message.
 */
export function parseMailRecipientFields(
  fields: MailRecipientFields,
): MailRecipientParse {
  const lists: Record<MailRecipientField, string[]> = { to: [], cc: [], bcc: [] };
  const seen = new Set<string>();
  let count = 0;
  for (const field of FIELD_ORDER) {
    for (const token of splitMailRecipientText(fields[field])) {
      const address = normalizeMailRecipient(token);
      if (address === null) {
        return Object.freeze({
          ok: false as const,
          problem: Object.freeze({
            kind: "invalid_address" as const,
            field,
            token,
          }),
        });
      }
      if (seen.has(address)) continue;
      seen.add(address);
      count += 1;
      if (count > MAIL_MAX_RECIPIENTS) {
        return Object.freeze({
          ok: false as const,
          problem: Object.freeze({
            kind: "too_many_recipients" as const,
            count,
          }),
        });
      }
      lists[field].push(address);
    }
  }
  if (count === 0) {
    return Object.freeze({
      ok: false as const,
      problem: Object.freeze({ kind: "no_recipients" as const }),
    });
  }
  return Object.freeze({
    ok: true as const,
    recipients: Object.freeze({
      to: Object.freeze(lists.to),
      cc: Object.freeze(lists.cc),
      bcc: Object.freeze(lists.bcc),
    }),
  });
}

/** The writer-facing sentence for a problem. One wording, one contract. */
export function describeMailRecipientProblem(
  problem: MailRecipientProblem,
): string {
  if (problem.kind === "no_recipients") return "Add at least one recipient.";
  if (problem.kind === "too_many_recipients") {
    return `A message can reach ${MAIL_MAX_RECIPIENTS} recipients at most.`;
  }
  return `${FIELD_LABEL[problem.field]} “${problem.token}” is not an email address.`;
}
