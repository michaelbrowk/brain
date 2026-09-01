import { describe, expect, it } from "vitest";

import { readMailServiceRuntimePaths } from "./runtime-config";

describe("mail service runtime paths", () => {
  it("derives the fixed wrapping-key name from systemd directories", () => {
    expect(
      readMailServiceRuntimePaths({
        STATE_DIRECTORY: "/var/lib/brain-mail",
        CREDENTIALS_DIRECTORY: "/run/credentials/brain-mail.service",
      }),
    ).toEqual({
      stateDirectory: "/var/lib/brain-mail",
      credentialPath:
        "/run/credentials/brain-mail.service/account-wrapping-key",
    });
  });

  it("rejects missing, relative, and multi-directory environment values", () => {
    for (const stateDirectory of [
      undefined,
      "relative",
      "/var/lib/brain-mail:/other",
      "/var/lib/../lib/brain-mail",
    ]) {
      expect(() =>
        readMailServiceRuntimePaths({
          STATE_DIRECTORY: stateDirectory,
          CREDENTIALS_DIRECTORY: "/run/credentials/brain-mail.service",
        }),
      ).toThrow();
    }
  });
});
