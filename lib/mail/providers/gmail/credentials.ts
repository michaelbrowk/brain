import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { GmailOAuthError } from "./oauth";

export const GMAIL_OAUTH_CREDENTIAL_NAMES = Object.freeze({
  clientSecret: "gmail-oauth-client-secret",
  transactionKey: "gmail-oauth-transaction-key",
});

export interface GmailOAuthServiceCredentials {
  /** Caller owns both buffers and must wipe them after constructing runtime objects. */
  readonly clientSecret: Buffer;
  readonly transactionKey: Buffer;
}

export async function readGmailOAuthServiceCredentials(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<GmailOAuthServiceCredentials> {
  const directory = requireCredentialsDirectory(environment.CREDENTIALS_DIRECTORY);
  let clientSecret: Buffer | null = null;
  let transactionKey: Buffer | null = null;
  try {
    clientSecret = await readPrivateCredential(
      path.join(directory, GMAIL_OAUTH_CREDENTIAL_NAMES.clientSecret),
      { minBytes: 1, maxBytes: 4 * 1024 },
    );
    if (
      clientSecret.includes(0) ||
      clientSecret.includes(10) ||
      clientSecret.includes(13)
    ) {
      throw new GmailOAuthError("gmail_oauth_unavailable");
    }
    transactionKey = await readPrivateCredential(
      path.join(directory, GMAIL_OAUTH_CREDENTIAL_NAMES.transactionKey),
      { exactBytes: 32 },
    );
    const result = Object.freeze({ clientSecret, transactionKey });
    clientSecret = null;
    transactionKey = null;
    return result;
  } catch (error) {
    if (error instanceof GmailOAuthError) throw error;
    throw new GmailOAuthError("gmail_oauth_unavailable");
  } finally {
    clientSecret?.fill(0);
    transactionKey?.fill(0);
  }
}

/** Read only the secret needed by the Gmail refresh-token grant path. */
export async function readGmailOAuthClientSecret(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<Buffer> {
  const directory = requireCredentialsDirectory(environment.CREDENTIALS_DIRECTORY);
  const secret = await readPrivateCredential(
    path.join(directory, GMAIL_OAUTH_CREDENTIAL_NAMES.clientSecret),
    { minBytes: 1, maxBytes: 4 * 1024 },
  );
  if (secret.includes(0) || secret.includes(10) || secret.includes(13)) {
    secret.fill(0);
    throw new GmailOAuthError("gmail_oauth_unavailable");
  }
  return secret;
}

async function readPrivateCredential(
  filePath: string,
  size:
    | { readonly exactBytes: number }
    | { readonly minBytes: number; readonly maxBytes: number },
): Promise<Buffer> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new GmailOAuthError("gmail_oauth_unavailable");
  }
  try {
    const metadata = await handle.stat();
    const sizeValid =
      "exactBytes" in size
        ? metadata.size === size.exactBytes
        : metadata.size >= size.minBytes && metadata.size <= size.maxBytes;
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      !sizeValid ||
      !isSafeGmailCredentialMetadata(metadata, uid)
    ) {
      throw new GmailOAuthError("gmail_oauth_unavailable");
    }
    const value = await handle.readFile();
    const readSizeValid =
      "exactBytes" in size
        ? value.length === size.exactBytes
        : value.length >= size.minBytes && value.length <= size.maxBytes;
    if (!readSizeValid) {
      value.fill(0);
      throw new GmailOAuthError("gmail_oauth_unavailable");
    }
    return value;
  } catch (error) {
    if (error instanceof GmailOAuthError) throw error;
    throw new GmailOAuthError("gmail_oauth_unavailable");
  } finally {
    await handle.close();
  }
}

export function isSafeGmailCredentialMetadata(
  metadata: Readonly<{ uid: number; gid: number; mode: number }>,
  serviceUid: number,
): boolean {
  const mode = metadata.mode & 0o777;
  const privateOwnerFile =
    (metadata.uid === 0 || metadata.uid === serviceUid) &&
    (mode & 0o077) === 0;
  const sealedSystemdCredential =
    metadata.uid === 0 && metadata.gid === 0 && mode === 0o440;
  return privateOwnerFile || sealedSystemdCredential;
}

function requireCredentialsDirectory(value: string | undefined): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes(":") ||
    value.includes("\u0000") ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value
  ) {
    throw new GmailOAuthError("gmail_oauth_unavailable");
  }
  return value;
}
