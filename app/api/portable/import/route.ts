import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import {
  applyPortableBundle,
  validatePortableArchive,
} from "@/lib/portable/model";
import { MAX_PORTABLE_ARCHIVE_BYTES } from "@/lib/portable/archive";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "portable archive is required" }, { status: 400 });
  }
  if (file.size === 0 || file.size > MAX_PORTABLE_ARCHIVE_BYTES) {
    return NextResponse.json(
      { error: "portable archive is empty or too large" },
      { status: 413 },
    );
  }
  const mode = form.get("mode") === "apply" ? "apply" : "dry-run";
  const rawParentId = form.get("parentId");
  const parentId =
    typeof rawParentId === "string" && rawParentId.trim()
      ? rawParentId.trim()
      : null;
  if (parentId && !/^[A-Za-z0-9_-]{1,128}$/.test(parentId)) {
    return NextResponse.json({ error: "invalid parent page" }, { status: 400 });
  }
  try {
    const store = await getStore();
    const checked = validatePortableArchive(
      new Uint8Array(await file.arrayBuffer()),
      store,
    );
    if (mode === "dry-run") {
      return NextResponse.json({
        ok: true,
        mode,
        summary: checked.summary,
      });
    }
    const result = await applyPortableBundle(store, checked.bundle, {
      parentId,
      src: req.headers.get("x-brain-client") ?? undefined,
    });
    return NextResponse.json({
      ok: true,
      mode,
      summary: checked.summary,
      result,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "portable import failed";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
