import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

describe("brain-mail MIME worker deployment contracts", () => {
  it("pins and patches the exact reviewed parser graph", () => {
    const packageJson = JSON.parse(read("package.json")) as {
      dependencies: Record<string, string>;
    };
    expect(packageJson.dependencies.mailparser).toBe("3.9.14");
    expect(packageJson.dependencies["@zone-eu/mailsplit"]).toBe("5.4.14");
    expect(packageJson.dependencies.htmlparser2).toBe("10.1.0");
    const workspace = read("pnpm-workspace.yaml");
    expect(workspace).toContain(
      "'@zone-eu/mailsplit@5.4.14': patches/@zone-eu__mailsplit@5.4.14.patch",
    );
    expect(workspace).toContain(
      "mailparser@3.9.14: patches/mailparser@3.9.14.patch",
    );
    const splitPatch = read("patches/@zone-eu__mailsplit@5.4.14.patch");
    expect(splitPatch).toContain("maxTotalHeadSize");
    expect(splitPatch).toContain("maxNestingDepth");
    expect(splitPatch).toContain("maxLineSize");
    const parserPatch = read("patches/mailparser@3.9.14.patch");
    expect(parserPatch).toContain("trackDecodedBytes");
    expect(parserPatch).toContain("trackTextCharacters");
    expect(parserPatch).toContain("return done(err)");
  });

  it("starts exactly one no-network, no-credential process per connection", () => {
    const socket = read("ops/brain-mail-mime.socket");
    const sysusers = read("ops/brain-mail-mime.sysusers.conf");
    const tmpfiles = read("ops/brain-mail-mime.tmpfiles.conf");
    expect(socket).toContain("Accept=yes");
    expect(socket).toContain(
      "ListenStream=/run/brain-mail-mime/brain-mail-mime.sock",
    );
    expect(socket).toContain("SocketMode=0600");
    expect(socket).toContain("MaxConnections=1");
    expect(sysusers).toBe(
      'u brain-mail-mime - "Brain Mail MIME parser" /nonexistent /usr/sbin/nologin\n',
    );
    expect(tmpfiles).toBe(
      "d /run/brain-mail-mime 0710 root brain-mail -\n",
    );

    const service = read("ops/brain-mail-mime@.service");
    expect(service).toContain("User=brain-mail-mime");
    expect(service).toContain("Group=brain-mail-mime");
    expect(service).toContain("SupplementaryGroups=brain-mail-runtime");
    expect(service).toContain("WorkingDirectory=/run/brain-mail-runtime/current");
    expect(service).toContain("StandardInput=socket");
    expect(service).toContain("PrivateNetwork=true");
    expect(service).toContain("RestrictAddressFamilies=AF_UNIX");
    expect(service).toContain("SocketBindDeny=any");
    expect(service).toContain("MemoryHigh=128M");
    expect(service).toContain("MemoryMax=192M");
    expect(service).toContain("CPUQuota=20%");
    expect(service).toContain("TasksMax=8");
    expect(service).toContain("LimitNOFILE=64");
    expect(service).toContain("RuntimeMaxSec=16");
    expect(service).toContain(
      "InaccessiblePaths=/etc/brain /var/lib/brain-mail /opt/brain/notes",
    );
    expect(service).not.toContain("LoadCredential=");
    expect(service).not.toMatch(/AF_INET|DATABASE|sqlite/i);
    expect(read("ops/install-brain-mail.sh")).toContain("brain-mail-mime@.service");
    expect(read("ops/install-brain-mail.sh")).toContain(
      "brain-mail-mime.tmpfiles.conf",
    );
    expect(read("ops/rollback-brain-mail-install.sh")).toContain(
      "brain-mail-mime.socket",
    );
    expect(read("ops/install-brain-mail.sh")).not.toMatch(
      /systemctl\s+(?:enable|start|restart)/,
    );

    const parent = read("ops/brain-mail.service");
    expect(parent).toContain(
      "Requires=brain-mail.socket brain-mail-mime.socket\n",
    );
    expect(parent).toContain("After=brain-mail.socket brain-mail-mime.socket\n");
    expect(parent.match(/^Sockets=.*$/gm)).toEqual(["Sockets=brain-mail.socket"]);
    expect(parent).not.toContain("Sockets=brain-mail-mime.socket");
  });

  it("bundles the worker and prefers the MIT license in dual-license packages", () => {
    const build = read("scripts/build-mail-service.mjs");
    expect(build).toContain('"mime-parser-worker.ts"');
    expect(build).toContain('"mime-parser-worker.js"');
    expect(build).toContain("mailparser@3.9.14");
    expect(build).toContain("@zone-eu/mailsplit@5.4.14");
    expect(build).toContain("htmlparser2@10.1.0");
    expect(build).toContain("/^(?:licen[cs]e|copying)(?:[-.]|$)/i");
    expect(build).toContain("/^licen[cs]e(?:[-.]mit)(?:\\.txt)?$/i");
  });
});
