import { describe, expect, it } from "vitest";

import type { MultiMailAccountStore } from "./account-store";
import type { StoredImapMailAccount } from "./account-types";
import { StoredMailProtocolAccessResolver } from "./account-access";

describe("stored mail protocol access resolver", () => {
  it("returns redacted protocol endpoints and caller-owned password bytes", async () => {
    const stored = fixture();
    const resolver = new StoredMailProtocolAccessResolver(store(stored));

    const smtp = await resolver.resolveSmtpAccess(stored.account.accountId);
    const imap = await resolver.resolveImapAccess(stored.account.accountId);
    expect(smtp).toMatchObject({
      endpoint: stored.account.smtp!.endpoint,
      username: stored.account.smtp!.username,
    });
    expect(imap).toMatchObject({
      endpoint: stored.account.endpoint,
      username: stored.account.username,
    });
    expect(JSON.stringify({ smtp, imap })).not.toMatch(/password|credential/i);

    const password = await smtp!.readPassword();
    expect(password.toString("utf8")).toBe("test-mailbox-password");
    password.fill(0);
  });

  it("fails closed when an account changes between endpoint and secret reads", async () => {
    const stored = fixture();
    let current = stored;
    const resolver = new StoredMailProtocolAccessResolver(store(() => current));
    const smtp = await resolver.resolveSmtpAccess(stored.account.accountId);
    current = {
      ...stored,
      account: {
        ...stored.account,
        credentialRef: { ...stored.account.credentialRef, version: 2 },
        smtp: {
          ...stored.account.smtp!,
          credentialRef: { ...stored.account.credentialRef, version: 2 },
        },
      },
    };

    await expect(smtp!.readPassword()).rejects.toThrow(
      "mail account access changed during resolution",
    );
  });

  it("does not expose SMTP for receive-only or reauth-required accounts", async () => {
    const receiveOnly = fixture({ smtp: false });
    const reauth = fixture({ status: "reauth_required" });
    await expect(
      new StoredMailProtocolAccessResolver(store(receiveOnly)).resolveSmtpAccess(
        receiveOnly.account.accountId,
      ),
    ).resolves.toBeNull();
    await expect(
      new StoredMailProtocolAccessResolver(store(reauth)).resolveImapAccess(
        reauth.account.accountId,
      ),
    ).resolves.toBeNull();
  });
});

function store(
  source: StoredImapMailAccount | (() => StoredImapMailAccount),
): MultiMailAccountStore {
  const read = () => (typeof source === "function" ? source() : source);
  return {
    localSchemaVersion: 2,
    initialize: async () => undefined,
    close: () => undefined,
    countAccounts: async () => 1,
    listAccounts: async () => [read()],
    readAccount: async () => read(),
    loadProvisionedAccount: async () => ({
      stored: read(),
      password: Buffer.from("test-mailbox-password"),
    }),
    save: async () => undefined,
    updateMetadata: async () => undefined,
    loadGmailCredential: async () => null,
    deleteAccount: async () => true,
  };
}

function fixture(options?: {
  readonly smtp?: boolean;
  readonly status?: "connected" | "reauth_required";
}): StoredImapMailAccount {
  const credentialRef = {
    id: `credential-r${"2".repeat(32)}`,
    version: 1,
  };
  return {
    account: {
      accountId: `account-a${"1".repeat(32)}`,
      emailAddress: "person@example.test",
      endpoint: { hostname: "imap.example.test", port: 993, tls: "implicit" },
      username: "imap-user@example.test",
      credentialRef,
      transportBindingRef: {
        id: `binding-r${"3".repeat(32)}`,
        version: 1,
      },
      ...(options?.smtp === false
        ? {}
        : {
            smtp: {
              endpoint: {
                hostname: "smtp.example.test",
                port: 587,
                tls: "starttls" as const,
              },
              username: "smtp-user@example.test",
              credentialRef,
              transportBindingRef: {
                id: `binding-r${"4".repeat(32)}`,
                version: 1,
              },
            },
          }),
      connectedAt: 1,
    },
    providerKind: "imap",
    displayName: null,
    status: options?.status ?? "connected",
    createdAt: 1,
    updatedAt: 1,
  };
}
