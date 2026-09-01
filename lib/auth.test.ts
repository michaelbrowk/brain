import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSession,
  createShareToken,
  LEGACY_OWNER_SUBJECT,
  OWNER_SUBJECT,
  verifySession,
  verifyShareToken,
} from "./auth";

const RAW_SECRET = "test-secret-with-enough-entropy";

describe("JWT authentication domains", () => {
  beforeEach(async () => {
    vi.stubEnv("AUTH_SECRET", RAW_SECRET);
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-auth-test-"));
    vi.stubEnv("BRAIN_AUTH_STATE_DIR", dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a human session but never accepts a share token as one", async () => {
    const session = await createSession();
    const share = await createShareToken("page-1", 3);

    await expect(verifySession(session)).resolves.toBe(true);
    await expect(verifySession(share)).resolves.toBe(false);
  });

  it("keeps legacy human sessions during migration and rejects legacy share tokens", async () => {
    const key = new TextEncoder().encode(RAW_SECRET);
    const legacySession = await new SignJWT({ sub: LEGACY_OWNER_SUBJECT })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);
    const legacyShare = await new SignJWT({ sub: "share:page-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);

    await expect(verifySession(legacySession)).resolves.toBe(true);
    await expect(verifySession(legacyShare)).resolves.toBe(false);
    await expect(verifyShareToken(legacyShare, "page-1", 0)).resolves.toBe(true);
    await expect(verifyShareToken(legacyShare, "page-1", 1)).resolves.toBe(false);
  });

  it("keeps a session issued to the subject's old name signed in", async () => {
    // The exact cookie the previous release minted: current format — scoped
    // secret, issuer, audience, kind, epoch — carrying the subject before it
    // was renamed. These live 90 days. If this ever goes red, deploying the
    // rename signs every existing session out.
    const scoped = new TextEncoder().encode(`${RAW_SECRET}\0brain:session:v1`);
    const asPreviousRelease = (subject: string) =>
      new SignJWT({ kind: "session", epoch: 0 })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer("brain")
        .setAudience("brain:web")
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime("90d")
        .sign(scoped);

    await expect(verifySession(await asPreviousRelease(LEGACY_OWNER_SUBJECT))).resolves.toBe(true);
    await expect(verifySession(await asPreviousRelease(OWNER_SUBJECT))).resolves.toBe(true);
    // And only those two: the alias is one retired name, not a loosened check.
    for (const stranger of ["someone", "share:page-1", "", `${LEGACY_OWNER_SUBJECT}x`]) {
      await expect(
        verifySession(await asPreviousRelease(stranger)),
        stranger,
      ).resolves.toBe(false);
    }
  });

  it("issues new sessions to the current subject, never the retired one", async () => {
    const { decodeJwt } = await import("jose");
    expect(decodeJwt(await createSession()).sub).toBe(OWNER_SUBJECT);
    expect(OWNER_SUBJECT).not.toBe(LEGACY_OWNER_SUBJECT);
  });

  it("binds a share token to both its page and current share version", async () => {
    const token = await createShareToken("page-1", 7);

    await expect(verifyShareToken(token, "page-1", 7)).resolves.toBe(true);
    await expect(verifyShareToken(token, "page-2", 7)).resolves.toBe(false);
    await expect(verifyShareToken(token, "page-1", 8)).resolves.toBe(false);
  });
});

describe("session epoch revocation", () => {
  beforeEach(async () => {
    vi.stubEnv("AUTH_SECRET", RAW_SECRET);
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "brain-auth-epoch-"));
    vi.stubEnv("BRAIN_AUTH_STATE_DIR", dir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("kills every earlier cookie on bump, including legacy ones, and issues valid new ones", async () => {
    const { bumpSessionEpoch, createSession, verifySession } = await import(
      "./auth"
    );
    const preBump = await createSession();
    const key = new TextEncoder().encode(RAW_SECRET);
    const legacy = await new SignJWT({ sub: LEGACY_OWNER_SUBJECT })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(key);
    await expect(verifySession(preBump)).resolves.toBe(true);
    await expect(verifySession(legacy)).resolves.toBe(true);

    await bumpSessionEpoch();

    await expect(verifySession(preBump)).resolves.toBe(false);
    await expect(verifySession(legacy)).resolves.toBe(false);

    const postBump = await createSession();
    await expect(verifySession(postBump)).resolves.toBe(true);
  });

  it("degrades to epoch 0 when the state file is missing — never a lockout", async () => {
    const { createSession, verifySession, currentSessionEpoch } = await import(
      "./auth"
    );
    await expect(currentSessionEpoch()).resolves.toBe(0);
    const session = await createSession();
    await expect(verifySession(session)).resolves.toBe(true);
  });
});
