import path from "node:path";

import { MailAccountError } from "./account-types";

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
