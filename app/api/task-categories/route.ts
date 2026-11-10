import { NextRequest, NextResponse } from "next/server";
import { getStore, isTaskValidation } from "@/lib/store";
import { badRequest, clientId, readJsonObject, refuseListQuery } from "../tasks/shared";

export const dynamic = "force-dynamic";
export async function GET(req: NextRequest) {
  const refused = refuseListQuery(req);
  if (refused) return refused;
  const store = await getStore();
  return NextResponse.json({categories: await store.listTaskCategories()});
}
export async function POST(req: NextRequest) {
  return save(req, false);
}
export async function PATCH(req: NextRequest) {
  return save(req, true);
}
async function save(req: NextRequest, update: boolean) {
  const refused = refuseListQuery(req);
  if (refused) return refused;
  const body = await readJsonObject(req);
  if (!body || typeof body.name !== "string" || Object.keys(body).some(key => !["name", "icon"].includes(key))) return badRequest("invalid_category");
  if (update ? body.icon !== null && typeof body.icon !== "string" : body.icon !== undefined && typeof body.icon !== "string") return badRequest("invalid_icon");
  const store = await getStore();
  try {
    const category = update
      ? await store.updateTaskCategory(body.name, body.icon as string | null, clientId(req))
      : await store.createTaskCategory(body.name, body.icon as string | undefined, clientId(req));
    return NextResponse.json({category}, {status: update ? 200 : 201});
  } catch (error) {
    if (isTaskValidation(error)) return badRequest(error.reason);
    throw error;
  }
}
