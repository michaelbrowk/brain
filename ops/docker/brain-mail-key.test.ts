import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteMailAccountStore } from "../../lib/mail/service/account-store";
import { ensureMailWrappingKey } from "./brain-mail-key.mjs";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "brain-docker-key-")); roots.push(root);
  const state = path.join(root, "state"); const credentials = path.join(root, "credentials");
  await mkdir(state, { mode: 0o700 }); await mkdir(credentials, { mode: 0o700 });
  return { state, credentials, key: path.join(credentials, "account-wrapping-key") };
}

describe("Docker mail key bootstrap", () => {
  it("creates one private key, preserves it on restart, and can encrypt a real account", async () => {
    const f = await fixture();
    await ensureMailWrappingKey(f.state, f.credentials);
    const initial = await readFile(f.key);
    expect(initial.length).toBe(32);
    expect((await stat(f.key)).mode & 0o777).toBe(0o600);
    const store = new SqliteMailAccountStore({ stateDirectory: f.state, credentialPath: f.key });
    await store.initialize();
    const account = {
      providerKind: "imap" as const, displayName: null, status: "connected" as const, createdAt: 1, updatedAt: 1,
      account: {
        accountId: "account-a11111111111111111111111111111111", emailAddress: "fixture@example.test",
        endpoint: { hostname: "imap.example.test", port: 993, tls: "implicit" as const }, username: "fixture@example.test",
        credentialRef: { id: "credential-r11111111111111111111111111111111", version: 1 },
        transportBindingRef: { id: "binding-r11111111111111111111111111111111", version: 1 }, connectedAt: 1,
      },
    };
    try {
      await store.save(account, Buffer.from("synthetic-test-password"), new AbortController().signal);
      expect(await store.listAccounts()).toHaveLength(1);
      await ensureMailWrappingKey(f.state, f.credentials);
      expect(await readFile(f.key)).toEqual(initial);
    } finally { store.close(); }
  });
  it.each(["local.sqlite3", "account.v1.json", "account.v1.migrated.json"])("refuses to invent a replacement key beside %s", async (name) => {
    const f = await fixture(); await writeFile(path.join(f.state, name), "existing state");
    await expect(ensureMailWrappingKey(f.state, f.credentials)).rejects.toThrow("restore the original credentials volume");
    await expect(stat(f.key)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("refuses an incomplete existing key without replacing it", async () => {
    const f = await fixture(); await writeFile(f.key, "partial", { mode: 0o600 });
    await expect(ensureMailWrappingKey(f.state, f.credentials)).rejects.toThrow("existing mail wrapping key is unsafe");
    expect(await readFile(f.key, "utf8")).toBe("partial");
  });
  it("refuses loose permissions and symlink keys", async () => {
    const f = await fixture(); await writeFile(f.key, randomBytes(32), { mode: 0o600 }); await chmod(f.key, 0o644);
    await expect(ensureMailWrappingKey(f.state, f.credentials)).rejects.toThrow("unsafe");
    await rm(f.key); const target = path.join(f.credentials, "other"); await writeFile(target, randomBytes(32), { mode: 0o600 }); await symlink(target, f.key);
    await expect(ensureMailWrappingKey(f.state, f.credentials)).rejects.toThrow();
  });
  it("recovers the original inode after SIGKILL between publishing and removing its staging link", async () => {
    const f = await fixture();
    // Fault injection stays in a separate process: the real bootstrap runs,
    // and the real link syscall completes before the process is killed.
    const crash = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const publish = fs.link;
      fs.link = async (...args) => {
        await publish(...args);
        process.kill(process.pid, "SIGKILL");
      };
      syncBuiltinESMExports();
      const { ensureMailWrappingKey } = await import(process.argv[1]);
      await ensureMailWrappingKey(process.argv[2], process.argv[3]);
    `, pathToFileURL(path.join(import.meta.dirname, "brain-mail-key.mjs")).href, f.state, f.credentials], { encoding: "utf8" });
    expect(crash.signal).toBe("SIGKILL");
    const initial = await readFile(f.key);
    const published = await stat(f.key);
    expect(published.nlink).toBe(2);
    expect(await readdir(f.credentials)).toHaveLength(2);
    // Recovery must also preserve an already-in-use key, never rotate it.
    await writeFile(path.join(f.state, "existing-state-marker"), "existing state");
    await ensureMailWrappingKey(f.state, f.credentials);
    expect(await readFile(f.key)).toEqual(initial);
    expect(await stat(f.key)).toMatchObject({ dev: published.dev, ino: published.ino, nlink: 1 });
    expect(await readdir(f.credentials)).toEqual(["account-wrapping-key"]);
    await ensureMailWrappingKey(f.state, f.credentials);
    expect(await readFile(f.key)).toEqual(initial);
  });

  it.each(["unrecognized name", "outside credentials", "own plus unknown", "symlink staging name"])("refuses an unexplained hardlink with %s", async (variant) => {
    const f = await fixture();
    await ensureMailWrappingKey(f.state, f.credentials);
    const initial = await readFile(f.key);
    const staged = path.join(f.credentials, `.account-wrapping-key.123.${"a".repeat(24)}`);
    const unknown = path.join(variant === "outside credentials" ? f.state : f.credentials, "foreign-key-link");
    await link(f.key, unknown);
    if (variant === "own plus unknown") await link(f.key, staged);
    if (variant === "symlink staging name") await symlink(f.key, staged);
    const before = await readdir(f.credentials);
    await expect(ensureMailWrappingKey(f.state, f.credentials)).rejects.toThrow("unsafe");
    expect(await readFile(f.key)).toEqual(initial);
    expect(await readFile(unknown)).toEqual(initial);
    expect(await readdir(f.credentials)).toEqual(before);
  });
});
