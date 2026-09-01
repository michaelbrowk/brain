"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { unreferencedDirectChildren } from "@/lib/derived-page-refs";
import {
  BRAIN_FILE_PAGE_EVENT,
  BRAIN_FILE_PAGE_RESULT_EVENT,
  BRAIN_UNFILED_PAGE_MIME,
  encodeUnfiledPage,
  getDocumentHeadings,
  getServerDocumentHeadings,
  setDraggingUnfiledPage,
  subscribeDocumentHeadings,
  unfiledPageDropHtml,
  unfiledPageDropText,
  type DocumentHeading,
  type FilePageRefDetail,
  type FilePageRefResult,
} from "@/lib/page-filing";
import type { TreeNode } from "@/lib/store/types";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type MouseEvent,
} from "react";
import { Icon } from "./ui/icon";

const subscribeToOrigin = () => () => {};
const getBrowserOrigin = () => window.location.origin;
const getServerOrigin = () => null;

export { referencedPageIds } from "@/lib/derived-page-refs";

function refLabel(child: TreeNode) {
  return `${child.icon || "📄"} ${child.title}`;
}

/** What the editor did, in the words the reader used to ask for it. A filing
 *  that lands somewhere other than the named section says so rather than
 *  looking like every other success. */
function announcement(title: string, result: FilePageRefResult): string {
  if (result.refused === "duplicate") return `${title} is already in this page`;
  if (result.refused === "locked") {
    return `The page is busy, ${title} was not filed`;
  }
  return result.section
    ? `${title} filed under ${result.section}`
    : `${title} filed at the end of the page`;
}

/** The row action, for a reader who cannot drag. A phone has the same problem
 *  from the other side — the tail sits below the document and a drag up into
 *  it is a poor gesture — so this is the touch path too and stays visible
 *  where there is no hover. */
function FileInPage({
  child,
  headings,
  onFile,
}: {
  child: TreeNode;
  headings: readonly DocumentHeading[];
  onFile: (child: TreeNode, headingIndex: number | null) => boolean;
}) {
  const filed = useRef(false);
  const choose = (headingIndex: number | null) => {
    filed.current = onFile(child, headingIndex);
  };
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button
          type="button"
          data-file-page-trigger={child.id}
          aria-label={`File ${child.title} into this page`}
          // 24px is the house minimum for a dense row (`brain-touch-min`);
          // 44 would cover the row above. Full opacity where there is no
          // hover, since there the control is the only path in (DESIGN.md §8).
          //
          // `top-px` is the row's own padding, so the control sits on the
          // first line rather than at the row's middle — on a phone a long
          // title wraps, and a centred control lands in the gap between the
          // two lines, belonging to neither.
          className="brain-touch-min absolute right-1 top-px grid size-6 place-items-center rounded-sm text-ink-3 opacity-0 transition-opacity hover:bg-fill-hover hover:text-ink-2 focus:opacity-100 group-hover/unfiled:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
        >
          <Icon name="menu-dots-bold" size={16} />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content
          side="bottom"
          align="end"
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            if (!filed.current) return;
            filed.current = false;
            // The plugin has already put the caret on the block it wrote.
            // Radix would hand focus back to this trigger, whose row unmounts
            // the moment the body serializes, and focus would fall to <body>.
            event.preventDefault();
          }}
          className="brain-menu z-[var(--z-modal)] w-[240px]"
        >
          {/* The list is as long as the page has sections. Scrolling it here
              rather than on the menu keeps the material's edge light still. */}
          <div
            className="overflow-y-auto overscroll-contain"
            style={{
              maxHeight:
                "min(320px, calc(var(--radix-dropdown-menu-content-available-height, 320px) - 12px))",
            }}
          >
            {headings.length > 0 && (
              <>
                <Dropdown.Label className="brain-menu-label">
                  File under
                </Dropdown.Label>
                {headings.map((heading) => (
                  <Dropdown.Item
                    key={heading.index}
                    className="brain-menu-item"
                    // The outline the reader already sees in the document.
                    style={{ paddingInlineStart: 8 + (heading.depth - 1) * 12 }}
                    onSelect={() => choose(heading.index)}
                  >
                    <Icon
                      name="hashtag-linear"
                      size={16}
                      className="brain-menu-icon"
                    />
                    <span className="truncate">
                      {heading.text || "Untitled heading"}
                    </span>
                  </Dropdown.Item>
                ))}
                <Dropdown.Separator className="brain-menu-sep" />
              </>
            )}
            {/* Last, and never the default: for a page whose sections are all
                above, "end of page" is the one choice that moves nothing. */}
            <Dropdown.Item
              className="brain-menu-item"
              onSelect={() => choose(null)}
            >
              <Icon
                name="document-text-linear"
                size={16}
                className="brain-menu-icon"
              />
              End of page
            </Dropdown.Item>
          </div>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

export function Subpages({
  pages,
  markdown,
  currentOrigin: providedOrigin,
  onNavigate,
}: {
  pages: readonly TreeNode[];
  markdown: string;
  currentOrigin?: string;
  onNavigate: (id: string) => void;
}) {
  const browserOrigin = useSyncExternalStore(
    subscribeToOrigin,
    getBrowserOrigin,
    getServerOrigin,
  );
  // The sections come from the mounted editor, not from this Markdown: the
  // menu and the insert have to count headings the same way or an index means
  // one block in the picker and another one in the document.
  const headings = useSyncExternalStore(
    subscribeDocumentHeadings,
    getDocumentHeadings,
    getServerDocumentHeadings,
  );
  const currentOrigin = providedOrigin ?? browserOrigin;
  const visibleChildren = useMemo(
    () => unreferencedDirectChildren(pages, markdown, currentOrigin),
    [pages, markdown, currentOrigin],
  );

  const [status, setStatus] = useState("");
  const asked = useRef<{ id: string; title: string } | null>(null);
  const answer = useRef<FilePageRefResult | null>(null);

  useEffect(() => {
    const onResult = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const result = event.detail as FilePageRefResult;
      answer.current = result;
      const pending = asked.current;
      if (!pending || pending.id !== result.id) return;
      asked.current = null;
      setStatus(announcement(pending.title, result));
    };
    window.addEventListener(BRAIN_FILE_PAGE_RESULT_EVENT, onResult);
    return () =>
      window.removeEventListener(BRAIN_FILE_PAGE_RESULT_EVENT, onResult);
  }, []);

  const navigate = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }
    event.preventDefault();
    onNavigate(id);
  };

  /** Hand ProseMirror an exact one-block slice as `text/html` and let its own
   *  external-drop path do the insert: the block drop indicator draws where it
   *  would for any block drag, and the reference lands at that boundary. The
   *  browser's default link payload is cleared first — it carries an absolute
   *  URL, which would end up written into the file. */
  const startDrag = (event: DragEvent<HTMLAnchorElement>, child: TreeNode) => {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    const payload = { id: child.id, label: refLabel(child) };
    transfer.effectAllowed = "copy";
    transfer.clearData();
    transfer.setData("text/html", unfiledPageDropHtml(payload));
    transfer.setData("text/plain", unfiledPageDropText(payload));
    transfer.setData(BRAIN_UNFILED_PAGE_MIME, encodeUnfiledPage(payload));
    // `dragover` cannot read the payload back, and that is where the editor
    // has to answer, so the id travels through the window as well.
    setDraggingUnfiledPage(payload);
    const anchor = event.currentTarget;
    if (typeof transfer.setDragImage === "function") {
      const rect = anchor.getBoundingClientRect();
      transfer.setDragImage(
        anchor,
        Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
        Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
      );
    }
    anchor.dataset.dragging = "true";
  };

  /** True when the editor took the page. The result comes back inside the
   *  dispatch, so the caller can act on it in the same turn. */
  const fileInPage = useCallback((child: TreeNode, headingIndex: number | null) => {
    const detail: FilePageRefDetail = {
      id: child.id,
      label: refLabel(child),
      headingIndex,
    };
    asked.current = { id: child.id, title: child.title };
    window.dispatchEvent(new CustomEvent(BRAIN_FILE_PAGE_EVENT, { detail }));
    if (asked.current) {
      // No editor answered at all — nothing was written, and nothing said so.
      asked.current = null;
      setStatus(`The page is busy, ${child.title} was not filed`);
      return false;
    }
    const result = answer.current;
    return result?.id === child.id && result.refused === null;
  }, []);

  if (visibleChildren.length === 0 && !status) return null;

  return (
    <>
      {/* Nothing else in this feature reaches a screen reader: the tail row
          leaves without a word and the block it became is only a flash. */}
      <span
        data-filing-status
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {status}
      </span>
      {visibleChildren.length > 0 && (
        <div
          data-derived-page-refs
          className="mt-6 min-w-0 max-w-full border-t border-hair pt-3"
        >
          {/* The rows below are children of this page that the page does not
              mention. Without the rule and the name they read as document
              content filed under whatever section they happen to follow. */}
          <p className="pb-1 text-label text-ink-2">Not in this page</p>
          {visibleChildren.map((child) => (
            <p
              key={child.id}
              // pr-7 keeps a wrapped title clear of the row action: on a phone
              // a long page name wraps instead of truncating, and the trigger
              // is always visible there. The fill makes the row and its
              // control one object rather than a title and a distant control.
              className="brain-page-ref-only group/unfiled relative -mx-1.5 min-w-0 max-w-full rounded-xs py-px pl-1.5 pr-7 transition-colors hover:bg-fill-hover focus-within:bg-fill-hover"
            >
              <a
                href={`/p/${child.id}`}
                data-page-ref={child.id}
                draggable
                onDragStart={(event) => startDrag(event, child)}
                onDragEnd={(event) => {
                  setDraggingUnfiledPage(null);
                  delete event.currentTarget.dataset.dragging;
                }}
                onClick={(event) => navigate(event, child.id)}
                className="brain-page-ref"
              >
                <span className="brain-page-ref-icon">{child.icon || "📄"}</span>
                {` ${child.title}`}
              </a>
              <FileInPage
                child={child}
                headings={headings}
                onFile={fileInPage}
              />
            </p>
          ))}
        </div>
      )}
    </>
  );
}
