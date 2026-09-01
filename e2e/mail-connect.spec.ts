import { expect, test, type Locator, type Page, type Route } from "playwright/test";

type Account = {
  accountId: string;
  emailAddress: string;
  displayName: string | null;
  status: "connected" | "reauth_required";
  connectedAt: number;
  createdAt: number;
  updatedAt: number;
  providerKind: "imap";
  imap: {
    hostname: string;
    port: number;
    tls: "implicit" | "starttls";
    username: string;
  };
};

async function login(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("Password").fill("e2e-password");
  const [response] = await Promise.all([
    page.waitForResponse(
      (candidate) =>
        candidate.url().endsWith("/api/auth") &&
        candidate.request().method() === "POST",
    ),
    page.getByRole("button", { name: "Sign in" }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(page).toHaveURL("/", { timeout: 20_000 });
}

function installMailAccountsRoute(page: Page) {
  let accounts: Account[] = [];
  const mutationBodies: unknown[] = [];
  let deletes = 0;

  const fulfill = (route: Route, body: unknown, status = 200) =>
    route.fulfill({
      status,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(body),
    });

  return page
    .route(/\/api\/mail\/accounts(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
      const request = route.request();
      const method = request.method();
      const pathname = new URL(request.url()).pathname;
      const accountId = pathname.split("/").at(-1);
      if (method === "GET") {
        await fulfill(
          route,
          pathname.endsWith("/capabilities")
            ? {
                apiVersion: 3,
                accounts: accounts.map((account) => ({
                  ...account,
                  capabilities: {
                    mailboxes: ["inbox"],
                    listThreads: true,
                    sync: true,
                    headerPreview: true,
                    messageBodies: true,
                    threadMutations: true,
                    compose: false,
                    send: false,
                    reply: false,
                  },
                })),
              }
            : { apiVersion: 2, accounts },
        );
        return;
      }
      if (method === "POST") {
        const body = request.postDataJSON() as {
          emailAddress: string;
          displayName: string | null;
          imap: Account["imap"] & { password: string };
        };
        mutationBodies.push(body);
        const now = 1_700_000_000_000 + accounts.length;
        const account: Account = {
          accountId: `account-a${String(accounts.length + 1).padStart(32, "0")}`,
          emailAddress: body.emailAddress,
          displayName: body.displayName,
          status: "connected",
          providerKind: "imap",
          connectedAt: now,
          createdAt: now,
          updatedAt: now,
          imap: {
            hostname: body.imap.hostname,
            port: body.imap.port,
            tls: body.imap.tls,
            username: body.imap.username,
          },
        };
        accounts = [...accounts, account];
        await fulfill(route, { apiVersion: 2, account });
        return;
      }
      const index = accounts.findIndex((account) => account.accountId === accountId);
      if (index < 0) {
        await fulfill(
          route,
          { apiVersion: 2, error: { code: "account_not_found" } },
          404,
        );
        return;
      }
      if (method === "PATCH") {
        const body = request.postDataJSON() as {
          emailAddress: string;
          displayName: string | null;
          imap: Account["imap"] & { password: string | null };
        };
        mutationBodies.push(body);
        const current = accounts[index];
        const account: Account = {
          ...current,
          emailAddress: body.emailAddress,
          displayName: body.displayName,
          updatedAt: current.updatedAt + 1,
          imap: {
            hostname: body.imap.hostname,
            port: body.imap.port,
            tls: body.imap.tls,
            username: body.imap.username,
          },
        };
        accounts = accounts.map((item) =>
          item.accountId === account.accountId ? account : item,
        );
        await fulfill(route, { apiVersion: 2, account });
        return;
      }
      if (method === "DELETE") {
        const [account] = accounts.splice(index, 1);
        accounts = [...accounts];
        deletes += 1;
        await fulfill(route, { apiVersion: 2, account });
        return;
      }
      await route.abort();
    })
    .then(() => ({
      readAccounts: () => accounts,
      readMutationBodies: () => mutationBodies,
      readDeletes: () => deletes,
    }));
}

/** The boundary and the surface both live on the Field atom's label — the
 *  input inside it is transparent and borderless. The boundary is the atom's
 *  1px ring (`box-shadow: 0 0 0 1px --hair-field`), the one hairline held to
 *  WCAG 1.4.11's 3:1 for a non-text control boundary. */
async function readFieldBoundary(input: Locator) {
  return input.evaluate((node) => {
    const element = node.closest("label.field") ?? node;
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("Canvas color conversion is unavailable");
    /** Paint `colors` in order onto one pixel — the canvas composites a
     *  translucent ring over the field's own paper the way the page does. */
    const rgb = (...colors: string[]) => {
      context.clearRect(0, 0, 1, 1);
      for (const color of colors) {
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
      }
      return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    };
    const luminance = (color: number[]) =>
      color
        .map((value) => {
          const channel = value / 255;
          return channel <= 0.04045
            ? channel / 12.92
            : ((channel + 0.055) / 1.055) ** 2.4;
        })
        .reduce(
          (sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index],
          0,
        );
    const styles = getComputedStyle(element);
    // computed box-shadow is "<color> 0px 0px 0px 1px" — everything before
    // the first length is the ring colour, whatever notation it resolves to
    const ring = styles.boxShadow.trim().replace(/\s*-?[\d.]+px[\s\S]*$/, "");
    if (!ring) throw new Error(`No ring on the field: "${styles.boxShadow}"`);
    const boundary = rgb(styles.backgroundColor, ring);
    const over = luminance(boundary);
    const surface = luminance(rgb(styles.backgroundColor));
    return {
      ratio: (Math.max(over, surface) + 0.05) / (Math.min(over, surface) + 0.05),
      boundary,
    };
  });
}

/** The same 3:1 for every state of the ring; `hue: "red"` also asserts the
 *  invalid one is red (`--hair-field-invalid`). The ring transitions over
 *  160ms, so a read taken the instant a form rejects a field lands on an
 *  interpolation between the old colour and the new one — poll until two
 *  reads agree. */
async function expectFieldBoundaryContrast(
  input: Locator,
  hue: "neutral" | "red" = "neutral",
) {
  const reads: Array<Awaited<ReturnType<typeof readFieldBoundary>>> = [];
  await expect
    .poll(
      async () => {
        reads.push(await readFieldBoundary(input));
        if (reads.length < 2) return false;
        const [previous, current] = reads.slice(-2);
        return previous.boundary.join() === current.boundary.join();
      },
      { timeout: 3_000 },
    )
    .toBe(true);
  const { ratio, boundary } = reads[reads.length - 1];
  expect(ratio).toBeGreaterThanOrEqual(3);
  if (hue === "red") {
    // the invalid ring is the one place the hue is the message. Compared as
    // composited channels, not as a colour string: the ring is authored in
    // oklch and Chromium is free to serialise it however it likes
    expect(boundary[0] - boundary[1]).toBeGreaterThan(40);
    expect(boundary[0] - boundary[2]).toBeGreaterThan(40);
  }
}

test("Mail stays first-class with zero accounts, then connects, edits, and removes one account", async ({
  page,
}, testInfo) => {
  const mailApi = await installMailAccountsRoute(page);
  await login(page);
  const sidebarMail = page
    .locator("aside.brain-sidebar")
    .getByRole("button", { name: "Mail", exact: true });

  await sidebarMail.click();
  await expect(page).toHaveURL("/mail");
  await expect(page.getByRole("heading", { name: "Mail", exact: true })).toBeVisible();
  await expect(page.getByText("Connect Gmail or a custom-domain mailbox")).toBeVisible();
  await page.getByRole("button", { name: "Connect account", exact: true }).click();

  // Connect account deep-links the Mail section of the settings surface
  await expect(page).toHaveURL("/settings/mail");
  const settings = page.getByTestId("mobile-settings-detail");
  await expect(settings).toBeVisible();
  await expect(
    page
      .locator("aside.brain-sidebar")
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name: "Mail", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await settings.getByRole("button", { name: "Connect account", exact: true }).click();
  const google = settings.getByRole("button", {
    name: "Google Gmail and Google Workspace",
  });
  await expect(google.locator("xpath=ancestor::form")).toHaveAttribute(
    "action",
    "/api/mail/oauth/google/start",
  );
  await expect(google.locator("xpath=ancestor::form")).toHaveAttribute("method", "post");
  await settings.getByRole("button", { name: "Other email Connect with IMAP" }).click();

  const name = settings.getByLabel("Name", { exact: true });
  const email = settings.getByLabel("Email");
  const hostname = settings.getByLabel("IMAP server");
  const username = settings.getByLabel("Username");
  const password = settings.getByLabel("Password or app password");
  await expect(settings.locator('form[autocomplete="off"]')).toBeVisible();
  await expect(username).toHaveAttribute(
    "autocomplete",
    "section-brain-mail username",
  );
  await expect(password).toHaveAttribute(
    "autocomplete",
    "section-brain-mail new-password",
  );
  await expectFieldBoundaryContrast(password);
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(true);
  await expectFieldBoundaryContrast(password);
  await page.emulateMedia({ colorScheme: "light" });
  await name.fill("Work");
  await email.fill("first@example.test");
  await expect(hostname).toHaveValue("imap.example.test");
  await expect(username).toHaveValue("first@example.test");
  await password.fill("e2e-app-password");
  await settings.getByText("Advanced", { exact: true }).click();
  await settings.getByLabel("Port").fill("7993");
  await settings.getByRole("button", { name: "Connect", exact: true }).click();

  await expect(settings).toBeHidden();
  await expect(page).toHaveURL("/mail");
  // The first account is a lone account, and mail opens straight into its
  // Inbox — the merge exists only once there is a second one to merge.
  const nav = page.locator('button[aria-label^="Mailbox: "]');
  // One control, and it names the destination the column stands at. No
  // second folder control anywhere, select or word.
  await expect(nav).toHaveAttribute("aria-label", "Mailbox: Inbox");
  await expect(page.locator("select")).toHaveCount(0);
  expect(mailApi.readAccounts()).toHaveLength(1);
  expect(mailApi.readMutationBodies()[0]).toEqual({
    providerKind: "imap",
    emailAddress: "first@example.test",
    displayName: "Work",
    imap: {
      hostname: "imap.example.test",
      port: 7993,
      tls: "implicit",
      username: "first@example.test",
      password: "e2e-app-password",
    },
  });
  await page.screenshot({
    path: testInfo.outputPath("mail-accounts-connected.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Settings", exact: true }).press("Enter");
  await expect(page).toHaveURL("/settings/appearance");
  await page
    .locator("aside.brain-sidebar")
    .getByRole("navigation", { name: "Settings sections" })
    .getByRole("button", { name: "Mail", exact: true })
    .click();
  await expect(page).toHaveURL("/settings/mail");
  await settings.getByRole("button", { name: /Work.*first@example\.test.*IMAP/ }).click();
  await settings.getByRole("button", { name: "Edit", exact: true }).click();
  await settings.getByLabel("IMAP server").fill("imap.attacker.test");
  await settings.getByRole("button", { name: "Save changes" }).click();
  await expect(settings.locator("#mail-password-error")).toHaveText(
    "Re-enter the password after changing the server, security, port, or username.",
  );
  // the rejected field says so itself: a red ring that still clears 3:1, in
  // both themes — the message alone sits in the other column
  const rejected = settings.getByLabel("Password or app password");
  await expectFieldBoundaryContrast(rejected, "red");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(true);
  await expectFieldBoundaryContrast(rejected, "red");
  await page.emulateMedia({ colorScheme: "light" });
  expect(mailApi.readMutationBodies()).toHaveLength(1);
  await settings.getByLabel("Password or app password").fill("new-app-password");
  await settings.getByRole("button", { name: "Save changes" }).click();
  await expect(settings.getByText("imap.attacker.test:7993")).toBeVisible();
  expect(mailApi.readMutationBodies()).toHaveLength(2);

  await settings.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(
    page.getByText("Nothing will be deleted from your mail provider."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Remove from Brain" }).click();
  await expect(settings.getByText("No mail accounts yet")).toBeVisible();
  expect(mailApi.readDeletes()).toBe(1);

  // Esc leaves the surface through history — back to Mail
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
  await expect(page).toHaveURL("/mail");
  await expect(page.getByRole("button", { name: "Connect account" })).toBeVisible();
});

test("@mobile Mail tab and full-screen account setup stay readable at 390 and 320", async ({
  page,
}, testInfo) => {
  await installMailAccountsRoute(page);
  await login(page);

  const primary = page.getByRole("navigation", { name: "Primary" });
  const mailTab = primary.getByRole("button", { name: "Mail", exact: true });
  await mailTab.click();
  await expect(page).toHaveURL("/mail");
  await expect(mailTab).toHaveAttribute("aria-current", "page");
  await expect(primary.getByRole("button", { name: "Settings" })).toHaveCount(0);
  await page.getByRole("button", { name: "Connect account", exact: true }).click();

  // the reauth-grade deep link: straight into /settings/mail, full screen
  await expect(page).toHaveURL("/settings/mail");
  const settings = page.getByTestId("mobile-settings-detail");
  await expect(settings).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await settings.getByRole("button", { name: "Connect account", exact: true }).click();
  await settings.getByRole("button", { name: "Other email Connect with IMAP" }).click();
  const inputs = settings.locator("input:not([type=radio])");
  await expect(inputs).toHaveCount(6);

  for (const width of [390, 320]) {
    const height = width === 390 ? 844 : 568;
    await page.setViewportSize({ width, height });
    await expect(settings).toBeVisible();
    const metrics = await inputs.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          fontSize: getComputedStyle(element).fontSize,
          left: rect.left,
          right: rect.right,
        };
      }),
    );
    for (const metric of metrics) {
      expect(metric.fontSize).toBe("16px");
      expect(metric.left).toBeGreaterThanOrEqual(0);
      expect(metric.right).toBeLessThanOrEqual(width);
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(0);
    if (width === 320) {
      await page.screenshot({
        path: testInfo.outputPath("mail-settings-fullscreen-320.png"),
        fullPage: true,
      });
    }
  }

  await page.goBack();
  await expect(settings).toBeHidden();
  await expect(page).toHaveURL("/mail");
});
