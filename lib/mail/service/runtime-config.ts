import path from "node:path";

import { MailAccountError } from "./account-types";
import {
  DEFAULT_GMAIL_INTERVAL_MS,
  DEFAULT_INTERVAL_MS,
} from "./background-sync";

const WRAPPING_KEY_CREDENTIAL_NAME = "account-wrapping-key";

export interface MailServiceRuntimePaths {
  readonly stateDirectory: string;
  readonly credentialPath: string;
}

export function readMailServiceRuntimePaths(
  environment: Readonly<Record<string, string | undefined>>,
): MailServiceRuntimePaths {
  const stateDirectory = requireSingleAbsoluteDirectory(
    environment.STATE_DIRECTORY,
  );
  const credentialsDirectory = requireSingleAbsoluteDirectory(
    environment.CREDENTIALS_DIRECTORY,
  );
  return Object.freeze({
    stateDirectory,
    credentialPath: path.join(
      credentialsDirectory,
      WRAPPING_KEY_CREDENTIAL_NAME,
    ),
  });
}

const MIN_SYNC_INTERVAL_MS = 5_000;
const MAX_SYNC_INTERVAL_MS = 60 * 60_000;

export interface MailSyncCadenceConfig {
  readonly intervalMs: number;
  readonly gmailIntervalMs: number;
  readonly imapIdle: boolean;
}

/**
 * The background sync's cadence: `BRAIN_MAIL_SYNC_INTERVAL_MS`, the fallback
 * every account comes back to (60 s), `BRAIN_MAIL_GMAIL_INTERVAL_MS`, Gmail's
 * own cadence (20 s), and `BRAIN_MAIL_IMAP_IDLE`, on unless it is `0`. A value
 * that is not a plain whole number of milliseconds inside the bounds, or a
 * switch that is not `0` or `1`, is refused rather than read, like the SMTP
 * flags beside it: a service that starts on a guess polls a provider at a rate
 * nobody chose.
 */
export function readMailSyncCadenceConfig(input: {
  readonly syncIntervalMs?: string;
  readonly gmailIntervalMs?: string;
  readonly imapIdle?: string;
}): MailSyncCadenceConfig {
  if (input.imapIdle !== undefined && input.imapIdle !== "0" && input.imapIdle !== "1") {
    throw new Error("mail sync cadence configuration is invalid");
  }
  const intervalMs =
    input.syncIntervalMs === undefined
      ? DEFAULT_INTERVAL_MS
      : parseInterval(input.syncIntervalMs);
  const gmailIntervalMs =
    input.gmailIntervalMs === undefined
      ? Math.min(DEFAULT_GMAIL_INTERVAL_MS, intervalMs)
      : parseInterval(input.gmailIntervalMs);
  // Gmail backs off to the fallback, so a slower Gmail cadence would turn
  // the backoff into a speed-up.
  if (gmailIntervalMs > intervalMs) {
    throw new Error("mail sync cadence configuration is invalid");
  }
  return Object.freeze({
    intervalMs,
    gmailIntervalMs,
    imapIdle: input.imapIdle !== "0",
  });
}

function parseInterval(value: string): number {
  const parsed = /^[1-9][0-9]{3,6}$/.test(value) ? Number(value) : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_SYNC_INTERVAL_MS ||
    parsed > MAX_SYNC_INTERVAL_MS
  ) {
    throw new Error("mail sync cadence configuration is invalid");
  }
  return parsed;
}

function requireSingleAbsoluteDirectory(value: string | undefined): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes(":") ||
    value.includes("\u0000") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw new MailAccountError("account_state_unavailable");
  }
  return value;
}
