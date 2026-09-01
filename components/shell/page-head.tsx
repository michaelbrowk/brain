"use client";

// The head of an open page: the cover banner above the article, then icon,
// title, collection-row properties, the meta-row (category, tags, cover,
// board, smart sort, sticker) and the inline stickers. Presentational —
// every piece of state and every handler comes from <Shell> as a prop; the
// cover upload queue and the sticker save queue stay in Shell.
// Extracted verbatim from shell.tsx (S4a of the shell extraction).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { CLIENT_ID } from "@/lib/client";
import { DUR, EASE_OUT } from "@/lib/motion";
import type { Sticker, TreeNode } from "@/lib/store/types";
import {
  clearCommittedTitleDrafts,
  normalizeTitle,
  persistTitleDraft,
  recoverTitleDraft,
} from "@/lib/title-draft";
import { Icon } from "../ui/icon";
import { EmojiPicker } from "../emoji-picker";
import { CategoryPicker } from "../category-picker";
import { TagRow } from "../tag-row";
import { CollectionRowProperties } from "../collection-view";
import { StickersInline, newSticker } from "../stickers";
import { formatAgo } from "@/lib/format-ago";
import { SaveIndicator } from "./save-indicator";
import { COVER_GRADIENTS, type LoadedPage, type SaveState } from "./helpers";

// value #1 — chrome disappears while writing. The meta-row affordances (add
// cover, board, smart sort, sticker, empty +Category/+Tag) fade out at rest and
// reveal on header hover/focus. Set metadata (a category or tag pill) stays.
// Touch keeps everything (no hover), keyboard reveals via focus-within.
const HEAD_REVEAL =
  "opacity-0 transition-opacity duration-200 group-hover/head:opacity-100 group-focus-within/head:opacity-100 [@media(hover:none)]:opacity-100";

export interface PageCoverProps {
  cover: string | undefined;
  reduceMotion: boolean | null;
  onSetCover: (cover: string) => Promise<boolean>;
  onUpload: (file: File) => Promise<boolean>;
}

/** The cover banner above the article. Collapses / expands in place when
 *  the cover is removed / added (opacity only under reduced motion). */
export function PageCover({
  cover,
  reduceMotion: reduce,
  onSetCover,
  onUpload,
}: PageCoverProps) {
  return (
    <AnimatePresence initial={false}>
      {cover && (
        <motion.div
          key="cover"
          initial={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
          animate={reduce ? { opacity: 1 } : { height: "auto", opacity: 1 }}
          exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
          transition={{ duration: DUR.page, ease: EASE_OUT }}
          // the collapse clips on height; brain-cover-bleed is what carries
          // the banner out under the sidebar to the window's left edge
          className="brain-cover-bleed overflow-hidden"
        >
          <CoverBanner
            cover={cover}
            onSetCover={onSetCover}
            onUpload={onUpload}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export interface PageHeadProps {
  page: LoadedPage;
  /** The tree node of the open page (metadata: category, tags, view,
   *  children, collection row). Null while the tree is catching up. */
  currentNode: TreeNode | null;
  /** The title block's meta line on paper: "Edited 2h ago" + the save state
   *  (DESIGN.md v2 → Materials: meta never sits in a pill). */
  save: SaveState;
  localRecoveryUnavailable: boolean;
  isBoard: boolean;
  isCollection: boolean;
  /** The collection this page is a row of — renders its properties under
   *  the title. */
  parentCollection: NonNullable<TreeNode["collection"]> | undefined;
  categorySuggestions: string[];
  /** Tags can be added only on a board card. */
  canAddTags: boolean;
  /** The page whose title should take focus (a freshly created page). */
  focusTitleId: string | null;
  smartSortLoading: boolean;
  onSetIcon: (icon: string) => Promise<void>;
  onCommitTitle: (title: string) => Promise<boolean>;
  onTitleFocused: () => void;
  onSetCategory: (category: string) => Promise<void>;
  onSetTags: (cardId: string, tags: string[]) => Promise<void>;
  onSetCover: (cover: string) => Promise<boolean>;
  onUploadCover: (file: File) => Promise<boolean>;
  onSetView: (view: "board" | null) => Promise<void>;
  onRunSmartSort: () => Promise<void>;
  onSetStickers: (next: Sticker[]) => void;
}

export function PageHead({
  page,
  currentNode,
  save,
  localRecoveryUnavailable,
  isBoard,
  isCollection,
  parentCollection,
  categorySuggestions,
  canAddTags,
  focusTitleId,
  smartSortLoading,
  onSetIcon,
  onCommitTitle,
  onTitleFocused,
  onSetCategory,
  onSetTags,
  onSetCover,
  onUploadCover,
  onSetView,
  onRunSmartSort,
  onSetStickers,
}: PageHeadProps) {
  // header left-aligns to the board's left edge (not centered).
  // group/head spans icon + title + meta so hover reveals every
  // affordance (Add icon / Add cover / …) at once
  return (
    <div
      className={`group/head ${
        isBoard || isCollection ? "max-w-[720px]" : ""
      }`}
    >
      <div className="mb-5">
        {page.icon ? (
          <EmojiPicker hasIcon onPick={onSetIcon} onRemove={() => onSetIcon("")}>
            <button
              aria-label="Change icon"
              className="-ml-1 rounded-md p-1 text-[44px] leading-none transition-colors hover:bg-fill-hover"
            >
              {page.icon}
            </button>
          </EmojiPicker>
        ) : (
          <EmojiPicker onPick={onSetIcon} onRemove={() => onSetIcon("")}>
            <button
              className={`brain-touch-min flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-[12px] text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink-2 ${HEAD_REVEAL}`}
            >
              <Icon name="smile-circle-linear" size={14} />
              Add icon
            </button>
          </EmojiPicker>
        )}
      </div>
      <div>
        <TitleInput
          pageId={page.id}
          value={page.title}
          autoFocus={focusTitleId === page.id}
          onDone={onTitleFocused}
          onCommit={onCommitTitle}
        />
        {currentNode && (
          <div className="brain-page-meta text-caption">
            <time
              dateTime={currentNode.updated}
              title={new Date(currentNode.updated).toLocaleString()}
              suppressHydrationWarning
            >
              Edited {formatAgo(currentNode.updated)}
            </time>
            <SaveIndicator
              state={save}
              recoveryUnavailable={localRecoveryUnavailable}
            />
          </div>
        )}
        {currentNode?.collectionRow && parentCollection && (
          <CollectionRowProperties
            definition={parentCollection}
            row={currentNode.collectionRow}
          />
        )}
        {/* -ml/pl pair widens the scrollport left so the category
            pill's negative margin isn't clipped on hover */}
        <div className="brain-hscroll -ml-2.5 -mt-2.5 mb-3.5 flex flex-nowrap items-center gap-1.5 overflow-x-auto py-0.5 pl-2.5">
          <CategoryPicker
            value={currentNode?.category}
            suggestions={categorySuggestions}
            onSet={onSetCategory}
            revealClass={HEAD_REVEAL}
          />
          <TagRow
            tags={currentNode?.tags ?? []}
            canAdd={canAddTags}
            onSet={(tags) =>
              currentNode && onSetTags(currentNode.id, tags)
            }
            revealClass={HEAD_REVEAL}
          />
          {!page.cover && (
            <CoverPicker onSetCover={onSetCover} onUpload={onUploadCover}>
              <button
                className={`brain-touch-min flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink-2 ${HEAD_REVEAL}`}
              >
                <Icon name="gallery-add-linear" size={13} />
                Add cover
              </button>
            </CoverPicker>
          )}
          {currentNode && !isCollection && (
            <button
              onClick={() => onSetView(isBoard ? null : "board")}
              className={`brain-touch-min flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink ${HEAD_REVEAL}`}
            >
              <Icon
                name={isBoard ? "text-linear" : "widget-2-linear"}
                size={13}
                className="text-ink-3"
              />
              {isBoard ? "Doc" : "Board"}
            </button>
          )}
          {/* Smart Sorting broom — organizes a flat pile of ≥4 pages
              into markdown headings + links; hidden in board view */}
          {currentNode &&
            !isBoard &&
            !isCollection &&
            currentNode.children.length >= 4 && (
              <button
                onClick={onRunSmartSort}
                disabled={smartSortLoading}
                aria-label="Smart sort"
                className={`brain-touch-min flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink disabled:opacity-50 ${HEAD_REVEAL}`}
              >
                <Icon name="magic-stick-3-linear" size={14} className="text-ink-3" />
                {smartSortLoading ? "Sorting…" : "Smart sort"}
              </button>
            )}
          {!isBoard && !isCollection && (
            <button
              onClick={() => onSetStickers([...(page.stickers ?? []), newSticker()])}
              aria-label="Add sticker"
              className={`brain-touch-min flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[12px] text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink-2 ${HEAD_REVEAL}`}
            >
              <Icon name="sticker-smile-circle-2-linear" size={13} className="text-ink-3" />
              Sticker
            </button>
          )}
        </div>
      </div>
      {!isBoard && !isCollection && (
        <StickersInline stickers={page.stickers} onChange={onSetStickers} />
      )}
    </div>
  );
}

function CoverBanner({
  cover,
  onSetCover,
  onUpload,
}: {
  cover: string;
  onSetCover: (cover: string) => Promise<boolean>;
  onUpload: (file: File) => Promise<boolean>;
}) {
  // Change / Remove hide at rest everywhere (.brain-cover-controls). Desktop
  // reveals on hover, keyboard focus reveals on every input; on touch a tap
  // on the cover toggles them so the chips never sit on the photo.
  const [revealed, setRevealed] = useState(false);
  return (
    <div
      className="brain-cover relative h-[180px] w-full overflow-hidden md:h-[220px]"
      data-revealed={revealed ? "" : undefined}
      onClick={(event) => {
        if (!window.matchMedia("(hover: none)").matches) return;
        const target = event.target as HTMLElement | null;
        if (target?.closest(".brain-cover-controls")) return;
        setRevealed((current) => !current);
      }}
    >
      <CoverVisual cover={cover} />
      {/* The two always-on dissolves (DESIGN.md v2 → Scroll-edge). The alpha
          lives on the image's own mask; these carry the blur that takes the
          detail out before the alpha does. */}
      <div aria-hidden className="brain-cover-foot">
        <i />
        <i />
      </div>
      <div aria-hidden className="brain-cover-left">
        <i />
      </div>
      <div className="brain-cover-controls absolute bottom-3 right-3 flex gap-1">
        <CoverPicker onSetCover={onSetCover} onUpload={onUpload}>
          <button className="flex h-7 items-center gap-1.5 rounded-sm border border-line bg-paper px-2 text-[12px] text-ink-2 shadow-[var(--shadow-lift)] transition-colors hover:bg-surface hover:text-ink">
            <Icon name="gallery-add-linear" size={13} />
            Change
          </button>
        </CoverPicker>
        <button
          onClick={() => onSetCover("")}
          className="h-7 rounded-sm border border-line bg-paper px-2 text-[12px] text-ink-3 shadow-[var(--shadow-lift)] transition-colors hover:bg-surface hover:text-ink-2"
        >
          Remove
        </button>
      </div>
    </div>
  );
}

function CoverVisual({ cover }: { cover: string }) {
  const gradient = COVER_GRADIENTS[cover];
  if (gradient) {
    return (
      <div
        aria-hidden
        className="brain-cover-visual h-full w-full"
        style={{ background: gradient }}
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={cover}
      alt=""
      className="brain-cover-visual h-full w-full bg-surface object-cover"
    />
  );
}

function CoverPicker({
  children,
  onSetCover,
  onUpload,
}: {
  children: React.ReactNode;
  onSetCover: (cover: string) => Promise<boolean>;
  onUpload: (file: File) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const reduce = useReducedMotion();

  const pick = async (cover: string) => {
    if (await onSetCover(cover)) setOpen(false);
  };

  const pickFile = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    const ok = await onUpload(file);
    setUploading(false);
    if (ok) setOpen(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={16}
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="z-[var(--z-modal)] outline-none"
        >
          <motion.div
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: -4 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: DUR.base, ease: EASE_OUT }}
            style={{ transformOrigin: "var(--radix-popover-content-transform-origin)" }}
            className="w-[220px] rounded-lg border border-line bg-paper p-1.5 shadow-[var(--shadow-overlay)]"
          >
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => pickFile(e.currentTarget.files?.[0])}
            />
            <button
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-[13px] text-ink-2 transition-colors hover:bg-fill-hover hover:text-ink disabled:pointer-events-none disabled:opacity-50"
            >
              <Icon name="gallery-add-linear" size={14} className="text-ink-3" />
              {uploading ? "Uploading..." : "Upload image"}
            </button>
            <div className="mt-1 grid grid-cols-5 gap-1">
              {Object.entries(COVER_GRADIENTS).map(([key, background], index) => (
                <button
                  key={key}
                  onClick={() => pick(key)}
                  aria-label={`Use gradient cover ${index + 1}`}
                  className="h-10 rounded-sm border border-line bg-surface p-1 transition-colors hover:border-ink-3"
                >
                  <span
                    aria-hidden
                    className="block h-full w-full rounded-xs"
                    style={{ background }}
                  />
                </button>
              ))}
            </div>
          </motion.div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** Value #1 — chrome that repeats what the page already says gets out of the
 *  way. A breadcrumb with one segment IS the title, a few centimetres above
 *  it, so it waits: while the title is on screen the shell carries nothing
 *  and the lone crumb stays hidden; when the title leaves the shell takes
 *  `data-title-out` and the crumb materialises (globals.css →
 *  `.brain-crumb-lone`). A crumb carrying an ancestor says something the
 *  title does not, and is gated by none of this.
 *
 *  The line is the scroller's own top, not the bottom of the pill band. The
 *  pills cover a strip at the left of the canvas, not the whole width — the
 *  document column runs to the right of them — so a title level with the
 *  pills is still on screen and still naming the page, and handing over
 *  there would put the same word in two places at once. Leaving at the top
 *  edge makes the handover exact: the crumb takes the name in the frame the
 *  title gives it up.
 *
 *  An IntersectionObserver on the title, the scroll-edge atom's pattern
 *  (DESIGN.md v2 → §7): off the scroll event path, and the flag lands on the
 *  DOM rather than in state, so crossing the line never re-renders the
 *  shell. Hidden is the rest state, so the crumb cannot flash before the
 *  first callback — an engine without the observer is handed the crumb it
 *  has always had. */
function useTitleReveal(ref: React.RefObject<HTMLTextAreaElement | null>) {
  useEffect(() => {
    const title = ref.current;
    const scroller = title?.closest<HTMLElement>(".brain-page-scroll");
    const shell = title?.closest<HTMLElement>(".brain-main");
    if (!title || !scroller || !shell) return;
    // The flag lives on the shell, which outlives any one title: during a
    // canvas change two TitleInputs are mounted at once, so the leaving one
    // must not clear a flag the arriving one has just set. Each observer
    // clears only what it set itself. Harmless today — navigation always
    // opens a page at the top — and not harmless the day scroll restoration
    // lands.
    let owns = false;
    const set = () => {
      owns = true;
      shell.dataset.titleOut = "";
    };
    const clear = () => {
      if (!owns) return;
      owns = false;
      delete shell.dataset.titleOut;
    };
    if (typeof IntersectionObserver === "undefined") {
      set();
      return clear;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) clear();
        else set();
      },
      { root: scroller, threshold: 0 },
    );
    observer.observe(title);
    return () => {
      observer.disconnect();
      clear();
    };
  }, [ref]);
}

function TitleInput({
  pageId,
  value,
  autoFocus,
  onCommit,
  onDone,
}: {
  pageId: string;
  value: string;
  autoFocus?: boolean;
  onCommit: (title: string) => Promise<boolean>;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useTitleReveal(ref);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const recovered = recoverTitleDraft(localStorage, pageId, value);
      setDraft(recovered?.title ?? value);
      if (recovered && recovered.title !== value) {
        persistTitleDraft(
          localStorage,
          pageId,
          CLIENT_ID,
          recovered.title,
          value,
          recovered.updatedAt,
        );
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [pageId, value]);
  useEffect(() => {
    if (autoFocus) {
      ref.current?.focus();
      ref.current?.select();
      onDone();
    }
  }, [autoFocus, onDone]);
  useLayoutEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);
  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label="Page title"
      value={draft}
      onChange={(e) => {
        const title = e.target.value.replace(/[\r\n]+/g, " ");
        setDraft(title);
        persistTitleDraft(localStorage, pageId, CLIENT_ID, title, value);
      }}
      onBlur={async () => {
        const title = normalizeTitle(draft);
        if (title !== draft) setDraft(title);
        if (await onCommit(title)) {
          clearCommittedTitleDrafts(localStorage, pageId, title);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
          e.preventDefault();
          e.currentTarget.blur();
          // Notion reflex: Enter from the title drops you into the body
          requestAnimationFrame(() => {
            document
              .querySelector<HTMLElement>(".milkdown .ProseMirror")
              ?.focus();
          });
        }
      }}
      placeholder="Untitled"
      style={{
        fontFamily: "var(--brain-page-headings, var(--font-headings))",
      }}
      className="mb-4 block w-full resize-none overflow-hidden bg-transparent text-[30px] font-bold leading-[1.15] tracking-[-0.02em] text-ink outline-none placeholder:text-ink-3"
    />
  );
}
