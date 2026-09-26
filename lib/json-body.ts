/** THE ONE BODY TYPE A CROSS-SITE FORM CANNOT DECLARE.
 *
 *  A form can declare `application/x-www-form-urlencoded`,
 *  `multipart/form-data` or `text/plain`, and nothing else. A cross-site
 *  `fetch` that declares this one turns the request into a preflighted one, and
 *  Brain answers no preflight, so the browser never sends it.
 *
 *  That makes this the cheapest gate there is on a POST a stranger's browser
 *  could be made to send without a line of script — which matters most where the
 *  POST costs something. `/api/auth` runs bcrypt and spends a rate budget before
 *  it, so a cross-site `text/plain` form could drain the budget and burn the CPU
 *  from any page a visitor happened to open. Asked before either.
 *
 *  It is not a substitute for the Origin rule in `lib/share-origin.ts`: a
 *  non-browser client sets any header it likes. The two are asked together, and
 *  what bounds a client that lies is the rate budget. */
export function declaresJson(headers: Headers): boolean {
  const type = headers.get("content-type");
  return (
    type !== null && type.split(";", 1)[0].trim().toLowerCase() === "application/json"
  );
}
