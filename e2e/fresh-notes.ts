import { expect, test } from "playwright/test";

/** A NOTEBOOK PER SPEC FILE, ON ONE SHARED SERVER.
 *
 *  `playwright.config.ts` runs one worker against one `webServer`, so every
 *  file here reads what the file before it wrote. Twice that turned into a
 *  failure that had nothing to do with the code under test:
 *  `notifications.spec.ts` asserted an empty bell that `apps.spec.ts` had
 *  already put a row in, and `critical-flows.spec.ts` searched for `E2E note`
 *  on a reused server that held two of them.
 *
 *  Calling `freshNotes()` at the top of a spec file registers one `beforeAll`
 *  that empties the notebook and the notification centre, so the file's
 *  premises are its own. It is per FILE and not per case: a case that seeds a
 *  fixture two cases in the same file also seed still has to tell them apart by
 *  name, which is what the run tags in `apps.spec.ts` are for. It is safe only
 *  while one file runs at a time, which the hook itself checks.
 *
 *  The reset itself is `app/api/dev/reset/route.ts`, which says why the root is
 *  emptied rather than exchanged and what the four gates on it are. The call
 *  goes out of a real page rather than out of an `APIRequestContext`: the
 *  session cookie is `Secure` and `HttpOnly`, and a request context does not
 *  carry it, which is the same reason `notifications.spec.ts` reads the centre
 *  through `page.evaluate`. */
export function freshNotes(): void {
  test.beforeAll(async ({ browser }, workerInfo) => {
    // ONE WORKER IS WHAT MAKES THIS SAFE, SO IT IS CHECKED AND NOT ASSUMED.
    //
    // A wipe is scoped to a file only while one file runs at a time. With two
    // workers against one server and one notes root, this hook deletes the pages
    // another file is mid-test on, and the failure shows up as that other file's
    // assertions going strange rather than as anything to do with a reset.
    // `playwright.config.ts` says `workers: 1` and `playwright-config.test.ts`
    // holds it there; a `--workers=2` on the command line answers to neither,
    // which is why the run checks itself here.
    if (workerInfo.config.workers !== 1) {
      throw new Error(
        `freshNotes() empties the notes root of the whole server, which is only safe one file at a time, and this run has ${workerInfo.config.workers} workers. Drop the --workers override, or take freshNotes() out of every spec file before raising it.`,
      );
    }
    const baseURL = workerInfo.project.use.baseURL;
    expect(baseURL, "the project has no baseURL to reset against").toBeTruthy();
    const page = await browser.newPage({ baseURL });
    try {
      await page.goto("/login");
      await page.getByPlaceholder("Password").fill("e2e-password");
      const [signedIn] = await Promise.all([
        page.waitForResponse(
          (candidate) =>
            candidate.url().endsWith("/api/auth") &&
            candidate.request().method() === "POST",
        ),
        page.getByRole("button", { name: "Sign in" }).click(),
      ]);
      expect(signedIn.status(), "the reset could not sign in").toBe(200);
      await expect(page).toHaveURL("/", { timeout: 30_000 });
      const reset = await page.evaluate(async () => {
        const response = await fetch("/api/dev/reset", { method: "POST" });
        return { status: response.status, body: await response.text() };
      });
      // A 404 here is the seam unset, which means the harness was not started
      // by `scripts/e2e-dev.mjs`. Say that rather than let the file run on
      // whatever the last one left behind.
      expect(
        reset.status,
        `POST /api/dev/reset answered ${reset.status}: ${reset.body}`,
      ).toBe(200);
    } finally {
      await page.close();
    }
  });
}
