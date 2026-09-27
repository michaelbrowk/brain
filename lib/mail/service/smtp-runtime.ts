import type { MailDnsResolverPort } from "../ports";
import type { SqliteMailAccountStore } from "./account-store";
import { StoredMailProtocolAccessResolver } from "./account-access";
import { ImapFlowSentCopyAdapter } from "./imap-sent-copy";
import {
  CloudflareSmtpConnectionFactory,
  DirectSmtpConnectionFactory,
  FirstPartySmtpCredentialVerifier,
  FirstPartySmtpSubmissionTransport,
  type CreateDirectConnection,
  type MailSmtpConnectionFactory,
  type SmtpCredentialVerifier,
} from "./smtp-transport";
import { readOptionalSmtpTransportConfig } from "./smtp-runtime-config";
import { MailSmtpSubmissionWorker } from "./smtp-worker";
import type { SqliteMailSendStore } from "./outbound-store";

export type ProductionSmtpTransportKind = "direct" | "authenticated_byte_relay";

export interface ProductionSmtpRuntime {
  readonly worker: MailSmtpSubmissionWorker;
  readonly verifier: SmtpCredentialVerifier;
  /** What the start record says about this runtime, and nothing more: the
   *  kind of byte transport, never a relay URL or a provider host. */
  readonly transport: ProductionSmtpTransportKind;
}

export async function createOptionalProductionSmtpRuntime(options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly accountStore: SqliteMailAccountStore;
  readonly outboxStore: SqliteMailSendStore;
  readonly dns: MailDnsResolverPort;
  readonly onEvent: ConstructorParameters<typeof MailSmtpSubmissionWorker>[0]["onEvent"];
  /** Test seam for the direct dialer; production leaves it to `net.connect`. */
  readonly createConnection?: CreateDirectConnection;
}): Promise<ProductionSmtpRuntime | null> {
  const config = await readOptionalSmtpTransportConfig(options.environment);
  if (!config) return null;
  const transportKind: ProductionSmtpTransportKind =
    config.kind === "direct" ? "direct" : "authenticated_byte_relay";
  const connections: MailSmtpConnectionFactory =
    config.kind === "direct"
      ? new DirectSmtpConnectionFactory(
          options.createConnection
            ? { createConnection: options.createConnection }
            : undefined,
        )
      : new CloudflareSmtpConnectionFactory(config.relay);
  const access = new StoredMailProtocolAccessResolver(options.accountStore);
  const transport = new FirstPartySmtpSubmissionTransport({
    dns: options.dns,
    connections,
    access,
    transportKind,
  });
  const sentCopy = new ImapFlowSentCopyAdapter({
    dns: options.dns,
    access,
  });
  return Object.freeze({
    transport: transportKind,
    verifier: new FirstPartySmtpCredentialVerifier({
      dns: options.dns,
      connections,
      transportKind,
    }),
    worker: new MailSmtpSubmissionWorker({
      store: options.outboxStore,
      transport,
      sentCopy,
      accountLifecycle: {
        markSmtpReauthRequired: (accountId) =>
          options.accountStore.markAccountReauthRequired(accountId),
      },
      onEvent: options.onEvent,
    }),
  });
}
