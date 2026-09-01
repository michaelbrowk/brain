import type { MultiMailAccountStore } from "../../service/account-store";
import type { StoredGmailMailAccount } from "../../service/account-types";
import { readGmailOAuthClientSecret } from "./credentials";
import {
  GmailAccessTokenError,
  parseGmailRetryAfterMs,
  type GmailAccessTokenPort,
} from "./api-types";
import { destroyStoredGmailCredential } from "./token-envelope";

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const MAX_TOKEN_RESPONSE_BYTES = 32 * 1024;
const MAX_ACCESS_TOKEN_BYTES = 16 * 1024;
const REFRESH_TIMEOUT_MS = 15_000;
const REFRESH_EARLY_MS = 60_000;

interface StoredGmailAccessTokenPortOptions {
  readonly accountId: string;
  readonly store: MultiMailAccountStore;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly request?: typeof fetch;
  readonly now?: () => number;
}

/**
 * Production access-token boundary. Refresh credentials are decrypted only for
 * one selected account and the Google client secret is read from its private
 * systemd credential on every refresh. Neither secret is retained afterwards.
 */
export class StoredGmailAccessTokenPort implements GmailAccessTokenPort {
  private readonly accountId: string;
  private readonly store: MultiMailAccountStore;
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private cached: { token: Buffer; expiresAt: number } | null = null;
  private refreshTail: Promise<void> = Promise.resolve();

  constructor(options: StoredGmailAccessTokenPortOptions) {
    if (!/^account-a[0-9a-f]{32}$/.test(options.accountId)) {
      throw new GmailAccessTokenError("refresh_unavailable");
    }
    this.accountId = options.accountId;
    this.store = options.store;
    this.environment = options.environment;
    this.request = options.request ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getAccessToken(
    input: { readonly forceRefresh: boolean },
    signal: AbortSignal,
  ): Promise<Buffer> {
    if (typeof input.forceRefresh !== "boolean") {
      throw new GmailAccessTokenError("refresh_unavailable");
    }
    signal.throwIfAborted();
    if (input.forceRefresh) this.clearCached();
    const cached = this.cached;
    if (cached && cached.expiresAt - REFRESH_EARLY_MS > this.now()) {
      return Buffer.from(cached.token);
    }
    await this.serializeRefresh(signal);
    const refreshed = this.cached;
    if (!refreshed || refreshed.expiresAt - REFRESH_EARLY_MS <= this.now()) {
      throw new GmailAccessTokenError("refresh_unavailable");
    }
    return Buffer.from(refreshed.token);
  }

  destroy(): void {
    this.clearCached();
  }

  private async serializeRefresh(signal: AbortSignal): Promise<void> {
    let started = false;
    const execute = async () => {
      started = true;
      signal.throwIfAborted();
      const cached = this.cached;
      if (cached && cached.expiresAt - REFRESH_EARLY_MS > this.now()) return;
      await this.refresh(signal);
    };
    const run = this.refreshTail.then(execute, execute);
    this.refreshTail = run.then(
      () => undefined,
      () => undefined,
    );
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        if (!started) finish(() => reject(signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      run.then(
        () => finish(resolve),
        (error) => finish(() => reject(error)),
      );
      if (signal.aborted) onAbort();
    });
  }

  private async refresh(callerSignal: AbortSignal): Promise<void> {
    const loaded = await this.store.loadGmailCredential(this.accountId);
    if (!loaded || loaded.stored.status !== "connected") {
      if (loaded) destroyStoredGmailCredential(loaded.credential);
      throw new GmailAccessTokenError("invalid_grant");
    }
    let clientSecret: Buffer | null = null;
    let accessToken: Buffer | null = null;
    let retryAfterMs: number | null = null;
    const timeoutSignal = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
    const signal = AbortSignal.any([callerSignal, timeoutSignal]);
    try {
      clientSecret = await readGmailOAuthClientSecret(this.environment);
      const clientId = validateClientId(this.environment.GMAIL_OAUTH_CLIENT_ID);
      const body = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret.toString("utf8"),
        refresh_token: loaded.credential.refreshToken.toString("utf8"),
        grant_type: "refresh_token",
      });
      let response: Response;
      try {
        response = await this.request(GOOGLE_TOKEN_ENDPOINT, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
          cache: "no-store",
          redirect: "error",
          signal,
        });
      } catch {
        if (callerSignal.aborted || timeoutSignal.aborted) {
          throw new GmailAccessTokenError("refresh_timeout");
        }
        throw new GmailAccessTokenError("refresh_unavailable");
      }
      retryAfterMs = parseGmailRetryAfterMs(
        response.headers.get("Retry-After"),
        this.now(),
      );
      const payload = await readBoundedJson(response);
      if (!response.ok) {
        if (
          response.status === 400 &&
          isRecord(payload) &&
          payload.error === "invalid_grant"
        ) {
          await this.markReauthRequired(loaded.stored);
          throw new GmailAccessTokenError("invalid_grant");
        }
        throw new GmailAccessTokenError("refresh_unavailable", retryAfterMs);
      }
      const grant = validateRefreshGrant(payload);
      accessToken = Buffer.from(grant.accessToken, "utf8");
      this.clearCached();
      this.cached = {
        token: Buffer.from(accessToken),
        expiresAt: this.now() + grant.expiresInSeconds * 1_000,
      };
    } catch (error) {
      if (error instanceof GmailAccessTokenError) {
        if (
          error.code === "refresh_unavailable" &&
          error.retryAfterMs === null &&
          retryAfterMs !== null
        ) {
          throw new GmailAccessTokenError(error.code, retryAfterMs);
        }
        throw error;
      }
      if (callerSignal.aborted || timeoutSignal.aborted) {
        throw new GmailAccessTokenError("refresh_timeout");
      }
      throw new GmailAccessTokenError("refresh_unavailable");
    } finally {
      accessToken?.fill(0);
      clientSecret?.fill(0);
      destroyStoredGmailCredential(loaded.credential);
    }
  }

  private async markReauthRequired(stored: StoredGmailMailAccount): Promise<void> {
    const now = this.now();
    if (stored.status === "reauth_required") return;
    try {
      await this.store.updateMetadata(
        Object.freeze({ ...stored, status: "reauth_required", updatedAt: now }),
        new AbortController().signal,
      );
    } catch {
      // The API still returns invalid_grant. A later sync can project the same
      // reauth state without turning a failed metadata write into token reuse.
    }
  }

  private clearCached(): void {
    this.cached?.token.fill(0);
    this.cached = null;
  }
}

function validateRefreshGrant(value: unknown): {
  readonly accessToken: string;
  readonly expiresInSeconds: number;
} {
  if (
    !isRecord(value) ||
    typeof value.access_token !== "string" ||
    value.access_token.length === 0 ||
    Buffer.byteLength(value.access_token) > MAX_ACCESS_TOKEN_BYTES ||
    /[\u0000\r\n]/.test(value.access_token) ||
    value.token_type !== "Bearer" ||
    !Number.isSafeInteger(value.expires_in) ||
    (value.expires_in as number) < 60 ||
    (value.expires_in as number) > 86_400
  ) {
    throw new GmailAccessTokenError("refresh_unavailable");
  }
  return Object.freeze({
    accessToken: value.access_token,
    expiresInSeconds: value.expires_in as number,
  });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type");
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType ?? "")) {
    await response.body?.cancel().catch(() => undefined);
    throw new GmailAccessTokenError("refresh_unavailable");
  }
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_TOKEN_RESPONSE_BYTES)) {
    await response.body?.cancel().catch(() => undefined);
    throw new GmailAccessTokenError("refresh_unavailable");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new GmailAccessTokenError("refresh_unavailable");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_TOKEN_RESPONSE_BYTES) {
        next.value.fill(0);
        await reader.cancel().catch(() => undefined);
        throw new GmailAccessTokenError("refresh_unavailable");
      }
      chunks.push(next.value.slice());
      next.value.fill(0);
    }
    const joined = Buffer.allocUnsafe(total);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(joined));
    } finally {
      joined.fill(0);
    }
  } catch (error) {
    if (error instanceof GmailAccessTokenError) throw error;
    throw new GmailAccessTokenError("refresh_unavailable");
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    reader.releaseLock();
  }
}

function validateClientId(value: string | undefined): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > 512 ||
    /[\u0000-\u0020\u007f]/.test(value)
  ) {
    throw new GmailAccessTokenError("refresh_unavailable");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
