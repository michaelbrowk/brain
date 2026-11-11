import { NextRequest, NextResponse } from "next/server";
import { getStore, isNotFound, isTaskValidation } from "@/lib/store";
import { taskMoveSchema } from "@/lib/tasks/order";
import { assertTaskId, badRequest, clientId, notFound, readJsonObject } from "../../shared";

export const dynamic = "force-dynamic";
export async function POST(req: NextRequest, {params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  if (!assertTaskId(id)) return badRequest("bad_id");
  if (req.nextUrl.search) return badRequest("unexpected_query");
  const parsed = taskMoveSchema.safeParse(await readJsonObject(req));
  if (!parsed.success) return badRequest(parsed.error.issues[0]?.message ?? "bad_body");
  const store = await getStore();
  try {
    return NextResponse.json({task: await store.moveTask(id, parsed.data, clientId(req))});
  } catch (error) {
    if (isNotFound(error)) return notFound();
    if (isTaskValidation(error)) return badRequest(error.reason);
    throw error;
  }
}
