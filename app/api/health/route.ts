import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { getStore } from "@/lib/store";
import { assertSearchReady } from "@/lib/search";
import { getOAuthStateStore } from "@/lib/oauth/state";

export const dynamic = "force-dynamic";

const build = () => ({
  commit: process.env.BRAIN_BUILD_SHA ?? "unknown",
  builtAt: process.env.BRAIN_BUILD_TIME ?? "unknown",
});

type ReadinessCheck =
  | "configuration"
  | "search"
  | "oauth_state"
  | "notes_store_init"
  | "notes_store_probe";

async function runReadinessStep<T>(
  check: ReadinessCheck,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  if (process.env.NODE_ENV === "production") {
    console.info(`[brain/health] readiness ${check} started`);
  }
  const result = await operation();
  if (process.env.NODE_ENV === "production") {
    console.info(`[brain/health] readiness ${check} passed`, {
      durationMs: Date.now() - startedAt,
    });
  }
  return result;
}

function exactEnvironmentValue(name: string): string {
  const raw = process.env[name];
  if (!raw || raw !== raw.trim()) {
    throw new Error(`${name} is missing or has surrounding whitespace`);
  }
  return raw;
}

function assertRuntimeConfiguration(): string {
  const notesRoot = exactEnvironmentValue("NOTES_ROOT");
  const authSecret = exactEnvironmentValue("AUTH_SECRET");
  const passwordHash = exactEnvironmentValue("AUTH_PASSWORD_HASH");
  const mcpToken = exactEnvironmentValue("MCP_TOKEN");
  const readinessToken = exactEnvironmentValue("BRAIN_READINESS_TOKEN");
  const edgeRateSecret = exactEnvironmentValue("BRAIN_EDGE_RATE_SECRET");

  if (!path.isAbsolute(notesRoot)) {
    throw new Error("NOTES_ROOT is not an absolute configured path");
  }
  if (Buffer.byteLength(authSecret, "utf8") < 32) {
    throw new Error("AUTH_SECRET is shorter than 256 bits");
  }
  if (!/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(passwordHash)) {
    throw new Error("AUTH_PASSWORD_HASH is not a bcrypt hash");
  }
  if (/\s/.test(mcpToken)) {
    throw new Error("MCP_TOKEN is not a valid bearer credential");
  }
  if (!/^[a-f0-9]{64}$/.test(readinessToken)) {
    throw new Error("BRAIN_READINESS_TOKEN is not a 256-bit hex token");
  }
  if (!/^[a-f0-9]{64}$/.test(edgeRateSecret)) {
    throw new Error("BRAIN_EDGE_RATE_SECRET is not a 256-bit hex token");
  }
  const oauthStateDirectory = process.env.BRAIN_OAUTH_STATE_DIR;
  if (
    oauthStateDirectory &&
    (oauthStateDirectory !== oauthStateDirectory.trim() ||
      !path.isAbsolute(oauthStateDirectory))
  ) {
    throw new Error("BRAIN_OAUTH_STATE_DIR is not an absolute configured path");
  }
  return path.resolve(notesRoot);
}

function verifyReadinessToken(value: string | null): boolean {
  const expected = process.env.BRAIN_READINESS_TOKEN;
  if (!expected || !value) return false;
  const actualBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

export async function GET(request: Request) {
  const deep = new URL(request.url).searchParams.get("ready") === "1";
  if (deep) {
    // The public liveness endpoint stays cheap. Deep readiness takes the store
    // mutation lock, spawns Git, and fsyncs a probe; exposing that work to
    // anonymous traffic would turn it into a denial-of-service primitive.
    if (!verifyReadinessToken(request.headers.get("x-brain-readiness"))) {
      return NextResponse.json(
        { status: "unauthorized", ...build() },
        {
          status: 401,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
    let check: ReadinessCheck = "configuration";
    try {
      const configuredNotesRoot = assertRuntimeConfiguration();
      check = "search";
      await runReadinessStep(check, assertSearchReady);
      check = "oauth_state";
      await runReadinessStep(check, () => getOAuthStateStore().readiness());
      check = "notes_store_init";
      const store = await runReadinessStep(check, getStore);
      if (store.root !== configuredNotesRoot) {
        throw new Error("active Store does not match configured NOTES_ROOT");
      }
      check = "notes_store_probe";
      await runReadinessStep(check, () => store.readiness());
    } catch (error) {
      // Full details stay in the service journal for operators; the public
      // endpoint deliberately exposes no secret, configured path, or cause.
      console.error("[brain/health] readiness failed", error);
      return NextResponse.json(
        { status: "unready", check, ...build() },
        {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  }

  return NextResponse.json(
    {
      status: "ok",
      ...build(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
