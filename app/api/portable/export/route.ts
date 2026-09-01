import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/store";
import {
  buildPortableArchive,
  portableFileName,
} from "@/lib/portable/model";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const rootId = req.nextUrl.searchParams.get("id")?.trim() || undefined;
  try {
    const store = await getStore();
    const exported = await buildPortableArchive(store, { rootId });
    return new NextResponse(Buffer.from(exported.bytes), {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${portableFileName(exported.manifest.title)}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("root was not found")) {
      return NextResponse.json({ error: "page not found" }, { status: 404 });
    }
    if (
      message.includes("there are no pages") ||
      message.includes("too large") ||
      message.includes("attachment")
    ) {
      return NextResponse.json({ error: message }, { status: 409 });
    }
    throw error;
  }
}
