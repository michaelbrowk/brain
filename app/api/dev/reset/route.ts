import { NextResponse } from "next/server";
import { clearNotifications } from "@/lib/notifications/store";
import { shareOriginAllowed } from "@/lib/share-origin";
import { configuredPublicOrigin, getStore } from "@/lib/store";

/** THE HARNESS RESET, AND WHY IT IS A WIPE AND NOT A SWITCH.
 *
 *  Every Playwright spec file shares one dev server (`playwright.config.ts`
 *  runs one worker against one `webServer`), so what one file writes the next
 *  file reads. That made emptiness a property of the alphabet: `apps.spec.ts`
 *  answers three cards, the bell holds a row, and `notifications.spec.ts` —
 *  which sorts after it — could no longer assert the centre it was written to
 *  assert. `critical-flows.spec.ts` had the mirror of it, two pages titled
 *  `E2E note` on a server a second run reused, and a search palette that then
 *  matched both.
 *
 *  The obvious cure is a notes root per spec file, and this repository cannot
 *  move one at runtime: `NOTES_ROOT` in `lib/store/index.ts` is resolved once
 *  at module load, the `Store` is pinned to `globalThis` so every Next module
 *  layer shares one instance, and `/api/health`'s deep readiness fails on
 *  purpose when the active Store's root is not the configured one. So the
 *  harness gets a root that is emptied between files instead of exchanged, and
 *  it is emptied through the Store, which stays the only writer of the notes
 *  filesystem.
 *
 *  The centre is the half no owner route can do. There is no "clear" in the
 *  bell and there should not be one; `lib/notifications/store.ts` says why.
 *
 *  Five gates, and any one of them closed means this route does nothing:
 *  `BRAIN_E2E_RESET` set to exactly `1`, a `NODE_ENV` of `development` or
 *  `test`, the owner session that `proxy.ts` demands of everything under
 *  `/api/`, a POST — no other verb is exported, which is what makes Next answer
 *  405 — and an `Origin` that is this instance's own. A developer running
 *  `pnpm dev` over their own notes has the seam unset, so the answer they get is
 *  the 404 a route that is not there gives.
 *
 *  Not reset, on purpose: `_attachments`, because a spec that uploads a file
 *  addresses it by the id it was given, and an orphan blob under a temp root
 *  the harness deletes at exit is not state any assertion can see. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** An allowlist, not a denylist, and the form `app/dev/glass/page.tsx` already
 *  uses: a `NODE_ENV` of `prod`, `staging`, `Production` or nothing at all is a
 *  host that is not a test runner, and `!== "production"` read every one of
 *  them as unlocked. Turbopack folds this to a constant in a production build,
 *  so the wipe is not merely refused there, it is unreachable. */
function unlocked(): boolean {
  const environment = process.env.NODE_ENV;
  return (
    (environment === "development" || environment === "test") &&
    process.env.BRAIN_E2E_RESET === "1"
  );
}

export async function POST(request: Request) {
  if (!unlocked()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // The same Origin rule the link-visitor write surface applies, and for the
  // same residual attacker: the session cookie is `sameSite: "lax"`, so a
  // cross-site post never carries it, and what is left is a same-site caller —
  // another dev server on localhost, a sibling host under one registrable
  // domain. A write does not let the fetch-metadata attestation decide, so a
  // post with no Origin is refused; the harness posts from a page, and the
  // Fetch spec gives every non-GET an Origin.
  if (!shareOriginAllowed(request.headers, configuredPublicOrigin())) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  const store = await getStore();

  // Tasks first. A linked task's `done` lives on the note line, so deleting
  // the page first would leave the record with nothing to reconcile against.
  let tasks = 0;
  for (const task of store.allTasks()) {
    await store.deleteTask(task.id);
    tasks += 1;
  }

  // The roots only: `deletePage` marks a subtree, so a child deleted after its
  // parent is a delete of a page already in the trash.
  let pages = 0;
  for (const node of store.getTree()) {
    await store.deletePage(node.id);
    pages += 1;
  }
  // Soft delete is the whole of `deletePage`, and a trashed page is still a
  // file under the root that ripgrep reads. Purging is what makes the next
  // file's search answer its own.
  await store.emptyTrash();

  const notifications = await clearNotifications();
  return NextResponse.json(
    { ok: true, tasks, pages, notifications },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
