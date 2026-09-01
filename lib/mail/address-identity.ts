export type MailAddressProviderKind = "gmail" | "imap";

const GMAIL_CONSUMER_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export function mailAddressesEquivalent(
  left: string,
  right: string,
  providerKind: MailAddressProviderKind,
): boolean {
  const normalizedLeft = splitAddress(left);
  const normalizedRight = splitAddress(right);
  if (normalizedLeft === null || normalizedRight === null) {
    return left.trim().toLowerCase() === right.trim().toLowerCase();
  }
  if (providerKind !== "gmail") {
    return (
      normalizedLeft.local === normalizedRight.local &&
      normalizedLeft.domain === normalizedRight.domain
    );
  }

  const leftConsumer = GMAIL_CONSUMER_DOMAINS.has(normalizedLeft.domain);
  const rightConsumer = GMAIL_CONSUMER_DOMAINS.has(normalizedRight.domain);
  if (leftConsumer || rightConsumer) {
    return (
      leftConsumer &&
      rightConsumer &&
      withoutPlusTag(normalizedLeft.local).replaceAll(".", "") ===
        withoutPlusTag(normalizedRight.local).replaceAll(".", "")
    );
  }
  return (
    normalizedLeft.domain === normalizedRight.domain &&
    withoutPlusTag(normalizedLeft.local) === withoutPlusTag(normalizedRight.local)
  );
}

function splitAddress(
  value: string,
): { readonly local: string; readonly domain: string } | null {
  const normalized = value.trim().toLowerCase();
  const separator = normalized.lastIndexOf("@");
  if (separator < 1 || separator === normalized.length - 1) return null;
  return {
    local: normalized.slice(0, separator),
    domain: normalized.slice(separator + 1),
  };
}

function withoutPlusTag(local: string): string {
  const separator = local.indexOf("+");
  return separator === -1 ? local : local.slice(0, separator);
}
