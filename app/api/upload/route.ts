import { NextRequest, NextResponse } from "next/server";
import {
  getStore,
  isAttachmentValidation,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/store";
import { canonicalAttachmentMimeType } from "@/lib/attachments";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File))
    return NextResponse.json({ error: "no file" }, { status: 400 });
  if (
    canonicalAttachmentMimeType(file.type) === "image/svg+xml" ||
    /\.svgz?$/i.test(file.name)
  )
    return NextResponse.json({ error: "unsafe file type" }, { status: 415 });
  if (file.size > MAX_ATTACHMENT_BYTES)
    return NextResponse.json({ error: "too large" }, { status: 413 });

  try {
    const store = await getStore();
    const saved = await store.saveAttachment(
      {
        data: new Uint8Array(await file.arrayBuffer()),
        originalName: file.name,
        mimeType: file.type,
      },
      req.headers.get("x-brain-client") ?? undefined,
    );
    return NextResponse.json(saved);
  } catch (error) {
    if (isAttachmentValidation(error)) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.code === "too_large" ? 413 : 415 },
      );
    }
    throw error;
  }
}
