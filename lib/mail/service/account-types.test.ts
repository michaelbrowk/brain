import { describe, expect, it } from "vitest";

import {
  MailAccountError,
  publicMailAccount,
  publicMailAccountV2,
  validateMailAccountConnectInput,
  validateProvisionedImapAccount,
  validateStoredMailAccount,
} from "./account-types";

describe("mail account schemas", () => {
  it("normalizes one custom-domain IMAP account without exposing its password", () => {
    const input = validateMailAccountConnectInput({
      emailAddress: "person@example.test",
      imap: {
        hostname: "IMAP.EXAMPLE.TEST.",
        port: 993,
        tls: "implicit",
        username: "person@example.test",
        password: "test-only-password",
      },
    });

    expect(input.imap.hostname).toBe("imap.example.test");
    expect(publicMailAccount(accountFixture()).imap).toEqual({
      hostname: "imap.example.test",
      port: 993,
      tls: "implicit",
      username: "person@example.test",
    });
    expect(JSON.stringify(publicMailAccount(accountFixture()))).not.toContain(
      "password",
    );
  });

  it("canonicalizes a blank edit password to keep-existing", () => {
    expect(
      validateMailAccountConnectInput({
        emailAddress: "person@example.test",
        imap: {
          hostname: "imap.example.test",
          port: 993,
          tls: "implicit",
          username: "person@example.test",
          password: "",
        },
      }).imap.password,
    ).toBeNull();
  });

  it("validates and redacts an independent SMTP endpoint", () => {
    const input = validateMailAccountConnectInput({
      emailAddress: "person@example.test",
      imap: {
        hostname: "imap.example.test",
        port: 993,
        tls: "implicit",
        username: "imap-user@example.test",
        password: "test-only-password",
      },
      smtp: {
        hostname: "SMTP.EXAMPLE.TEST.",
        port: 587,
        tls: "starttls",
        username: "smtp-user@example.test",
      },
    });
    expect(input.smtp).toEqual({
      hostname: "smtp.example.test",
      port: 587,
      tls: "starttls",
      username: "smtp-user@example.test",
    });

    const account = validateProvisionedImapAccount({
      ...accountFixture(),
      smtp: {
        endpoint: input.smtp,
        username: input.smtp!.username,
        credentialRef: accountFixture().credentialRef,
        transportBindingRef: {
          id: "binding-r44444444444444444444444444444444",
          version: 1,
        },
      },
    });
    expect(publicMailAccount(account).smtp).toEqual(input.smtp);
    expect(JSON.stringify(publicMailAccount(account))).not.toMatch(
      /credential|binding|password/i,
    );
  });

  it("rejects one transport binding reused across IMAP and SMTP", () => {
    const account = accountFixture();
    expect(() =>
      validateProvisionedImapAccount({
        ...account,
        smtp: {
          endpoint: {
            hostname: "smtp.example.test",
            port: 465,
            tls: "implicit",
          },
          username: "person@example.test",
          credentialRef: account.credentialRef,
          transportBindingRef: account.transportBindingRef,
        },
      }),
    ).toThrowError(new MailAccountError("account_state_invalid"));
  });

  it("rejects a silent SMTP credential fallback to a different secret", () => {
    const account = accountFixture();
    expect(() =>
      validateProvisionedImapAccount({
        ...account,
        smtp: {
          endpoint: {
            hostname: "smtp.example.test",
            port: 587,
            tls: "starttls",
          },
          username: "person@example.test",
          credentialRef: {
            id: "credential-r55555555555555555555555555555555",
            version: 1,
          },
          transportBindingRef: {
            id: "binding-r44444444444444444444444444444444",
            version: 1,
          },
        },
      }),
    ).toThrowError(new MailAccountError("account_state_invalid"));
  });

  it("keeps credential and transport-binding references type-separated", () => {
    const account = accountFixture();
    expect(() =>
      validateProvisionedImapAccount({
        ...account,
        credentialRef: account.transportBindingRef,
      }),
    ).toThrowError(new MailAccountError("account_state_invalid"));
    expect(() =>
      validateProvisionedImapAccount({
        ...account,
        transportBindingRef: account.credentialRef,
      }),
    ).toThrowError(new MailAccountError("account_state_invalid"));
  });

  it("rejects absurd future timestamps in stored state", () => {
    expect(() =>
      validateProvisionedImapAccount(
        { ...accountFixture(), connectedAt: 10_000_001 },
        1,
      ),
    ).toThrowError(new MailAccountError("account_state_invalid"));
  });

  it("preserves the two public lifecycle states", () => {
    for (const status of ["connected", "reauth_required"] as const) {
      expect(
        validateStoredMailAccount({
          account: accountFixture(),
          providerKind: "imap",
          displayName: null,
          status,
          createdAt: 1,
          updatedAt: 1,
        }).status,
      ).toBe(status);
    }
  });

  it("returns the exact redacted Gmail public variant", () => {
    const publicAccount = publicMailAccountV2(
      validateStoredMailAccount(
        {
          account: {
            accountId: "account-a11111111111111111111111111111111",
            emailAddress: "person@gmail.com",
            subject: "google-subject-1",
            credentialRef: {
              id: "credential-r22222222222222222222222222222222",
              version: 2,
            },
            connectedAt: 2,
            grantedAt: 2,
          },
          providerKind: "gmail",
          displayName: "Personal",
          status: "connected",
          createdAt: 1,
          updatedAt: 2,
        },
        2,
      ),
    );
    expect(publicAccount).toEqual({
      accountId: "account-a11111111111111111111111111111111",
      emailAddress: "person@gmail.com",
      connectedAt: 2,
      providerKind: "gmail",
      displayName: "Personal",
      status: "connected",
      createdAt: 1,
      updatedAt: 2,
    });
    expect(JSON.stringify(publicAccount)).not.toMatch(
      /subject|credential|refresh|access/i,
    );
  });
});

function accountFixture() {
  return {
    accountId: "account-a11111111111111111111111111111111",
    emailAddress: "person@example.test",
    endpoint: {
      hostname: "imap.example.test",
      port: 993,
      tls: "implicit" as const,
    },
    username: "person@example.test",
    credentialRef: {
      id: "credential-r22222222222222222222222222222222",
      version: 1,
    },
    transportBindingRef: {
      id: "binding-r33333333333333333333333333333333",
      version: 1,
    },
    connectedAt: 1,
  };
}
