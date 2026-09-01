import {
  chmod,
  link,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GMAIL_OAUTH_CREDENTIAL_NAMES,
  isSafeGmailCredentialMetadata,
  readGmailOAuthServiceCredentials,
} from "./credentials";
import { GmailOAuthError } from "./oauth";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Gmail OAuth systemd credentials", () => {
  it("accepts the root-owned 0440 files emitted by systemd credentials", () => {
    expect(
      isSafeGmailCredentialMetadata(
        { uid: 0, gid: 0, mode: 0o100440 },
        997,
      ),
    ).toBe(true);
    expect(
      isSafeGmailCredentialMetadata(
        { uid: 0, gid: 42, mode: 0o100440 },
        997,
      ),
    ).toBe(false);
    expect(
      isSafeGmailCredentialMetadata(
        { uid: 997, gid: 997, mode: 0o100440 },
        997,
      ),
    ).toBe(false);
    expect(
      isSafeGmailCredentialMetadata(
        { uid: 0, gid: 0, mode: 0o100460 },
        997,
      ),
    ).toBe(false);
  });

  it("reads only the two exact private credential files", async () => {
    const directory = await createCredentials();
    const credentials = await readGmailOAuthServiceCredentials({
      CREDENTIALS_DIRECTORY: directory,
    });
    expect(credentials.clientSecret.toString("utf8")).toBe("test-secret");
    expect(credentials.transactionKey).toEqual(Buffer.alloc(32, 7));
    credentials.clientSecret.fill(0);
    credentials.transactionKey.fill(0);
  });

  it("rejects unsafe permissions, symlinks, hardlinks and wrong key length", async () => {
    for (const unsafe of ["permissions", "symlink", "hardlink", "length"] as const) {
      const directory = await createCredentials();
      const keyPath = path.join(
        directory,
        GMAIL_OAUTH_CREDENTIAL_NAMES.transactionKey,
      );
      if (unsafe === "permissions") {
        await chmod(keyPath, 0o644);
      } else if (unsafe === "symlink") {
        await rm(keyPath);
        const outside = path.join(directory, "outside-key");
        await writeFile(outside, Buffer.alloc(32, 7), { mode: 0o600 });
        await symlink(outside, keyPath);
      } else if (unsafe === "hardlink") {
        await link(keyPath, path.join(directory, "linked-key"));
      } else {
        await writeFile(keyPath, Buffer.alloc(31, 7), { mode: 0o600 });
      }
      await expect(
        readGmailOAuthServiceCredentials({ CREDENTIALS_DIRECTORY: directory }),
      ).rejects.toEqual(new GmailOAuthError("gmail_oauth_unavailable"));
    }
  });

  it("rejects a newline-bearing client secret and an unsafe directory", async () => {
    const directory = await createCredentials();
    await writeFile(
      path.join(directory, GMAIL_OAUTH_CREDENTIAL_NAMES.clientSecret),
      "test-secret\n",
      { mode: 0o600 },
    );
    await expect(
      readGmailOAuthServiceCredentials({ CREDENTIALS_DIRECTORY: directory }),
    ).rejects.toEqual(new GmailOAuthError("gmail_oauth_unavailable"));
    await expect(
      readGmailOAuthServiceCredentials({ CREDENTIALS_DIRECTORY: "relative" }),
    ).rejects.toEqual(new GmailOAuthError("gmail_oauth_unavailable"));
  });
});

async function createCredentials(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "brain-gmail-credentials-"));
  roots.push(directory);
  await chmod(directory, 0o700);
  await writeFile(
    path.join(directory, GMAIL_OAUTH_CREDENTIAL_NAMES.clientSecret),
    "test-secret",
    { mode: 0o600 },
  );
  await writeFile(
    path.join(directory, GMAIL_OAUTH_CREDENTIAL_NAMES.transactionKey),
    Buffer.alloc(32, 7),
    { mode: 0o600 },
  );
  return directory;
}
