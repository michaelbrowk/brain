"use client";

// Sharing: every public page, with copy / unshare. Active links work for
// anyone who has them; expired links stay listed for review.

import { useState } from "react";
import { DEFAULT_PAGE_ICON } from "@/lib/constants";
import type { TreeNode } from "@/lib/store/types";
import { Button } from "../ui/button";
import { SettingsGroup } from "./shared";

function flattenPublic(tree: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.public) out.push(n);
      walk(n.children);
    }
  };
  walk(tree);
  return out;
}

function isExpiredPublicPage(page: TreeNode): boolean {
  if (!page.shareExpiresAt) return false;
  const deadline = Date.parse(page.shareExpiresAt);
  return !Number.isFinite(deadline) || deadline <= Date.now();
}

export function SharingSection({
  tree,
  onUnshare,
  onCopyShareLink,
}: {
  tree: TreeNode[];
  onUnshare: (id: string) => void | Promise<void>;
  onCopyShareLink?: (id: string) => void | Promise<void>;
}) {
  const [unsharingPage, setUnsharingPage] = useState<string | null>(null);
  const [unshareError, setUnshareError] = useState<string | null>(null);
  const shared = flattenPublic(tree);

  return (
    <div className="space-y-7">
      <SettingsGroup
        title="Shared pages"
        description="Active links work for anyone who has them. Expired links stay listed for review."
      >
        {shared.length === 0 && (
          <p className="brain-settings-row text-table text-ink-3">
            Nothing is shared — use the share icon on a page
          </p>
        )}
        {shared.map((p) => (
          <div key={p.id} className="brain-settings-row">
            <span aria-hidden="true" className="text-[15px]">
              {p.icon ?? DEFAULT_PAGE_ICON}
            </span>
            <span className="min-w-0 flex-1 truncate text-table text-ink">
              {p.title}
            </span>
            {isExpiredPublicPage(p) && (
              <span className="brain-settings-badge text-table text-ink-2">
                Expired
              </span>
            )}
            <Button
              variant="quiet"
              disabled={
                isExpiredPublicPage(p) ||
                !onCopyShareLink ||
                unsharingPage === p.id
              }
              onClick={async () => {
                setUnshareError(null);
                try {
                  await onCopyShareLink?.(p.id);
                } catch {
                  setUnshareError(
                    "Couldn't verify and copy this link.",
                  );
                }
              }}
              aria-label={`Copy link for ${p.title}`}
            >
              Copy link
            </Button>
            <Button
              variant="quiet"
              disabled={unsharingPage === p.id}
              onClick={async () => {
                setUnsharingPage(p.id);
                setUnshareError(null);
                try {
                  await onUnshare(p.id);
                } catch {
                  setUnshareError(
                    "Couldn't stop sharing. The link is still active.",
                  );
                } finally {
                  setUnsharingPage(null);
                }
              }}
              aria-label={`Stop sharing ${p.title}`}
            >
              {unsharingPage === p.id ? "Stopping…" : "Unshare"}
            </Button>
          </div>
        ))}
      </SettingsGroup>
      {unshareError && (
        <p role="alert" className="text-caption text-ink-2">
          {unshareError}
        </p>
      )}
    </div>
  );
}
