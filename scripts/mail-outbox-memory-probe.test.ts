import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { MAIL_SEND_ATTACHMENT_LIMITS } from "@/lib/mail/send-attachment-codec";

const source = readFileSync(
  path.join(process.cwd(), "scripts", "lib", "mail-outbox-memory-probe.ts"),
  "utf8",
);

describe("the outbox memory probe", () => {
  /** A probe run with no `--size` measures the cap that ships, and the cap is
   *  what the probe exists to justify. The default was a literal through two
   *  cap moves and had to be remembered each time — a probe still reporting
   *  the previous figure is a stale measurement nobody notices, because it
   *  prints a table either way. */
  it("takes its default size from the outgoing attachment cap", () => {
    expect(source).toMatch(
      /const DEFAULT_SIZE_MIB\s*=\s*MAIL_SEND_ATTACHMENT_LIMITS\.maxTotalBytes \/ \(1024 \* 1024\);/,
    );
    expect(source).toMatch(/options\.sizes\.push\(DEFAULT_SIZE_MIB\)/);
    // Neither the usage line nor the file header may carry a size of its own.
    expect(source).not.toMatch(/--size \d/);
    expect(source).not.toMatch(/sizes\.push\(\s*\d/);
    // The default is printed into the usage line, so a cap that is not a whole
    // number of mebibytes would print as a fraction nobody would type back.
    expect(
      MAIL_SEND_ATTACHMENT_LIMITS.maxTotalBytes % (1024 * 1024),
    ).toBe(0);
  });
});
