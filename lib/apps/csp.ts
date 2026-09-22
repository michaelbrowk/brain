/** WHAT AN APP MAY DO.
 *
 *  The frame gets an opaque origin — no `allow-same-origin` — so it has no
 *  cookies, no shared storage and no way to call Brain's API as the owner. On
 *  top of that the policy takes the network away entirely: `connect-src
 *  'none'` means there is no fetch, no XHR and no WebSocket out of an app,
 *  which is what makes "apps that reach the network" out of scope rather than
 *  a promise. Everything an app is allowed to reach goes through the bridge,
 *  where the host can see it.
 *
 *  `script-src` and `style-src` are `'unsafe-inline'` because an app IS an
 *  inline script and an inline stylesheet: the agent inlines its libraries
 *  into one file. That is not a loosening of Brain's own policy — the frame
 *  shares no origin with Brain and can reach nothing of Brain's.
 *
 *  NOTHING HERE SAYS `'self'`. The keyword means the protected resource's own
 *  origin, and this resource's origin is opaque, so `'self'` matches nothing:
 *  an app under `img-src 'self'` paints no asset and says nothing about why,
 *  because a violation inside an opaque-origin frame reaches no console
 *  anybody opens. Every source list names the origin outright, down to the
 *  app's own asset folder, so one app's frame can load one app's assets.
 *
 *  The origin is the public one the deployment configured, and otherwise the
 *  one the request came in on, never a header: `Host` and `X-Forwarded-Host`
 *  are the client's to set, and a policy built from one is a policy the
 *  client wrote. */
const ORIGIN = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/;
const PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function appFrameCsp(origin: string, pageId: string): string {
  // Both land in a header, so neither may carry a newline, a space or a
  // semicolon: a header split is how one policy becomes two.
  if (!ORIGIN.test(origin)) throw new Error("app frame CSP needs an exact origin");
  if (!PAGE_ID.test(pageId)) throw new Error("app frame CSP needs a page id");
  const assets = `${origin}/api/app/${pageId}/assets/`;
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    `img-src blob: data: ${assets}`,
    `font-src data: ${assets}`,
    `media-src data: ${assets}`,
    "connect-src 'none'",
    `frame-ancestors ${origin}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/** No `allow-same-origin`, which is the whole arrangement: without it the
 *  frame's origin is opaque and nothing inside it can read a cookie, a
 *  storage area or Brain's own DOM. Scripts, forms and modals are what an app
 *  needs to be an app. */
export const APP_FRAME_SANDBOX = "allow-scripts allow-forms allow-modals";
