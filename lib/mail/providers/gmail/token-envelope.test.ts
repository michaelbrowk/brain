import { describe, expect, it } from "vitest";

import {
  destroyGmailOAuthGrant,
  GmailOAuthError,
  GMAIL_OAUTH_SCOPES,
  type GmailOAuthGrant,
} from "./oauth";
import {
  destroyStoredGmailCredential,
  openGmailTokenEnvelope,
  sealGmailTokenEnvelope,
  validateSealedGmailTokenEnvelope,
} from "./token-envelope";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const BINDING = Object.freeze({
  accountId: ACCOUNT_ID,
  kind: "oauth_refresh" as const,
  credentialRef: "credential-r22222222222222222222222222222222",
  version: 1,
});

describe("sealed Gmail token envelope", () => {
  it("encrypts tokens and identity metadata and opens them for the bound account", () => {
    const key = Buffer.alloc(32, 7);
    const grant = grantFixture();
    const envelope = sealGmailTokenEnvelope(grant, key, BINDING);
    const serialized = JSON.stringify(envelope);

    for (const secretOrMetadata of [
      "test-access-token",
      "test-refresh-token",
      "person@gmail.com",
      "google-subject-1",
      "gmail.modify",
    ]) {
      expect(serialized).not.toContain(secretOrMetadata);
    }
    expect(Object.keys(envelope)).toEqual(["schemaVersion", "encryption"]);
    expect(Object.keys(envelope.encryption)).toEqual([
      "algorithm",
      "iv",
      "ciphertext",
      "tag",
    ]);

    const opened = openGmailTokenEnvelope(envelope, key, BINDING);
    expect(opened).toMatchObject({
      credentialVersion: 1,
      provider: "gmail",
      subject: "google-subject-1",
      emailAddress: "person@gmail.com",
      scopes: GMAIL_OAUTH_SCOPES,
      grantedAt: 1_800_000_000_000,
    });
    expect(opened.refreshToken.toString("utf8")).toBe("test-refresh-token");
    expect("accessToken" in opened).toBe(false);
    expect("accessTokenExpiresAt" in opened).toBe(false);
    destroyStoredGmailCredential(opened);
    destroyGmailOAuthGrant(grant);
    key.fill(0);
  });

  it("authenticates ciphertext, key and account binding", () => {
    const key = Buffer.alloc(32, 7);
    const grant = grantFixture();
    const envelope = sealGmailTokenEnvelope(grant, key, BINDING);
    const tampered = structuredClone(envelope);
    const first = tampered.encryption.ciphertext[0];
    (tampered.encryption as { ciphertext: string }).ciphertext = `${
      first === "A" ? "B" : "A"
    }${tampered.encryption.ciphertext.slice(1)}`;

    expect(() => openGmailTokenEnvelope(tampered, key, BINDING)).toThrow(
      new GmailOAuthError("gmail_oauth_token_invalid"),
    );
    expect(() =>
      openGmailTokenEnvelope(envelope, Buffer.alloc(32, 8), BINDING),
    ).toThrow(new GmailOAuthError("gmail_oauth_token_invalid"));
    expect(() =>
      openGmailTokenEnvelope(
        envelope,
        key,
        { ...BINDING, accountId: "account-a22222222222222222222222222222222" },
      ),
    ).toThrow(new GmailOAuthError("gmail_oauth_token_invalid"));
    for (const binding of [
      { ...BINDING, credentialRef: "credential-r33333333333333333333333333333333" },
      { ...BINDING, version: 2 },
    ]) {
      expect(() => openGmailTokenEnvelope(envelope, key, binding)).toThrow(
        new GmailOAuthError("gmail_oauth_token_invalid"),
      );
    }
    destroyGmailOAuthGrant(grant);
    key.fill(0);
  });

  it("rejects malformed envelopes and invalid grants without partial output", () => {
    for (const value of [
      null,
      {},
      { schemaVersion: 2, encryption: {} },
      {
        schemaVersion: 1,
        encryption: {
          algorithm: "aes-256-gcm",
          iv: "not+base64url",
          ciphertext: "a",
          tag: "b",
        },
      },
    ]) {
      expect(() => validateSealedGmailTokenEnvelope(value)).toThrow(
        new GmailOAuthError("gmail_oauth_token_invalid"),
      );
    }

    const invalid = {
      ...grantFixture(),
      accessTokenExpiresAt: 1_800_000_000_000,
    };
    expect(() =>
      sealGmailTokenEnvelope(invalid, Buffer.alloc(32, 7), BINDING),
    ).toThrow(new GmailOAuthError("gmail_oauth_token_invalid"));
    destroyGmailOAuthGrant(invalid);
  });

  it("does not mutate the caller key or token buffers", () => {
    const key = Buffer.alloc(32, 7);
    const keyBefore = Buffer.from(key);
    const grant = grantFixture();
    const accessBefore = Buffer.from(grant.accessToken);
    const refreshBefore = Buffer.from(grant.refreshToken);

    sealGmailTokenEnvelope(grant, key, BINDING);

    expect(key).toEqual(keyBefore);
    expect(grant.accessToken).toEqual(accessBefore);
    expect(grant.refreshToken).toEqual(refreshBefore);
    key.fill(0);
    keyBefore.fill(0);
    accessBefore.fill(0);
    refreshBefore.fill(0);
    destroyGmailOAuthGrant(grant);
  });
});

function grantFixture(): GmailOAuthGrant {
  return Object.freeze({
    provider: "gmail",
    subject: "google-subject-1",
    emailAddress: "person@gmail.com",
    scopes: GMAIL_OAUTH_SCOPES,
    accessToken: Buffer.from("test-access-token"),
    refreshToken: Buffer.from("test-refresh-token"),
    accessTokenExpiresAt: 1_800_003_600_000,
    grantedAt: 1_800_000_000_000,
  });
}
