import { SignJWT, jwtVerify } from "jose";
import { appFrameSigningKey } from "@/lib/auth";

/** WHY AN APP'S AUTHORITY IS IN ITS ADDRESS.
 *
 *  The frame is sandboxed without `allow-same-origin`, so its document has an
 *  opaque origin and EVERY subresource it asks for is a cross-site request.
 *  No SameSite cookie rides with one. The owner is signed in, the entry loads
 *  (that navigation is started by the same-site top document), and then the
 *  app's own `assets/card.png` arrives at the server carrying nothing at all.
 *  Chrome reports the result as `ERR_BLOCKED_BY_ORB`, with no CSP violation,
 *  no `securitypolicyviolation` event and no console line inside a sandbox
 *  nobody can open: the picture simply never appears.
 *
 *  A query string cannot carry it either. `assets/card.png` is relative, so it
 *  resolves against the path and drops the query, which is why a visitor's
 *  `?root=&v=` reached the entry and nothing after it.
 *
 *  So the grant sits in a path segment, where a relative URL carries it:
 *  `/api/app/<id>/t/<token>/index.html`, and `assets/card.png` beside it
 *  resolves to `/api/app/<id>/t/<token>/assets/card.png` on its own. The token
 *  is signed, short-lived and bound to one page, and the route reads no cookie
 *  at all: one authority, in one place, for the document and for every file
 *  under it.
 *
 *  It is a bearer capability and it is treated as one. Twelve hours for the
 *  owner. A visitor's dies with the share's own expiry, and sooner than that
 *  the moment the link is rotated: the version it names is compared with the
 *  live one on every request. */

/** The owner's window. Long enough that an app left open all day keeps
 *  working, short enough that a URL out of somebody's history is not a key. */
export const APP_FRAME_TOKEN_MAX_AGE_SECONDS = 12 * 60 * 60;

const ISSUER = "brain";
const AUDIENCE = "brain:app-frame";
const KIND = "app-frame";
const PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** What the bearer is allowed to be. `owner` is a signed-in session that has
 *  already been checked; `share` is a link visitor, and it carries the root
 *  they came through and the version that was live when they were let in. */
export type AppFrameGrant =
  | { readonly kind: "owner" }
  | { readonly kind: "share"; readonly root: string; readonly version: number };

export interface MintAppFrameToken {
  readonly pageId: string;
  readonly grant: AppFrameGrant;
  /** Absolute, in seconds since the epoch. The caller decides: the owner gets
   *  `APP_FRAME_TOKEN_MAX_AGE_SECONDS`, a visitor gets the sooner of that and
   *  the share's own expiry, so a token never outlives the link it came from. */
  readonly exp: number;
}

export async function mintAppFrameToken({
  pageId,
  grant,
  exp,
}: MintAppFrameToken): Promise<string> {
  if (!PAGE_ID.test(pageId)) throw new Error("an app frame token needs a page id");
  if (grant.kind === "share" && !PAGE_ID.test(grant.root)) {
    throw new Error("an app frame token needs a share root id");
  }
  return new SignJWT({ kind: KIND, grant })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(`app:${pageId}`)
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(appFrameSigningKey());
}

/** The grant this token carries for THIS page, or null for anything else: a
 *  forged or edited one, one that has expired, and one minted for another
 *  app. Null is the only failure, because every one of them is the same 404
 *  to the caller and telling them apart would be telling them which. */
export async function verifyAppFrameToken(
  token: string,
  pageId: string,
): Promise<AppFrameGrant | null> {
  if (!token || !PAGE_ID.test(pageId)) return null;
  try {
    const { payload } = await jwtVerify(token, appFrameSigningKey(), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: `app:${pageId}`,
    });
    if (payload.kind !== KIND) return null;
    const grant = payload.grant as AppFrameGrant | undefined;
    if (grant?.kind === "owner") return { kind: "owner" };
    if (
      grant?.kind === "share" &&
      typeof grant.root === "string" &&
      PAGE_ID.test(grant.root) &&
      Number.isInteger(grant.version)
    ) {
      return { kind: "share", root: grant.root, version: grant.version };
    }
    return null;
  } catch {
    return null;
  }
}
