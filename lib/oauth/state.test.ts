import crypto from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { threadId as currentThreadId } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OAuthRequestError, type McpScope } from "./config";
import {
  migrateOAuthStateForward,
  nextRefreshGeneration,
  OAUTH_STATE_MIGRATIONS,
  OAuthStateStore,
  type RefreshCredential,
} from "./state";

const RESOURCE = "https://brain.example/api/mcp";
const REDIRECT = "https://client.example/callback";

describe("durable OAuth state", () => {
  let root: string;
  let stateDirectory: string;
  let store: OAuthStateStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "brain-oauth-state-"));
    stateDirectory = path.join(root, "oauth");
    store = new OAuthStateStore(stateDirectory);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("stores only hashed credentials in a private state directory and file", async () => {
    const client = await register(store);
    const verifier = "v".repeat(43);
    const code = await issue(store, client.id, verifier);
    const redeemed = await redeem(store, client.id, code, verifier);

    const raw = await fs.readFile(store.file, "utf8");
    expect(raw).not.toContain(code);
    expect(raw).not.toContain(redeemed.refresh.nonce);
    expect((await fs.stat(stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(store.file)).mode & 0o777).toBe(0o600);
  });

  it("makes authorization codes one-time, revokes a replayed family, and rejects expiry", async () => {
    const client = await register(store);
    const verifier = "a".repeat(43);
    const expired = await issue(store, client.id, verifier, 1_000);

    await expect(
      redeem(store, client.id, expired, verifier, 301_001),
    ).rejects.toMatchObject({ code: "invalid_grant" });

    const fresh = await issue(store, client.id, verifier, 10_000);
    const first = await redeem(store, client.id, fresh, verifier, 10_001);
    await expect(
      redeem(store, client.id, fresh, verifier, 10_002),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(active(store, first.refresh)).resolves.toBe(false);
  });

  it("rejects PKCE mismatch without leaking the expected challenge", async () => {
    const client = await register(store);
    const code = await issue(store, client.id, "x".repeat(43));

    await expect(
      redeem(store, client.id, code, "y".repeat(43)),
    ).rejects.toEqual(
      expect.objectContaining<Partial<OAuthRequestError>>({
        code: "invalid_grant",
        message: "Invalid authorization code",
      }),
    );
  });

  it("rotates refresh credentials and revokes only their family on replay", async () => {
    const clientA = await register(store, "Client A");
    const clientB = await register(store, "Client B");
    const firstA = await authorize(store, clientA.id, "a".repeat(43));
    const firstB = await authorize(store, clientB.id, "b".repeat(43));
    const secondA = await store.rotateRefreshToken({
      credential: firstA.refresh,
    });
    const secondB = await store.rotateRefreshToken({
      credential: firstB.refresh,
    });

    await expect(
      store.rotateRefreshToken({ credential: firstA.refresh }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(
      store.rotateRefreshToken({ credential: secondA.refresh }),
    ).rejects.toMatchObject({ code: "invalid_grant" });
    await expect(active(store, firstA.refresh)).resolves.toBe(false);

    const thirdB = await store.rotateRefreshToken({
      credential: secondB.refresh,
    });
    expect(thirdB.refresh.generation).toBe(2);
    await expect(active(store, firstB.refresh)).resolves.toBe(true);
  });

  it("accepts a durable rotation beyond 512 without a global spent-token capacity", async () => {
    let generation = 0;
    for (let rotation = 0; rotation < 600; rotation += 1) {
      generation = nextRefreshGeneration(generation) ?? -1;
    }
    expect(generation).toBe(600);
    expect(nextRefreshGeneration(Number.MAX_SAFE_INTEGER)).toBeNull();

    const client = await register(store);
    const first = await authorize(store, client.id, "r".repeat(43));
    const state = JSON.parse(await fs.readFile(store.file, "utf8")) as {
      grants: Record<string, { refresh?: { generation: number } }>;
    };
    state.grants[first.refresh.grantId].refresh!.generation = 512;
    await fs.writeFile(store.file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    const afterBoundary = await store.rotateRefreshToken({
      credential: { ...first.refresh, generation: 512 },
    });

    expect(afterBoundary.refresh.generation).toBe(513);
    await expect(active(store, afterBoundary.refresh)).resolves.toBe(true);
  });

  it("persists refresh downscope across replacements without consuming an invalid escalation", async () => {
    const client = await register(store);
    const first = await authorize(
      store,
      client.id,
      "s".repeat(43),
      ["brain:read", "brain:write"],
    );
    const downscoped = await store.rotateRefreshToken({
      credential: first.refresh,
      requestedScopes: ["brain:read"],
    });

    await expect(
      store.rotateRefreshToken({
        credential: downscoped.refresh,
        requestedScopes: ["brain:write"],
      }),
    ).rejects.toMatchObject({ code: "invalid_scope" });
    const replacement = await store.rotateRefreshToken({
      credential: downscoped.refresh,
    });
    expect(replacement.refresh.scopes).toEqual(["brain:read"]);
  });

  it("continues the same refresh generation after reopening the state store", async () => {
    const client = await register(store);
    const first = await authorize(store, client.id, "t".repeat(43));
    const second = await store.rotateRefreshToken({ credential: first.refresh });

    const reopened = new OAuthStateStore(stateDirectory);
    const third = await reopened.rotateRefreshToken({
      credential: second.refresh,
    });

    expect(third.refresh.generation).toBe(2);
    await expect(active(reopened, third.refresh)).resolves.toBe(true);
  });

  it("evicts the oldest unused DCR client when the bounded registry is full", async () => {
    const first = await store.registerClient({
      name: "Old unused client",
      redirectUris: ["https://client.example/old"],
      applicationType: "web",
      now: 1,
    });
    const state = JSON.parse(await fs.readFile(store.file, "utf8")) as {
      clients: Record<string, unknown>;
    };
    for (let index = 1; index < 128; index += 1) {
      const id = `brain_client_seed_${String(index).padStart(4, "0")}`;
      state.clients[id] = {
        id,
        name: `Client ${index}`,
        redirectUris: [`https://client.example/${index}`],
        applicationType: "web",
        createdAt: index + 1,
      };
    }
    await fs.writeFile(store.file, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    const replacement = await store.registerClient({
      name: "Replacement",
      redirectUris: ["https://client.example/replacement"],
      applicationType: "web",
      now: 130,
    });

    await expect(store.getClient(first.id)).resolves.toBeNull();
    await expect(store.getClient(replacement.id)).resolves.toMatchObject({
      name: "Replacement",
    });
  });

  it("rejects an insecure pre-existing state directory without changing its mode", async () => {
    await fs.mkdir(stateDirectory, { mode: 0o755 });

    await expect(register(store)).rejects.toThrow(
      "OAuth state directory must not be group/world accessible",
    );
    expect((await fs.stat(stateDirectory)).mode & 0o777).toBe(0o755);
  });

  it.runIf(process.platform !== "win32")(
    "readiness rejects an insecure existing state file without rewriting it",
    async () => {
      await register(store);
      await fs.chmod(store.file, 0o644);

      await expect(store.readiness()).rejects.toThrow(
        "OAuth state file must not be group/world accessible",
      );
      expect((await fs.stat(store.file)).mode & 0o777).toBe(0o644);
    },
  );

  it("rejects a symlink state directory", async () => {
    const target = path.join(root, "target");
    await fs.mkdir(target, { mode: 0o700 });
    await fs.symlink(target, stateDirectory);

    await expect(register(store)).rejects.toThrow(
      "OAuth state directory must be a real directory",
    );
  });

  it("rejects a state directory owned by another live process", async () => {
    const ownerProcess = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1_000)"],
      { stdio: "ignore" },
    );
    await new Promise<void>((resolve, reject) => {
      ownerProcess.once("spawn", resolve);
      ownerProcess.once("error", reject);
    });
    try {
      if (!ownerProcess.pid) throw new Error("owner test process has no pid");
      await fs.mkdir(stateDirectory, { mode: 0o700 });
      const owner = {
        pid: ownerProcess.pid,
        threadId: 0,
        processStart: await liveProcessStart(ownerProcess.pid),
        nonce: crypto.randomBytes(32).toString("base64url"),
      };
      const ownerFile = path.join(
        stateDirectory,
        `process-owner-${owner.pid}-${owner.threadId}-${owner.nonce}.json`,
      );
      await fs.writeFile(ownerFile, `${JSON.stringify(owner)}\n`, { mode: 0o600 });

      await expect(register(store)).rejects.toThrow(
        "OAuth state is already owned by another live process",
      );
    } finally {
      ownerProcess.kill();
      await new Promise<void>((resolve) => {
        if (ownerProcess.exitCode !== null || ownerProcess.signalCode !== null) resolve();
        else ownerProcess.once("exit", () => resolve());
      });
    }
  });

  it("removes only the exact stale process claim before a restart", async () => {
    await fs.mkdir(stateDirectory, { mode: 0o700 });
    const stale = {
      pid: 2_147_483_647,
      threadId: 0,
      processStart: "stale-process",
      nonce: crypto.randomBytes(32).toString("base64url"),
    };
    const staleFile = path.join(
      stateDirectory,
      `process-owner-${stale.pid}-${stale.threadId}-${stale.nonce}.json`,
    );
    await fs.writeFile(staleFile, `${JSON.stringify(stale)}\n`, { mode: 0o600 });

    await expect(register(store)).resolves.toMatchObject({ name: "Test client" });
    await expect(fs.lstat(staleFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it(
    "serializes parallel first reads after 100 simulated restarts",
    async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const directory = path.join(root, `parallel-restart-${attempt}`);
        await fs.mkdir(directory, { mode: 0o700 });
        const stale = {
          pid: 2_147_483_647,
          threadId: 0,
          processStart: "stale-process",
          nonce: crypto.randomBytes(32).toString("base64url"),
        };
        await fs.writeFile(
          path.join(
            directory,
            `process-owner-${stale.pid}-${stale.threadId}-${stale.nonce}.json`,
          ),
          `${JSON.stringify(stale)}\n`,
          { mode: 0o600 },
        );
        const restarting = new OAuthStateStore(directory);

        await Promise.all(
          Array.from({ length: 16 }, () => restarting.getClient("missing")),
        );

        const claims = await ownerClaimNames(directory);
        expect(claims, `restart ${attempt}`).toHaveLength(1);
        const claimFile = path.join(directory, claims[0]);
        await expect(fs.lstat(claimFile)).resolves.toMatchObject({
          mode: expect.any(Number),
        });
        expect(JSON.parse(await fs.readFile(claimFile, "utf8"))).toMatchObject({
          pid: process.pid,
          threadId: currentThreadId,
        });
      }
    },
    15_000,
  );

  it("reacquires one verified claim if the accepted claim disappears", async () => {
    await expect(store.getClient("missing")).resolves.toBeNull();
    const [firstClaim] = await ownerClaimNames(stateDirectory);
    await fs.rm(path.join(stateDirectory, firstClaim));

    await Promise.all(
      Array.from({ length: 16 }, () => store.getClient("still-missing")),
    );

    const claims = await ownerClaimNames(stateDirectory);
    expect(claims).toHaveLength(1);
    expect(claims[0]).not.toBe(firstClaim);
    await expect(fs.lstat(path.join(stateDirectory, claims[0]))).resolves.toBeDefined();
  });

  it("migrates a state file forward and refuses a future version", () => {
    const current = { version: 2, clients: {}, grants: {}, codes: {}, consentRequests: {} };
    expect(migrateOAuthStateForward(current)).toEqual(current);
    expect(() => migrateOAuthStateForward({ ...current, version: 3 })).toThrow(
      "OAuth state version 3 is newer than this release",
    );
    expect(() => migrateOAuthStateForward({ ...current, version: 1 })).toThrow(
      "OAuth state version 1 has no forward migration",
    );
  });

  it("runs an injected ladder step, bumps the version, and stops at current", () => {
    const ladder = OAUTH_STATE_MIGRATIONS as unknown as Map<
      number,
      (state: Record<string, unknown>) => Record<string, unknown>
    >;
    ladder.set(1, (state) => ({ ...state, upgraded: true }));
    try {
      expect(migrateOAuthStateForward({ version: 1, clients: {} })).toEqual({
        version: 2,
        clients: {},
        upgraded: true,
      });
    } finally {
      ladder.delete(1);
    }
  });
});

async function ownerClaimNames(directory: string): Promise<string[]> {
  return (await fs.readdir(directory)).filter(
    (name) => name.startsWith("process-owner-") && name.endsWith(".json"),
  );
}

async function liveProcessStart(pid: number): Promise<string> {
  try {
    const raw = await fs.readFile(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    const fields = raw.slice(close + 2).trim().split(/\s+/);
    if (fields[19]) return `linux:${fields[19]}`;
  } catch {
    // macOS has no /proc; the production path verifies liveness with signal 0.
  }
  return `live:${pid}`;
}

async function register(store: OAuthStateStore, name = "Test client") {
  return store.registerClient({
    name,
    redirectUris: [REDIRECT],
    applicationType: "web",
  });
}

async function issue(
  store: OAuthStateStore,
  clientId: string,
  verifier: string,
  now?: number,
  scopes: McpScope[] = ["brain:read"],
) {
  const challenge = crypto
    .createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  return store.issueCode({
    clientId,
    redirectUri: REDIRECT,
    scopes,
    resource: RESOURCE,
    codeChallenge: challenge,
    requestId: crypto.randomUUID(),
    requestExpiresAt: (now ?? Date.now()) + 10 * 60_000,
    now,
  });
}

function redeem(
  store: OAuthStateStore,
  clientId: string,
  code: string,
  verifier: string,
  now?: number,
) {
  return store.redeemCode({
    code,
    clientId,
    redirectUri: REDIRECT,
    resource: RESOURCE,
    codeVerifier: verifier,
    now,
  });
}

async function authorize(
  store: OAuthStateStore,
  clientId: string,
  verifier: string,
  scopes: McpScope[] = ["brain:read"],
) {
  const code = await issue(store, clientId, verifier, undefined, scopes);
  return redeem(store, clientId, code, verifier);
}

function active(store: OAuthStateStore, credential: RefreshCredential) {
  return store.isGrantActive({
    grantId: credential.grantId,
    clientId: credential.clientId,
    resource: credential.resource,
    scopes: credential.scopes,
  });
}
