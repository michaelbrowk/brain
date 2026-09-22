"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/client";
import type { AppRequest } from "@/lib/apps/bridge";
import { APP_FRAME_SANDBOX } from "@/lib/apps/csp";
import { APP_STATE_MAX_BYTES } from "@/lib/apps/model";
import { readAppTokens } from "@/lib/apps/tokens";
import { createAppBridge } from "@/components/shell/app-bridge";
import { AppBridgeError } from "@/components/shell/app-reads";

export interface ShareAppFrameProps {
  appId: string;
  rootId: string;
  shareVersion: number;
  title: string;
}

/** SPEC §7, AS AMENDED: A VISITOR'S PROGRESS IS THE VISITOR'S (deviation 3).
 *
 *  Never the owner's disk: a shared trainer that wrote its state through the
 *  state route would put a stranger's progress into the owner's notes folder
 *  and into their git history.
 *
 *  And not the frame's own `sessionStorage`, which is what §7 says and what
 *  cannot work: the frame has an opaque origin, so its storage is unreadable
 *  across a load and cleared on every one of them. A trainer would forget the
 *  card between two answers. The state lives in the SHARE PAGE's own
 *  `sessionStorage` instead, keyed by the app, which is this tab and this
 *  visit and no more durable than §7 intended. */
const stateKey = (appId: string) => `brain-app-state:${appId}`;

/** Storage throws rather than answers in a private window and under a blocked
 *  third-party cookie policy, and a share link is opened in both. A visitor
 *  who cannot keep state still gets to use the app. */
function readVisitorState(appId: string): unknown {
  try {
    const raw = sessionStorage.getItem(stateKey(appId));
    return raw === null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function writeVisitorState(appId: string, json: unknown): void {
  const encoded = JSON.stringify(json);
  if (encoded === undefined || encoded.length > APP_STATE_MAX_BYTES) {
    throw new AppBridgeError("that state is too large to keep", "too_large");
  }
  try {
    sessionStorage.setItem(stateKey(appId), encoded);
  } catch {
    // Nothing is kept, and nothing is broken. The alternative is refusing an
    // answer the visitor already gave.
  }
}

/** THE VISITOR'S HALF OF THE BRIDGE.
 *
 *  The same host, the same protocol, the same rate limit. Two differences,
 *  and each is one of spec §7's three rules:
 *
 *  Reads go to `/api/app-bridge/<id>/share`, which answers inside the shared
 *  subtree and 404s outside it. The check is the server's, not this module's:
 *  a browser-side subtree test would be a second opinion on the one question
 *  the grant exists to answer.
 *
 *  Writes are refused, in one sentence, before anything is asked of the
 *  network. The route they would have gone to has no write verb, so this is
 *  the polite half of a guarantee that holds without it. */
function createShareAppHandler(
  appId: string,
  rootId: string,
  shareVersion: number,
): (request: AppRequest) => Promise<unknown> {
  const base = `/api/app-bridge/${encodeURIComponent(appId)}/share?root=${encodeURIComponent(
    rootId,
  )}&v=${encodeURIComponent(String(shareVersion))}`;

  const read = async (path: string): Promise<unknown> => {
    let response: Response;
    try {
      response = await apiFetch(path);
    } catch {
      throw new AppBridgeError("Brain could not answer that request", "store_failed");
    }
    if (response.status === 404) {
      throw new AppBridgeError("that page is not there", "not_found");
    }
    if (!response.ok) {
      throw new AppBridgeError("Brain could not answer that request", "store_failed");
    }
    try {
      return await response.json();
    } catch {
      throw new AppBridgeError("Brain could not answer that request", "store_failed");
    }
  };

  return async (request) => {
    if (request.type === "read.tree") return read(base);
    if (request.type === "read.page") {
      return read(`${base}&page=${encodeURIComponent(request.id)}`);
    }
    // A shared copy indexes nothing. An empty result is the honest answer for
    // a surface with no search rather than a refusal an app has to branch on,
    // and it is the same answer a search of an empty notebook would give.
    if (request.type === "read.pages") return { hits: [] };
    if (request.type === "state.get") return { state: readVisitorState(appId) };
    if (request.type === "state.set") {
      writeVisitorState(appId, request.json);
      return { ok: true };
    }
    throw new AppBridgeError("this is a shared copy, so it cannot be changed", "read_only");
  };
}

/** The address of one page of a share, the same form the shared page itself
 *  links to. `brain.open` from inside a shared app lands on the reader's own
 *  copy of that page, or on a 404 if the share does not reach it, which is
 *  the same answer every other link on the page gives. */
function sharePageHref(rootId: string, pageId: string): string {
  const root = `/share/${encodeURIComponent(rootId)}`;
  return pageId === rootId ? root : `${root}?page=${encodeURIComponent(pageId)}`;
}

/** A shared app, running. The page head above it is the shared page's own, so
 *  this draws the frame and the one line a `toast` needs to land on.
 *
 *  `data-share-app` is what `app/globals.css` reads to drop the read-only
 *  body the server always draws: a browser running no scripts reads the
 *  agent's description of the app, which is what spec §2 asks for, and it
 *  goes the moment this island is a sibling of it in the DOM. */
export function ShareAppFrame({ appId, rootId, shareVersion, title }: ShareAppFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [toast, setToast] = useState("");

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const bridge = createAppBridge({
      frame,
      page: { id: appId, title },
      theme: () =>
        document.documentElement.classList.contains("dark") ? "dark" : "light",
      tokens: () => readAppTokens(document.documentElement),
      handle: createShareAppHandler(appId, rootId, shareVersion),
      onOpenPage: (id) => {
        window.location.href = sharePageHref(rootId, id);
      },
      onToast: setToast,
    });
    return () => bridge.dispose();
  }, [appId, rootId, shareVersion, title]);

  const src = `/api/app/${encodeURIComponent(appId)}/index.html?root=${encodeURIComponent(
    rootId,
  )}&v=${encodeURIComponent(String(shareVersion))}`;

  return (
    <div data-share-app className="brain-app-canvas">
      <iframe
        ref={frameRef}
        title={title}
        sandbox={APP_FRAME_SANDBOX}
        src={src}
        className="brain-app-frame"
      />
      {toast && (
        <p role="status" aria-live="polite" className="mt-2 text-caption text-ink-3">
          {toast}
        </p>
      )}
    </div>
  );
}
