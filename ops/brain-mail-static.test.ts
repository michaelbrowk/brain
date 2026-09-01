import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (name: string) => readFileSync(path.join(root, "ops", name), "utf8");

describe("brain-mail systemd contracts", () => {
  it("leaves socket ownership to systemd with one private client group", () => {
    const socket = read("brain-mail.socket");
    const sysusers = read("brain-mail.sysusers.conf");
    const tmpfiles = read("brain-mail.tmpfiles.conf");
    const brain = read("brain.service");
    const gate = readFileSync(
      path.join(root, "scripts", "verify-ops.sh"),
      "utf8",
    );
    const brainClientDropIn = readFileSync(
      path.join(root, "ops", "brain.service.d", "90-brain-mail-client.conf"),
      "utf8",
    );

    expect(socket).toContain("ListenStream=/run/brain-mail/brain-mail.sock\n");
    expect(socket).toContain("FileDescriptorName=brain-mail\n");
    expect(socket).toContain("SocketUser=root\n");
    expect(socket).toContain("SocketGroup=brain-mail-client\n");
    expect(socket).toContain("SocketMode=0660\n");
    expect(socket).toContain("DirectoryMode=0710\n");
    expect(socket).not.toMatch(/Listen(?:Datagram|FIFO|Netlink|Special|MessageQueue|USBFunction)=/);
    expect(socket).not.toMatch(/ListenStream=(?:\d+|[^/\n])/);

    expect(sysusers.trim().split("\n")).toEqual([
      'u brain-mail - "Brain Mail service" /nonexistent /usr/sbin/nologin',
      "g brain-mail-client -",
      "g brain-mail-runtime -",
    ]);
    expect(tmpfiles.trim().split("\n")).toEqual([
      "d /run/brain-mail 0710 root brain-mail-client -",
      "d /run/brain-mail-runtime 0550 root brain-mail-runtime -",
      "a+ /opt/brain - - - - g:brain-mail-runtime:--x",
    ]);
    expect(gate).toContain(
      'sudo sed -i "s/g:brain-mail-runtime:--x/g:$runtime_gid:--x/" \\\n  "$sandbox/usr/lib/tmpfiles.d/brain-mail.conf"\n',
    );
    expect(brain).not.toContain("brain-mail-client");
    expect(brainClientDropIn).toBe(
      "[Service]\nSupplementaryGroups=brain-mail-client\n",
    );
  });

  it("pins the isolated process identity, resources, and outbound-only network", () => {
    const service = read("brain-mail.service");

    for (const line of [
      "User=brain-mail",
      "Group=brain-mail",
      "MemoryHigh=192M",
      "MemoryMax=256M",
      "CPUQuota=35%",
      "TasksMax=32",
      "LimitNOFILE=256",
      "LimitCORE=0",
      "TimeoutStopSec=15",
      "PrivateNetwork=false",
      "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6",
      "SocketBindDeny=any",
      "NoNewPrivileges=true",
      "ProtectSystem=strict",
      "CapabilityBoundingSet=",
      "AmbientCapabilities=",
    ]) {
      expect(service).toContain(`${line}\n`);
    }
    expect(service).not.toMatch(/PORT=|HOST(?:NAME)?=/);
    // One environment file, and it is the mail service's own — never
    // /etc/brain/brain.env, which holds the web process's secrets.
    expect(service.match(/^EnvironmentFile=.*$/gm)).toEqual([
      "EnvironmentFile=-/etc/brain/brain-mail.env",
    ]);
    expect(service).toContain("StateDirectory=brain-mail\n");
    expect(service).toContain("StateDirectoryMode=0700\n");
    expect(service).toContain(
      "LoadCredential=account-wrapping-key:/etc/brain/brain-mail-account.key\n",
    );
    // The origin is the operator's, so the unit states where it comes from and
    // names no host of its own. A placeholder here worked for nobody: it
    // shipped as a real setting and every install inherited it.
    expect(service).not.toMatch(/^Environment=BRAIN_PUBLIC_ORIGIN=/m);
    expect(service).not.toMatch(/https?:\/\//);
    expect(service).not.toContain("GMAIL_OAUTH_CLIENT_ID");
    expect(service).not.toContain("gmail-oauth-client-secret");
    expect(service).not.toContain("gmail-oauth-transaction-key");
    expect(service).toContain("SupplementaryGroups=brain-mail-runtime\n");
    expect(service).toContain(
      "Requires=brain-mail.socket brain-mail-mime.socket\n",
    );
    expect(service).toContain("After=brain-mail.socket brain-mail-mime.socket\n");
    expect(service.match(/^Sockets=.*$/gm)).toEqual(["Sockets=brain-mail.socket"]);
    expect(service).toContain(
      "ExecStartPre=+/usr/bin/python3 /opt/brain/bin/project_mail_runtime.py\n",
    );
    expect(service).toContain(
      "ExecStart=/opt/brain/runtime/current/bin/node --disable-warning=ExperimentalWarning /run/brain-mail-runtime/current/service/main.js\n",
    );
    expect(service).not.toContain("NODE_NO_WARNINGS");
    expect(service).not.toContain("--no-warnings");
    expect(service).toContain("WorkingDirectory=/run/brain-mail-runtime\n");
    expect(service).toContain("InaccessiblePaths=/etc/brain /opt/brain/notes\n");
    expect(service).toContain(
      "ReadWritePaths=/run/brain-mail-runtime /var/lib/brain-mail\n",
    );
    const main = readFileSync(
      path.join(root, "lib", "mail", "service", "main.ts"),
      "utf8",
    );
    expect(main).toContain("const SHUTDOWN_DEADLINE_MS = 12_000;\n");
  });

  it("documents Gmail as an explicit credential-gated drop-in", () => {
    const guide = readFileSync(
      path.join(root, "docs", "gmail-oauth.md"),
      "utf8",
    );
    expect(guide).toContain("/etc/systemd/system/brain-mail.service.d/90-gmail-oauth.conf");
    expect(guide).toContain("Environment=GMAIL_OAUTH_CLIENT_ID=<google-web-client-id>");
    expect(guide).toContain(
      "LoadCredential=gmail-oauth-client-secret:/etc/brain/brain-mail-gmail-client-secret",
    );
    expect(guide).toContain(
      "LoadCredential=gmail-oauth-transaction-key:/etc/brain/brain-mail-gmail-transaction.key",
    );
    expect(guide).toContain(
      "The base unit contains none of these three Gmail settings",
    );
  });

  it("keeps SMTP egress behind an explicit credential-gated canary drop-in", () => {
    const base = read("brain-mail.service");
    const template = readFileSync(
      path.join(
        root,
        "ops",
        "brain-mail.service.d",
        "90-smtp-egress.conf.example",
      ),
      "utf8",
    );
    const guide = readFileSync(
      path.join(root, "docs", "mail-egress-operations.md"),
      "utf8",
    );

    expect(base).not.toContain("BRAIN_MAIL_SMTP_EGRESS_");
    expect(base).not.toContain("smtp-egress-");
    for (const line of [
      "Environment=BRAIN_MAIL_SMTP_EGRESS_ENABLED=1",
      "Environment=BRAIN_MAIL_SMTP_EGRESS_URL=wss://smtp-egress.example.invalid/v1/tunnel",
      "Environment=BRAIN_MAIL_SMTP_EGRESS_ACCESS_ENABLED=1",
      "LoadCredential=smtp-egress-hmac-key:/etc/brain/brain-mail-smtp-egress-hmac.key",
      "LoadCredential=smtp-egress-access-client-id:/etc/brain/brain-mail-smtp-egress-access-client-id",
      "LoadCredential=smtp-egress-access-client-secret:/etc/brain/brain-mail-smtp-egress-access-client-secret",
    ]) {
      expect(template).toContain(`${line}\n`);
    }
    expect(guide).toContain(
      "/etc/systemd/system/brain-mail.service.d/90-smtp-egress.conf",
    );
    expect(guide).toContain(
      "remove `/etc/systemd/system/brain-mail.service.d/90-smtp-egress.conf`",
    );
    expect(guide).toContain(
      "verify the effective unit no longer contains `BRAIN_MAIL_SMTP_EGRESS_`",
    );
  });

  it("projects the complete Mail client runtime and smokes that exact tree", () => {
    const projector = readFileSync(
      path.join(root, "ops", "project_mail_runtime.py"),
      "utf8",
    );
    const smoke = readFileSync(
      path.join(root, "scripts", "smoke-mail-service.mjs"),
      "utf8",
    );
    const packer = readFileSync(
      path.join(root, "scripts", "build-release.mjs"),
      "utf8",
    );

    const runtimeFiles = [
      "address-identity.js",
      "content-codec.js",
      "content-types.js",
      "draft-codec.js",
      "draft-types.js",
      "message-codec.js",
      "search-query.js",
      "message-types.js",
      "ports.js",
      "reader-content.js",
      "raster-metadata.js",
      "recipients.js",
      "security.js",
      "send-state.js",
      "thread-contract.js",
      "build.json",
      "providers/gmail/access-token-port.js",
      "providers/gmail/api-client.js",
      "providers/gmail/api-types.js",
      "providers/gmail/content-source-adapter.js",
      "providers/gmail/contract.js",
      "providers/gmail/credentials.js",
      "providers/gmail/oauth.js",
      "providers/gmail/raw-message-stream.js",
      "providers/gmail/send-adapter.js",
      "providers/gmail/service-adapter.js",
      "providers/gmail/sync-adapter.js",
      "providers/gmail/token-envelope.js",
      "providers/imap/sync-adapter.js",
      "service/account-store.js",
      "service/account-types.js",
      "service/accounts.js",
      "service/admission.js",
      "service/background-sync.js",
      "service/content-blob-store.js",
      "service/content-cache.js",
      "service/content-coordinator.js",
      "service/content-source.js",
      "service/content-work-runner.js",
      "service/dns.js",
      "service/drafts.js",
      "service/http.js",
      "service/imapflow-adapter.js",
      "service/limits.js",
      "service/mail-html-sanitizer.js",
      "service/main.js",
      "service/message-cache.js",
      "service/message-service-registry.js",
      "service/message-service.js",
      "service/mime-parser-client.js",
      "service/mime-parser-runtime.js",
      "service/mime-parser-worker.js",
      "service/mime-protocol.js",
      "service/outbound-message.js",
      "service/outbound-store.js",
      "service/outbound-worker.js",
      "service/outbound.js",
      "service/remote-image-fetcher.js",
      "service/runtime-config.js",
      "service/smtp-runtime.js",
      "service/smtp-state-store.js",
    ];
    const requiredFilesBlock = /REQUIRED_FILES = \(\n([\s\S]*?)\n\)/.exec(
      projector,
    )?.[1];
    expect(requiredFilesBlock).toBeDefined();
    const projectedFiles = [
      ...(requiredFilesBlock ?? "").matchAll(/Path\("([^"]+)"\)/g),
    ].map((match) => match[1]);
    expect(projectedFiles).toEqual(runtimeFiles);
    for (const relative of runtimeFiles) {
      expect(projector).toContain(`Path("${relative}")`);
      expect(packer).toContain(`"${path.basename(relative)}|f"`);
    }
    expect(projector).toContain('Path("providers/gmail"),\n');
    for (const key of [
      '".":',
      "providers:",
      '"providers/gmail":',
      '"providers/imap":',
      "service:",
    ]) {
      expect(packer).toContain(key);
    }
    expect(smoke).toContain('"project-mail-runtime-for-smoke.py"');
    expect(smoke).toContain("cwd: runtimeRoot,\n");
    expect(smoke).not.toContain("cwd: artifactRoot,\n");
  });

  /**
   * The projected tree is an allowlist, so a new provider-neutral module reads
   * as green in every other check and then fails to start under systemd. The
   * closure has to hold: whatever a projected service module requires at
   * runtime must be projected too. Modules that exist only inside an esbuild
   * bundle are not projected and are deliberately out of this closure.
   */
  it("projects the whole require closure of every projected service module", () => {
    const projector = readFileSync(
      path.join(root, "ops", "project_mail_runtime.py"),
      "utf8",
    );
    const packer = readFileSync(
      path.join(root, "scripts", "build-release.mjs"),
      "utf8",
    );
    const block = /REQUIRED_FILES = \(\n([\s\S]*?)\n\)/.exec(projector)?.[1];
    expect(block).toBeDefined();
    const projected = [...(block ?? "").matchAll(/Path\("([^"]+)"\)/g)].map(
      (match) => match[1]!,
    );
    const projectedServiceModules = projected.filter((relative) =>
      relative.startsWith("service/"),
    );

    // The architecture note states this count, and a stale one hides a module
    // that was added to the tree but never to the projection.
    const compiled = projected.filter((relative) => relative.endsWith(".js"));
    const documented = readFileSync(
      path.join(root, "docs", "mail-architecture.md"),
      "utf8",
    );
    expect(documented).toContain(
      `projects exactly ${compiled.length} allowlisted compiled Mail files`,
    );

    expect(projectedServiceModules.length).toBeGreaterThan(0);
    for (const relative of projectedServiceModules) {
      const source = path.join(
        root,
        "lib",
        "mail",
        relative.replace(/\.js$/, ".ts"),
      );
      if (!existsSync(source)) continue;
      // A type-only import compiles away, so it never becomes a require.
      const executable = readFileSync(source, "utf8").replace(
        /import\s+type\s[\s\S]*?from\s+"[^"]+";/g,
        "",
      );
      for (const match of executable.matchAll(/from\s+"\.\.\/([\w-]+)"/g)) {
        const emitted = `${match[1]!}.js`;
        expect(
          projected,
          `${relative} requires ${emitted}, which is not projected`,
        ).toContain(emitted);
        expect(
          packer,
          `${emitted} is missing from the artifact manifest`,
        ).toContain(`"${emitted}|f"`);
      }
    }
  });

  it("cannot configure TCP, bind a path, or unlink its inherited socket", () => {
    const source = readFileSync(
      path.join(root, "lib", "mail", "service", "main.ts"),
      "utf8",
    );

    expect(source).toContain("server.listen({ fd: SYSTEMD_FIRST_FD }");
    expect(source).not.toMatch(/\.listen\([^)]*(?:port|host|socketPath|\/run\/)/i);
    expect(source).not.toMatch(/\bunlink(?:Sync)?\b|\brm(?:Sync)?\b/);
    expect(source).not.toMatch(/process\.env\.(?:PORT|HOST|HOSTNAME)/);
  });

  it("creates the wrapping key once without enabling the staged service", () => {
    const source = readFileSync(
      path.join(root, "ops", "create-brain-mail-key.sh"),
      "utf8",
    );

    expect(source).toContain('key_path="$key_dir/brain-mail-account.key"\n');
    expect(source).toContain(
      'echo "brain-mail key already exists; refusing to overwrite or rotate it" >&2\n',
    );
    expect(source).toContain(
      'dd if=/dev/urandom of="$temp_path" bs=32 count=1 status=none conv=notrunc\n',
    );
    expect(source).toContain(
      `if [[ "$(stat -c '%u' "$key_dir")" != "0" ]]; then\n`,
    );
    expect(source).not.toContain(`stat -c '%u:%g' "$key_dir"`);
    expect(source).toContain(
      `if (( 8#$(stat -c '%a' "$key_dir") & 8#022 )); then\n`,
    );
    expect(source).toContain('chmod 0400 "$temp_path"\n');
    expect(source).toContain('ln "$temp_path" "$key_path"\n');
    expect(source).not.toMatch(/systemctl\s+(?:enable|start|restart)|openssl\s+rand\s+-base64/);
  });

  it("packages matching staged ops but never installs or enables them in CI", () => {
    const workflow = readFileSync(
      path.join(root, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    const packer = readFileSync(
      path.join(root, "scripts", "build-release.mjs"),
      "utf8",
    );

    // Staged twice: once into brain-mail-ops/, once into the release ops/bin/.
    expect(packer.match(/ops\/create-brain-mail-key\.sh/g)).toHaveLength(2);
    expect(packer).toContain('"brain.service.d/90-brain-mail-client.conf"');
    expect(packer).toContain(
      '"brain-mail.service.d/90-smtp-egress.conf.example"',
    );
    for (const file of [
      "brain-mail.service",
      "brain-mail.socket",
      "brain-mail-mime.socket",
      "brain-mail-mime@.service",
      "brain-mail.sysusers.conf",
      "brain-mail-mime.sysusers.conf",
      "brain-mail.tmpfiles.conf",
      "brain-mail-mime.tmpfiles.conf",
      "project_mail_runtime.py",
      "create-brain-mail-key.sh",
      "brain-mail-state-rollback.py",
      "install-brain-mail.sh",
      "rollback-brain-mail-install.sh",
      "mail-account-connect-operations.md",
      "mail-egress-operations.md",
      "90-brain-mail-client.conf",
      "90-smtp-egress.conf.example",
      "MANIFEST.sha256",
    ]) {
      expect(packer).toContain(file);
    }
    expect(workflow).not.toMatch(
      /systemctl\s+(?:enable|start|restart)\s+brain-mail/,
    );
    expect(packer).not.toMatch(
      /systemctl\s+(?:enable|start|restart)\s+brain-mail/,
    );
  });

  it("packages a root-only stopped-service full-state rollback guard", () => {
    const source = readFileSync(
      path.join(root, "ops", "brain-mail-state-rollback.py"),
      "utf8",
    );

    expect(source).toContain('STATE_DIRECTORY = Path("/var/lib/brain-mail")\n');
    expect(source).toContain(
      'UNITS = ("brain-mail-mime.socket", "brain-mail.socket", "brain-mail.service")\n',
    );
    expect(source).toContain('if os.geteuid() != 0:\n');
    expect(source).toContain("RENAME_EXCHANGE = 2\n");
    expect(source).toContain(
      'raise StateRollbackError(f"{unit} must be exactly inactive")\n',
    );
    expect(source).not.toMatch(/systemctl\s+(?:start|restart)/);
  });

  it("documents a canary that always stops and verifies the service and both sockets", () => {
    const operations = readFileSync(
      path.join(root, "docs", "mail-account-connect-operations.md"),
      "utf8",
    );

    expect(operations).toContain(
      "sudo systemctl start brain-mail.socket brain-mail-mime.socket brain-mail.service\n",
    );
    expect(operations).toContain(
      "sudo /bin/bash \\\n  /opt/brain/releases/<release>/brain-mail-ops/install-brain-mail.sh \\\n",
    );
    expect(operations).toContain(
      "cleanup() { sudo systemctl stop brain-mail.service brain-mail-mime.socket brain-mail.socket; }\n",
    );
    for (const unit of [
      "brain-mail.service",
      "brain-mail-mime.socket",
      "brain-mail.socket",
    ]) {
      expect(operations).toContain(
        `! sudo systemctl is-active --quiet ${unit}\n`,
      );
      expect(operations).toContain(
        `! sudo systemctl is-enabled --quiet ${unit}\n`,
      );
    }
  });
});
