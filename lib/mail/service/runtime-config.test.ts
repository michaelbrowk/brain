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
  it("polls every minute, Gmail every twenty seconds, and holds IMAP IDLE when nothing is set", () => {
    expect(readMailSyncCadenceConfig({})).toEqual({
      intervalMs: 60_000,
      gmailIntervalMs: 20_000,
      imapIdle: true,
    });
  });

  it("takes both intervals and the IDLE switch from the environment", () => {
    expect(
      readMailSyncCadenceConfig({
        syncIntervalMs: "120000",
        gmailIntervalMs: "15000",
        imapIdle: "1",
      }),
    ).toEqual({ intervalMs: 120_000, gmailIntervalMs: 15_000, imapIdle: true });
    // A fallback set below the Gmail default carries Gmail down with it.
    expect(readMailSyncCadenceConfig({ syncIntervalMs: "10000" })).toEqual({
      intervalMs: 10_000,
      gmailIntervalMs: 10_000,
      imapIdle: true,
    });
    // `0` is the one way to turn IDLE off; the poll then carries IMAP alone.
    expect(readMailSyncCadenceConfig({ imapIdle: "0" })).toMatchObject({
      imapIdle: false,
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
      // The fallback is the slowest any account syncs, Gmail included.
      { syncIntervalMs: "30000", gmailIntervalMs: "40000" },
      { imapIdle: "" },
      { imapIdle: "true" },
      { imapIdle: "off" },
    ]) {
      expect(() => readMailSyncCadenceConfig(input), JSON.stringify(input)).toThrow();
    }
  });
});
