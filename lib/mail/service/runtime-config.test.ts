import { describe, expect, it } from "vitest";

import {
  readMailServiceRuntimePaths,
  readMailSyncCadenceConfig,
} from "./runtime-config";

describe("mail service runtime paths", () => {
  it("derives the fixed wrapping-key name from systemd directories", () => {
    expect(
      readMailServiceRuntimePaths({
        STATE_DIRECTORY: "/var/lib/brain-mail",
        CREDENTIALS_DIRECTORY: "/run/credentials/brain-mail.service",
      }),
    ).toEqual({
      stateDirectory: "/var/lib/brain-mail",
      credentialPath:
        "/run/credentials/brain-mail.service/account-wrapping-key",
    });
  });

  it("rejects missing, relative, and multi-directory environment values", () => {
    for (const stateDirectory of [
      undefined,
      "relative",
      "/var/lib/brain-mail:/other",
      "/var/lib/../lib/brain-mail",
    ]) {
      expect(() =>
        readMailServiceRuntimePaths({
          STATE_DIRECTORY: stateDirectory,
          CREDENTIALS_DIRECTORY: "/run/credentials/brain-mail.service",
        }),
      ).toThrow();
    }
  });
});

describe("mail sync cadence", () => {
  it("polls every minute, and Gmail every twenty seconds, when nothing is set", () => {
    expect(readMailSyncCadenceConfig({})).toEqual({
      intervalMs: 60_000,
      gmailIntervalMs: 20_000,
    });
  });

  it("takes both intervals from the environment", () => {
    expect(
      readMailSyncCadenceConfig({
        syncIntervalMs: "120000",
        gmailIntervalMs: "15000",
      }),
    ).toEqual({ intervalMs: 120_000, gmailIntervalMs: 15_000 });
    // A fallback set below the Gmail default carries Gmail down with it.
    expect(readMailSyncCadenceConfig({ syncIntervalMs: "10000" })).toEqual({
      intervalMs: 10_000,
      gmailIntervalMs: 10_000,
    });
  });

  it("refuses a value it would have to guess at", () => {
    for (const input of [
      { syncIntervalMs: "60s" },
      { syncIntervalMs: "" },
      { syncIntervalMs: "4999" },
      { syncIntervalMs: "3600001" },
      { gmailIntervalMs: "1e4" },
      { gmailIntervalMs: "20000.5" },
      // A Gmail cadence slower than the fallback would make the backoff a
      // speed-up.
      { syncIntervalMs: "30000", gmailIntervalMs: "40000" },
    ]) {
      expect(() => readMailSyncCadenceConfig(input), JSON.stringify(input)).toThrow();
    }
  });
});
