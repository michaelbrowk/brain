/**
 * The one Origin rule the link-visitor surface applies, so the guard that
 * checks the edit capability and the mint that hands it out cannot drift.
 *
 * Origin decides for every request that carries one, and a mutating request
 * must carry one: that is the rule lib/mail/providers/gmail/public-proxy.ts
 * applies to its POST. A cross-site form POST and a cross-site fetch both send
 * it, and a script cannot forge it, Origin being a forbidden header name.
 *
 * A same-origin GET carries no Origin at all. The Fetch spec appends one only
 * for a CORS-tainted request or a non-GET method, so the conflict refresh the
 * editor issues arrives bare. `Sec-Fetch-Site` is the browser's own account of
 * where the request came from, and it decides when it is there. When it is
 * absent too — an older browser, an in-app webview, a header-stripping proxy —
 * a read is admitted and the double submit two steps later decides instead: a
 * cross-site page cannot read the HttpOnly edit cookie, so it cannot echo the
 * `vid`, and a navigation cannot set a header at all. Failing closed here
 * bought nothing the double submit was not already buying, and cost a visitor
 * behind such a proxy every conflict banner they would ever see.
 */
export function shareOriginAllowed(
  headers: Headers,
  expected: string | null,
  options: { attestationMayDecide?: boolean } = {},
): boolean {
  const sent = headers.get("origin");
  if (sent !== null) return expected !== null && sent === expected;
  if (options.attestationMayDecide !== true) return false;
  const site = headers.get("sec-fetch-site");
  return site === null || site === "same-origin";
}
