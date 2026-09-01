import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readOptionalSmtpEgressConfig,
  SMTP_EGRESS_CREDENTIAL_NAMES,
} from "./smtp-runtime-config";

const HMAC_KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("SMTP production egress configuration", () => {
  it("stays disabled without reading credentials", async () => {
    await expect(readOptionalSmtpEgressConfig({})).resolves.toBeNull();
    await expect(
      readOptionalSmtpEgressConfig({ BRAIN_MAIL_SMTP_EGRESS_ENABLED: "0" }),
    ).resolves.toBeNull();
  });

  it("reads the exact root-style systemd credentials for Cloudflare relay", async () => {
    const directory = await credentials();
    await expect(
      readOptionalSmtpEgressConfig({
        BRAIN_MAIL_SMTP_EGRESS_ENABLED: "1",
        BRAIN_MAIL_SMTP_EGRESS_URL: "wss://relay.example.test/v1/tunnel",
        BRAIN_MAIL_SMTP_EGRESS_ACCESS_ENABLED: "1",
        CREDENTIALS_DIRECTORY: directory,
      }),
    ).resolves.toEqual({
      url: "wss://relay.example.test/v1/tunnel",
      hmacKeyBase64Url: HMAC_KEY,
      accessClientId: "test-access-id",
      accessClientSecret: "test-access-secret",
    });
  });

  it("fails closed for unsafe URLs, partial flags, and public credentials", async () => {
    const directory = await credentials();
    await expect(
      readOptionalSmtpEgressConfig({
        BRAIN_MAIL_SMTP_EGRESS_ENABLED: "yes",
      }),
    ).rejects.toThrow("SMTP egress configuration is invalid");
    await expect(
      readOptionalSmtpEgressConfig({
        BRAIN_MAIL_SMTP_EGRESS_ENABLED: "1",
        BRAIN_MAIL_SMTP_EGRESS_URL: "wss://relay.example.test/v1/tunnel",
        CREDENTIALS_DIRECTORY: directory,
      }),
    ).rejects.toThrow("SMTP egress configuration is invalid");
    await expect(
      readOptionalSmtpEgressConfig({
        BRAIN_MAIL_SMTP_EGRESS_ENABLED: "1",
        BRAIN_MAIL_SMTP_EGRESS_URL:
          "wss://relay.example.test/v1/tunnel?secret=bad",
        BRAIN_MAIL_SMTP_EGRESS_ACCESS_ENABLED: "1",
        CREDENTIALS_DIRECTORY: directory,
      }),
    ).rejects.toThrow("SMTP egress configuration is invalid");
    await chmod(path.join(directory, SMTP_EGRESS_CREDENTIAL_NAMES.hmacKey), 0o644);
    await expect(
      readOptionalSmtpEgressConfig({
        BRAIN_MAIL_SMTP_EGRESS_ENABLED: "1",
        BRAIN_MAIL_SMTP_EGRESS_URL: "wss://relay.example.test/v1/tunnel",
        BRAIN_MAIL_SMTP_EGRESS_ACCESS_ENABLED: "1",
        CREDENTIALS_DIRECTORY: directory,
      }),
    ).rejects.toThrow("SMTP egress configuration is unavailable");
  });
});

async function credentials(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "brain-smtp-credentials-"));
  roots.push(directory);
  await chmod(directory, 0o700);
  await Promise.all([
    writeFile(
      path.join(directory, SMTP_EGRESS_CREDENTIAL_NAMES.hmacKey),
      HMAC_KEY,
      { mode: 0o600 },
    ),
    writeFile(
      path.join(directory, SMTP_EGRESS_CREDENTIAL_NAMES.accessClientId),
      "test-access-id",
      { mode: 0o600 },
    ),
    writeFile(
      path.join(directory, SMTP_EGRESS_CREDENTIAL_NAMES.accessClientSecret),
      "test-access-secret",
      { mode: 0o600 },
    ),
  ]);
  return directory;
}
