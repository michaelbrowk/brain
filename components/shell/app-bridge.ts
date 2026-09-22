import {
  appAnswer,
  appEvent,
  appRefusal,
  appRequestSchema,
  BRIDGE_VERSION,
  type AppRefusalReason,
  type AppRequest,
  type AppTheme,
} from "@/lib/apps/bridge";
import { FixedWindowRateLimiter } from "@/lib/rate-limit";

export interface AppBridgeOptions {
  readonly frame: HTMLIFrameElement;
  readonly page: { id: string; title: string };
  readonly theme: () => AppTheme;
  readonly tokens: () => Record<string, string>;
  /** Every request but `hello`, `open` and `toast`. The read side and the
   *  write side are fitted in here; until they are, it refuses. */
  readonly handle: (request: AppRequest) => Promise<unknown>;
  readonly onOpenPage: (id: string) => void;
  readonly onToast: (text: string) => void;
}

export interface AppBridge {
  dispose(): void;
  sendTheme(theme: AppTheme): void;
  sendVisibility(visible: boolean): void;
}

/** Spec §4. One second, thirty requests, one frame. A read of the whole tree
 *  is one request, so a well-behaved app spends a handful at open and then
 *  almost none. */
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 1000;

/** THE HOST HALF OF THE BRIDGE.
 *
 *  It trusts the frame it created and nothing else. `event.origin` from an
 *  opaque origin is the string "null", which any page can produce, so the
 *  check is `event.source === frame.contentWindow`: a window reference cannot
 *  be forged from outside.
 *
 *  Three requests never leave this module — `hello`, `open` and `toast` are
 *  the shell's own answers. Everything else goes to `handle`, which is the
 *  seam the read side and the write side are fitted into.
 *
 *  A message with no usable request id is dropped rather than refused: there
 *  is nowhere to send the refusal, and posting one with a made-up id would
 *  resolve a promise the app is holding for something else. */
export function createAppBridge(options: AppBridgeOptions): AppBridge {
  const limiter = new FixedWindowRateLimiter({
    limit: RATE_LIMIT,
    windowMs: RATE_WINDOW_MS,
    maxEntries: 4,
  });

  const post = (message: unknown) => {
    // "*" because the frame's origin is opaque and no other value can match
    // it. Nothing secret travels: the frame only ever receives what it asked
    // for, and it is the only window that can receive this at all.
    options.frame.contentWindow?.postMessage(message, "*");
  };

  const refuse = (rid: string, error: string, reason: AppRefusalReason) =>
    post(appRefusal(rid, error, reason));

  const listener = (event: MessageEvent) => {
    if (event.source !== options.frame.contentWindow) return;
    const raw = event.data as { rid?: unknown } | null;
    const rid = typeof raw?.rid === "string" && raw.rid.length > 0 ? raw.rid : null;
    if (rid === null) return;

    // The budget is spent BEFORE the message is parsed, because a refusal is
    // itself a postMessage back into the frame: refusing outside the limiter
    // would let a frame in a tight loop of junk pull an unbounded stream of
    // answers out of the host, which is the cost the budget exists to bound.
    if (!limiter.consume(options.page.id).allowed) {
      refuse(rid, "that app is asking too often", "too_many");
      return;
    }

    const parsed = appRequestSchema.safeParse(event.data);
    if (!parsed.success) {
      refuse(rid, "Brain did not understand that request", "bad_request");
      return;
    }

    const request = parsed.data;
    if (request.type === "hello") {
      post(
        appAnswer(rid, {
          v: BRIDGE_VERSION,
          theme: options.theme(),
          page: options.page,
          kit: { tokens: options.tokens() },
        }),
      );
      return;
    }
    if (request.type === "open") {
      options.onOpenPage(request.id);
      post(appAnswer(rid, { ok: true }));
      return;
    }
    if (request.type === "toast") {
      options.onToast(request.text);
      post(appAnswer(rid, { ok: true }));
      return;
    }

    void options
      .handle(request)
      .then((data) => post(appAnswer(rid, data)))
      .catch((error: unknown) => {
        const reason =
          typeof (error as { reason?: unknown })?.reason === "string"
            ? (error as { reason: AppRefusalReason }).reason
            : "store_failed";
        const sentence =
          typeof (error as { message?: unknown })?.message === "string"
            ? (error as { message: string }).message
            : "Brain could not answer that request";
        refuse(rid, sentence, reason);
      });
  };

  window.addEventListener("message", listener);

  return {
    dispose: () => window.removeEventListener("message", listener),
    // The tokens are re-read here rather than carried over from `hello`: a
    // theme change is a change of values, and the frame cannot read Brain's
    // stylesheet to find the new ones for itself.
    sendTheme: (theme) => post(appEvent("theme", theme, options.tokens())),
    sendVisibility: (visible) => post(appEvent("visibility", visible)),
  };
}
