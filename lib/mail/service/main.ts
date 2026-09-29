import { fstatSync, readFileSync } from "node:fs";
import path from "node:path";

import { projectMailLogRecord } from "../security";
import {
  createMailServiceHttpServer,
  type MailServiceBuildIdentity,
} from "./http";
import { SqliteMailAccountStore } from "./account-store";
import {
  CompositeMailAccountRemovalGuard,
  MultiMailAccountService,
  type MailAccountProtocolMutationGuard,
} from "./accounts";
import { MailAccountError } from "./account-types";
import { AtomicMailSystemAdmission } from "./admission";
import { MailBackgroundSyncScheduler } from "./background-sync";
import { MailContentCoordinator } from "./content-coordinator";
import {
  createProductionMailContentSourceFactory,
  ProductionMailContentWorkRunner,
} from "./content-work-runner";
import { CompleteSetMailDnsResolver } from "./dns";
import {
  listDraftSourceMessageIds,
  ProviderNeutralMailDraftService,
} from "./drafts";
import {
  ImapFlowCredentialVerifier,
  ImapFlowReadSessionFactory,
} from "./imapflow-adapter";
import {
  createProductionMailProviderFactory,
  MultiAccountMailMessageService,
} from "./message-service-registry";
import {
  MailSendError,
  ProviderNeutralMailSendService,
} from "./outbound";
import { SqliteMailSendStore } from "./outbound-store";
import { MailOutboundWorker } from "./outbound-worker";
import { readMailServiceRuntimePaths } from "./runtime-config";
import {
  MailSenderScreen,
  MailSenderScreenedMessageService,
  SqliteMailSenderStore,
} from "./senders";
import { createMailSyncPause, mailSyncPauseWorkers } from "./sync-pause";
import { UnixSocketMailMimeParser } from "./mime-parser-client";
import { StoredGmailAccessTokenPort } from "../providers/gmail/access-token-port";
import { MultiAccountGmailSendAdapter } from "../providers/gmail/send-adapter";
import { createOptionalGmailOAuthServiceAdapter } from "../providers/gmail/service-adapter";
import { createOptionalProductionSmtpRuntime } from "./smtp-runtime";

const SYSTEMD_FIRST_FD = 3;
const EXPECTED_FD_NAME = "brain-mail";
const SHUTDOWN_DEADLINE_MS = 12_000;

async function main(): Promise<void> {
  assertInheritedSystemdSocket();
  const build = readBuildIdentity();
  const runtime = readMailServiceRuntimePaths(process.env);
  const store = new SqliteMailAccountStore(runtime);
  await store.initialize();
  const dns = new CompleteSetMailDnsResolver();
  // One bounded read-only IMAP session factory serves metadata sync and raw
  // message fetches alike, so both paths share DNS and binding validation.
  const imapSessions = new ImapFlowReadSessionFactory({ dns, store });
  const messages = new MultiAccountMailMessageService({
    stateDirectory: runtime.stateDirectory,
    store,
    providerFactory: createProductionMailProviderFactory({
      store,
      environment: process.env,
      imapSessions,
    }),
  });
  const senderScreen = await openSenderScreen(runtime.stateDirectory, messages);
  const outbox = new SqliteMailSendStore({
    cacheRoot: path.join(runtime.stateDirectory, "cache"),
    onSent: (sent) => senderScreen?.screen.recordSentRecipients(sent),
  });
  await outbox.initialize();
  const smtpRuntime = await createOptionalProductionSmtpRuntime({
    environment: process.env,
    accountStore: store,
    outboxStore: outbox,
    dns,
    onEvent: writeServiceLog,
  });
  const gmailSender = new MultiAccountGmailSendAdapter({
    createTokenLease(accountId) {
      const tokenPort = new StoredGmailAccessTokenPort({
        accountId,
        store,
        environment: process.env,
      });
      return Object.freeze({
        tokenPort,
        destroy: () => tokenPort.destroy(),
      });
    },
  });
  // One ledger for the whole process: the download routes and the body
  // prefetch count against the same two fetch streams.
  const admission = new AtomicMailSystemAdmission();
  // The scheduler is constructed after the coordinator it polls; the kick
  // holder closes the cycle so an owner-demanded message can start its
  // remote-image pass without waiting for the next timer tick.
  let kickBackgroundSync: () => void = () => undefined;
  const content = new MailContentCoordinator({
    stateDirectory: runtime.stateDirectory,
    store,
    runner: new ProductionMailContentWorkRunner({
      sourceFactory: createProductionMailContentSourceFactory({
        store,
        environment: process.env,
        imapSessions,
      }),
      parser: new UnixSocketMailMimeParser(),
    }),
    admission,
    draftSources: {
      listDraftSourceMessageIds: (accountId) =>
        listDraftSourceMessageIds(outbox, accountId),
    },
    onBackgroundWorkAvailable: () => kickBackgroundSync(),
    onEvent: writeServiceLog,
  });
  const sendAccounts = {
    async readSendAccount(accountId: string) {
      try {
        const stored = await store.readAccount(accountId);
        return stored === null
          ? null
          : Object.freeze({
              accountId: stored.account.accountId,
              providerKind: stored.providerKind,
              emailAddress: stored.account.emailAddress,
              status: stored.status,
              sendConfigured:
                stored.providerKind === "gmail" ||
                (smtpRuntime?.worker.isReady() === true &&
                  stored.account.smtp !== undefined),
            });
      } catch {
        throw new MailSendError("mail_send_service_unavailable");
      }
    },
  };
  const replyContexts = {
    async resolveReplyContext(accountId: string, messageId: string) {
      try {
        const cached = await messages.readReplyContext(accountId, messageId);
        return cached === null || cached.rfcMessageId === null
          ? null
          : Object.freeze({
              providerThreadId: cached.providerThreadId,
              rfcMessageId: cached.rfcMessageId,
              references: cached.references,
            });
      } catch {
        throw new MailSendError("mail_send_service_unavailable");
      }
    },
  };
  const send = new ProviderNeutralMailSendService({
    store: outbox,
    accounts: sendAccounts,
    replies: replyContexts,
    providers: [gmailSender],
  });
  const drafts = new ProviderNeutralMailDraftService({
    store: outbox,
    accounts: sendAccounts,
    replies: replyContexts,
    sender: send,
  });
  const outboundWorker = new MailOutboundWorker({
    store: outbox,
    processor: send,
    onEvent: writeServiceLog,
  });
  const removalGuard = new CompositeMailAccountRemovalGuard([
    messages,
    outboundWorker,
    ...(smtpRuntime ? [smtpRuntime.worker] : []),
    gmailSender,
    outbox,
    content,
  ]);
  const protocolMutationGuard: MailAccountProtocolMutationGuard = {
    async run<T>(
      accountId: string,
      mutation: { readonly preservesBindings: boolean },
      operation: () => Promise<T>,
    ): Promise<T> {
      await removalGuard.invalidateAccount(accountId);
      try {
        try {
          await outbox.assertAccountProtocolMutationSafe(accountId, mutation);
        } catch {
          throw new MailAccountError("account_state_unavailable");
        }
        return await operation();
      } finally {
        await removalGuard.restoreInvalidatedAccount(accountId);
      }
    },
  };
  const accounts = new MultiMailAccountService({
    store,
    verifier: new ImapFlowCredentialVerifier({
      dns,
    }),
    ...(smtpRuntime ? { smtpVerifier: smtpRuntime.verifier } : {}),
    removalGuard,
    protocolMutationGuard,
    smtpSubmissionReady: () => smtpRuntime?.worker.isReady() === true,
  });
  const gmailOAuth = await createOptionalGmailOAuthServiceAdapter(
    process.env,
    store,
  );
  const backgroundSync = new MailBackgroundSyncScheduler(messages, {
    privacyCache: content,
    searchIndex: messages,
    ...(senderScreen ? { senders: senderScreen.screen } : {}),
  });
  kickBackgroundSync = () => backgroundSync.kick();
  // Everything the pause turns off, in the order they are started below.
  // "Off means nothing leaves" is why the two send-side workers travel in
  // that list beside the receive-side scheduler, and why the list is built by
  // `mailSyncPauseWorkers` rather than spelled here: this file has no test,
  // and a worker missing from the list would be invisible.
  const syncPause = createMailSyncPause({
    readPaused: () => store.readSyncPaused(),
    writePaused: (paused) => store.writeSyncPaused(paused),
    workers: mailSyncPauseWorkers({
      outboundWorker,
      ...(smtpRuntime ? { smtpWorker: smtpRuntime.worker } : {}),
      backgroundSync,
    }),
  });
  const server = createMailServiceHttpServer({
    build,
    admission,
    accounts,
    gmailOAuth,
    messages: senderScreen
      ? new MailSenderScreenedMessageService(messages, senderScreen.screen)
      : messages,
    send,
    drafts,
    content,
    syncPause,
    ...(senderScreen ? { senders: senderScreen.screen } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ fd: SYSTEMD_FIRST_FD }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Comes up the way it went down. Without this a paused service would sync
  // and send for one interval after every restart, and `Restart=on-failure`
  // means a restart is not something anybody schedules.
  let workersRunning = false;
  if (!syncPause.isPaused()) {
    await outboundWorker.start();
    await smtpRuntime?.worker.start();
    backgroundSync.start();
    workersRunning = true;
  }
  // The `phase` is what this start actually did, not what the stored flag
  // says. An operator reading the journal after a restart needs to see that
  // the silence is the switch rather than a fault, and it is the only place
  // outside the process where the branch above is visible: the artifact smoke
  // reads this line to hold the restart honest. The `transport` names which
  // SMTP byte transport the flags selected, direct or the relay, and is absent
  // for a receive-only service; it never carries a relay URL or a provider host.
  writeServiceLog({
    event: "mail_service_started",
    phase: workersRunning ? "running" : "paused",
    ...(smtpRuntime ? { transport: smtpRuntime.transport } : {}),
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    writeServiceLog({ event: "mail_service_stopping" });
    const deadline = setTimeout(() => {
      writeServiceLog({
        event: "mail_service_stop_failed",
        errorCode: "shutdown_deadline_exceeded",
      });
      process.exitCode = 1;
      process.exit();
    }, SHUTDOWN_DEADLINE_MS);
    deadline.unref();
    const backgroundStop = backgroundSync.stop();
    const outboundStop = outboundWorker.stop();
    const smtpStop = smtpRuntime?.worker.stop() ?? Promise.resolve();
    server.close((error) => {
      void finishShutdown({
        backgroundStop,
        outboundStop,
        smtpStop,
        error,
        messages,
        gmailSender,
        content,
        outbox,
        store,
        senderStore: senderScreen?.store ?? null,
        deadline,
      });
    });
    server.closeIdleConnections();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

async function finishShutdown(options: {
  readonly backgroundStop: Promise<void>;
  readonly outboundStop: Promise<void>;
  readonly smtpStop: Promise<void>;
  readonly error?: Error;
  readonly messages: MultiAccountMailMessageService;
  readonly gmailSender: MultiAccountGmailSendAdapter;
  readonly content: MailContentCoordinator;
  readonly outbox: SqliteMailSendStore;
  readonly store: SqliteMailAccountStore;
  readonly senderStore: SqliteMailSenderStore | null;
  readonly deadline: ReturnType<typeof setTimeout>;
}): Promise<void> {
  let failed = options.error !== undefined;
  if (failed) {
    writeServiceLog({
      event: "mail_service_stop_failed",
      errorCode: "server_close_failed",
    });
  }
  try {
    await options.backgroundStop;
  } catch {
    failed = true;
    writeServiceLog({
      event: "mail_service_stop_failed",
      errorCode: "background_stop_failed",
    });
  }
  try {
    await options.outboundStop;
  } catch {
    failed = true;
    writeServiceLog({
      event: "mail_service_stop_failed",
      errorCode: "outbound_stop_failed",
    });
  }
  try {
    await options.smtpStop;
  } catch {
    failed = true;
    writeServiceLog({
      event: "mail_service_stop_failed",
      errorCode: "smtp_stop_failed",
    });
  }
  const settled = await Promise.allSettled([
    options.messages.close(),
    options.gmailSender.close(),
    options.content.close(),
    options.outbox.close(),
  ]);
  if (settled.some((result) => result.status === "rejected")) {
    failed = true;
    writeServiceLog({
      event: "mail_service_stop_failed",
      errorCode: "runtime_close_failed",
    });
  }
  try {
    options.senderStore?.close();
  } catch {
    failed = true;
    writeServiceLog({
      event: "mail_service_stop_failed",
      errorCode: "senders_close_failed",
    });
  }
  try {
    options.store.close();
  } catch {
    failed = true;
    writeServiceLog({
      event: "mail_service_stop_failed",
      errorCode: "database_close_failed",
    });
  } finally {
    clearTimeout(options.deadline);
  }
  if (failed) process.exitCode = 1;
}

/**
 * The new-senders screen is a layer over mail, not a condition of it: a
 * `senders.sqlite3` that cannot be opened leaves the service running without
 * the screen, with every thread ungated and the routes answering
 * `mail_senders_unavailable`, and the journal says so once.
 */
async function openSenderScreen(
  stateDirectory: string,
  messages: MultiAccountMailMessageService,
): Promise<{ readonly store: SqliteMailSenderStore; readonly screen: MailSenderScreen } | null> {
  const store = new SqliteMailSenderStore({ stateDirectory });
  try {
    await store.initialize();
  } catch {
    writeServiceLog({
      event: "mail_service_senders_unavailable",
      errorCode: "mail_senders_unavailable",
    });
    return null;
  }
  return Object.freeze({
    store,
    screen: new MailSenderScreen({ store, mail: messages, onEvent: writeServiceLog }),
  });
}

function assertInheritedSystemdSocket(): void {
  if (
    process.env.LISTEN_PID !== String(process.pid) ||
    process.env.LISTEN_FDS !== "1" ||
    process.env.LISTEN_FDNAMES !== EXPECTED_FD_NAME
  ) {
    throw new Error("brain-mail requires exactly one named systemd socket");
  }
  if (!fstatSync(SYSTEMD_FIRST_FD).isSocket()) {
    throw new Error("brain-mail inherited descriptor is not a socket");
  }
}

function readBuildIdentity(): MailServiceBuildIdentity {
  const source = JSON.parse(
    readFileSync(path.join(__dirname, "..", "build.json"), "utf8"),
  ) as unknown;
  if (!isPlainRecord(source)) throw new Error("mail build identity is invalid");
  const keys = Object.keys(source).sort();
  if (keys.length !== 2 || keys[0] !== "builtAt" || keys[1] !== "commit") {
    throw new Error("mail build identity is invalid");
  }
  if (typeof source.commit !== "string" || typeof source.builtAt !== "string") {
    throw new Error("mail build identity is invalid");
  }
  return Object.freeze({ commit: source.commit, builtAt: source.builtAt });
}

/**
 * The service's own record — lifecycle and worker events — to stdout. An
 * answered request failure is a different stream: `writeMailLogRecord` in
 * `security.ts` writes those to stderr, and the artifact smoke reads the two
 * apart. The names differ so the two are never imported under one.
 */
function writeServiceLog(value: unknown): void {
  const projected = projectMailLogRecord(value);
  if (projected) process.stdout.write(`${JSON.stringify(projected)}\n`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

void main().catch(() => {
  writeServiceLog({ event: "mail_service_start_failed", errorCode: "startup_failed" });
  process.exitCode = 1;
});
