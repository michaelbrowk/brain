// The service worker, in a real browser.
//
// It does NOT call pushManager.subscribe(). That reaches an external push
// service over the network, which CI has no route to and no stub for, and
// microsoft/playwright#23954 is still open on push testing in general. What is
// testable without leaving the machine is everything up to the subscribe: the
// script is served as JavaScript with the right headers, it registers, it
// activates, the PushManager is there, and the key the server hands out is a
// real uncompressed P-256 point.
//
// @release, because a worker that fails to register is invisible until
// somebody's phone stops ringing.
import { expect, test, type Page } from "playwright/test";

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("e2e-password");
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/auth") && candidate.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

test("@release the push worker is served, registers and activates", async ({ page, context }) => {
  await context.grantPermissions(["notifications"]);
  await login(page);

  const script = await page.request.get("/sw.js");
  expect(script.status()).toBe(200);
  expect(script.headers()["service-worker-allowed"]).toBe("/");
  expect(script.headers()["cache-control"]).toContain("no-cache");
  // ONE CONTENT TYPE, FROM ONE SOURCE. Next's static route types the file and
  // next.config.ts no longer restates it. Playwright joins repeated headers
  // with a comma, so a second source would show up here as a comma and a
  // browser would refuse the worker over it.
  expect(script.headers()["content-type"]).toContain("javascript");
  expect(script.headers()["content-type"]).not.toContain(",");

  // `navigator.serviceWorker.ready` resolves as soon as the registration has
  // an active worker, which is the START of activation and not its end: read
  // synchronously after it, the state is "activating" about half the time.
  // The assertion below still wants "activated", because a worker that never
  // finishes activating never receives a push, so the wait is here instead.
  const registered = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const ready = await navigator.serviceWorker.ready;
    const worker = ready.active;
    if (worker && worker.state !== "activated") {
      await new Promise<void>((resolve) => {
        const settle = () => {
          if (worker.state !== "activated") return;
          worker.removeEventListener("statechange", settle);
          resolve();
        };
        worker.addEventListener("statechange", settle);
        settle();
      });
    }
    return {
      scope: registration.scope,
      hasPushManager: "pushManager" in ready,
      state: worker?.state ?? null,
    };
  });
  // THE ORIGIN IS THE PAGE'S, NOT A PORT WRITTEN DOWN HERE. The harness takes
  // its port from BRAIN_E2E_PORT (playwright.config.ts), so a hard-coded 3021
  // failed this whole file on any run that moved the server, which is every
  // parallel run there has ever been. The scope is still asserted exactly: it
  // has to be the root, because a worker scoped anywhere else receives no push
  // for the pages that matter.
  expect(registered.scope).toBe(`${new URL(page.url()).origin}/`);
  expect(registered.hasPushManager).toBe(true);
  expect(registered.state).toBe("activated");
});

test("@release the served VAPID key decodes to a P-256 point", async ({ page }) => {
  await login(page);
  const key = await page.evaluate(async () => {
    const { publicKey } = await (await fetch("/api/push/key")).json();
    const raw = publicKey.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(raw + "=".repeat((4 - (raw.length % 4)) % 4));
    return { length: binary.length, first: binary.charCodeAt(0) };
  });
  expect(key.length).toBe(65);
  expect(key.first).toBe(4);
});

test("@release the bell opens the centre and says when nothing is waiting", async ({ page }) => {
  await login(page);

  // WHAT IS THE SERVER'S OWN HERE, AND WHAT STOPPED BEING SO.
  //
  // This case used to assert a centre with nothing in it, on the reasoning
  // that nothing on this server could put a row there: a row arrives through
  // the reminder scan or the mail poll, and the server runs with
  // BRAIN_REMINDERS=0 over a fresh temp notes root and no mail account.
  //
  // An app's write through the bridge is a third producer, and it needs no
  // scan and no poll: `e2e/apps.spec.ts` answers three cards and the centre
  // holds "Trainer updated Words" from that moment. Every spec shares one
  // server and that file sorts before this one, so emptiness is now a
  // property of the run order rather than of the server, and asserting it
  // would be asserting the alphabet.
  //
  // What is still the server's own is the shape of the answer and what the
  // bell does with it, which is what this asserts: the badge follows
  // `unread`, and the menu says "Nothing waiting" exactly when nothing is
  // waiting. Both are read off the centre this test fetched rather than
  // branched on, so a bell that drew the wrong half fails either way.
  //
  // The produced-row path is covered by
  // components/notifications-bell.test.tsx: the glyph per kind, the unread
  // mark, the open handler, and the counted mail row that opens Mail and
  // names no thread.
  // Read from the page's own session rather than through `page.request`: the
  // centre is behind the human-session gate and the API context does not carry
  // that cookie.
  const centre = await page.evaluate(async () => {
    const response = await fetch("/api/notifications");
    return {
      status: response.status,
      body: (await response.json()) as {
        notifications: unknown[];
        unread: number;
      },
    };
  });
  expect(centre.status).toBe(200);
  expect(Array.isArray(centre.body.notifications)).toBe(true);
  expect(typeof centre.body.unread).toBe("number");
  expect(centre.body.unread).toBeLessThanOrEqual(centre.body.notifications.length);

  const bell = page.getByRole("button", { name: /^Notifications/ });
  await expect(bell).toBeVisible();
  await expect(bell).toHaveAccessibleName(
    centre.body.unread > 0
      ? `Notifications, ${centre.body.unread} unread`
      : "Notifications",
  );
  await expect(page.locator(".brain-bell-badge")).toHaveCount(
    centre.body.unread > 0 ? 1 : 0,
  );

  await bell.click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByText("Nothing waiting")).toHaveCount(
    centre.body.notifications.length === 0 ? 1 : 0,
  );
});
