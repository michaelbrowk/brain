// Owner-gate artifact capture for the settings content pass — run on demand:
//
//   SETTINGS_CONTENT_SHOTS=1 BRAIN_E2E_PORT=3041 BRAIN_DIST_DIR=.next/e2esc \
//     pnpm exec playwright test e2e/settings-content-shots.spec.ts --project=chromium
//
// Screenshots land in docs/design/settings-content/. Mail accounts, the
// backup snapshot, and MCP settings are route-mocked — a sandbox stand has no
// mail service, no backup history, and no MCP grant. Skipped everywhere else
// so the full e2e suite never rewrites the artifacts on disk.
//
// The directory it writes into is on the publication denylist
// (scripts/publication-denylist.mjs), so this repository carries none of
// these frames. Shoot them, read them, throw them away — but do not commit
// them here: the forbidden-path step of `pnpm check` refuses a tracked path
// the list names.

import { expect, test, type Page } from "playwright/test";
import path from "node:path";

const OUT = path.join(process.cwd(), "docs", "design", "settings-content");

test.skip(
  process.env.SETTINGS_CONTENT_SHOTS !== "1",
  "artifact capture — run with SETTINGS_CONTENT_SHOTS=1",
);

const WORK_ADDRESS = "p.hartington@company-name.example.test";

const ACCOUNTS = [
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
    // a work address of a realistic length: the form's control column has to
    // hold it, and the Edit form is where it is read rather than typed
    emailAddress: WORK_ADDRESS,
    displayName: "Work",
    status: "reauth_required",
    providerKind: "imap",
    imap: {
      hostname: "imap.company-name.example.test",
      port: 993,
      tls: "implicit",
      username: WORK_ADDRESS,
    },
    connectedAt: 1_755_000_000_000,
    createdAt: 1_755_000_000_000,
    updatedAt: 1_755_000_000_000,
  },
];

const BACKUP_OK = {
  apiVersion: 1,
  policy: { cadence: "daily", staleAfterSeconds: 129_600, retainsUpTo: 7 },
  stale: false,
  lastAttempt: {
    outcome: "success",
    startedAt: "2026-08-24T03:00:00Z",
    finishedAt: "2026-08-24T03:04:10Z",
    failureCode: null,
  },
  lastVerifiedBackup: {
    verifiedAt: "2026-08-24T03:04:10Z",
    notesCommit: "9f2c1ab4d5e6f708192a3b4c5d6e7f8091a2b3c4",
    extractionRehearsal: "passed",
  },
  retainedVerifiedArchives: 7,
  issues: [],
};

// today's run failed, so the panel leads with the failure and falls back to
// the last archive that did verify. `stale` stays false: the service sets it
// from the age of the last attempt, and this one ran hours ago
const BACKUP_FAILED = {
  ...BACKUP_OK,
  stale: false,
  lastAttempt: {
    outcome: "failed",
    startedAt: "2026-08-24T03:00:00Z",
    finishedAt: "2026-08-24T03:00:12Z",
    failureCode: "archive_check_failed",
  },
  lastVerifiedBackup: {
    verifiedAt: "2026-08-21T03:04:10Z",
    notesCommit: "9f2c1ab4d5e6f708192a3b4c5d6e7f8091a2b3c4",
    extractionRehearsal: "passed",
  },
  retainedVerifiedArchives: 3,
  issues: [],
};

// the other half of `stale`: nothing has been attempted since the window
// closed. The lead still names the attempt that did run, so the stale row
// has to say which window was missed instead of denying it
const BACKUP_STALE = {
  ...BACKUP_OK,
  stale: true,
  lastAttempt: {
    outcome: "success",
    startedAt: "2026-08-20T03:00:00Z",
    finishedAt: "2026-08-20T03:04:10Z",
    failureCode: null,
  },
  lastVerifiedBackup: {
    verifiedAt: "2026-08-20T03:04:10Z",
    notesCommit: "9f2c1ab4d5e6f708192a3b4c5d6e7f8091a2b3c4",
    extractionRehearsal: "passed",
  },
  retainedVerifiedArchives: 4,
  issues: [],
};

const MCP = {
  endpoint: "https://brain.example/api/mcp",
  token: "brain_live_7f3c9a12d4e5",
  oauth: {
    issuer: "https://brain.example",
    authorizationEndpoint: "https://brain.example/oauth/authorize",
  },
  connectedApps: [
    {
      grantId: "grant-1",
      clientId: "client-claude",
      clientName: "Claude Desktop",
      scopes: ["brain:read", "brain:write"],
      connectedAt: 1_755_000_000_000,
    },
  ],
};

const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(body),
});

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

async function setScheme(page: Page, scheme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: scheme });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(scheme === "dark");
}

const shot = async (page: Page, name: string) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
};

/** Walk the IMAP form to the state the shot needs. */
async function openImapForm(page: Page) {
  const settings = page.getByTestId("mobile-settings-detail");
  await settings.getByRole("button", { name: "Add account", exact: true }).click();
  await settings.getByRole("button", { name: "Other email Connect with IMAP" }).click();
  await expect(settings.getByLabel("IMAP server")).toBeVisible();
  return settings;
}

test("capture the settings content artifacts", async ({ page }) => {
  test.setTimeout(240_000);
  await page.route(/\/api\/mail\/accounts(?:\?.*)?$/, (route) =>
    route.fulfill(json({ apiVersion: 2, accounts: ACCOUNTS })),
  );
  await page.route(/\/api\/settings\/mcp$/, (route) => route.fulfill(json(MCP)));
  let backup: unknown = BACKUP_OK;
  await page.route(/\/api\/settings\/backup$/, (route) => route.fulfill(json(backup)));

  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const scheme of ["light", "dark"] as const) {
    await setScheme(page, scheme);

    // quick capture on the hub — proves the Field atom change did not
    // regress the one paper field outside settings
    await page.goto("/");
    await expect(page.getByPlaceholder("New thought…")).toBeVisible();
    // the hub autofocuses quick capture; the shot is about the rest ring
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await shot(page, `hub-quick-capture-${scheme}`);

    // the account list: the reauth account wears a state badge
    await page.goto("/settings/mail");
    await expect(page.getByText(WORK_ADDRESS)).toBeVisible();
    await shot(page, `mail-list-${scheme}`);

    // account details — an IMAP account in reauth names its repair in the
    // row that states the problem
    let settings = page.getByTestId("mobile-settings-detail");
    await settings.getByRole("button", { name: /Work/ }).click();
    // One "Edit" — the group's nav row. The reauth row beside it names its
    // own repair ("Update password") rather than repeating the nav row's.
    await expect(settings.getByRole("button", { name: "Edit", exact: true })).toHaveCount(1);
    await expect(
      settings.getByRole("button", { name: "Update password", exact: true }),
    ).toHaveCount(1);
    await shot(page, `mail-details-${scheme}`);

    // the Edit form, arriving pre-filled: the control column has to hold a
    // real address, and Advanced is open so Port keeps its own width
    await settings.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(settings.getByLabel("Email")).toHaveValue(WORK_ADDRESS);
    await settings.getByText("Advanced", { exact: true }).click();
    await expect(settings.getByLabel("Port")).toBeVisible();
    await shot(page, `mail-edit-form-${scheme}`);

    // the add-account form at rest
    await page.goto("/settings/mail");
    await expect(page.getByText(WORK_ADDRESS)).toBeVisible();
    settings = await openImapForm(page);
    await shot(page, `mail-add-form-${scheme}`);

    // a Field under the pointer
    await settings.getByLabel("IMAP server").hover();
    await shot(page, `mail-field-hover-${scheme}`);

    // a Field holding keyboard focus. Name validates nothing on blur, so
    // tabbing off it lands on Email with the form still clean — the field's
    // own blue ring is its focus state for every modality (DESIGN.md §8)
    await settings.getByLabel("Name", { exact: true }).click();
    await page.keyboard.press("Tab");
    await shot(page, `mail-field-focus-${scheme}`);

    // the form in its error state: submit empty, then blur each field
    await page.goto("/settings/mail");
    await expect(page.getByText(WORK_ADDRESS)).toBeVisible();
    settings = await openImapForm(page);
    await settings.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(settings.getByText("Enter a complete email address.")).toBeVisible();
    await shot(page, `mail-add-form-error-${scheme}`);

    // connections
    await page.goto("/settings/connections");
    await expect(page.getByText("Claude Desktop")).toBeVisible();
    await shot(page, `connections-${scheme}`);

    // data — the backup panel, verified then failed
    backup = BACKUP_OK;
    await page.goto("/settings/data");
    await expect(page.getByText("Extraction verified")).toBeVisible();
    await shot(page, `data-backups-${scheme}`);

    backup = BACKUP_FAILED;
    await page.goto("/settings/data");
    await expect(page.getByText("Archive extraction failed")).toBeVisible();
    await shot(page, `data-backups-failed-${scheme}`);

    backup = BACKUP_STALE;
    await page.goto("/settings/data");
    await expect(page.getByText("older than the 36-hour window")).toBeVisible();
    await shot(page, `data-backups-stale-${scheme}`);
  }
});
