import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import {
  getStore,
  isNotFound,
  isShareScopeConflict,
} from "@/lib/store";
import { parseShareExpiry } from "@/lib/sharing";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };
const SCOPE_TOKEN_RE = /^[0-9a-f]{64}$/;
const src = (req: NextRequest) =>
  req.headers.get("x-brain-client") ?? undefined;

export async function GET(_req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  try {
    const store = await getStore();
    return NextResponse.json(await store.readShareScope(id));
  } catch (error) {
    if (isNotFound(error)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw error;
  }
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = (await req.json()) as Record<string, unknown>;
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { error: "invalid share configuration" },
      { status: 400 },
    );
  }

  if (!body.enabled) {
    try {
      const store = await getStore();
      await store.configureShare(id, { enabled: false, src: src(req) });
      // Return a fresh read, not an optimistic projection of the write.
      return NextResponse.json(await store.readShareScope(id));
    } catch (error) {
      if (isNotFound(error)) {
        return NextResponse.json({ error: "not found" }, { status: 404 });
      }
      throw error;
    }
  }

  if (
    typeof body.expectedScopeToken !== "string" ||
    !SCOPE_TOKEN_RE.test(body.expectedScopeToken) ||
    (body.password !== undefined &&
      body.password !== null &&
      (typeof body.password !== "string" ||
        Buffer.byteLength(body.password, "utf8") > 72))
  ) {
    return NextResponse.json(
      { error: "invalid share configuration" },
      { status: 400 },
    );
  }

  let expiresAt: string | null | undefined;
  try {
    expiresAt = parseShareExpiry(body.expiresAt);
  } catch {
    return NextResponse.json(
      { error: "invalid share expiry" },
      { status: 400 },
    );
  }

  try {
    const store = await getStore();
    const password =
      body.password === undefined
        ? undefined
        : typeof body.password === "string" && body.password
          ? await bcrypt.hash(body.password, 10)
          : null;
    await store.configureShare(id, {
      enabled: true,
      expectedScopeToken: body.expectedScopeToken,
      sharePass: password,
      shareExpiresAt: expiresAt,
      src: src(req),
    });
    // The owner UI may only announce success or copy after this durable read.
    return NextResponse.json(await store.readShareScope(id));
  } catch (error) {
    if (isShareScopeConflict(error)) {
      return NextResponse.json(
        { error: "scope changed", snapshot: error.snapshot },
        { status: 409 },
      );
    }
    if (isNotFound(error)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    throw error;
  }
}
