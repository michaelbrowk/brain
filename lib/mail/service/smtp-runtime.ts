import type { SqliteMailAccountStore } from "./account-store";
import { StoredMailProtocolAccessResolver } from "./account-access";
import type { CompleteSetMailDnsResolver } from "./dns";
import { ImapFlowSentCopyAdapter } from "./imap-sent-copy";
import {
  CloudflareSmtpConnectionFactory,
  FirstPartySmtpCredentialVerifier,
  FirstPartySmtpSubmissionTransport,
  type SmtpCredentialVerifier,
} from "./smtp-transport";
import { readOptionalSmtpEgressConfig } from "./smtp-runtime-config";
import { MailSmtpSubmissionWorker } from "./smtp-worker";
import type { SqliteMailSendStore } from "./outbound-store";

export interface ProductionSmtpRuntime {
  readonly worker: MailSmtpSubmissionWorker;
  readonly verifier: SmtpCredentialVerifier;
}

export async function createOptionalProductionSmtpRuntime(options: {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly accountStore: SqliteMailAccountStore;
  readonly outboxStore: SqliteMailSendStore;
  readonly dns: CompleteSetMailDnsResolver;
  readonly onEvent: ConstructorParameters<typeof MailSmtpSubmissionWorker>[0]["onEvent"];
}): Promise<ProductionSmtpRuntime | null> {
  const relay = await readOptionalSmtpEgressConfig(options.environment);
  if (!relay) return null;
  const access = new StoredMailProtocolAccessResolver(options.accountStore);
  const connections = new CloudflareSmtpConnectionFactory(relay);
  const transport = new FirstPartySmtpSubmissionTransport({
    dns: options.dns,
    connections,
    access,
    transportKind: "authenticated_byte_relay",
  });
  const sentCopy = new ImapFlowSentCopyAdapter({
    dns: options.dns,
    access,
  });
  return Object.freeze({
    verifier: new FirstPartySmtpCredentialVerifier({
      dns: options.dns,
      connections,
      transportKind: "authenticated_byte_relay",
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
