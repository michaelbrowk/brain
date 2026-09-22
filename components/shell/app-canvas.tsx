"use client";

import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { apiFetch } from "@/lib/client";
import type { TreeNode } from "@/lib/store/types";
import { APP_FRAME_SANDBOX } from "@/lib/apps/csp";
import { readAppTokens } from "@/lib/apps/tokens";
import { createAppBridge } from "./app-bridge";
import { Empty } from "../ui/empty";
import { Icon } from "../ui/icon";

export interface AppCanvasProps {
  node: TreeNode;
  /** The shell's own tree, read on every request rather than snapshotted:
   *  what an app may read has to follow what the notebook holds now. The read
   *  handler is what consumes it, so nothing in this component does yet. */
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
export function AppCanvas({ node, onOpenPage, onToast }: AppCanvasProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "dark" ? "dark" : "light";
  const bridgeRef = useRef<ReturnType<typeof createAppBridge> | null>(null);
  const [copied, setCopied] = useState(false);

  /** ASK BEFORE MOUNTING.
   *
   *  A `kind: app` page whose files are not there — hand-written frontmatter,
   *  a restore that has not finished, a rebuild that failed part way — would
   *  otherwise mount a frame onto a 404 and paint the browser's own error
   *  document inside the canvas, which says nothing the owner can act on. One
   *  HEAD, and then either the frame or a sentence with the Rebuild control
   *  already beside it.
   *
   *  `undefined` while the question is open: neither branch draws, so the
   *  canvas does not flash a frame it is about to replace. The answer is held
   *  WITH the id it was asked about, so opening a second app reads as an open
   *  question again without a `setState` in the effect body. */
  const [probe, setProbe] = useState<{
    id: string;
    files: "present" | "missing";
  } | null>(null);
  const files = probe?.id === node.id ? probe.files : undefined;
  useEffect(() => {
    let live = true;
    void apiFetch(`/api/app/${encodeURIComponent(node.id)}/index.html`, { method: "HEAD" })
      .then((response) => {
        if (live) setProbe({ id: node.id, files: response.ok ? "present" : "missing" });
      })
      .catch(() => {
        // A network failure is not a missing file. The frame is mounted and
        // the browser retries the request itself, which is the better of two
        // wrong answers: an app that is there still runs.
        if (live) setProbe({ id: node.id, files: "present" });
      });
    return () => {
      live = false;
    };
  }, [node.id]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || files !== "present") return;
    const bridge = createAppBridge({
      frame,
      page: { id: node.id, title: node.title },
      theme: () => (document.documentElement.classList.contains("dark") ? "dark" : "light"),
      tokens: () => readAppTokens(document.documentElement),
      // The read side and the write side replace this. Until then an app can
      // say hello, open a page and raise a toast, and can reach the notebook
      // through nothing.
      handle: async () => {
        throw Object.assign(new Error("that request is not available yet"), {
          reason: "bad_request",
        });
      },
      onOpenPage,
      onToast,
    });
    bridgeRef.current = bridge;
    return () => {
      bridge.dispose();
      bridgeRef.current = null;
    };
  }, [files, node.id, node.title, onOpenPage, onToast]);

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
    await navigator.clipboard.writeText(prompt);
    setCopied(true);
  };

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
          <span className="text-caption text-ink-3">
            {copied ? "Copied. Paste it to your agent." : "Copy a prompt for your agent"}
          </span>
        </div>
      </div>
      {files === "missing" ? (
        <div className="mx-auto w-full max-w-[720px] px-5 md:px-6">
          <Empty
            icon="file-corrupted-linear"
            title="App files are missing. Ask your agent to rebuild the page."
            hint="The page is here and its description is above. What it runs is not."
          />
        </div>
      ) : files === "present" ? (
        <iframe
          ref={frameRef}
          title={node.title}
          sandbox={APP_FRAME_SANDBOX}
          src={`/api/app/${encodeURIComponent(node.id)}/index.html`}
          className="brain-app-frame"
        />
      ) : null}
    </div>
  );
}
