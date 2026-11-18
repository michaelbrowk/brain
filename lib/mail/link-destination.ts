/** Mail can name an absolute web address or a mail handler. It can never
 * resolve a relative address against the Brain application. */
export function mailLinkDestination(value: string | null | undefined): string | null {
  if (!value || value.length > 2048) return null;
  const trimmed = value.trim();
  const address = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  if (!/^(?:https?:\/\/|mailto:)/i.test(address) || /[\r\n\t\\]/.test(address)) return null;
  try {
    const url = new URL(address);
    if (url.username || url.password) return null;
    if (url.protocol === "mailto:" ? !url.pathname : !url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}
