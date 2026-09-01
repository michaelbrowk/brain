import { NextRequest, NextResponse } from "next/server";
import {
  getStore,
  isNotFound,
  isPageRefNestValidation,
  isRevConflict,
  redactPage,
  redactPageMeta,
} from "@/lib/store";

export const dynamic = "force-dynamic";

const PAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const REV_TOKEN_RE = /^[0-9a-f]{12}$/;

interface NestPageRefBody {
  sourceId: string;
  targetId: string;
  parentPageId: string;
  expectedParentRev: string;
  sourceOccurrence: number | null;
  sourceFingerprint: string | null;
  scope: "sibling" | "tree";
}

function parseBody(value: unknown): NestPageRefBody | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const {
    sourceId,
    targetId,
    parentPageId,
    expectedParentRev,
    sourceOccurrence,
    sourceFingerprint,
    scope,
  } = body;
  const synthesized = sourceOccurrence === null && sourceFingerprint === null;
  const physical =
    Number.isSafeInteger(sourceOccurrence) &&
    typeof sourceOccurrence === "number" &&
    sourceOccurrence >= 0 &&
    typeof sourceFingerprint === "string" &&
    sourceFingerprint.length > 0 &&
    sourceFingerprint.length <= 16 * 1024;
  if (
    typeof sourceId !== "string" ||
    typeof targetId !== "string" ||
    typeof parentPageId !== "string" ||
    typeof expectedParentRev !== "string" ||
    !PAGE_ID_RE.test(sourceId) ||
    !PAGE_ID_RE.test(targetId) ||
    !PAGE_ID_RE.test(parentPageId) ||
    !REV_TOKEN_RE.test(expectedParentRev) ||
    (scope !== undefined && scope !== "sibling" && scope !== "tree") ||
    (!synthesized && !physical)
  ) {
    return null;
  }
  return {
    sourceId,
    targetId,
    parentPageId,
    expectedParentRev,
    sourceOccurrence: sourceOccurrence as number | null,
    sourceFingerprint: sourceFingerprint as string | null,
    scope: scope === "tree" ? "tree" : "sibling",
  };
}

export async function POST(req: NextRequest) {
  let body: NestPageRefBody | null;
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
    const result = await store.nestPageRef(
      body.sourceId,
      body.targetId,
      body.parentPageId,
      body.expectedParentRev,
      body.sourceOccurrence,
      body.sourceFingerprint,
      req.headers.get("x-brain-client") ?? undefined,
      body.scope,
    );
    return NextResponse.json({
      removed: result.removed,
      moved: redactPageMeta(result.moved),
      parent: redactPage(result.parent),
    });
  } catch (error) {
    if (isRevConflict(error)) {
      return NextResponse.json(
        { error: "conflict", currentRev: error.currentRev },
        { status: 409 },
      );
    }
    if (isNotFound(error)) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (isPageRefNestValidation(error)) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "page-ref nesting failed" },
      { status: 500 },
    );
  }
}
