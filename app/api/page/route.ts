import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import {
  getStore,
  isNotFound,
  isQuickCaptureConflict,
  redactPageMeta,
} from "@/lib/store";
import { pickEmoji } from "@/lib/emoji";

export const dynamic = "force-dynamic";

const QUICK_CAPTURE_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const QUICK_CAPTURE_MAX_TITLE_LENGTH = 500;

function quickCapturePageId(idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update("brain.quick-capture.v1\0")
    .update(idempotencyKey)
    .digest("base64url")
    .slice(0, 32);
  return `quickcapture_${digest}`;
}

function quickCaptureFingerprint(payload: readonly unknown[]): string {
  return createHash("sha256")
    .update("brain.quick-capture.payload.v1\0")
    .update(JSON.stringify(payload))
    .digest("hex");
}

// create a page
export async function POST(req: NextRequest) {
  const {
    parentId = null,
    title = "Untitled",
    status,
    markdown,
    icon,
    cover,
    idempotencyKey,
  } = await req.json();
  // The deterministic-id path stays pinned to the one shape quick capture
  // sends: a root page with a bounded title and a well-formed key.
  if (
    idempotencyKey !== undefined &&
    (parentId !== null ||
      typeof title !== "string" ||
      title.length > QUICK_CAPTURE_MAX_TITLE_LENGTH ||
      typeof idempotencyKey !== "string" ||
      !QUICK_CAPTURE_KEY_RE.test(idempotencyKey))
  ) {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  try {
    const store = await getStore();
    const meta = await store.createPage(parentId, title, {
      ...(idempotencyKey
        ? {
            id: quickCapturePageId(idempotencyKey),
            quickCaptureFingerprint: quickCaptureFingerprint([
              parentId,
              title,
              status ?? null,
              markdown ?? null,
              icon ?? null,
              cover ?? null,
            ]),
          }
        : {}),
      icon: icon || pickEmoji(title),
      cover,
      status,
      markdown,
      by: "me",
      src: req.headers.get("x-brain-client") ?? undefined,
    });
    return NextResponse.json(redactPageMeta(meta));
  } catch (e) {
    if (isQuickCaptureConflict(e)) {
      // The page for this key exists; only its fingerprint disagrees. That
      // happens across a deploy that changed what the fingerprint covers, and
      // the key is per draft, so the page is this capture. Name it: a client
      // whose first response was lost can open it instead of retrying into
      // the same 409 for the next thirty days.
      return NextResponse.json(
        { error: "quick capture conflict", id: quickCapturePageId(idempotencyKey) },
        { status: 409 },
      );
    }
    if (isNotFound(e))
      return NextResponse.json({ error: "parent not found" }, { status: 404 });
    throw e;
  }
}
