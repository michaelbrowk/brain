const RETURN_BASE = "https://brain-return.invalid";
const RAW_CONTROL_OR_BACKSLASH = /[\u0000-\u001f\u007f\\]/;
const ENCODED_CONTROL_OR_BACKSLASH = /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i;

/** The login page accepts a return target only for the OAuth consent screen.
 *  It deliberately does not act as a general-purpose post-login redirect. */
export function safeOAuthReturnTo(value: string | null | undefined): string {
  if (
    !value ||
    value.length > 16_384 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    RAW_CONTROL_OR_BACKSLASH.test(value) ||
    ENCODED_CONTROL_OR_BACKSLASH.test(value)
  ) {
    return "/";
  }
  try {
    const parsed = new URL(value, RETURN_BASE);
    if (
      parsed.origin !== RETURN_BASE ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.pathname !== "/oauth/authorize"
    ) {
      return "/";
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "/";
  }
}
