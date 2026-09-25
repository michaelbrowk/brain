import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFileSync(path.join(process.cwd(), "ops", name), "utf8");

/** The two long-lived units carried every namespace and every system call
 *  systemd offers, because neither directive was in the unit at all and the
 *  defaults are `SystemCallFilter=` empty and `RestrictNamespaces=no`. Measured
 *  on the droplet in the 0.15.0 audit.
 *
 *  `@system-service` is the set a service like these needs: Node, sqlite,
 *  AF_UNIX and AF_INET sockets, and the child processes the web service spawns
 *  for git, ripgrep and the mail work. What it withholds is what neither
 *  service does — loading a module, mounting a filesystem, setting the clock,
 *  raw I/O, rebooting, swap. `RestrictNamespaces=yes` withholds the rest of the
 *  container-building surface, which neither service asks for either.
 *
 *  Nothing in the standalone smoke runs systemd, so the reasoning above is the
 *  evidence here, plus `systemd-analyze verify` in `scripts/verify-ops.sh`. */
describe("the long-lived units keep a syscall filter and no new namespaces", () => {
  it.each(["brain.service", "brain-mail.service"])("%s", (unit) => {
    const service = read(unit);
    expect(service.match(/^SystemCallFilter=.*$/gm)).toEqual([
      "SystemCallFilter=@system-service",
    ]);
    expect(service.match(/^RestrictNamespaces=.*$/gm)).toEqual([
      "RestrictNamespaces=yes",
    ]);
  });
});
