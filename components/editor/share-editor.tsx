"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MilkdownEditor, type EditorCapabilities } from "./milkdown-editor";
import { setAttachmentSrcResolver } from "./attachment-src";
import { createKeyedQueue, saveMarkdown, SaveRequestError } from "@/lib/autosave";
import { localAttachmentName } from "@/lib/attachments";
import { Button } from "../ui/button";

/** Longer than the owner's 700 ms (components/shell.tsx). Every visitor save
 *  is a round trip plus a scheduled git commit, and the visitor write bucket
 *  is 60 per 60 seconds: at 2000 ms continuous typing spends at most half of
 *  it and leaves room for the conflict GET. */
export const SHARE_AUTOSAVE_DEBOUNCE_MS = 2000;

/** The double submit `lib/share-write.ts` checks against the edit cookie.
 *  Named here rather than imported: that module is server-only. */
const VID_HEADER = "x-brain-share-vid";

const CONFLICT_COPY =
  "Someone else saved this page while you were writing. Your text is still here. Reload to see their version.";

export default function ShareEditor({
  rootId,
  pageId,
  shareVersion,
  vid,
  initialMarkdown,
  initialRev,
  onReload = () => location.reload(),
}: {
  rootId: string;
  pageId: string;
  shareVersion: number;
  vid: string;
  initialMarkdown: string;
  initialRev: string;
  onReload?: () => void;
}) {
  const [markdown, setMarkdown] = useState(initialMarkdown);
  const [conflict, setConflict] = useState(false);
  const revision = useRef(initialRev);
  const base = useRef(initialMarkdown);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // One save in flight per page, so a second PUT always carries the rev the
  // first one produced instead of racing it into a spurious 409.
  const [queue] = useState(createKeyedQueue);

  const query = `root=${encodeURIComponent(rootId)}&v=${shareVersion}`;
  const vidHeaders = useMemo(() => ({ [VID_HEADER]: vid }), [vid]);

  const fetcher = useCallback<typeof fetch>(
    (input, init = {}) =>
      fetch(input, {
        ...init,
        headers: {
          ...((init.headers as Record<string, string>) ?? {}),
          ...vidHeaders,
        },
      }),
    [vidHeaders],
  );

  useEffect(() => {
    setAttachmentSrcResolver((url) => {
      const name = localAttachmentName(url);
      if (!name) return url;
      return `/api/media/${name}?root=${encodeURIComponent(rootId)}&page=${encodeURIComponent(pageId)}&v=${shareVersion}`;
    });
    return () => setAttachmentSrcResolver(null);
  }, [pageId, rootId, shareVersion]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const save = useCallback(
    async (next: string) => {
      try {
        await saveMarkdown({
          fetcher,
          id: pageId,
          markdown: next,
          getRevision: () => revision.current,
          setRevision: (value) => {
            revision.current = value;
          },
          getBaseMarkdown: () => base.current,
          setBaseMarkdown: (value) => {
            base.current = value;
          },
          endpoint: (id) => `/api/share-edit/page/${id}?${query}`,
        });
        setConflict(false);
      } catch (error) {
        // Two strangers, not one person with two tabs: the text stays, and
        // Reload is a press, never something that happens to them.
        if (error instanceof SaveRequestError && error.status === 409) {
          setConflict(true);
          return;
        }
        setConflict(false);
      }
    },
    [fetcher, pageId, query],
  );

  const onChange = useCallback(
    (next: string) => {
      setMarkdown(next);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        void queue.run(pageId, () => save(next));
      }, SHARE_AUTOSAVE_DEBOUNCE_MS);
    },
    [pageId, queue, save],
  );

  const capabilities = useMemo<EditorCapabilities>(
    () => ({
      upload: {
        endpoint: `/api/share-edit/upload?${query}&page=${encodeURIComponent(pageId)}`,
        fetcher,
        headers: vidHeaders,
      },
    }),
    [fetcher, pageId, query, vidHeaders],
  );

  return (
    <div data-share-editor>
      {conflict && (
        <div
          data-share-conflict
          role="status"
          className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg bg-[var(--fill-tint)] py-2 pl-4 pr-2 text-table text-ink"
        >
          <span className="min-w-0 flex-1">{CONFLICT_COPY}</span>
          <Button type="button" variant="quiet" onClick={onReload}>
            Reload
          </Button>
        </div>
      )}
      <MilkdownEditor value={markdown} onChange={onChange} capabilities={capabilities} />
    </div>
  );
}
