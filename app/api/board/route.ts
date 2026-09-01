import { NextRequest, NextResponse } from "next/server";
import {
  getStore,
  isNotFound,
  type BoardMutationInput,
} from "@/lib/store";

export const dynamic = "force-dynamic";

const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function parseBody(value: unknown): BoardMutationInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.operation !== "string" ||
    typeof body.boardId !== "string" ||
    !PAGE_ID_RE.test(body.boardId)
  ) {
    return null;
  }
  if (body.operation === "move-card") {
    if (
      typeof body.cardId !== "string" ||
      !PAGE_ID_RE.test(body.cardId) ||
      typeof body.status !== "string" ||
      !(
        body.beforeId === null ||
        (typeof body.beforeId === "string" && PAGE_ID_RE.test(body.beforeId))
      )
    ) {
      return null;
    }
    return {
      operation: "move-card",
      boardId: body.boardId,
      cardId: body.cardId,
      status: body.status,
      beforeId: body.beforeId,
    };
  }
  if (body.operation === "rename-column") {
    if (typeof body.from !== "string" || typeof body.to !== "string") {
      return null;
    }
    return {
      operation: "rename-column",
      boardId: body.boardId,
      from: body.from,
      to: body.to,
    };
  }
  if (body.operation === "delete-column") {
    if (typeof body.name !== "string" || typeof body.fallback !== "string") {
      return null;
    }
    return {
      operation: "delete-column",
      boardId: body.boardId,
      name: body.name,
      fallback: body.fallback,
    };
  }
  return null;
}

export async function POST(req: NextRequest) {
  let body: BoardMutationInput | null;
  try {
    body = parseBody(await req.json());
  } catch {
    body = null;
  }
  if (!body) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  try {
    const store = await getStore();
    await store.mutateBoard(
      body,
      req.headers.get("x-brain-client") ?? undefined,
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isNotFound(error)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: "board changed" },
      { status: 409 },
    );
  }
}
