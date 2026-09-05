import { NextRequest } from "next/server";
import { vi } from "vitest";
import { createShareEditToken, shareEditCookieName } from "@/lib/auth";
import { SHARE_VID_HEADER } from "@/lib/share-write";

/**
 * Scaffolding for a route under /api/share-edit. Every request built here
 * passes the whole guard: the configured origin, a valid edit cookie for
 * ROOT_ID at SHARE_VERSION naming Ada, the matching vid header, and `root`
 * and `v` on the URL. What a test varies is the body and the Store.
 */

export const ORIGIN = "https://brain.test";
export const VID = "vid123456789";
export const ROOT_ID = "root-1";
export const SHARE_VERSION = 2;
export const TARGET_ID = "page-9";
export const VISITOR_NAME = "Ada";
export const SRC = `share-edit:${VID}`;

function grantedAccess() {
  return {
    kind: "granted" as const,
    root: {
      meta: {
        id: ROOT_ID,
        public: true,
        shareEdit: true,
        shareVersion: SHARE_VERSION,
      },
    },
    target: { meta: { id: TARGET_ID } },
    shareVersion: SHARE_VERSION,
    directChildren: [],
  };
}

type StoreMock = Record<string, unknown>;

/** Mock the two modules the guard reaches before a route's own code runs:
 *  the Store singleton becomes `store`, and every share resolves as granted
 *  and editable. Call before the dynamic import of the route under test and
 *  pair with `restoreShareEditModules` in afterEach. The returned `resolve`
 *  spy proves whether the guard got as far as the Store.
 *
 *  A store given as a thunk is built when the guard first asks for it, which
 *  is after the route and its whole import chain exist under these mocks. A
 *  test whose store throws one of share-access's own classes has to build it
 *  that late: the registry reset below gives that module a fresh identity,
 *  and `withShareWrite` matches those two errors by `instanceof`. */
export function mockShareEditModules(
  store: StoreMock | (() => Promise<StoreMock>),
) {
  // This helper's own static imports evaluated lib/share-write.ts against
  // the real Store before any mock existed. Drop that instance now, so the
  // route's dynamic import rebuilds the whole chain under the mocks below,
  // in the first test of a file as much as in the last.
  vi.resetModules();
  vi.stubEnv("AUTH_SECRET", "route-secret");
  const resolve = vi.fn().mockImplementation(async () => grantedAccess());
  vi.doMock("@/lib/store", async () => {
    const actual = await vi.importActual<typeof import("@/lib/store")>(
      "@/lib/store",
    );
    return {
      ...actual,
      getStore: async () => (typeof store === "function" ? store() : store),
      configuredPublicOrigin: () => ORIGIN,
    };
  });
  vi.doMock("@/lib/share-access", async () => {
    const actual = await vi.importActual<typeof import("@/lib/share-access")>(
      "@/lib/share-access",
    );
    return { ...actual, resolveShareAccess: resolve };
  });
  return { resolve };
}

export function restoreShareEditModules() {
  vi.doUnmock("@/lib/store");
  vi.doUnmock("@/lib/share-access");
  vi.unstubAllEnvs();
  vi.resetModules();
}

export async function visitorRequest(
  pathWithQuery: string,
  init: {
    method?: string;
    body?: BodyInit | null;
    headers?: Record<string, string>;
  } = {},
): Promise<NextRequest> {
  const url = new URL(`${ORIGIN}${pathWithQuery}`);
  url.searchParams.set("root", ROOT_ID);
  url.searchParams.set("v", String(SHARE_VERSION));
  const token = await createShareEditToken(
    ROOT_ID,
    SHARE_VERSION,
    VID,
    VISITOR_NAME,
  );
  return new NextRequest(url, {
    method: init.method ?? "GET",
    body: init.body,
    headers: {
      Origin: ORIGIN,
      [SHARE_VID_HEADER]: VID,
      cookie: `${shareEditCookieName(ROOT_ID)}=${token}`,
      ...init.headers,
    },
  });
}

/** A JSON body with, by default, the Content-Length a browser would send. */
export function jsonBody(
  body: unknown,
  options: { declareLength?: boolean } = {},
): { body: string; headers: Record<string, string> } {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (options.declareLength !== false) {
    headers["Content-Length"] = String(Buffer.byteLength(payload, "utf8"));
  }
  return { body: payload, headers };
}
