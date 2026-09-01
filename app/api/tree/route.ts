import { NextResponse } from "next/server";
import { getStore } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = await getStore();
  return NextResponse.json({ tree: store.getTree() });
}
