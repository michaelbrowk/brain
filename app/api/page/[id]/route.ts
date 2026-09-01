import { NextRequest, NextResponse } from "next/server";
import { DEFAULT_PAGE_ICON } from "@/lib/constants";
import {
  getStore,
  isMetadataConflict,
  isNotFound,
  isRevConflict,
  redactPage,
  redactPageMeta,
} from "@/lib/store";
import { smartEmoji } from "@/lib/emoji-llm";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** Originating client id — threaded into store events so the writer's own SSE
 *  echo can be ignored client-side. */
const src = (req: NextRequest) =>
  req.headers.get("x-brain-client") ?? undefined;
const REV_TOKEN_RE = /^[0-9a-f]{12}$/;
const EXPECTED_STRING_FIELDS = new Set([
  "title",
  "icon",
  "cover",
  "shareExpiresAt",
  "category",
  "status",
  "view",
  "font",
]);
const EXPECTED_BOOLEAN_FIELDS = new Set([
  "public",
  "pinned",
  "smallText",
  "fullWidth",
]);
const EXPECTED_ARRAY_FIELDS = new Set(["sections", "tags"]);
const EXPECTED_FIELDS = new Set([
  ...EXPECTED_STRING_FIELDS,
  ...EXPECTED_BOOLEAN_FIELDS,
  ...EXPECTED_ARRAY_FIELDS,
  "shareLocked",
  "stickers",
]);

function validExpectedSticker(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const sticker = value as Record<string, unknown>;
  return (
    typeof sticker.id === "string" &&
    typeof sticker.text === "string" &&
    typeof sticker.x === "number" &&
    Number.isFinite(sticker.x) &&
    typeof sticker.y === "number" &&
    Number.isFinite(sticker.y)
  );
}

function validMetadataExpected(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([field, expected]) => {
      if (!EXPECTED_FIELDS.has(field)) return false;
      if (field === "shareLocked") return typeof expected === "boolean";
      if (expected === null) return true;
      if (EXPECTED_STRING_FIELDS.has(field))
        return typeof expected === "string";
      if (EXPECTED_BOOLEAN_FIELDS.has(field))
        return typeof expected === "boolean";
      if (EXPECTED_ARRAY_FIELDS.has(field))
        return (
          Array.isArray(expected) &&
          expected.every((item) => typeof item === "string")
        );
      return (
        field === "stickers" &&
        Array.isArray(expected) &&
        expected.every(validExpectedSticker)
      );
    },
  );
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const store = await getStore();
    return NextResponse.json(redactPage(await store.readPage(id)));
  } catch (e) {
    if (isNotFound(e))
      return NextResponse.json({ error: "not found" }, { status: 404 });
    throw e;
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const { markdown, rev, baseMarkdown } = await req.json();
  const store = await getStore();
  try {
    return NextResponse.json(
      redactPage(
        await store.writePage(
          id,
          markdown ?? "",
          rev,
          "me",
          src(req),
          typeof baseMarkdown === "string" ? baseMarkdown : undefined,
        ),
      ),
    );
  } catch (e) {
    if (isRevConflict(e)) {
      // Schema-v2 crash drafts predate baseMarkdown. Resolve their exact old
      // 12-hex revision only through this page's id-bound, capped Git history.
      // Any missing/uncommitted/ambiguous revision stays a normal safe 409.
      let historicalBase: string | null = null;
      if (
        typeof baseMarkdown !== "string" &&
        typeof rev === "string" &&
        REV_TOKEN_RE.test(rev)
      ) {
        historicalBase = await store
          .historicalMarkdownForRev(id, rev)
          .catch(() => null);
      }
      return NextResponse.json(
        {
          error: "conflict",
          currentRev: e.currentRev,
          ...(historicalBase !== null
            ? { baseMarkdown: historicalBase }
            : {}),
        },
        { status: 409 },
      );
    }
    if (isNotFound(e))
      return NextResponse.json({ error: "not found" }, { status: 404 });
    throw e;
  }
}

// update meta: title / icon / public / …  (a manually-set icon wins)
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json();
  const {
    title,
    icon,
    cover,
    public: pub,
    sharePassword,
    shareExpiresAt: rawShareExpiresAt,
    category,
    pinned,
    status,
    view,
    font,
    smallText,
    fullWidth,
    sections,
    stickers,
    tags,
    expected,
  } = body;
  if (!validMetadataExpected(expected)) {
    return NextResponse.json(
      { error: "invalid metadata precondition" },
      { status: 400 },
    );
  }
  // Public authority and its credentials must be configured atomically only
  // after the owner has read the exact subtree disclosure. Keep the legacy
  // false transition as a safe revoke, but reject the entire mixed PATCH
  // before Store access so it cannot partially mutate ordinary metadata.
  if (
    (pub !== undefined && pub !== false) ||
    sharePassword !== undefined ||
    rawShareExpiresAt !== undefined
  ) {
    return NextResponse.json(
      { error: "use share configuration endpoint" },
      { status: 400 },
    );
  }
  const validFont =
    font === undefined ||
    font === null ||
    font === "sans" ||
    font === "serif" ||
    font === "mono";
  if (
    !validFont ||
    (smallText !== undefined && typeof smallText !== "boolean") ||
    (fullWidth !== undefined && typeof fullWidth !== "boolean")
  ) {
    return NextResponse.json(
      { error: "invalid page appearance" },
      { status: 400 },
    );
  }
  try {
    const store = await getStore();

    // auto-emoji on rename: only when no explicit icon is passed AND the page
    // has no manual icon yet (empty or the generic default)
    let autoIcon: string | undefined;
    if (title !== undefined && icon === undefined) {
      let cur: string | undefined;
      try {
        cur = (await store.readPage(id)).meta.icon;
      } catch {}
      if (!cur || cur === DEFAULT_PAGE_ICON) autoIcon = await smartEmoji(title);
    }

    const meta = await store.updateMeta(id, {
      ...(title !== undefined ? { title } : {}),
      ...(icon !== undefined ? { icon } : autoIcon ? { icon: autoIcon } : {}),
      ...(cover !== undefined ? { cover } : {}),
      ...(pub === false ? { public: false } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(view !== undefined ? { view } : {}),
      ...(font !== undefined ? { font } : {}),
      ...(smallText !== undefined ? { smallText } : {}),
      ...(fullWidth !== undefined ? { fullWidth } : {}),
      ...(sections !== undefined ? { sections } : {}),
      ...(tags !== undefined ? { tags } : {}),
      ...(stickers !== undefined ? { stickers } : {}),
      ...(expected !== undefined ? { expected } : {}),
      by: "me",
      src: src(req),
    });
    return NextResponse.json(redactPageMeta(meta));
  } catch (e) {
    if (isMetadataConflict(e)) {
      return NextResponse.json(
        { error: "conflict", fields: e.fields },
        { status: 409 },
      );
    }
    if (isNotFound(e))
      return NextResponse.json({ error: "not found" }, { status: 404 });
    throw e;
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  try {
    const store = await getStore();
    await store.deletePage(id, src(req));
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (isNotFound(e))
      return NextResponse.json({ error: "not found" }, { status: 404 });
    throw e;
  }
}
