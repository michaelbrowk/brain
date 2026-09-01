import {
  destroyGmailOAuthGrant,
  GmailOAuthFlow,
  GmailOAuthError,
  GmailOAuthTransactionCodec,
  GoogleGmailIdTokenVerifier,
  GoogleGmailOAuthTokenClient,
  InMemoryGmailOAuthTransactionStore,
  readGmailOAuthConfig,
  type GmailOAuthGrant,
} from "./oauth";
import { GMAIL_OAUTH_TRANSACTION_COOKIE } from "./contract";
import { readGmailOAuthServiceCredentials } from "./credentials";
import { projectMailLogRecord } from "../../security";

const MAX_COOKIE_HEADER_BYTES = 8 * 1024;
const MAX_CALLBACK_QUERY_BYTES = 8 * 1024;
const MAX_COOKIE_AGE_SECONDS = 600;

export interface GmailOAuthGrantSink {
  isReady(): boolean;
  validateReconnectTarget(accountId: string): Promise<void>;
  /** Must commit before resolving. The adapter wipes both token buffers next. */
  persistGrant(
    grant: GmailOAuthGrant,
    targetAccountId: string | null,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface GmailOAuthServiceRedirect {
  readonly status: 303;
  readonly location: string;
  readonly setCookie: string;
}

export interface GmailOAuthLogRecord {
  readonly event: string;
  readonly phase: string;
  readonly errorCode?: string;
}

export class GmailOAuthServiceAdapter {
  constructor(
    private readonly flow: GmailOAuthFlow,
    private readonly sink: GmailOAuthGrantSink,
    private readonly now: () => number = Date.now,
    private readonly log: (record: GmailOAuthLogRecord) => void = () => {},
  ) {}

  async start(
    targetAccountId: string | null = null,
  ): Promise<GmailOAuthServiceRedirect> {
    if (!this.sink.isReady()) {
      throw new GmailOAuthError("gmail_oauth_unavailable");
    }
    if (targetAccountId !== null) {
      await this.sink.validateReconnectTarget(targetAccountId);
    }
    const started = this.flow.start(targetAccountId);
    const ageSeconds = Math.ceil((started.expiresAt - this.now()) / 1_000);
    if (
      !Number.isSafeInteger(ageSeconds) ||
      ageSeconds < 1 ||
      ageSeconds > MAX_COOKIE_AGE_SECONDS
    ) {
      throw new GmailOAuthError("gmail_oauth_unavailable");
    }
    return Object.freeze({
      status: 303,
      location: started.authorizationUrl,
      setCookie: createTransactionCookie(
        started.transactionCookieValue,
        ageSeconds,
      ),
    });
  }

  async callback(
    rawQuery: string,
    cookieHeader: string | undefined,
    signal: AbortSignal,
  ): Promise<GmailOAuthServiceRedirect> {
    let phase = "request";
    if (!this.sink.isReady()) {
      this.emit("unavailable", "gmail_oauth_unavailable");
      return this.result("error");
    }
    let grant: GmailOAuthGrant | null = null;
    try {
      const query = validateRawQuery(rawQuery);
      const cookie = extractTransactionCookie(cookieHeader);
      phase = "exchange";
      const completion = await this.flow.complete(
        `${this.flow.config.redirectUri}${query}`,
        cookie,
        signal,
      );
      grant = completion.grant;
      phase = "persist";
      await this.sink.persistGrant(grant, completion.targetAccountId, signal);
      this.emit("connected");
      return this.result("connected");
    } catch (error) {
      this.emit(
        phase,
        error instanceof GmailOAuthError
          ? error.code
          : phase === "persist"
            ? "grant_persist_failed"
            : "unexpected_error",
      );
      return this.result(
        error instanceof GmailOAuthError &&
          error.code === "gmail_oauth_provider_denied"
          ? "cancelled"
          : "error",
      );
    } finally {
      if (grant !== null) destroyGmailOAuthGrant(grant);
    }
  }

  private emit(phase: string, errorCode?: string): void {
    this.log(
      errorCode === undefined
        ? { event: "gmail_oauth_callback", phase }
        : { event: "gmail_oauth_callback", phase, errorCode },
    );
  }

  private result(
    outcome: "connected" | "cancelled" | "error",
  ): GmailOAuthServiceRedirect {
    return Object.freeze({
      status: 303,
      location: `${this.flow.config.publicOrigin}/mail?gmail=${outcome}`,
      setCookie: clearTransactionCookie(),
    });
  }
}

export async function createOptionalGmailOAuthServiceAdapter(
  environment: Readonly<Record<string, string | undefined>>,
  sink: GmailOAuthGrantSink,
  now: () => number = Date.now,
): Promise<GmailOAuthServiceAdapter | undefined> {
  if (
    typeof environment.GMAIL_OAUTH_CLIENT_ID !== "string" ||
    environment.GMAIL_OAUTH_CLIENT_ID.length === 0
  ) {
    return undefined;
  }
  let clientSecret: Buffer | null = null;
  let transactionKey: Buffer | null = null;
  try {
    const credentials = await readGmailOAuthServiceCredentials(environment);
    clientSecret = credentials.clientSecret;
    transactionKey = credentials.transactionKey;
    const config = readGmailOAuthConfig(environment, clientSecret);
    const flow = new GmailOAuthFlow(
      config,
      new GmailOAuthTransactionCodec(transactionKey),
      new InMemoryGmailOAuthTransactionStore(),
      new GoogleGmailOAuthTokenClient(fetch, now),
      new GoogleGmailIdTokenVerifier(),
      now,
    );
    return new GmailOAuthServiceAdapter(flow, sink, now, writeGmailOAuthLog);
  } finally {
    clientSecret?.fill(0);
    transactionKey?.fill(0);
  }
}

function writeGmailOAuthLog(record: GmailOAuthLogRecord): void {
  const projected = projectMailLogRecord(record);
  if (projected) process.stderr.write(`${JSON.stringify(projected)}\n`);
}

export function createTransactionCookie(value: string, maxAgeSeconds: number): string {
  if (
    !/^[A-Za-z0-9_-]{16,4096}$/.test(value) ||
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 1 ||
    maxAgeSeconds > MAX_COOKIE_AGE_SECONDS
  ) {
    throw new GmailOAuthError("gmail_oauth_unavailable");
  }
  return `${GMAIL_OAUTH_TRANSACTION_COOKIE}=${value}; Path=/; Max-Age=${maxAgeSeconds}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearTransactionCookie(): string {
  return `${GMAIL_OAUTH_TRANSACTION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

function validateRawQuery(value: string): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("?") ||
    value.includes("#") ||
    Buffer.byteLength(value) > MAX_CALLBACK_QUERY_BYTES
  ) {
    throw new GmailOAuthError("gmail_oauth_request_invalid");
  }
  return value;
}

function extractTransactionCookie(cookieHeader: string | undefined): string {
  if (
    typeof cookieHeader !== "string" ||
    Buffer.byteLength(cookieHeader) > MAX_COOKIE_HEADER_BYTES
  ) {
    throw new GmailOAuthError("gmail_oauth_state_invalid");
  }
  const prefix = `${GMAIL_OAUTH_TRANSACTION_COOKIE}=`;
  const parts = cookieHeader
    .split(";")
    .map((part) => part.trim());
  const matches = parts.filter((part) => part.startsWith(prefix));
  if (matches.length !== 1) {
    throw new GmailOAuthError("gmail_oauth_state_invalid");
  }
  const value = matches[0].slice(prefix.length);
  if (!/^[A-Za-z0-9_-]{16,4096}$/.test(value)) {
    throw new GmailOAuthError("gmail_oauth_state_invalid");
  }
  return value;
}
