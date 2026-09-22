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
 *  decide for themselves, exactly as the attachment routes beside them do. */
describe("an app's own files at the session wall", () => {
  it("lets the entry and the assets through to the route that decides", async () => {
    expect(await wall("/api/app/app1/index.html")).toBe(200);
    expect(await wall("/api/app/app1/assets/cards/front.png")).toBe(200);
    // and the wall asked nothing of the session on the way
    expect(verifySession).not.toHaveBeenCalled();
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
