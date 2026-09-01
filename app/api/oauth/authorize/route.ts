import { NextResponse } from "next/server";
import { OAuthRequestError } from "@/lib/oauth/config";
import { readBoundedText } from "@/lib/oauth/http";
import {
  approveAuthorizationRequest,
  denyAuthorizationRequest,
} from "@/lib/oauth/server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const form = new URLSearchParams(await readBoundedText(request, 8 * 1024));
    const requestToken = single(form, "request", 8_000);
    const decision = single(form, "decision", 16);
    const redirect =
      decision === "approve"
        ? await approveAuthorizationRequest(requestToken)
        : decision === "deny"
          ? await denyAuthorizationRequest(requestToken)
          : null;
    if (!redirect) {
      throw new OAuthRequestError("invalid_request", "Invalid decision");
    }
    return NextResponse.redirect(redirect, 303);
  } catch {
    return NextResponse.redirect(
      new URL("/oauth/authorize?invalid=1", request.url),
      303,
    );
  }
}

function single(form: URLSearchParams, name: string, max: number): string {
  const values = form.getAll(name);
  if (values.length !== 1 || !values[0] || values[0].length > max) {
    throw new OAuthRequestError("invalid_request", `Invalid ${name}`);
  }
  return values[0];
}
