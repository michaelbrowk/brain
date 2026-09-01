import { defineConfig, devices } from "playwright/test";

const e2ePort = process.env.BRAIN_E2E_PORT ?? "3021";
const e2eOrigin = `http://127.0.0.1:${e2ePort}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: e2eOrigin,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      grepInvert: /@mobile/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "mobile-chromium",
      grep: /@mobile/,
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: "node scripts/e2e-dev.mjs",
    url: `${e2eOrigin}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
