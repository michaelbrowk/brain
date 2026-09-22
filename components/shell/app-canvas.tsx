"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { apiFetch } from "@/lib/client";
import type { TreeNode } from "@/lib/store/types";
import { APP_FRAME_SANDBOX } from "@/lib/apps/csp";
import { readAppTokens } from "@/lib/apps/tokens";
import { createAppBridge } from "./app-bridge";
import { AppBridgeError, createAppReads } from "./app-reads";
import { Empty } from "../ui/empty";
import { Icon } from "../ui/icon";

/** How long "Copied." stands before the line goes back to the invitation. */
const COPIED_FOR_MS = 2_000;

/** How long before a frame token dies the canvas asks for the next one. Wide
 *  enough that a slow answer still lands in time, narrow enough that an app
 *  open all day is re-addressed once rather than repeatedly. */
const REMINT_BEFORE_MS = 5 * 60 * 1000;

export interface AppCanvasProps {
  node: TreeNode;
  /** The shell's own tree, read on every request rather than snapshotted:
   *  what an app may read has to follow what the notebook holds now. */
  liveTree: () => readonly TreeNode[];
  onOpenPage: (id: string) => void;
  onToast: (text: string) => void;
}

/** THE CANVAS OF A PAGE AN AGENT BUILT.
 *
 *  The standard head — icon, title, who built it and when — and then the app
 *  itself in a frame with an opaque origin, filling what is left of the
 *  canvas. There is no editor here and no "edit anyway": the owner asks the
 *  agent, and Rebuild is that sentence on the clipboard.
 *
 *  On a phone the frame stops above the tab bar rather than under it, because
 *  an app's own bottom control would otherwise sit behind Brain's.
 *
 *  One prop shape: the tree node. It already carries the id, the title, the
 *  icon and the `app` map, so a second `page` prop would be a second place
 *  for the same four facts to come from. */
export function AppCanvas({ node, liveTree, onOpenPage, onToast }: AppCanvasProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const reads = useMemo(() => createAppReads(liveTree), [liveTree]);
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const bridgeRef = useRef<ReturnType<typeof createAppBridge> | null>(null);
  /** What the line beside Rebuild is saying. "copied" is a confirmation and
   *  goes back to the invitation on its own, the way every other momentary
   *  confirmation in the shell does. "failed" stays, because the owner still
   *  has the prompt to deal with. */
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  /** ASK FOR THE ADDRESS BEFORE MOUNTING.
   *
   *  The frame's authority is in its path, so the canvas cannot know where to
   *  mount it. It asks, and the server answers with a signed address or with
   *  404, which makes one call do two jobs. A `kind: app` page whose files are
   *  not there — hand-written frontmatter, a restore that has not finished, a
   *  rebuild that failed part way — would otherwise mount a frame onto a 404
   *  and paint the browser's own error document inside the canvas, which says
   *  nothing the owner can act on. Here it is an answer with no address in it,
   *  and the canvas draws the sentence with the Rebuild control beside it.
   *
   *  `undefined` while the question is open: neither branch draws, so the
   *  canvas does not flash a frame it is about to replace. The answer is held
   *  WITH the id it was asked about, so opening a second app reads as an open
   *  question again without a `setState` in the effect body. */
  const [probe, setProbe] = useState<{
    id: string;
    src: string | null;
    /** When the token in that address stops working, in seconds since the
     *  epoch, as the route minted it. */
    exp: number;
  } | null>(null);
  const src = probe?.id === node.id ? probe.src : undefined;
  const exp = probe?.id === node.id ? probe.exp : undefined;

  const askForAddress = useCallback(async (id: string) => {
    try {
      const response = await apiFetch(`/api/app/${encodeURIComponent(id)}/frame`, {
        method: "POST",
      });
      if (!response.ok) return { id, src: null, exp: 0 };
      const body = (await response.json()) as { src?: unknown; exp?: unknown };
      return {
        id,
        src: typeof body.src === "string" ? body.src : null,
        exp: typeof body.exp === "number" ? body.exp : 0,
      };
    } catch {
      // A network failure is not a missing file, but with no address there is
      // nothing to mount either. The owner gets the sentence and the Rebuild
      // control, and reopening the page asks again.
      return { id, src: null, exp: 0 };
    }
  }, []);

  useEffect(() => {
    let live = true;
    void askForAddress(node.id).then((answer) => {
      if (live) setProbe(answer);
    });
    return () => {
      live = false;
    };
  }, [node.id, askForAddress]);

  /** ASK AGAIN BEFORE THE ADDRESS DIES.
   *
   *  The token in it lasts twelve hours. An app left open longer than that
   *  goes on running and then fails the first file it had not already
   *  fetched, and inside an opaque-origin frame that failure reaches no
   *  console: the picture simply stops appearing. So the canvas asks for a
   *  new address five minutes before the old one expires.
   *
   *  A new address is a new token, so the frame's `src` changes and the frame
   *  reloads. AN APP LOSES WHATEVER IT WAS HOLDING IN MEMORY WHEN THAT
   *  HAPPENS, at most once every twelve hours. That is the trade: an app that
   *  forgets a half-typed answer twice a day beats one that quietly stops
   *  loading its own pictures. An app with anything worth keeping keeps it in
   *  its state, which is the bridge's and survives the reload.
   *
   *  A timer alone is not enough. A backgrounded tab's timers are throttled
   *  hard and can fire an hour late, so coming back to the page is its own
   *  moment to check. */
  useEffect(() => {
    if (!exp || src === null) return;
    const remaining = () => exp * 1000 - Date.now();
    const renew = () => {
      void askForAddress(node.id).then(setProbe);
    };
    const timer = setTimeout(renew, Math.max(0, remaining() - REMINT_BEFORE_MS));
    const onVisible = () => {
      if (!document.hidden && remaining() <= REMINT_BEFORE_MS) renew();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [exp, src, node.id, askForAddress]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !src) return;
    const bridge = createAppBridge({
      frame,
      page: { id: node.id, title: node.title },
      theme: () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
      tokens: () => readAppTokens(document.documentElement),
      // The reads answer what they own and hand back `undefined` for the
      // rest, so the write side layers over this with one more `??` rather
      // than a second switch that could disagree with the first.
      handle: async (request) => {
        const answer = await reads(request);
        if (answer !== undefined) return answer;
        throw new AppBridgeError("that request is not available yet", "bad_request");
      },
      onOpenPage,
      onToast,
    });
    bridgeRef.current = bridge;
    return () => {
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [src, node.id, node.title, reads, onOpenPage, onToast]);

  useEffect(() => {
    bridgeRef.current?.sendTheme(theme);
  }, [theme]);

  useEffect(() => {
    const onVisibility = () => bridgeRef.current?.sendVisibility(!document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  /** "22 Sep", the Caption line's second half. Built with the reader's own
   *  locale rather than a fixed one, and `null` for an `app` map that has no
   *  timestamp, so the separator goes with it rather than standing alone. */
  const built = node.app?.builtAt
    ? new Date(node.app.builtAt).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })
    : null;

  const prompt = `rebuild the page ${node.title} (id ${node.id})`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(prompt);
    } catch {
      // A denied permission, or a page served over plain http, where there is
      // no clipboard to write to at all. Unhandled this is a rejected promise
      // inside an onClick and an owner who pressed a button that did nothing,
      // so the prompt goes on the page instead, where it can be selected.
      setCopyState("failed");
      onToast("Could not copy. The prompt is beside the button, select it there.");
      return;
    }
    setCopyState("copied");
  };

  useEffect(() => {
    if (copyState !== "copied") return;
    const settle = setTimeout(() => setCopyState("idle"), COPIED_FOR_MS);
    return () => clearTimeout(settle);
  }, [copyState]);

  return (
    <div data-app-canvas className="brain-app-canvas brain-page-top">
      <div className="mx-auto w-full max-w-[720px] px-5 md:px-6">
        {node.icon && <div className="mb-5 text-[44px] leading-none">{node.icon}</div>}
        <h1 className="text-title text-ink">{node.title}</h1>
        <p className="brain-page-meta text-caption">
          {`Built by ${node.app?.builtBy ?? "an agent"}`}
          {/* The date is the reader's locale rendering of a fixed instant, so
              the shell's DOM contract masks this node the way it masks a
              `<time title>`. The marker is what it masks by. */}
          {built !== null && <span data-app-built>{` · ${built}`}</span>}
        </p>
        {node.app?.reason && (
          <p className="mt-1 text-caption text-ink-3">{node.app.reason}</p>
        )}
        <div className="mt-4 mb-5 flex items-center gap-2">
          <button
            type="button"
            data-app-rebuild
            onClick={copy}
            className="brain-touch-min flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink"
          >
            <Icon name="refresh-linear" size={13} className="text-ink-3" />
            Rebuild
          </button>
          {copyState === "failed" ? (
            <span data-app-prompt className="text-caption text-ink-2 select-all">
              {prompt}
            </span>
          ) : (
            <span className="text-caption text-ink-3">
              {copyState === "copied"
                ? "Copied. Paste it to your agent."
                : "Copy a prompt for your agent"}
            </span>
          )}
        </div>
      </div>
      {src === null ? (
        <div className="mx-auto w-full max-w-[720px] px-5 md:px-6">
          <Empty
            icon="file-corrupted-linear"
            title="App files are missing. Ask your agent to rebuild the page."
            hint="The page is here and its description is above. What it runs is not."
          />
        </div>
      ) : src !== undefined ? (
        <iframe
          ref={frameRef}
          title={node.title}
          sandbox={APP_FRAME_SANDBOX}
          src={src}
          className="brain-app-frame"
        />
      ) : null}
    </div>
  );
}
