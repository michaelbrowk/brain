import { NextResponse } from "next/server";
import { clearNotifications } from "@/lib/notifications/store";
import { getStore } from "@/lib/store";

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
 *  Four gates, and any one of them closed means this route does not exist:
 *  `BRAIN_E2E_RESET` set to exactly `1`, a `NODE_ENV` that is not production,
 *  the owner session that `proxy.ts` demands of everything under `/api/`, and
 *  a POST. A developer running `pnpm dev` over their own notes has the seam
 *  unset, so the answer they get is the 404 a route that is not there gives.
 *
 *  Not reset, on purpose: `_attachments`, because a spec that uploads a file
 *  addresses it by the id it was given, and an orphan blob under a temp root
 *  the harness deletes at exit is not state any assertion can see. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function unlocked(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.BRAIN_E2E_RESET === "1";
}

export async function POST() {
  if (!unlocked()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
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
