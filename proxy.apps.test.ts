import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const verifySession = vi.fn();
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "brain_session", verifySession }));

const { proxy } = await import("./proxy");

/** What the wall does with one path for a caller carrying no session. 200
 *  means it passed through to the route, which is then the one that decides. */
async function wall(pathname: string): Promise<number> {
  const answer = await proxy(
    new NextRequest(new URL(pathname, "https://brain.example")),
  );
  return answer.status;
}

beforeEach(() => {
  vi.clearAllMocks();
  verifySession.mockResolvedValue(false);
});

/** THE WALL AND THE FRAME.
 *
 *  An app runs in a frame with an opaque origin. Two consequences the session
 *  wall has to know about, and neither of them is obvious from the path:
 *
 *  Every subresource the frame asks for is a CROSS-SITE request, so no
 *  SameSite cookie rides with it. The owner is signed in and their app's own
 *  image still arrives at the wall with nothing on it.
 *
 *  And a link visitor has no session at all, for the entry as well as for the
 *  assets.
 *
 *  A 401 from the wall in either case is invisible: a blocked subresource
 *  inside an opaque-origin frame reaches no console the owner will open, and
 *  the app simply never shows the picture. So the app routes pass the wall and
 *  decide for themselves, exactly as the attachment routes beside them do.
 *
 *  The opening is ONE SHAPE, not the `/api/app/` prefix: `/t/` is where the
 *  grant lives, and it is the only address under that prefix a caller can
 *  reach without a cookie. Everything else there is the owner's and same-site,
 *  so a route added beside these is behind the wall by default rather than in
 *  front of it by accident. */
describe("an app's own files at the session wall", () => {
  it("lets the entry and the assets through to the route that decides", async () => {
    const token = "head.body.signature";
    expect(await wall(`/api/app/app1/t/${token}/index.html`)).toBe(200);
    expect(await wall(`/api/app/app1/t/${token}/assets/cards/front.png`)).toBe(200);
    // and the wall asked nothing of the session on the way
    expect(verifySession).not.toHaveBeenCalled();
  });

  it("keeps the mint behind the wall, because its caller is same-site", async () => {
    // `POST /api/app/<id>/frame` hands out a capability, and the shell that
    // asks for it carries the session. It walls itself as well, and that is
    // the belt: this is the braces, and it is what makes a route added under
    // `/api/app/` tomorrow private until somebody says otherwise.
    expect(await wall("/api/app/app1/frame")).toBe(401);
    expect(await wall("/api/app/app1/frame/")).toBe(401);
    expect(await wall("/api/app//frame")).toBe(401);
  });

  it("opens the grant's shape and nothing else under the same prefix", async () => {
    // `/t/` with nothing after it is still the frame's shape, and the route
    // behind it answers 404 for a path it will not address. What matters here
    // is that the wall does not decide that; the route does.
    expect(await wall("/api/app/app1/t/")).toBe(200);
    // These are not that shape. Whatever they are, they are not cookie-free.
    expect(await wall("/api/app/app1")).toBe(401);
    expect(await wall("/api/app/app1/")).toBe(401);
    expect(await wall("/api/app/app1/state.json")).toBe(401);
    expect(await wall("/api/app/app1/t")).toBe(401);
  });

  it("lets a visitor's read side through, and only that one", async () => {
    expect(await wall("/api/app-bridge/app1/share")).toBe(200);
    expect(await wall("/api/app-bridge/app1/share?root=root1&v=2")).toBe(200);
  });

  it("keeps the three write doors behind it", async () => {
    // These are the owner's, and they are where `owns`, the rev and the size
    // caps are enforced. A visitor reaching one at all would be a bug the
    // route's own refusal should never have to catch.
    expect(await wall("/api/app-bridge/app1/state")).toBe(401);
    expect(await wall("/api/app-bridge/app1/page")).toBe(401);
    expect(await wall("/api/app-bridge/app1/page/words1")).toBe(401);
    expect(await wall("/api/app-bridge/app1/share/extra")).toBe(401);
  });

  it("changes nothing about the rest of the API", async () => {
    expect(await wall("/api/tree")).toBe(401);
    expect(await wall("/api/page/p1")).toBe(401);
    // A path that merely starts with the same letters is not an app's file.
    expect(await wall("/api/apples")).toBe(401);
  });
});
