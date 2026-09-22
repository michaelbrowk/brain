"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { apiFetch } from "@/lib/client";
import type { TreeNode } from "@/lib/store/types";
import { APP_FRAME_SANDBOX } from "@/lib/apps/csp";
import { readAppTokens } from "@/lib/apps/tokens";
import { createAppBridge } from "./app-bridge";
import { createAppReads } from "./app-reads";
import { createAppHandler, createAppWrites } from "./app-writes";
import { Empty } from "../ui/empty";
import { Icon } from "../ui/icon";

/** How long "Copied." stands before the line goes back to the invitation. */
const COPIED_FOR_MS = 2_000;

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
  /** THE PAGES THIS APP HAS JUST MADE.
   *
   *  The shell's tree is the read guard, and it hears about a new page over
   *  SSE a moment after the create route has answered. Without this set an
   *  app that creates a page and reads it in its next request is told its own
   *  page is not there. A ref rather than state: nothing draws from it, and
   *  the bridge is rebuilt on a rename, which must not empty it. It is
   *  replaced when a different app opens, and bounded by the create route's
   *  own `APP_MAX_OWNED` cap. */
  const createdRef = useRef<{ appId: string; ids: Set<string> }>({
    appId: node.id,
    ids: new Set(),
  });
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
  const [probe, setProbe] = useState<{ id: string; src: string | null } | null>(
    null,
  );
  const src = probe?.id === node.id ? probe.src : undefined;
  useEffect(() => {
    let live = true;
    void apiFetch(`/api/app/${encodeURIComponent(node.id)}/frame`, { method: "POST" })
      .then(async (response) => {
        if (!live) return;
        if (!response.ok) {
          setProbe({ id: node.id, src: null });
          return;
        }
        const body = (await response.json()) as { src?: unknown };
        setProbe({
          id: node.id,
          src: typeof body.src === "string" ? body.src : null,
        });
      })
      .catch(() => {
        // A network failure is not a missing file, but with no address there
        // is nothing to mount either. The owner gets the sentence and the
        // Rebuild control, and reopening the page asks again.
        if (live) setProbe({ id: node.id, src: null });
      });
    return () => {
      live = false;
    };
  }, [node.id]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !src) return;
    if (createdRef.current.appId !== node.id) {
      createdRef.current = { appId: node.id, ids: new Set() };
    }
    const created = createdRef.current.ids;
    const bridge = createAppBridge({
      frame,
      page: { id: node.id, title: node.title },
      theme: () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
      tokens: () => readAppTokens(document.documentElement),
      // Reads, then writes, then the refusal. The order and the sentinel that
      // separates "no answer" from an answer of `null` live in
      // `createAppHandler`, which has a test of its own.
      handle: createAppHandler(
        createAppReads(liveTree, created),
        createAppWrites(node.id, (id) => created.add(id)),
      ),
      onOpenPage,
      onToast,
    });
    bridgeRef.current = bridge;
    return () => {
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [src, node.id, node.title, liveTree, onOpenPage, onToast]);

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
