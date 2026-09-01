import type { MailEndpoint, MailTlsMode } from "../ports";
import type { MailSystemMailbox } from "../message-types";
import { validateMailEndpoint } from "../security";

const SAFE_ACCOUNT_ID = /^account-a[0-9a-f]{32}$/;
const SAFE_CREDENTIAL_REF = /^credential-r[0-9a-f]{32}$/;
const SAFE_BINDING_REF = /^binding-r[0-9a-f]{32}$/;
const MAX_CONNECTED_AT_FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_EMAIL_BYTES = 320;
const MAX_USERNAME_BYTES = 512;
const MAX_PASSWORD_BYTES = 4 * 1024;
const MAX_DISPLAY_NAME_BYTES = 256;

export const MAX_MAIL_ACCOUNTS = 3;

export const MAIL_ACCOUNT_CAPABILITIES_CONTRACT_HEADER =
  "x-brain-mail-account-capabilities";
export const MAIL_ACCOUNT_CAPABILITIES_CONTRACT_VALUE = "v1";

export type MailProviderKind = "imap" | "gmail";
export type MailAccountLifecycleStatus = "connected" | "reauth_required";

export interface MailAccountCapabilities {
  readonly mailboxes: readonly MailSystemMailbox[];
  readonly listThreads: boolean;
  readonly sync: boolean;
  readonly headerPreview: boolean;
  readonly messageBodies: boolean;
  readonly threadMutations: boolean;
  readonly compose: boolean;
  readonly send: boolean;
  readonly reply: boolean;
}

const GMAIL_MAIL_ACCOUNT_CAPABILITIES: MailAccountCapabilities = Object.freeze({
  mailboxes: Object.freeze<MailSystemMailbox[]>([
    "inbox",
    "starred",
    "sent",
    "all",
    "spam",
    "trash",
  ]),
  listThreads: true,
  sync: true,
  headerPreview: true,
  messageBodies: true,
  threadMutations: true,
  compose: true,
  send: true,
  reply: true,
});

/**
 * An IMAP account mutates threads: `\Seen` and `\Flagged` through STORE,
 * archive, trash and junk through a MOVE to a mailbox found by SPECIAL-USE or
 * a well-known name. `mailboxes` stays Inbox-only because listing those other
 * folders is a separate slice — the mutations move mail out of the Inbox, they
 * do not yet give it somewhere to be browsed. A server that advertises no
 * mailbox for a role refuses that one mutation at the moment it is pressed.
 */
const IMAP_MAIL_ACCOUNT_CAPABILITIES: MailAccountCapabilities = Object.freeze({
  mailboxes: Object.freeze<MailSystemMailbox[]>(["inbox"]),
  listThreads: true,
  sync: true,
  headerPreview: true,
  messageBodies: true,
  threadMutations: true,
  compose: false,
  send: false,
  reply: false,
});

const IMAP_SMTP_MAIL_ACCOUNT_CAPABILITIES: MailAccountCapabilities =
  Object.freeze({
    ...IMAP_MAIL_ACCOUNT_CAPABILITIES,
    compose: true,
    send: true,
    reply: true,
  });

export interface MailAccountConnectInput {
  readonly emailAddress: string;
  readonly imap: {
    readonly hostname: string;
    readonly port: number;
    readonly tls: MailTlsMode;
    readonly username: string;
    /** Null means "keep the saved password" and is valid only for an edit. */
    readonly password: string | null;
  };
  /**
   * Optional custom-domain SMTP endpoint. It intentionally has its own
   * username and transport binding even when it reuses the encrypted mailbox
   * password. Omitting it keeps a receive-only account.
   */
  readonly smtp?: {
    readonly hostname: string;
    readonly port: number;
    readonly tls: MailTlsMode;
    readonly username: string;
  };
}

export interface ProvisionedSmtpAccount {
  readonly endpoint: MailEndpoint;
  readonly username: string;
  readonly credentialRef: {
    readonly id: string;
    readonly version: number;
  };
  readonly transportBindingRef: {
    readonly id: string;
    readonly version: number;
  };
}

export interface ProvisionedImapAccount {
  readonly accountId: string;
  readonly emailAddress: string;
  readonly endpoint: MailEndpoint;
  readonly username: string;
  readonly credentialRef: {
    readonly id: string;
    readonly version: number;
  };
  readonly transportBindingRef: {
    readonly id: string;
    readonly version: number;
  };
  /** Missing means the legacy receive-only account shape. */
  readonly smtp?: ProvisionedSmtpAccount;
  readonly connectedAt: number;
}

export interface PublicMailAccount {
  readonly accountId: string;
  readonly emailAddress: string;
  readonly imap: {
    readonly hostname: string;
    readonly port: number;
    readonly tls: MailTlsMode;
    readonly username: string;
  };
  readonly smtp?: {
    readonly hostname: string;
    readonly port: number;
    readonly tls: MailTlsMode;
    readonly username: string;
  };
  readonly connectedAt: number;
}

export interface MailAccountStatus {
  readonly apiVersion: 1;
  readonly configured: boolean;
  readonly account: PublicMailAccount | null;
}

export interface StoredImapMailAccount {
  readonly account: ProvisionedImapAccount;
  readonly providerKind: "imap";
  readonly displayName: string | null;
  readonly status: MailAccountLifecycleStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ProvisionedGmailAccount {
  readonly accountId: string;
  readonly emailAddress: string;
  readonly subject: string;
  readonly credentialRef: {
    readonly id: string;
    readonly version: number;
  };
  readonly connectedAt: number;
  readonly grantedAt: number;
}

export interface StoredGmailMailAccount {
  readonly account: ProvisionedGmailAccount;
  readonly providerKind: "gmail";
  readonly displayName: string | null;
  readonly status: MailAccountLifecycleStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type StoredMailAccount =
  | StoredImapMailAccount
  | StoredGmailMailAccount;

export interface BasePublicMailAccountV2 {
  readonly accountId: string;
  readonly emailAddress: string;
  readonly connectedAt: number;
  readonly displayName: string | null;
  readonly status: MailAccountLifecycleStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface PublicImapMailAccountV2 extends BasePublicMailAccountV2 {
  readonly providerKind: "imap";
  readonly imap: PublicMailAccount["imap"];
  readonly smtp?: PublicMailAccount["smtp"];
}

/** Reserved response variant for the separately implemented OAuth provider. */
export interface PublicGmailMailAccountV2 extends BasePublicMailAccountV2 {
  readonly providerKind: "gmail";
}

export type PublicMailAccountV2 =
  | PublicImapMailAccountV2
  | PublicGmailMailAccountV2;

export type PublicMailAccountV3 = PublicMailAccountV2 & {
  readonly capabilities: MailAccountCapabilities;
};

export interface MailAccountsStatus {
  readonly apiVersion: 2;
  readonly accounts: readonly PublicMailAccountV2[];
}

export interface MailAccountsCapabilitiesStatus {
  readonly apiVersion: 3;
  readonly accounts: readonly PublicMailAccountV3[];
}

export interface MailAccountResult {
  readonly apiVersion: 2;
  readonly account: PublicMailAccountV2;
}

export interface MailAccountCreateInput extends MailAccountConnectInput {
  readonly providerKind: "imap";
  readonly displayName: string | null;
}

export interface MailAccountPatchInput {
  readonly emailAddress?: string;
  readonly displayName?: string | null;
  readonly imap?: {
    readonly hostname?: string;
    readonly port?: number;
    readonly tls?: MailTlsMode;
    readonly username?: string;
    readonly password?: string | null;
  };
  /** Null explicitly removes SMTP and returns the account to receive-only. */
  readonly smtp?:
    | {
        readonly hostname?: string;
        readonly port?: number;
        readonly tls?: MailTlsMode;
        readonly username?: string;
      }
    | null;
}

export type MailAccountErrorCode =
  | "account_request_invalid"
  | "account_not_configured"
  | "account_not_found"
  | "account_already_exists"
  | "account_limit_reached"
  | "account_selection_required"
  | "account_state_invalid"
  | "account_state_unavailable"
  | "credential_key_invalid"
  | "imap_dns_failed"
  | "imap_tls_failed"
  | "imap_connection_failed"
  | "imap_authentication_failed"
  | "imap_connection_timeout"
  | "smtp_dns_failed"
  | "smtp_tls_failed"
  | "smtp_connection_failed"
  | "smtp_authentication_failed"
  | "smtp_connection_timeout";

export class MailAccountError extends Error {
  readonly code: MailAccountErrorCode;

  constructor(code: MailAccountErrorCode) {
    super(code);
    this.name = "MailAccountError";
    this.code = code;
  }
}

export function validateMailAccountConnectInput(
  value: unknown,
): MailAccountConnectInput {
  if (!isRecordWithFields(value, ["emailAddress", "imap"], ["smtp"])) {
    throw new MailAccountError("account_request_invalid");
  }
  if (!isExactRecord(value.imap, ["hostname", "password", "port", "tls", "username"])) {
    throw new MailAccountError("account_request_invalid");
  }

  const emailAddress = validateEmailAddress(value.emailAddress);
  const username = validateUsername(value.imap.username);
  const password = validatePassword(value.imap.password);
  let endpoint: MailEndpoint;
  try {
    endpoint = validateMailEndpoint("imap", {
      hostname: value.imap.hostname as string,
      port: value.imap.port as number,
      tls: value.imap.tls as MailTlsMode,
    });
  } catch {
    throw new MailAccountError("account_request_invalid");
  }

  let smtp: MailAccountConnectInput["smtp"];
  if (Object.prototype.hasOwnProperty.call(value, "smtp")) {
    if (
      !isExactRecord(value.smtp, ["hostname", "port", "tls", "username"])
    ) {
      throw new MailAccountError("account_request_invalid");
    }
    let smtpEndpoint: MailEndpoint;
    try {
      smtpEndpoint = validateMailEndpoint("smtp", {
        hostname: value.smtp.hostname as string,
        port: value.smtp.port as number,
        tls: value.smtp.tls as MailTlsMode,
      });
    } catch {
      throw new MailAccountError("account_request_invalid");
    }
    smtp = Object.freeze({
      ...smtpEndpoint,
      username: validateUsername(value.smtp.username),
    });
  }

  return Object.freeze({
    emailAddress,
    imap: Object.freeze({
      ...endpoint,
      username,
      password,
    }),
    ...(smtp ? { smtp } : {}),
  });
}

export function validateMailAccountCreateInput(
  value: unknown,
): MailAccountCreateInput {
  if (
    !isRecordWithFields(
      value,
      ["emailAddress", "imap", "providerKind"],
      ["displayName", "smtp"],
    ) ||
    value.providerKind !== "imap"
  ) {
    throw new MailAccountError("account_request_invalid");
  }
  const input = validateMailAccountConnectInput({
    emailAddress: value.emailAddress,
    imap: value.imap,
    ...(Object.prototype.hasOwnProperty.call(value, "smtp")
      ? { smtp: value.smtp }
      : {}),
  });
  return Object.freeze({
    ...input,
    providerKind: "imap",
    displayName: validateDisplayName(value.displayName),
  });
}

export function validateMailAccountPatchInput(
  value: unknown,
): MailAccountPatchInput {
  if (
    !isRecordWithFields(value, [], ["displayName", "emailAddress", "imap", "smtp"]) ||
    Reflect.ownKeys(value).length === 0
  ) {
    throw new MailAccountError("account_request_invalid");
  }

  const patch: {
    emailAddress?: string;
    displayName?: string | null;
    imap?: {
      hostname?: string;
      port?: number;
      tls?: MailTlsMode;
      username?: string;
      password?: string | null;
    };
    smtp?:
      | {
          hostname?: string;
          port?: number;
          tls?: MailTlsMode;
          username?: string;
        }
      | null;
  } = {};
  if (Object.prototype.hasOwnProperty.call(value, "emailAddress")) {
    patch.emailAddress = validateEmailAddress(value.emailAddress);
  }
  if (Object.prototype.hasOwnProperty.call(value, "displayName")) {
    patch.displayName = validateDisplayName(value.displayName);
  }
  if (Object.prototype.hasOwnProperty.call(value, "imap")) {
    if (
      !isRecordWithFields(
        value.imap,
        [],
        ["hostname", "password", "port", "tls", "username"],
      ) ||
      Reflect.ownKeys(value.imap).length === 0
    ) {
      throw new MailAccountError("account_request_invalid");
    }
    const imap: {
      hostname?: string;
      port?: number;
      tls?: MailTlsMode;
      username?: string;
      password?: string | null;
    } = {};
    if (Object.prototype.hasOwnProperty.call(value.imap, "hostname")) {
      if (typeof value.imap.hostname !== "string") {
        throw new MailAccountError("account_request_invalid");
      }
      imap.hostname = value.imap.hostname;
    }
    if (Object.prototype.hasOwnProperty.call(value.imap, "port")) {
      if (typeof value.imap.port !== "number") {
        throw new MailAccountError("account_request_invalid");
      }
      imap.port = value.imap.port;
    }
    if (Object.prototype.hasOwnProperty.call(value.imap, "tls")) {
      if (value.imap.tls !== "implicit" && value.imap.tls !== "starttls") {
        throw new MailAccountError("account_request_invalid");
      }
      imap.tls = value.imap.tls;
    }
    if (Object.prototype.hasOwnProperty.call(value.imap, "username")) {
      imap.username = validateUsername(value.imap.username);
    }
    if (Object.prototype.hasOwnProperty.call(value.imap, "password")) {
      imap.password = validatePassword(value.imap.password);
    }
    patch.imap = Object.freeze(imap);
  }
  if (Object.prototype.hasOwnProperty.call(value, "smtp")) {
    if (value.smtp === null) {
      patch.smtp = null;
    } else {
      if (
        !isRecordWithFields(
          value.smtp,
          [],
          ["hostname", "port", "tls", "username"],
        ) ||
        Reflect.ownKeys(value.smtp).length === 0
      ) {
        throw new MailAccountError("account_request_invalid");
      }
      const smtp: {
        hostname?: string;
        port?: number;
        tls?: MailTlsMode;
        username?: string;
      } = {};
      if (Object.prototype.hasOwnProperty.call(value.smtp, "hostname")) {
        if (typeof value.smtp.hostname !== "string") {
          throw new MailAccountError("account_request_invalid");
        }
        smtp.hostname = value.smtp.hostname;
      }
      if (Object.prototype.hasOwnProperty.call(value.smtp, "port")) {
        if (typeof value.smtp.port !== "number") {
          throw new MailAccountError("account_request_invalid");
        }
        smtp.port = value.smtp.port;
      }
      if (Object.prototype.hasOwnProperty.call(value.smtp, "tls")) {
        if (value.smtp.tls !== "implicit" && value.smtp.tls !== "starttls") {
          throw new MailAccountError("account_request_invalid");
        }
        smtp.tls = value.smtp.tls;
      }
      if (Object.prototype.hasOwnProperty.call(value.smtp, "username")) {
        smtp.username = validateUsername(value.smtp.username);
      }
      patch.smtp = Object.freeze(smtp);
    }
  }
  return Object.freeze(patch);
}

export function validateProvisionedImapAccount(
  value: unknown,
  now = Date.now(),
): ProvisionedImapAccount {
  if (
    !isRecordWithFields(
      value,
      [
        "accountId",
        "connectedAt",
        "credentialRef",
        "emailAddress",
        "endpoint",
        "transportBindingRef",
        "username",
      ],
      ["smtp"],
    ) ||
    !isExactRecord(value.credentialRef, ["id", "version"]) ||
    !isExactRecord(value.transportBindingRef, ["id", "version"])
  ) {
    throw new MailAccountError("account_state_invalid");
  }

  if (typeof value.accountId !== "string" || !SAFE_ACCOUNT_ID.test(value.accountId)) {
    throw new MailAccountError("account_state_invalid");
  }
  if (
    typeof value.credentialRef.id !== "string" ||
    !SAFE_CREDENTIAL_REF.test(value.credentialRef.id) ||
    typeof value.transportBindingRef.id !== "string" ||
    !SAFE_BINDING_REF.test(value.transportBindingRef.id) ||
    !isPositiveVersion(value.credentialRef.version) ||
    !isPositiveVersion(value.transportBindingRef.version)
  ) {
    throw new MailAccountError("account_state_invalid");
  }
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(value.connectedAt) ||
    (value.connectedAt as number) < 0 ||
    (value.connectedAt as number) > now + MAX_CONNECTED_AT_FUTURE_SKEW_MS
  ) {
    throw new MailAccountError("account_state_invalid");
  }

  let endpoint: MailEndpoint;
  try {
    endpoint = validateMailEndpoint("imap", value.endpoint as MailEndpoint);
  } catch {
    throw new MailAccountError("account_state_invalid");
  }

  let smtp: ProvisionedSmtpAccount | undefined;
  if (Object.prototype.hasOwnProperty.call(value, "smtp")) {
    if (
      !isExactRecord(value.smtp, [
        "credentialRef",
        "endpoint",
        "transportBindingRef",
        "username",
      ]) ||
      !isExactRecord(value.smtp.credentialRef, ["id", "version"]) ||
      !isExactRecord(value.smtp.transportBindingRef, ["id", "version"]) ||
      typeof value.smtp.credentialRef.id !== "string" ||
      !SAFE_CREDENTIAL_REF.test(value.smtp.credentialRef.id) ||
      !isPositiveVersion(value.smtp.credentialRef.version) ||
      typeof value.smtp.transportBindingRef.id !== "string" ||
      !SAFE_BINDING_REF.test(value.smtp.transportBindingRef.id) ||
      !isPositiveVersion(value.smtp.transportBindingRef.version) ||
      value.smtp.transportBindingRef.id === value.transportBindingRef.id ||
      value.smtp.credentialRef.id !== value.credentialRef.id ||
      value.smtp.credentialRef.version !== value.credentialRef.version
    ) {
      throw new MailAccountError("account_state_invalid");
    }
    let smtpEndpoint: MailEndpoint;
    try {
      smtpEndpoint = validateMailEndpoint("smtp", value.smtp.endpoint as MailEndpoint);
    } catch {
      throw new MailAccountError("account_state_invalid");
    }
    smtp = Object.freeze({
      endpoint: smtpEndpoint,
      username: validateStoredUsername(value.smtp.username),
      credentialRef: Object.freeze({
        id: value.smtp.credentialRef.id,
        version: value.smtp.credentialRef.version as number,
      }),
      transportBindingRef: Object.freeze({
        id: value.smtp.transportBindingRef.id,
        version: value.smtp.transportBindingRef.version as number,
      }),
    });
  }

  return Object.freeze({
    accountId: value.accountId,
    emailAddress: validateStoredEmailAddress(value.emailAddress),
    endpoint,
    username: validateStoredUsername(value.username),
    credentialRef: Object.freeze({
      id: value.credentialRef.id,
      version: value.credentialRef.version as number,
    }),
    transportBindingRef: Object.freeze({
      id: value.transportBindingRef.id,
      version: value.transportBindingRef.version as number,
    }),
    ...(smtp ? { smtp } : {}),
    connectedAt: value.connectedAt as number,
  });
}

export function publicMailAccount(
  account: ProvisionedImapAccount,
): PublicMailAccount {
  return Object.freeze({
    accountId: account.accountId,
    emailAddress: account.emailAddress,
    imap: Object.freeze({
      ...account.endpoint,
      username: account.username,
    }),
    ...(account.smtp
      ? {
          smtp: Object.freeze({
            ...account.smtp.endpoint,
            username: account.smtp.username,
          }),
        }
      : {}),
    connectedAt: account.connectedAt,
  });
}

export function validateStoredMailAccount(
  value: unknown,
  now = Date.now(),
): StoredMailAccount {
  if (
    !isExactRecord(value, [
      "account",
      "createdAt",
      "displayName",
      "providerKind",
      "status",
      "updatedAt",
    ]) ||
    (value.providerKind !== "imap" && value.providerKind !== "gmail") ||
    (value.status !== "connected" && value.status !== "reauth_required") ||
    !isSafeTimestamp(value.createdAt, now) ||
    !isSafeTimestamp(value.updatedAt, now) ||
    (value.updatedAt as number) < (value.createdAt as number)
  ) {
    throw new MailAccountError("account_state_invalid");
  }
  const common = {
    displayName: validateStoredDisplayName(value.displayName),
    status: value.status,
    createdAt: value.createdAt as number,
    updatedAt: value.updatedAt as number,
  } as const;
  if (value.providerKind === "imap") {
    return Object.freeze({
      account: validateProvisionedImapAccount(value.account, now),
      providerKind: "imap",
      ...common,
    });
  }
  return Object.freeze({
    account: validateProvisionedGmailAccount(value.account, now),
    providerKind: "gmail",
    ...common,
  });
}

export function publicMailAccountV2(
  stored: StoredMailAccount,
): PublicMailAccountV2 {
  if (stored.providerKind === "gmail") {
    return Object.freeze({
      accountId: stored.account.accountId,
      emailAddress: stored.account.emailAddress,
      connectedAt: stored.account.connectedAt,
      providerKind: "gmail",
      displayName: stored.displayName,
      status: stored.status,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
    });
  }
  return Object.freeze({
    ...publicMailAccount(stored.account),
    providerKind: stored.providerKind,
    displayName: stored.displayName,
    status: stored.status,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
  });
}

export function mailAccountCapabilities(
  providerKind: MailProviderKind,
  sendConfigured = providerKind === "gmail",
): MailAccountCapabilities {
  if (providerKind === "gmail") return GMAIL_MAIL_ACCOUNT_CAPABILITIES;
  return sendConfigured
    ? IMAP_SMTP_MAIL_ACCOUNT_CAPABILITIES
    : IMAP_MAIL_ACCOUNT_CAPABILITIES;
}

export function publicMailAccountV3(
  stored: StoredMailAccount,
  smtpSubmissionReady = true,
): PublicMailAccountV3 {
  const account = publicMailAccountV2(stored);
  return Object.freeze({
    ...account,
    capabilities: mailAccountCapabilities(
      stored.providerKind,
      stored.providerKind === "gmail" ||
        (smtpSubmissionReady &&
          stored.status === "connected" &&
          stored.account.smtp !== undefined),
    ),
  });
}

export function validateProvisionedGmailAccount(
  value: unknown,
  now = Date.now(),
): ProvisionedGmailAccount {
  if (
    !isExactRecord(value, [
      "accountId",
      "connectedAt",
      "credentialRef",
      "emailAddress",
      "grantedAt",
      "subject",
    ]) ||
    !isExactRecord(value.credentialRef, ["id", "version"]) ||
    typeof value.accountId !== "string" ||
    !SAFE_ACCOUNT_ID.test(value.accountId) ||
    typeof value.credentialRef.id !== "string" ||
    !SAFE_CREDENTIAL_REF.test(value.credentialRef.id) ||
    !isPositiveVersion(value.credentialRef.version) ||
    typeof value.subject !== "string" ||
    !/^[A-Za-z0-9_-]{1,255}$/.test(value.subject) ||
    !isSafeTimestamp(value.connectedAt, now) ||
    !isSafeTimestamp(value.grantedAt, now) ||
    (value.grantedAt as number) > (value.connectedAt as number)
  ) {
    throw new MailAccountError("account_state_invalid");
  }
  return Object.freeze({
    accountId: value.accountId,
    emailAddress: validateStoredEmailAddress(value.emailAddress),
    subject: value.subject,
    credentialRef: Object.freeze({
      id: value.credentialRef.id,
      version: value.credentialRef.version as number,
    }),
    connectedAt: value.connectedAt as number,
    grantedAt: value.grantedAt as number,
  });
}

function validateEmailAddress(value: unknown): string {
  if (typeof value !== "string") {
    throw new MailAccountError("account_request_invalid");
  }
  const normalized = value.trim();
  if (
    Buffer.byteLength(normalized) === 0 ||
    Buffer.byteLength(normalized) > MAX_EMAIL_BYTES ||
    /[\u0000-\u0020\u007f]/.test(normalized) ||
    !/^[^@]+@[^@.]+(?:\.[^@.]+)+$/.test(normalized)
  ) {
    throw new MailAccountError("account_request_invalid");
  }
  return normalized;
}

function validateUsername(value: unknown): string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) === 0 ||
    Buffer.byteLength(value) > MAX_USERNAME_BYTES ||
    /[\u0000\r\n]/.test(value)
  ) {
    throw new MailAccountError("account_request_invalid");
  }
  return value;
}

function validatePassword(value: unknown): string | null {
  if (value === "" || value === null) return null;
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) === 0 ||
    Buffer.byteLength(value) > MAX_PASSWORD_BYTES ||
    value.includes("\u0000")
  ) {
    throw new MailAccountError("account_request_invalid");
  }
  return value;
}

function validateDisplayName(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new MailAccountError("account_request_invalid");
  }
  const normalized = value.trim();
  if (
    Buffer.byteLength(normalized) === 0 ||
    Buffer.byteLength(normalized) > MAX_DISPLAY_NAME_BYTES ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new MailAccountError("account_request_invalid");
  }
  return normalized;
}

function validateStoredDisplayName(value: unknown): string | null {
  try {
    if (value === undefined) throw new Error("missing display name");
    return validateDisplayName(value);
  } catch {
    throw new MailAccountError("account_state_invalid");
  }
}

function isSafeTimestamp(value: unknown, now: number): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= now + MAX_CONNECTED_AT_FUTURE_SKEW_MS
  );
}

function validateStoredEmailAddress(value: unknown): string {
  try {
    return validateEmailAddress(value);
  } catch {
    throw new MailAccountError("account_state_invalid");
  }
}

function validateStoredUsername(value: unknown): string {
  try {
    return validateUsername(value);
  } catch {
    throw new MailAccountError("account_state_invalid");
  }
}

function isPositiveVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  ) {
    return false;
  }
  return fields.every((field) => {
    const descriptor = descriptors[field];
    return descriptor !== undefined && "value" in descriptor;
  });
}

function isRecordWithFields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  const allowed = [...required, ...optional];
  return (
    required.every((field) => Object.prototype.hasOwnProperty.call(value, field)) &&
    keys.every(
      (key) =>
        typeof key === "string" &&
        allowed.includes(key) &&
        descriptors[key] !== undefined &&
        "value" in descriptors[key],
    )
  );
}
