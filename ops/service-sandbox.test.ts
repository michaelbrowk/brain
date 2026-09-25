import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(path.join(process.cwd(), "ops", name), "utf8");

/** The two long-lived units carried every namespace systemd offers, because the
 *  directive was not in the unit at all and the default is
 *  `RestrictNamespaces=no`. Measured on the droplet in the 0.15.0 audit. Node
 *  creates no namespace, so withholding them costs these services nothing.
 *
 *  `SystemCallFilter` is deliberately absent, and this is the test that says so.
 *  A whitelist kills the process with SIGSYS on the first call outside it, and
 *  nothing here has ever executed one on Linux: libuv probes io_uring at startup
 *  on a kernel that has it, and `@system-service`'s coverage of that probe is
 *  exactly the kind of thing a launch day should not be the first to find out.
 *  Shipping it without a staged restart on the box would trade a rate-limit
 *  defect for a crash loop. The backlog carries the verification
 *  (`systemd-analyze syscall-filter @system-service`, a staged restart, then
 *  `SystemCallErrorNumber=EPERM` so a miss is an error and not a corpse) together
 *  with `brain-mail-mime@.service`, the untrusted-MIME parser, which has neither
 *  directive either. */
describe("the long-lived units restrict namespaces and filter no system calls", () => {
  it.each(["brain.service", "brain-mail.service"])("%s", (unit) => {
    const service = read(unit);
    expect(service.match(/^RestrictNamespaces=.*$/gm)).toEqual([
      "RestrictNamespaces=yes",
    ]);
    expect(service).not.toMatch(/^SystemCallFilter=/m);
  });
});
