import { NextResponse } from "next/server";
import { readReleaseInfo } from "@/lib/release-info";
import { compareVersions, readUpdateState, runUpdateCheck, updateCheckEnabled, type UpdateState } from "@/lib/update-check";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = { "Cache-Control": "private, no-store" };

/** Owner-only. Human session authentication is enforced by proxy.ts. */
async function status(state: UpdateState | null) {
  const release = await readReleaseInfo();
  const latest = state?.latest ?? null;
  return {
    apiVersion: 1 as const,
    version: release.version,
    commit: release.commit,
    buildTime: release.buildTime,
    updateCheck: updateCheckEnabled() ? ("on" as const) : ("off" as const),
    checkedAt: state?.checkedAt ?? null,
    latest,
    updateAvailable: release.version !== null && latest !== null && compareVersions(latest.version, release.version) === 1,
    error: state?.error ?? null,
  };
}

export async function GET() {
  return NextResponse.json(await status(await readUpdateState()), { headers: HEADERS });
}

export async function POST() {
  if (!updateCheckEnabled()) {
    return NextResponse.json({ error: "update check is off" }, { status: 409, headers: HEADERS });
  }
  return NextResponse.json(await status(await runUpdateCheck()), { headers: HEADERS });
}
