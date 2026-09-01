import type { MultiMailAccountStore } from "./account-store";
import type {
  MailImapAccess,
  MailImapAccessResolver,
} from "./imap-sent-copy";
import type {
  MailSmtpAccess,
  MailSmtpAccessResolver,
} from "./smtp-transport";

const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;

/**
 * Resolves protocol endpoints from the authoritative account store while
 * decrypting the shared mailbox password only at the last possible moment.
 * A concurrent account edit invalidates the snapshot before the secret can be
 * returned, so a password can never be paired with a stale endpoint.
 */
export class StoredMailProtocolAccessResolver
  implements MailSmtpAccessResolver, MailImapAccessResolver
{
  constructor(private readonly store: MultiMailAccountStore) {}

  async resolveSmtpAccess(accountId: string): Promise<MailSmtpAccess | null> {
    if (!SAFE_ACCOUNT_ID.test(accountId)) return null;
    const stored = await this.store.readAccount(accountId);
    if (stored?.providerKind !== "imap" || stored.status !== "connected") {
      return null;
    }
    const snapshot = stored.account;
    const smtp = snapshot.smtp;
    if (!smtp) return null;
    return Object.freeze({
      endpoint: smtp.endpoint,
      username: smtp.username,
      readPassword: () => this.readMatchingPassword(snapshot, "smtp"),
    });
  }

  async resolveImapAccess(accountId: string): Promise<MailImapAccess | null> {
    if (!SAFE_ACCOUNT_ID.test(accountId)) return null;
    const stored = await this.store.readAccount(accountId);
    if (stored?.providerKind !== "imap" || stored.status !== "connected") {
      return null;
    }
    const snapshot = stored.account;
    return Object.freeze({
      endpoint: snapshot.endpoint,
      username: snapshot.username,
      readPassword: () => this.readMatchingPassword(snapshot, "imap"),
    });
  }

  private async readMatchingPassword(
    snapshot: Extract<
      Awaited<ReturnType<MultiMailAccountStore["readAccount"]>>,
      { readonly providerKind: "imap" }
    >["account"],
    protocol: "imap" | "smtp",
  ): Promise<Buffer> {
    const loaded = await this.store.loadProvisionedAccount(snapshot.accountId);
    if (!loaded) throw new Error("mail account access is unavailable");
    const current = loaded.stored.account;
    const endpointMatches =
      protocol === "imap"
        ? sameEndpoint(current.endpoint, snapshot.endpoint) &&
          current.username === snapshot.username
        : current.smtp !== undefined &&
          snapshot.smtp !== undefined &&
          sameEndpoint(current.smtp.endpoint, snapshot.smtp.endpoint) &&
          current.smtp.username === snapshot.smtp.username;
    const referencesMatch =
      current.credentialRef.id === snapshot.credentialRef.id &&
      current.credentialRef.version === snapshot.credentialRef.version;
    if (!endpointMatches || !referencesMatch) {
      loaded.password.fill(0);
      throw new Error("mail account access changed during resolution");
    }
    return loaded.password;
  }
}

function sameEndpoint(
  left: { readonly hostname: string; readonly port: number; readonly tls: string },
  right: { readonly hostname: string; readonly port: number; readonly tls: string },
): boolean {
  return (
    left.hostname === right.hostname &&
    left.port === right.port &&
    left.tls === right.tls
  );
}
