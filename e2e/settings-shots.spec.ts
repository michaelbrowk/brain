// Owner-gate artifact capture for the settings surface — run on demand:
//
//   SETTINGS_SHOTS=1 pnpm exec playwright test e2e/settings-shots.spec.ts
//
// Screenshots land in docs/design/settings/. Skipped everywhere else so the
// full e2e suite never rewrites the committed artifacts.
import { expect, test, type Page } from "playwright/test";
import path from "node:path";

const OUT = path.join(process.cwd(), "docs", "design", "settings");

test.skip(
  process.env.SETTINGS_SHOTS !== "1",
  "artifact capture — run with SETTINGS_SHOTS=1",
);

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("e2e-password");
  await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/auth") &&
        candidate.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

function installMailAccountsRoute(page: Page) {
  const accounts = [
    {
      accountId: `account-a${"0".repeat(32)}`,
      emailAddress: "misha@example.test",
      displayName: "Personal",
      status: "connected",
      providerKind: "gmail",
      connectedAt: 1_755_000_000_000,
      createdAt: 1_755_000_000_000,
      updatedAt: 1_755_000_000_000,
    },
    {
      accountId: `account-b${"0".repeat(32)}`,
      emailAddress: "work@example.test",
      displayName: "Work",
      status: "reauth_required",
      providerKind: "imap",
      imap: {
        hostname: "imap.example.test",
        port: 993,
        tls: "implicit",
        username: "work@example.test",
      },
      connectedAt: 1_755_000_000_000,
      createdAt: 1_755_000_000_000,
      updatedAt: 1_755_000_000_000,
    },
  ];
  return page.route(/\/api\/mail\/accounts(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ apiVersion: 2, accounts }),
    }),
  );
}

async function setScheme(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(scheme === "dark");
}

test("capture desktop settings artifacts", async ({ page }) => {
  test.setTimeout(120_000);
  await installMailAccountsRoute(page);
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const scheme of ["light", "dark"] as const) {
    await setScheme(page, scheme);

    await page.goto("/settings/appearance");
    await expect(page.getByTestId("mobile-settings-detail")).toBeVisible();
    await expect(page.getByText("Reading typeface")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `appearance-${scheme}.png`) });

    await page.goto("/settings/mail");
    await expect(page.getByText("misha@example.test")).toBeVisible();
    await expect(page.getByText("work@example.test")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `mail-${scheme}.png`) });

    await page.goto("/settings/data");
    await expect(page.getByText("Export all notes")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, `data-${scheme}.png`) });
  }
});

test("capture sidebar slot back-row artifacts", async ({ page }) => {
  test.setTimeout(120_000);
  await installMailAccountsRoute(page);
  // the mail surface reads /api/mail/accounts/capabilities (apiVersion 3) —
  // one connected gmail account so the mail column renders at all
  await page.route(/\/api\/mail\/accounts\/capabilities(?:\?.*)?$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({
        apiVersion: 3,
        accounts: [
          {
            accountId: `account-a${"0".repeat(32)}`,
            emailAddress: "misha@example.test",
            displayName: "Personal",
            status: "connected",
            providerKind: "gmail",
            connectedAt: 1_755_000_000_000,
            createdAt: 1_755_000_000_000,
            updatedAt: 1_755_000_000_000,
            capabilities: {
              mailboxes: ["inbox", "starred", "sent", "all", "spam", "trash"],
              listThreads: true,
              sync: true,
              headerPreview: true,
              messageBodies: true,
              threadMutations: true,
              compose: true,
              send: true,
              reply: true,
            },
          },
        ],
      }),
    }),
  );
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await setScheme(page, "light");
  const sidebar = page.locator("aside.brain-sidebar");
  const backRow = sidebar.getByRole("button", { name: "Back", exact: true });

  await page.goto("/settings/appearance");
  await expect(page.getByTestId("mobile-settings-detail")).toBeVisible();
  await expect(backRow).toBeVisible();
  await page.waitForTimeout(400);
  await sidebar.screenshot({
    path: path.join(OUT, "slot-back-settings-light.png"),
  });

  // Mail no longer takes the panel over: it navigates itself from the head of
  // its own column, so the panel keeps the tree and there is no back row to
  // shoot. What is worth the frame is that the Mail row marks itself.
  await page.goto("/mail");
  await expect(backRow).toHaveCount(0);
  await expect(
    sidebar.getByRole("button", { name: "Mail", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await page.waitForTimeout(400);
  await sidebar.screenshot({
    path: path.join(OUT, "slot-mail-selected-light.png"),
  });
});

test("capture mobile settings artifacts", async ({ page }) => {
  test.setTimeout(120_000);
  await installMailAccountsRoute(page);
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });

  for (const scheme of ["light", "dark"] as const) {
    await setScheme(page, scheme);

    await page.goto("/settings");
    await expect(page.getByTestId("mobile-settings-root")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(OUT, `mobile-root-${scheme}.png`),
    });

    await page
      .getByTestId("mobile-settings-root")
      .getByRole("button", { name: "Appearance", exact: true })
      .click();
    await expect(page).toHaveURL("/settings/appearance");
    await expect(page.getByTestId("mobile-settings-detail")).toBeVisible();
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(OUT, `mobile-appearance-${scheme}.png`),
    });
  }
});
