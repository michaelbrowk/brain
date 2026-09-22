import { apiFetch } from "@/lib/client";
import type { AppRefusalReason, AppRequest } from "@/lib/apps/bridge";
import { AppBridgeError, UNHANDLED, type AppRequestHandler } from "./app-reads";

/** THE HOST RELAYS; IT DOES NOT DECIDE.
 *
 *  Every authority question, is this page in `owns`, is this rev current, is
 *  this state too large, is answered on the server, in the three routes under
 *  `/api/app-bridge/`. This module's whole job is to turn a bridge request
 *  into one of those calls and to hand the route's own `reason` straight back
 *  through the frame.
 *
 *  It must not soften a refusal into a message of its own: an app branches on
 *  `reason`, and a second vocabulary here is how the two ends stop agreeing.
 */
async function call(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await apiFetch(path, init);
  } catch {
    throw new AppBridgeError("Brain could not answer that request", "store_failed");
  }
  const body = (await response.json().catch(() => null)) as
    | { error?: string; reason?: AppRefusalReason }
    | null;
  if (!response.ok) {
    throw new AppBridgeError(
      body?.error ?? "Brain could not answer that request",
      body?.reason ?? "store_failed",
    );
  }
  return body;
}

const asJson = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** The owner's write side. `onCreated` is told the id of every page a create
 *  produced, because the read guard is the shell's tree and the shell has not
 *  heard about that page yet. See `createAppReads`. */
export function createAppWrites(
  appId: string,
  onCreated?: (id: string) => void,
): AppRequestHandler {
  const base = `/api/app-bridge/${encodeURIComponent(appId)}`;
  return async (request) => {
    if (request.type === "write.page") {
      return call(`${base}/page/${encodeURIComponent(request.id)}`, {
        ...asJson("PUT", { markdown: request.markdown, rev: request.rev }),
      });
    }
    if (request.type === "create.page") {
      const answer = await call(`${base}/page`, {
        ...asJson("POST", {
          title: request.title,
          ...(request.icon === undefined ? {} : { icon: request.icon }),
          markdown: request.markdown,
        }),
      });
      const id = (answer as { id?: unknown } | null)?.id;
      if (typeof id === "string") onCreated?.(id);
      return answer;
    }
    if (request.type === "state.get") return call(`${base}/state`);
    if (request.type === "state.set") {
      return call(`${base}/state`, asJson("PUT", { json: request.json }));
    }
    return UNHANDLED;
  };
}

/** THE TWO HALVES, IN ORDER, AND THE REFUSAL AT THE END OF THEM.
 *
 *  Reads first, then writes, and a request neither half claimed is the one
 *  the frame is told Brain did not understand. The test is `UNHANDLED` rather
 *  than a falsy answer: `null` is a real answer from `state.get`, and `??`
 *  between the halves would swallow it.
 *
 *  Here rather than inline in the canvas so the order and the sentinel have a
 *  test of their own; the canvas hands it the two halves and nothing else. */
export function createAppHandler(
  reads: AppRequestHandler,
  writes: AppRequestHandler,
): (request: AppRequest) => Promise<unknown> {
  return async (request) => {
    const read = await reads(request);
    if (read !== UNHANDLED) return read;
    const written = await writes(request);
    if (written !== UNHANDLED) return written;
    throw new AppBridgeError("Brain did not understand that request", "bad_request");
  };
}
