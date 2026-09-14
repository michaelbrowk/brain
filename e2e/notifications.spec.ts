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
  expect(script.headers()["content-type"]).toContain("javascript");

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
  expect(registered.scope).toBe("http://127.0.0.1:3021/");
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
