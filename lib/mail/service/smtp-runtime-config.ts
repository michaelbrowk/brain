import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";

import type { CloudflareEgressClientOptions } from "../cloudflare-egress-client";
import { isSafeGmailCredentialMetadata } from "../providers/gmail/credentials";

export const SMTP_EGRESS_CREDENTIAL_NAMES = Object.freeze({
  hmacKey: "smtp-egress-hmac-key",
  accessClientId: "smtp-egress-access-client-id",
  accessClientSecret: "smtp-egress-access-client-secret",
});

/**
 * SMTP egress is an explicit production feature flag. Disabled or incomplete
 * configuration never falls back to direct SMTP or a weaker transport.
 */
export async function readOptionalSmtpEgressConfig(
  environment: Readonly<Record<string, string | undefined>>,
): Promise<CloudflareEgressClientOptions | null> {
  const enabled = environment.BRAIN_MAIL_SMTP_EGRESS_ENABLED;
  if (enabled === undefined || enabled === "0") return null;
  if (enabled !== "1") throw new Error("SMTP egress configuration is invalid");

  const url = validateRelayUrl(environment.BRAIN_MAIL_SMTP_EGRESS_URL);
  const directory = requireCredentialsDirectory(
    environment.CREDENTIALS_DIRECTORY,
  );
  const hmacKey = await readPrivateTextCredential(
    path.join(directory, SMTP_EGRESS_CREDENTIAL_NAMES.hmacKey),
    43,
  );
  if (!/^[A-Za-z0-9_-]{43}$/.test(hmacKey)) {
    throw new Error("SMTP egress configuration is invalid");
  }

  // The production service never connects to an HMAC-only public relay.
  // Preview/probe tooling may exercise that lower layer separately, but the
  // long-lived runtime requires Cloudflare Access as the outer identity gate.
  if (environment.BRAIN_MAIL_SMTP_EGRESS_ACCESS_ENABLED !== "1") {
    throw new Error("SMTP egress configuration is invalid");
  }
  const accessClientId = await readPrivateTextCredential(
    path.join(directory, SMTP_EGRESS_CREDENTIAL_NAMES.accessClientId),
    512,
  );
  const accessClientSecret = await readPrivateTextCredential(
    path.join(directory, SMTP_EGRESS_CREDENTIAL_NAMES.accessClientSecret),
    4 * 1024,
  );
  return Object.freeze({
    url,
    hmacKeyBase64Url: hmacKey,
    accessClientId,
    accessClientSecret,
  });
}

function validateRelayUrl(value: string | undefined): string {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("SMTP egress configuration is invalid");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("SMTP egress configuration is invalid");
  }
  if (
    parsed.protocol !== "wss:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname !== "/v1/tunnel" ||
    parsed.toString() !== value
  ) {
    throw new Error("SMTP egress configuration is invalid");
  }
  return value;
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
    throw new Error("SMTP egress configuration is invalid");
  }
  return value;
}

async function readPrivateTextCredential(
  filePath: string,
  maxBytes: number,
): Promise<string> {
  let handle: FileHandle;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new Error("SMTP egress configuration is unavailable");
  }
  try {
    const metadata = await handle.stat();
    const uid = typeof process.getuid === "function" ? process.getuid() : -1;
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size < 1 ||
      metadata.size > maxBytes ||
      !isSafeGmailCredentialMetadata(metadata, uid)
    ) {
      throw new Error("SMTP egress configuration is unavailable");
    }
    const bytes = await handle.readFile();
    try {
      if (
        bytes.length < 1 ||
        bytes.length > maxBytes ||
        bytes.includes(0) ||
        bytes.includes(10) ||
        bytes.includes(13)
      ) {
        throw new Error("SMTP egress configuration is unavailable");
      }
      return bytes.toString("utf8");
    } finally {
      bytes.fill(0);
    }
  } finally {
    await handle.close();
  }
}
