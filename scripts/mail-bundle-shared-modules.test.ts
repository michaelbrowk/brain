import path from "node:path";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

import { sharedMailModulesPlugin } from "./mail-bundle-shared-modules.mjs";

const root = process.cwd();

async function bundleSmtpRuntime() {
  return build({
    entryPoints: [path.join(root, "lib", "mail", "service", "smtp-runtime.ts")],
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    write: false,
    metafile: true,
    logLevel: "silent",
    plugins: [sharedMailModulesPlugin(root)],
  });
}

describe("SMTP runtime bundle", () => {
  // http.ts maps a refused SMTP sign-in by `instanceof MailAccountError`. A
  // second copy of the class inside this bundle turned every failed SMTP
  // check on an account edit into a 500 internal_error.
  it("loads MailAccountError from the shared runtime module", async () => {
    const result = await bundleSmtpRuntime();
    expect(Object.keys(result.metafile.inputs)).not.toContain(
      "lib/mail/service/account-types.ts",
    );
    const code = result.outputFiles[0]!.text;
    expect(code).toContain('require("./account-types")');
    expect(code).not.toMatch(/MailAccountError = class/);
  }, 60_000);
});
