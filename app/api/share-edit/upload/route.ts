import { NextRequest, NextResponse } from "next/server";
import { canonicalAttachmentMimeType } from "@/lib/attachments";
import { readBoundedBody } from "@/lib/bounded-body";
import { shareWriteBusy, withShareWrite } from "@/lib/share-write";
import {
  isAttachmentStoreUnavailable,
  isAttachmentValidation,
  isShareUploadQuota,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const pageId = req.nextUrl.searchParams.get("page") ?? "";
  return withShareWrite(
    req,
    { targetId: pageId, bucket: "upload" },
    async (ctx, store) => {
      // Read to the cap and no further, rather than trusting Content-Length,
      // which a chunked request omits. The owner route can check file.size
      // after the parse because it sits behind a session; on anonymous
      // traffic that would mean up to sixty bodies of nginx's 101 MB
      // allocated per window on a 2 GB box. A multipart body is a little
      // larger than the file it carries, so a file within a few hundred bytes
      // of the cap is refused here rather than after the parse: the safe side
      // of the line.
      const body = await readBoundedBody(req, MAX_ATTACHMENT_BYTES);
      if (body === null) return tooLarge();
      // The bytes are re-wrapped so the multipart parser sees the same body
      // this route decided to accept, and nothing past the cap.
      const form = await new Response(new Blob([body]), {
        headers: { "content-type": req.headers.get("content-type") ?? "" },
      }).formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json({ error: "no file" }, { status: 400 });
      }
      if (
        canonicalAttachmentMimeType(file.type) === "image/svg+xml" ||
        /\.svgz?$/i.test(file.name)
      ) {
        return unsafeType();
      }
      if (file.size > MAX_ATTACHMENT_BYTES) return tooLarge();
      try {
        const saved = await store.saveSharedAttachment({
          rootId: ctx.rootId,
          targetId: ctx.targetId,
          shareVersion: ctx.shareVersion,
          file: {
            data: new Uint8Array(await file.arrayBuffer()),
            originalName: file.name,
            mimeType: file.type,
          },
          src: `share-edit:${ctx.vid}`,
        });
        // The bare path only. The access triple is added at display time by
        // the editor, never written into the document.
        return NextResponse.json({ name: saved.name, url: saved.url });
      } catch (error) {
        if (isShareUploadQuota(error)) {
          return NextResponse.json({ error: "root_quota" }, { status: 413 });
        }
        if (isAttachmentValidation(error)) {
          return error.code === "too_large" ? tooLarge() : unsafeType();
        }
        if (isAttachmentStoreUnavailable(error)) {
          // The visitor can do nothing about a disk fault; the owner can.
          // Answer as a retryable outage and leave the cause in the server
          // log, where a clean 503 would otherwise hide it.
          console.error("share-edit upload: attachment store is unavailable");
          return shareWriteBusy();
        }
        throw error;
      }
    },
  );
}

function tooLarge() {
  return NextResponse.json({ error: "too_large" }, { status: 413 });
}

function unsafeType() {
  return NextResponse.json({ error: "unsafe_type" }, { status: 415 });
}
