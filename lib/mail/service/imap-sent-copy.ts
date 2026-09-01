import { ImapFlow, type ImapFlowOptions } from "imapflow";

import type {
  ImapAppendHooks,
  MailDnsResolverPort,
  MailEndpoint,
  ValidatedMailDialTarget,
} from "../ports";
import { createVerificationOptions } from "./imapflow-adapter";
import type {
  MailSentCopyAppendRequest,
  MailSentCopyAppendResult,
  MailSentCopyFindRequest,
  MailSentCopyLookup,
  MailSentCopyPort,
} from "./smtp-worker";

const MAX_TARGET_ATTEMPT_MS = 5_000;
const MAX_SENT_MAILBOXES = 256;
/** Stable internal identifier for the special-use Sent mailbox. */
const SENT_MAILBOX_ID = "sent";

interface SentCopyImapClient {
  readonly secureConnection: boolean;
  readonly authenticated: boolean | string;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  on(event: "error", listener: (error: unknown) => void): this;
  list(): Promise<
    readonly { readonly path: string; readonly specialUse?: string }[]
  >;
  mailboxOpen(
    path: string,
  ): Promise<{ readonly uidValidity: bigint | number }>;
  search(
    query: { readonly header: Record<string, string> },
    options: { readonly uid: true },
  ): Promise<readonly number[] | false>;
  append(
    path: string,
    content: Buffer,
    flags?: readonly string[],
  ): Promise<
    | {
        readonly destination: string;
        readonly uidValidity?: bigint;
        readonly uid?: number;
      }
    | false
  >;
}

type SentCopyClientFactory = (options: ImapFlowOptions) => SentCopyImapClient;

export interface MailImapAccess {
  readonly endpoint: MailEndpoint;
  readonly username: string;
  /** Returns caller-owned secret bytes; the adapter wipes them after use. */
  readPassword(): Promise<Buffer>;
}

export interface MailImapAccessResolver {
  resolveImapAccess(accountId: string): Promise<MailImapAccess | null>;
}

class SentCopyUnavailableError extends Error {
  constructor(readonly errorCode: string) {
    super(errorCode);
    this.name = "SentCopyUnavailableError";
  }
}

/**
 * ImapFlow-backed Sent mailbox adapter. It follows the house connection
 * pattern from imapflow-adapter.ts: pinned validated literal address as host,
 * original hostname as TLS servername, certificate verification always on,
 * mandatory STARTTLS on 143, and logging disabled.
 *
 * The APPEND barrier here is conservative: hooks.beforeLiteral() is awaited
 * before the append command is issued at all, because ImapFlow's documented
 * append() API exposes no continuation callback. Marking delivery risk
 * earlier than the literal can only widen the ambiguity window toward
 * sent_copy_unknown, which reconciliation by Message-ID then resolves; it can
 * never duplicate a Sent copy.
 */
export class ImapFlowSentCopyAdapter implements MailSentCopyPort {
  private readonly dns: MailDnsResolverPort;
  private readonly access: MailImapAccessResolver;
  private readonly createClient: SentCopyClientFactory;
  private readonly now: () => number;

  constructor(options: {
    readonly dns: MailDnsResolverPort;
    readonly access: MailImapAccessResolver;
    readonly createClient?: SentCopyClientFactory;
    readonly now?: () => number;
  }) {
    this.dns = options.dns;
    this.access = options.access;
    this.createClient =
      options.createClient ??
      ((clientOptions) =>
        new ImapFlow(clientOptions) as unknown as SentCopyImapClient);
    this.now = options.now ?? Date.now;
  }

  async findByMessageId(
    request: MailSentCopyFindRequest,
  ): Promise<MailSentCopyLookup> {
    try {
      return await this.withClient(
        request.accountId,
        request.deadlineAt,
        request.signal,
        async (client) => {
          const path = await this.locateSentPath(client);
          const mailbox = await client.mailboxOpen(path);
          const uidValidity = validateUidValidity(mailbox.uidValidity);
          const uids = await client.search(
            { header: { "message-id": request.messageId } },
            { uid: true },
          );
          if (uids === false || !Array.isArray(uids) || uids.length === 0) {
            return Object.freeze({
              kind: "absent" as const,
              mailboxId: SENT_MAILBOX_ID,
            });
          }
          const uid = validateUid(uids[uids.length - 1]);
          return Object.freeze({
            kind: "found" as const,
            mailboxId: SENT_MAILBOX_ID,
            uidValidity,
            uid,
          });
        },
      );
    } catch (error) {
      return Object.freeze({
        kind: "unavailable" as const,
        errorCode:
          error instanceof SentCopyUnavailableError
            ? error.errorCode
            : "sent_copy_lookup_failed",
      });
    }
  }

  async append(
    request: MailSentCopyAppendRequest,
    hooks: ImapAppendHooks,
  ): Promise<MailSentCopyAppendResult> {
    return this.withClient(
      request.accountId,
      request.deadlineAt,
      request.signal,
      async (client) => {
        const path = await this.locateSentPath(client);
        // Durable barrier before any APPEND bytes may reach the connection.
        await hooks.beforeLiteral();
        let result: Awaited<ReturnType<SentCopyImapClient["append"]>>;
        try {
          result = await client.append(path, request.raw, ["\\Seen"]);
        } catch {
          return Object.freeze({
            mailboxId: SENT_MAILBOX_ID,
            outcome: Object.freeze({
              kind: "transport_error" as const,
              deliveryRisk: "possible" as const,
              errorCode: "sent_copy_append_failed",
            }),
          });
        }
        if (result === false) {
          return Object.freeze({
            mailboxId: SENT_MAILBOX_ID,
            outcome: Object.freeze({
              kind: "rejected" as const,
              retryable: true,
              errorCode: "sent_copy_append_rejected",
            }),
          });
        }
        if (
          result.uid !== undefined &&
          result.uidValidity !== undefined &&
          Number.isSafeInteger(result.uid)
        ) {
          return Object.freeze({
            mailboxId: SENT_MAILBOX_ID,
            outcome: Object.freeze({
              kind: "stored" as const,
              uidValidity: validateUidValidity(result.uidValidity),
              uid: validateUid(result.uid),
            }),
          });
        }
        return Object.freeze({
          mailboxId: SENT_MAILBOX_ID,
          outcome: Object.freeze({ kind: "stored_without_uid" as const }),
        });
      },
    );
  }

  private async locateSentPath(client: SentCopyImapClient): Promise<string> {
    const mailboxes = await client.list();
    if (!Array.isArray(mailboxes) || mailboxes.length > MAX_SENT_MAILBOXES) {
      throw new SentCopyUnavailableError("sent_mailbox_list_invalid");
    }
    const specialUse = mailboxes.find(
      (entry) => entry.specialUse === "\\Sent",
    );
    const named = mailboxes.find(
      (entry) => typeof entry.path === "string" && entry.path === "Sent",
    );
    const chosen = specialUse ?? named;
    if (!chosen || typeof chosen.path !== "string" || chosen.path.length === 0) {
      throw new SentCopyUnavailableError("sent_mailbox_missing");
    }
    return chosen.path;
  }

  private async withClient<T>(
    accountId: string,
    deadlineAt: number,
    signal: AbortSignal,
    operation: (client: SentCopyImapClient) => Promise<T>,
  ): Promise<T> {
    const access = await this.access.resolveImapAccess(accountId);
    if (access === null) {
      throw new SentCopyUnavailableError("sent_copy_account_unavailable");
    }
    const targets = await this.dns.resolve(
      "imap",
      access.endpoint,
      deadlineAt,
      signal,
    );
    const password = await access.readPassword();
    try {
      let lastError: unknown = new SentCopyUnavailableError(
        "sent_copy_connection_failed",
      );
      for (const [index, target] of targets.entries()) {
        if (signal.aborted || this.now() >= deadlineAt) break;
        const targetDeadlineAt = this.targetDeadline(
          deadlineAt,
          target,
          index === targets.length - 1,
        );
        if (targetDeadlineAt <= this.now()) continue;
        let client: SentCopyImapClient | null = null;
        try {
          client = this.createClient(
            createVerificationOptions(
              target,
              { username: access.username, password },
              Math.max(1, targetDeadlineAt - this.now()),
            ),
          );
          client.on("error", () => undefined);
          await this.connectWithDeadline(client, targetDeadlineAt, signal);
          return await operation(client);
        } catch (error) {
          if (error instanceof SentCopyUnavailableError) throw error;
          lastError = error;
        } finally {
          if (client !== null) {
            await client.logout().catch(() => undefined);
            client.close();
          }
        }
      }
      throw lastError;
    } finally {
      password.fill(0);
    }
  }

  private targetDeadline(
    deadlineAt: number,
    target: ValidatedMailDialTarget,
    isFinal: boolean,
  ): number {
    const absolute = Math.min(deadlineAt, target.expiresAt - 1);
    if (isFinal) return absolute;
    return Math.min(absolute, this.now() + MAX_TARGET_ATTEMPT_MS);
  }

  private async connectWithDeadline(
    client: SentCopyImapClient,
    deadlineAt: number,
    signal: AbortSignal,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortHandler: (() => void) | undefined;
    try {
      await Promise.race([
        client.connect(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => {
              client.close();
              reject(new Error("sent copy connection timed out"));
            },
            Math.max(1, deadlineAt - this.now()),
          );
        }),
        new Promise<never>((_resolve, reject) => {
          abortHandler = () => {
            client.close();
            reject(new Error("sent copy connection aborted"));
          };
          if (signal.aborted) {
            abortHandler();
            return;
          }
          signal.addEventListener("abort", abortHandler, { once: true });
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (abortHandler) signal.removeEventListener("abort", abortHandler);
    }
    if (client.secureConnection !== true) {
      throw new Error("sent copy connection is not TLS-verified");
    }
    if (
      client.authenticated !== true &&
      (typeof client.authenticated !== "string" ||
        client.authenticated.length === 0)
    ) {
      throw new SentCopyUnavailableError("sent_copy_authentication_failed");
    }
  }
}

function validateUidValidity(value: bigint | number): string {
  const text = String(value);
  if (!/^[1-9][0-9]{0,9}$/.test(text) || Number(text) > 0xffff_ffff) {
    throw new SentCopyUnavailableError("sent_copy_uidvalidity_invalid");
  }
  return text;
}

function validateUid(value: number | undefined): number {
  if (
    value === undefined ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 0xffff_ffff
  ) {
    throw new SentCopyUnavailableError("sent_copy_uid_invalid");
  }
  return value;
}
