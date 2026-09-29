import { MAIL_RESOURCE_LIMITS } from "../security";
import { MailAccountError } from "./account-types";

const IDLE_CAPABILITY = "IDLE";
/** The first wait after a failure; each further failure in a row doubles it. */
const DEFAULT_BACKOFF_BASE_MS = 60_000;
/**
 * The longest a failing account waits between attempts, and how long a server
 * without IDLE waits before it is asked again.
 */
const DEFAULT_BACKOFF_CAP_MS = 30 * 60_000;

/**
 * The part of one ImapFlow session the supervisor drives. ImapFlow satisfies
 * it as it stands: `idle()` stays pending until a later command breaks it with
 * DONE, and updates to the selected mailbox arrive as events.
 */
export interface ImapIdleClient {
  readonly capabilities: ReadonlyMap<string, boolean | number>;
  idle(): Promise<boolean>;
  noop(): Promise<void>;
  close(): void;
  on(event: "exists", listener: (update: { readonly path?: string }) => void): this;
  on(event: "expunge", listener: (update: { readonly path?: string }) => void): this;
  on(event: "flags", listener: (update: { readonly path?: string }) => void): this;
  on(event: "close", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
}

export interface ImapIdleConnector {
  /**
   * One authenticated session with INBOX examined read-only. It stays open
   * until the supervisor closes it; a failure rejects with a stable code.
   */
  openIdleSession(accountId: string, signal: AbortSignal): Promise<ImapIdleClient>;
}

export interface MailImapIdleEvent {
  readonly event: "mail_imap_idle_connected" | "mail_imap_idle_fallback";
  readonly accountId: string;
  readonly reason?: "connect_failed" | "connection_dropped" | "idle_unsupported";
  readonly errorCode?: string;
  readonly failureCount?: number;
}

interface IdleConnection {
  readonly client: ImapIdleClient;
  phase: "awaiting_pass" | "idling" | "leaving";
  restartTimer: ReturnType<typeof setTimeout> | null;
  closed: boolean;
}

interface IdleAccount {
  connection: IdleConnection | null;
  opening: { readonly controller: AbortController; readonly settled: Promise<void> } | null;
  /** Failures in a row, which set the backoff and appear in the log only. */
  failures: number;
  retryAt: number;
}

/**
 * IMAP IDLE on each custom-domain account's INBOX, as a hint that makes the
 * background sync run sooner. It is never a source of truth (section 8 of the
 * architecture note): an update does not touch the cache, it only asks the
 * scheduler for the same bounded pass the poll runs, and the poll stays on
 * underneath as the recovery.
 *
 * One session per account, entered after a pass. An update to INBOX (EXISTS,
 * EXPUNGE or FLAGS) leaves IDLE and asks for one pass; a burst of updates is
 * still one pass, because nothing more is asked until the pass has run and IDLE
 * is entered again, and the server repeats anything that changed meanwhile the
 * moment it is. IDLE is left and entered again every `idleRestartMs`, under the
 * 29 minutes RFC 2177 allows, with a pass in between.
 *
 * A server without IDLE, a session that will not open and a connection that
 * drops all fall back to the poll with one log line, and the account is asked
 * again only after an exponential backoff with a cap. Retries happen on the
 * scheduler's passes rather than on a timer of their own, so a flapping server
 * can cost at most one attempt per pass.
 */
export class MailImapIdleSupervisor {
  private readonly connector: ImapIdleConnector;
  private readonly onChange: (accountId: string) => void;
  private readonly onEvent: (record: MailImapIdleEvent) => void;
  private readonly restartMs: number;
  private readonly accounts = new Map<string, IdleAccount>();
  private readonly invalidated = new Set<string>();
  private running = false;

  constructor(options: {
    readonly connector: ImapIdleConnector;
    /** Ask the scheduler for one pass of this account. */
    readonly onChange: (accountId: string) => void;
    readonly onEvent?: (record: MailImapIdleEvent) => void;
  }) {
    this.connector = options.connector;
    this.onChange = options.onChange;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.restartMs = MAIL_RESOURCE_LIMITS.idleRestartMs;
  }

  start(): void {
    this.running = true;
  }

  /** The Mail switch and shutdown: every session closes, nothing reopens. */
  async stop(): Promise<void> {
    this.running = false;
    const accounts = [...this.accounts.values()];
    this.accounts.clear();
    await Promise.all(accounts.map((account) => this.tearDown(account)));
  }

  /**
   * A pass of this IMAP account has run and its provider sync is caught up:
   * hold IDLE on its INBOX. Opens the session when there is none and the
   * backoff allows, and enters IDLE again after the pass an update asked for.
   */
  afterSync(accountId: string): void {
    if (!this.running || this.invalidated.has(accountId)) return;
    let account = this.accounts.get(accountId);
    if (account === undefined) {
      account = { connection: null, opening: null, failures: 0, retryAt: 0 };
      this.accounts.set(accountId, account);
    }
    if (account.opening !== null) return;
    const connection = account.connection;
    if (connection !== null) {
      if (connection.phase === "awaiting_pass") {
        this.enterIdle(accountId, account, connection);
      }
      return;
    }
    if (Date.now() < account.retryAt) return;
    this.open(accountId, account);
  }

  /** Closes the session of every account that no longer syncs. */
  retain(accountIds: readonly string[]): void {
    const active = new Set(accountIds);
    for (const [accountId, account] of this.accounts) {
      if (active.has(accountId)) continue;
      this.accounts.delete(accountId);
      void this.tearDown(account);
    }
  }

  /** Removal and credential edits: the session closes before they commit. */
  async invalidateAccount(accountId: string): Promise<void> {
    this.invalidated.add(accountId);
    const account = this.accounts.get(accountId);
    if (account === undefined) return;
    this.accounts.delete(accountId);
    await this.tearDown(account);
  }

  restoreInvalidatedAccount(accountId: string): void {
    this.invalidated.delete(accountId);
  }

  private open(accountId: string, account: IdleAccount): void {
    const controller = new AbortController();
    const settled = this.connector.openIdleSession(accountId, controller.signal).then(
      (client) => {
        if (account.opening?.controller === controller) account.opening = null;
        if (
          controller.signal.aborted ||
          !this.running ||
          this.accounts.get(accountId) !== account
        ) {
          closeQuietly(client);
          return;
        }
        this.adopt(accountId, account, client);
      },
      (error: unknown) => {
        if (account.opening?.controller === controller) account.opening = null;
        if (controller.signal.aborted) return;
        this.fail(
          accountId,
          account,
          "connect_failed",
          error instanceof MailAccountError ? error.code : "imap_connection_failed",
        );
      },
    );
    account.opening = { controller, settled };
  }

  private adopt(accountId: string, account: IdleAccount, client: ImapIdleClient): void {
    const connection: IdleConnection = {
      client,
      phase: "awaiting_pass",
      restartTimer: null,
      closed: false,
    };
    const drop = () => this.drop(accountId, account, connection);
    client.on("error", drop);
    client.on("close", drop);
    if (!client.capabilities.has(IDLE_CAPABILITY)) {
      retire(connection);
      this.fail(accountId, account, "idle_unsupported");
      return;
    }
    // Only INBOX is examined, so an update naming anything else is not ours
    // to act on.
    const update = (value: { readonly path?: string }) => {
      if (typeof value?.path === "string" && value.path.toUpperCase() === "INBOX") {
        this.leave(accountId, account, connection);
      }
    };
    client.on("exists", update);
    client.on("expunge", update);
    client.on("flags", update);
    account.connection = connection;
    this.onEvent({ event: "mail_imap_idle_connected", accountId });
    // The pass that opened this session read INBOX before the session
    // examined it, so mail that landed in between would wait for the poll.
    // One more pass closes that gap, and IDLE starts after it like after any.
    this.onChange(accountId);
  }

  private enterIdle(
    accountId: string,
    account: IdleAccount,
    connection: IdleConnection,
  ): void {
    connection.phase = "idling";
    connection.restartTimer = setTimeout(
      () => this.leave(accountId, account, connection),
      this.restartMs,
    );
    connection.restartTimer.unref?.();
    connection.client.idle().then(
      (result) => {
        // IDLE ends on the DONE that `leave` sends. Ending any other way (the
        // server's BYE, a refused command, ImapFlow recovering from a socket
        // timeout on its own) leaves a session nobody is driving.
        if (result === false || connection.phase === "idling") {
          this.drop(accountId, account, connection);
        }
      },
      () => this.drop(accountId, account, connection),
    );
  }

  /** Leaves IDLE (a NOOP makes ImapFlow send DONE) and asks for one pass. */
  private leave(
    accountId: string,
    account: IdleAccount,
    connection: IdleConnection,
  ): void {
    if (connection.closed || connection.phase !== "idling") return;
    connection.phase = "leaving";
    clearRestart(connection);
    connection.client.noop().then(
      () => {
        if (connection.closed || connection.phase !== "leaving") return;
        connection.phase = "awaiting_pass";
        // A full cycle means the session works, so the next failure starts
        // the backoff from the bottom again.
        account.failures = 0;
        this.onChange(accountId);
      },
      () => this.drop(accountId, account, connection),
    );
  }

  private drop(
    accountId: string,
    account: IdleAccount,
    connection: IdleConnection,
  ): void {
    if (connection.closed) return;
    retire(connection);
    if (account.connection === connection) account.connection = null;
    if (!this.running || this.accounts.get(accountId) !== account) return;
    this.fail(accountId, account, "connection_dropped");
  }

  private fail(
    accountId: string,
    account: IdleAccount,
    reason: NonNullable<MailImapIdleEvent["reason"]>,
    errorCode?: string,
  ): void {
    account.failures += 1;
    const waitMs =
      reason === "idle_unsupported"
        ? DEFAULT_BACKOFF_CAP_MS
        : Math.min(
            DEFAULT_BACKOFF_CAP_MS,
            DEFAULT_BACKOFF_BASE_MS * 2 ** Math.min(account.failures - 1, 16),
          );
    account.retryAt = Date.now() + waitMs;
    this.onEvent({
      event: "mail_imap_idle_fallback",
      accountId,
      reason,
      ...(errorCode === undefined ? {} : { errorCode }),
      failureCount: account.failures,
    });
  }

  private tearDown(account: IdleAccount): Promise<void> {
    const opening = account.opening;
    account.opening = null;
    opening?.controller.abort();
    if (account.connection !== null) {
      retire(account.connection);
      account.connection = null;
    }
    return opening?.settled ?? Promise.resolve();
  }
}

function retire(connection: IdleConnection): void {
  connection.closed = true;
  clearRestart(connection);
  closeQuietly(connection.client);
}

function clearRestart(connection: IdleConnection): void {
  if (connection.restartTimer !== null) clearTimeout(connection.restartTimer);
  connection.restartTimer = null;
}

function closeQuietly(client: ImapIdleClient): void {
  try {
    client.close();
  } catch {
    // Closing is best effort: the socket is being dropped either way.
  }
}
