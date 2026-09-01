"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { motion, useReducedMotion } from "framer-motion";
import { SPRING_SHEET } from "@/lib/motion";
import { IconButton } from "./ui/button";
import { Icon } from "./ui/icon";
import { Kbd } from "./ui/primitives";
import { useScrollEdge } from "./ui/scroll-edge";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { emitMailCommand, type MailCommand } from "./mail-commands";
import type { TreeNode } from "@/lib/store/types";
import type { SearchHit } from "@/lib/search";
import type { SearchTextTarget } from "@/lib/search-navigation";

export type CommandPaletteSelection =
  | { kind: "page"; id: string }
  | { kind: "text"; id: string; target: SearchTextTarget | null };

interface FlatPage {
  id: string;
  title: string;
  icon?: string;
  path: string;
  category?: string;
  tags?: string[];
}

interface PaletteAction {
  id: string;
  label: string;
  icon: string;
  shortcut?: string;
  keywords?: string[];
  run: () => void | Promise<void>;
}

function flattenPages(tree: TreeNode[]): FlatPage[] {
  const out: FlatPage[] = [];
  const walk = (nodes: TreeNode[], trail: string[]) => {
    for (const n of nodes) {
      out.push({
        id: n.id,
        title: n.title,
        icon: n.icon,
        path: trail.join(" / "),
        category: n.category,
        tags: n.tags,
      });
      walk(n.children, [...trail, n.title]);
    }
  };
  walk(tree, []);
  return out;
}

type PageFilter = { type: "tag" | "cat"; value: string };

const PAGE_LIMIT = 12;
const MARK_CLASS = "rounded-[2px] bg-fill-active text-ink"; // no px — padding split words apart ("Журав лев")
// Group headings (Label 11, sentence case) and rows (r10, the selected one a
// white capsule) are styled once, in globals.css, for the desktop panel and
// the phone's sheet alike — `.brain-palette` / `.brain-palette-sheet`. One
// surface, one rule set.
const ITEM_CLASS =
  "brain-palette-item flex cursor-pointer items-center gap-2.5 px-2.5 py-2 text-[14px] text-ink";

function parsePaletteQuery(input: string): { filter: PageFilter | null; text: string } {
  const trimmed = input.trimStart();
  const match = /^(tag|cat):(\S+)/i.exec(trimmed);
  if (!match) return { filter: null, text: input.trim() };
  return {
    filter: { type: match[1].toLowerCase() as PageFilter["type"], value: match[2] },
    text: trimmed.slice(match[0].length).trim(),
  };
}

/**
 * Mail commands surface only while Mail is the open route. They reach the
 * mounted MailSurface over the mail-commands window bus instead of props, so
 * the shell stays out of the loop; the surface applies its capability gates.
 */
const MAIL_PALETTE_ACTIONS: readonly {
  readonly command: MailCommand;
  readonly label: string;
  readonly icon: string;
  readonly keywords: readonly string[];
}[] = [
  {
    command: "compose",
    label: "Compose message",
    icon: "pen-new-square-linear",
    keywords: ["mail", "email", "new", "write", "send"],
  },
  {
    command: "goto-inbox",
    label: "Go to Inbox",
    icon: "inbox-linear",
    keywords: ["mail", "email", "folder"],
  },
  {
    command: "goto-starred",
    label: "Go to Starred",
    icon: "star-linear",
    keywords: ["mail", "email", "favorites", "folder"],
  },
  {
    command: "goto-unread",
    label: "Go to Unread",
    icon: "letter-unread-linear",
    keywords: ["mail", "email", "smart", "view"],
  },
  {
    command: "goto-lists",
    label: "Go to Lists",
    icon: "mailbox-linear",
    keywords: ["mail", "email", "smart", "view", "newsletters"],
  },
  {
    command: "goto-people",
    label: "Go to People",
    icon: "user-rounded-linear",
    keywords: ["mail", "email", "smart", "view", "contacts"],
  },
  {
    command: "goto-attachments",
    label: "Go to Attachments",
    icon: "paperclip-linear",
    keywords: ["mail", "email", "smart", "view", "files"],
  },
  {
    command: "goto-drafts",
    label: "Go to Drafts",
    icon: "document-text-linear",
    keywords: ["mail", "email", "unsent"],
  },
];

function pageMatchesFilter(page: FlatPage, filter: PageFilter | null): boolean {
  if (!filter) return true;
  const value = filter.value.toLowerCase();
  if (filter.type === "cat") return page.category?.toLowerCase() === value;
  return page.tags?.some((tag) => tag.toLowerCase() === value) ?? false;
}

function isWordBoundary(value: string, index: number): boolean {
  return index === 0 || /[^a-z0-9]/i.test(value[index - 1] ?? "");
}

function findSubsequence(value: string, query: string): number[] | null {
  const haystack = value.toLowerCase();
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return [];
  const indexes: number[] = [];
  let from = 0;
  for (const char of needle) {
    const index = haystack.indexOf(char, from);
    if (index === -1) return null;
    indexes.push(index);
    from = index + 1;
  }
  return indexes;
}

function rankTitleMatch(title: string, query: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;

  const haystack = title.toLowerCase();
  const exactIndex = haystack.indexOf(needle);
  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 10;
  if (exactIndex !== -1 && isWordBoundary(haystack, exactIndex)) return 20 + exactIndex;
  if (exactIndex !== -1) return 40 + exactIndex;

  const subsequence = findSubsequence(title, query);
  if (!subsequence) return null;
  const spread = subsequence.at(-1)! - subsequence[0];
  return 100 + spread + subsequence[0] + title.length / 100;
}

function mergeRanges(ranges: Array<{ start: number; end: number }>) {
  const sorted = ranges
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function rangesForTerms(text: string, query: string): Array<{ start: number; end: number }> {
  const lower = text.toLowerCase();
  const terms = Array.from(
    new Set(
      query
        .trim()
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean),
    ),
  ).sort((a, b) => b.length - a.length);

  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    let index = lower.indexOf(term);
    while (index !== -1) {
      ranges.push({ start: index, end: index + term.length });
      index = lower.indexOf(term, index + term.length);
    }
  }

  return mergeRanges(ranges);
}

function rangesForSubsequence(text: string, query: string): Array<{ start: number; end: number }> {
  const indexes = findSubsequence(text, query);
  if (!indexes) return [];
  return mergeRanges(indexes.map((index) => ({ start: index, end: index + 1 })));
}

function highlightText(text: string, query: string, fallbackToSubsequence = false): ReactNode {
  const termRanges = rangesForTerms(text, query);
  const ranges = termRanges.length || !fallbackToSubsequence ? termRanges : rangesForSubsequence(text, query);
  if (ranges.length === 0) return text;

  const parts: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach((range, index) => {
    if (range.start > cursor) parts.push(text.slice(cursor, range.start));
    parts.push(
      <mark key={`${range.start}-${range.end}-${index}`} className={MARK_CLASS}>
        {text.slice(range.start, range.end)}
      </mark>,
    );
    cursor = range.end;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

export function CommandPalette({
  open,
  onOpenChange,
  tree,
  onSelect,
  hasCurrent,
  recentIds = [],
  onNewPage,
  onNewChild,
  onToday,
  onHome,
  onOpenMail,
  onOpenTrash,
  onOpenSettings,
  onToggleTheme,
  mobile = false,
  mobileFooter,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tree: TreeNode[];
  onSelect: (selection: CommandPaletteSelection) => void;
  hasCurrent: boolean;
  /** most-recent-first page ids — shown as a Recent group on an empty query */
  recentIds?: string[];
  onNewPage?: () => void | Promise<void>;
  onNewChild?: () => void | Promise<void>;
  onToday?: () => void | Promise<void>;
  onHome?: () => void | Promise<void>;
  onOpenMail?: () => void | Promise<void>;
  onOpenTrash?: () => void | Promise<void>;
  onOpenSettings?: () => void | Promise<void>;
  onToggleTheme?: () => void | Promise<void>;
  mobile?: boolean;
  mobileFooter?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searchState, setSearchState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [resolvedQuery, setResolvedQuery] = useState("");
  const [searchRetry, setSearchRetry] = useState(0);
  const pages = useMemo(() => flattenPages(tree), [tree]);
  const pageById = useMemo(() => new Map(pages.map((page) => [page.id, page])), [pages]);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mobileInputRef = useRef<HTMLInputElement>(null);

  const rawQuery = query.trim();
  const { filter: activeFilter, text: q } = useMemo(() => parsePaletteQuery(query), [query]);
  const hasPageFilter = activeFilter !== null;
  const actions = useMemo(() => {
    const items: PaletteAction[] = [];
    if (onNewPage) {
      items.push({
        id: "new-page",
        label: "New page",
        // The mark for making a page, not the pen: "Compose message" is a row
        // of this same list and wears the pen.
        icon: "add-linear",
        shortcut: "⌘⌥N",
        keywords: ["create", "blank"],
        run: onNewPage,
      });
    }
    if (onToday) {
      items.push({
        id: "today-note",
        label: "Today's note",
        icon: "sun-linear",
        keywords: ["daily", "journal", "log"],
        run: onToday,
      });
    }
    if (hasCurrent && onNewChild) {
      items.push({
        // Same act, so the same mark: the plus is what this system draws for
        // making a page, and the tree row menu already wears it on this very
        // action. It wore a ringed plus and sat one row from "New page", which
        // wore a boxed one — two drawings that differed only in the shape
        // around the same stroke. Both are bare now (DESIGN.md §10 ban 13), so
        // the two rows read as one act. What differs here is not the act but
        // the destination, and the destination is a word: the row-menu's word,
        // not "here".
        id: "new-page-here",
        label: "New page inside",
        icon: "add-linear",
        keywords: ["child", "inside", "current", "here"],
        run: onNewChild,
      });
    }
    if (onHome) {
      items.push({
        id: "go-home",
        label: "Go home",
        icon: "widget-2-linear",
        keywords: ["hub", "start"],
        run: onHome,
      });
    }
    if (onOpenMail) {
      items.push({
        id: "open-mail",
        label: "Open Mail",
        icon: "letter-linear",
        keywords: ["email", "imap"],
        run: onOpenMail,
      });
    }
    if (onOpenTrash) {
      items.push({
        id: "open-trash",
        label: "Open Trash",
        icon: "trash-bin-trash-linear",
        keywords: ["deleted", "restore"],
        run: onOpenTrash,
      });
    }
    if (onOpenSettings) {
      items.push({
        id: "settings",
        label: "Settings",
        icon: "settings-linear",
        keywords: ["preferences"],
        run: onOpenSettings,
      });
    }
    if (onToggleTheme) {
      items.push({
        id: "toggle-theme",
        label: "Toggle theme",
        icon: "moon-linear",
        keywords: ["dark", "light", "appearance"],
        run: onToggleTheme,
      });
    }
    return items;
  }, [
    hasCurrent,
    onHome,
    onNewChild,
    onNewPage,
    onToday,
    onOpenMail,
    onOpenSettings,
    onOpenTrash,
    onToggleTheme,
  ]);
  const filteredActions = useMemo(() => {
    if (hasPageFilter) return [];
    const needle = q.toLowerCase();
    if (!needle) return actions;
    return actions.filter((action) =>
      [action.label, action.shortcut, ...(action.keywords ?? [])].some((value) =>
        value?.toLowerCase().includes(needle),
      ),
    );
  }, [actions, hasPageFilter, q]);
  // Evaluated while open, so the list rebuilds against the current route.
  const mailOpen =
    open && typeof window !== "undefined" && window.location.pathname === "/mail";
  const mailActions = useMemo<PaletteAction[]>(() => {
    if (!mailOpen) return [];
    return MAIL_PALETTE_ACTIONS.map((action) => ({
      id: `mail-${action.command}`,
      label: action.label,
      icon: action.icon,
      keywords: [...action.keywords],
      run: () => emitMailCommand(action.command),
    }));
  }, [mailOpen]);
  const filteredMailActions = useMemo(() => {
    if (hasPageFilter) return [];
    const needle = q.toLowerCase();
    if (!needle) return mailActions;
    return mailActions.filter((action) =>
      [action.label, ...(action.keywords ?? [])].some((value) =>
        value?.toLowerCase().includes(needle),
      ),
    );
  }, [hasPageFilter, mailActions, q]);
  const filteredPages = useMemo(() => {
    const scopedPages = pages
      .map((page, index) => ({ page, index, rank: rankTitleMatch(page.title, q) }))
      .filter(({ page, rank }) => pageMatchesFilter(page, activeFilter) && rank !== null);

    if (q) scopedPages.sort((a, b) => a.rank! - b.rank! || a.index - b.index);
    return scopedPages.slice(0, PAGE_LIMIT).map(({ page }) => page);
  }, [activeFilter, pages, q]);

  // Recent: the empty-query palette opens on what you just touched (Linear/
  // Notion) instead of tree order. Only when nothing is typed and no filter.
  const recentPages = useMemo(() => {
    if (q || hasPageFilter) return [];
    const byId = new Map(pages.map((p) => [p.id, p]));
    return recentIds
      .map((id) => byId.get(id))
      .filter((p): p is (typeof pages)[number] => !!p)
      .slice(0, 6);
  }, [pages, recentIds, q, hasPageFilter]);
  const recentSet = useMemo(() => new Set(recentPages.map((p) => p.id)), [recentPages]);
  // On an empty query, recent pages already answer the most likely intent.
  // Repeating the start of the whole tree below them made the palette feel
  // like three navigation surfaces stacked together. Keep the broader page
  // list for typed queries, filters, and first use before recents exist.
  const pageResults = useMemo(() => {
    if (!q && !hasPageFilter && recentPages.length > 0) return [];
    return filteredPages.filter((page) => !recentSet.has(page.id));
  }, [filteredPages, hasPageFilter, q, recentPages.length, recentSet]);

  // full-text search, debounced
  useEffect(() => {
    if (debounce.current) {
      clearTimeout(debounce.current);
      debounce.current = null;
    }
    if (!open) return;
    if (q.length < 2) return;
    const controller = new AbortController();
    debounce.current = setTimeout(async () => {
      setHits([]);
      setSearchState("loading");
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("search unavailable");
        const body = (await response.json()) as { hits?: SearchHit[] };
        if (!Array.isArray(body.hits)) throw new Error("invalid search response");
        setHits(body.hits);
        setResolvedQuery(q);
        setSearchState("ready");
      } catch (error) {
        if (controller.signal.aborted) return;
        console.error("Search request failed", error);
        setHits([]);
        setResolvedQuery(q);
        setSearchState("error");
      }
    }, 200);
    return () => {
      controller.abort();
      if (debounce.current) {
        clearTimeout(debounce.current);
        debounce.current = null;
      }
    };
  }, [q, open, searchRetry]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setQuery("");
      setHits([]);
      setResolvedQuery("");
      setSearchState("idle");
    }
    onOpenChange(nextOpen);
  };

  const pickPage = (id: string) => {
    onSelect({ kind: "page", id });
    handleOpenChange(false);
  };

  const pickText = (hit: SearchHit) => {
    onSelect({ kind: "text", id: hit.id, target: hit.target ?? null });
    handleOpenChange(false);
  };

  const runAction = (action: PaletteAction) => {
    try {
      void action.run();
    } finally {
      handleOpenChange(false);
    }
  };

  const effectiveSearchState =
    q.length < 2
      ? "idle"
      : resolvedQuery === q
        ? searchState
        : "loading";
  const visibleHits =
    effectiveSearchState === "ready" && resolvedQuery === q
      ? hits.filter((hit) => {
          if (hit.source === "title") return false;
          const page = pageById.get(hit.id);
          return page ? pageMatchesFilter(page, activeFilter) : !activeFilter;
        })
      : [];
  const nothing =
    effectiveSearchState !== "loading" &&
    effectiveSearchState !== "error" &&
    filteredActions.length === 0 &&
    filteredMailActions.length === 0 &&
    recentPages.length === 0 &&
    pageResults.length === 0 &&
    visibleHits.length === 0;

  const paletteItems = (
    <>
      {effectiveSearchState === "loading" && (
        <div
          role="status"
          aria-live="polite"
          className="px-3 py-8 text-center text-[13px] text-ink-2"
        >
          Searching…
        </div>
      )}

      {effectiveSearchState === "error" && (
        <div
          role="alert"
          className="flex flex-col items-center px-3 py-8 text-center"
        >
          <p className="text-[13px] font-medium text-ink">
            Search couldn&apos;t load
          </p>
          <p className="mt-1 text-[12px] text-ink-2">
            Your pages are safe. Check the connection and try again.
          </p>
          <button
            type="button"
            onClick={() => setSearchRetry((value) => value + 1)}
            className="brain-touch-hit mt-3 rounded-sm bg-ink px-3 py-1.5 text-[12px] font-medium text-paper"
          >
            Try again
          </button>
        </div>
      )}

      {nothing && (
        <div className="px-3 py-8 text-center">
          <p className="text-[13px] text-ink-2">
            {rawQuery ? `No results for “${rawQuery}”` : "Nothing here yet"}
          </p>
          <p className="mt-1 text-[12px] text-ink-2">
            {hasPageFilter
              ? "No filtered pages match"
              : q.length === 1
                ? "Keep typing to search inside pages"
                : "Searches titles and page text"}
          </p>
        </div>
      )}

      {filteredActions.length > 0 && (
        <Command.Group heading="Actions">
          {filteredActions.map((action) => (
            <Command.Item
              key={action.id}
              value={`action-${action.id}`}
              onSelect={() => runAction(action)}
              className={ITEM_CLASS}
            >
              <span className="grid size-5 shrink-0 place-items-center text-ink-2">
                <Icon name={action.icon} size={15} />
              </span>
              <span className="min-w-0 flex-1 truncate">{action.label}</span>
              {action.shortcut && <Kbd>{action.shortcut}</Kbd>}
            </Command.Item>
          ))}
        </Command.Group>
      )}

      {filteredMailActions.length > 0 && (
        <Command.Group heading="Mail">
          {filteredMailActions.map((action) => (
            <Command.Item
              key={action.id}
              value={`action-${action.id}`}
              onSelect={() => runAction(action)}
              className={ITEM_CLASS}
            >
              <span className="grid size-5 shrink-0 place-items-center text-ink-2">
                <Icon name={action.icon} size={15} />
              </span>
              <span className="min-w-0 flex-1 truncate">{action.label}</span>
            </Command.Item>
          ))}
        </Command.Group>
      )}

      {recentPages.length > 0 && (
        <Command.Group heading="Recent">
          {recentPages.map((p) => (
            <Command.Item
              key={`recent-${p.id}`}
              value={`recent-${p.id}`}
              onSelect={() => pickPage(p.id)}
              className={ITEM_CLASS}
            >
              <span className="grid size-5 shrink-0 place-items-center text-[15px]">
                {p.icon ?? (
                  <Icon
                    name="document-text-linear"
                    size={15}
                    className="text-ink-2"
                  />
                )}
              </span>
              <span className="min-w-0 flex-1 truncate">{p.title}</span>
              {p.path && (
                <span className="max-w-[45%] shrink-0 truncate text-[12px] text-ink-2">
                  {p.path}
                </span>
              )}
            </Command.Item>
          ))}
        </Command.Group>
      )}

      {pageResults.length > 0 && (
        <Command.Group heading={q || hasPageFilter ? "Pages" : "Jump to page"}>
          {pageResults.map((p) => (
              <Command.Item
                key={p.id}
                value={`page-${p.id}`}
                onSelect={() => pickPage(p.id)}
                className={ITEM_CLASS}
              >
                <span className="grid size-5 shrink-0 place-items-center text-[15px]">
                  {p.icon ?? (
                    <Icon
                      name="document-text-linear"
                      size={15}
                      className="text-ink-2"
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {highlightText(p.title, q, true)}
                </span>
                {p.path && (
                  <span className="max-w-[45%] shrink-0 truncate text-[12px] text-ink-2">
                    {p.path}
                  </span>
                )}
              </Command.Item>
            ))}
        </Command.Group>
      )}

      {visibleHits.length > 0 && (
        <Command.Group heading="In text">
          {visibleHits.map((h) => (
            <Command.Item
              key={`hit-${h.id}`}
              value={`hit-${h.id}`}
              onSelect={() => pickText(h)}
              className="brain-palette-item flex cursor-pointer flex-col gap-0.5 px-2.5 py-2"
            >
              <span className="flex items-center gap-2.5 text-[14px] text-ink">
                <span className="grid size-5 shrink-0 place-items-center text-[15px]">
                  {h.icon ?? (
                    <Icon
                      name="document-text-linear"
                      size={15}
                      className="text-ink-2"
                    />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {highlightText(h.title, q, true)}
                </span>
              </span>
              <span className="truncate pl-[30px] text-[12px] text-ink-2">
                {highlightText(h.snippet.before, q)}
                {highlightText(h.snippet.match, q)}
                {highlightText(h.snippet.after, q)}
              </span>
            </Command.Item>
          ))}
        </Command.Group>
      )}
    </>
  );

  // The phone's search is the same surface as the desktop palette, built the
  // way the Pages sheet is: the Radix content is the transparent full-screen
  // focus scope and the thick sheet is its child (`.brain-palette-sheet` in
  // globals.css), on the 8px inset over the safe area, rising on
  // SPRING_SHEET. Headings and rows take the desktop panel's rules.
  if (mobile) {
    return (
      <Dialog.Root open={open} onOpenChange={handleOpenChange}>
        <Dialog.Portal>
          <Dialog.Content
            data-testid="mobile-search-view"
            aria-modal="true"
            className="brain-palette-mobile fixed inset-0 z-[var(--z-modal)] outline-none md:hidden"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              mobileInputRef.current?.focus({ preventScroll: true });
            }}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              // When the viewport grows, the same open search becomes the
              // desktop palette. Let its freshly mounted input keep focus.
              window.requestAnimationFrame(() => {
                const desktopInput = document.querySelector<HTMLInputElement>(
                  '[data-testid="desktop-command-palette"] input[cmdk-input]',
                );
                if (desktopInput?.getClientRects().length) {
                  desktopInput.focus({ preventScroll: true });
                }
              });
            }}
          >
            <Dialog.Title className="sr-only">Search</Dialog.Title>
            <Dialog.Description className="sr-only">
              Search pages, page text, and Brain actions.
            </Dialog.Description>
            <PaletteSheet>
              <Command
                label="Search and commands"
                shouldFilter={false}
                onKeyDown={(event) => {
                  if (event.key === "Escape") handleOpenChange(false);
                }}
                className="flex min-h-0 flex-1 flex-col"
              >
                <header className="brain-palette-sheet-head">
                  {/* The way back is the word the sidebar slot and the mobile
                      settings header use (DESIGN.md §12, SlotBackRow): a
                      place-name would be wrong here too — search opens over
                      Mail and the hub as well as over a page. */}
                  <button
                    type="button"
                    onClick={() => handleOpenChange(false)}
                    aria-label="Back"
                    className="tree-row focus-inset brain-touch-hit w-auto justify-self-start"
                  >
                    <span className="tree-row-glyph" aria-hidden>
                      <Icon name="alt-arrow-left" size={16} />
                    </span>
                    <span className="tree-row-title">Back</span>
                  </button>
                  <h1 className="text-h3 text-ink">Search</h1>
                  <span aria-hidden="true" />
                </header>

                {/* the field atom on glass, the Pages sheet's capsule; cmdk
                    owns the input so the atom is composed, not imported */}
                <div className="field field-glass search-capsule shrink-0">
                  <Icon name="magnifer" size={16} />
                  {activeFilter && (
                    <span className="text-label max-w-[8rem] shrink-0 truncate rounded-full bg-[var(--fill-glass-selected)] px-2 text-ink">
                      {activeFilter.type}:{activeFilter.value}
                    </span>
                  )}
                  <Command.Input
                    ref={mobileInputRef}
                    value={query}
                    onValueChange={setQuery}
                    aria-label="Search pages and text"
                    placeholder="Search pages and text…"
                  />
                  {query && (
                    <IconButton
                      size={28}
                      aria-label="Clear search"
                      onClick={() => setQuery("")}
                    >
                      <Icon name="close" size={16} />
                    </IconButton>
                  )}
                </div>

                <PaletteList className="overscroll-contain px-2 pb-2 pt-1 [&_[cmdk-item]]:min-h-11">
                  {paletteItems}
                </PaletteList>
              </Command>
              {mobileFooter}
            </PaletteSheet>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  // A real modal: Radix owns focus trap, Escape, outside-press, and hides the
  // app from assistive tech. The panel is the thick material (`.brain-palette`
  // in globals.css) and materializes on Radix's data-state through keyframes;
  // Radix keeps it mounted for the exit keyframe. The overlay fades via the
  // shared brain-dialog-overlay keyframes the same way.
  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="brain-dialog-overlay fixed inset-0 z-[var(--z-modal)]" />
        <Dialog.Content
          data-testid="desktop-command-palette"
          aria-modal="true"
          // The shell decides where focus lands after close (the
          // invoking search trigger, else main) — Radix must not race it.
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="brain-palette fixed left-1/2 z-[var(--z-modal)] flex -translate-x-1/2 flex-col overflow-hidden outline-none"
        >
          <Dialog.Title className="sr-only">Search and commands</Dialog.Title>
          <Dialog.Description className="sr-only">
            Search pages, page text, and Brain actions.
          </Dialog.Description>
          <Command label="Search and commands" shouldFilter={false} className="flex min-h-0 flex-col">
            <div className="flex items-center gap-2.5 px-4">
              <Icon name="magnifer-linear" size={18} className="shrink-0 text-ink-2" />
              {activeFilter && (
                <span className="text-label max-w-[9rem] shrink-0 truncate rounded-full bg-[var(--fill-glass-selected)] px-2 text-ink">
                  {activeFilter.type}:{activeFilter.value}
                </span>
              )}
              <Command.Input
                value={query}
                onValueChange={setQuery}
                aria-label="Search pages and text"
                placeholder="Search pages and text…"
                autoFocus
                className="text-subheading h-14 min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:font-medium placeholder:text-ink-2"
              />
            </div>
            {/* results fade under the top once scrolled and always at the
                bottom (edge-fade); the inset clears the 22px radius so the last
                row's capsule is never cut */}
            <PaletteList>{paletteItems}</PaletteList>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteList({
  children,
  className = "px-3 pb-3 pt-1",
}: {
  children: ReactNode;
  className?: string;
}) {
  const { ref, sentinelRef, endRef } = useScrollEdge<HTMLDivElement>();
  return (
    <Command.List ref={ref} className={`edge-fade min-h-0 flex-1 overflow-y-auto ${className}`}>
      <div ref={sentinelRef} aria-hidden className="-mb-px h-px w-full" />
      {children}
      <div ref={endRef} aria-hidden className="-mt-px h-px w-full" />
    </Command.List>
  );
}

/** The phone's sheet: a thick material with the 8px inset over the safe
 *  area, rising on SPRING_SHEET from below (a fade under reduced motion).
 *  Entrance only — Radix unmounts on close, so the tab bar underneath can
 *  take focus the moment the search is dismissed. The Pages sheet's twin. */
function PaletteSheet({ children }: { children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className="brain-palette-sheet mat-thick"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 48 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reduce ? { duration: 0.12 } : SPRING_SHEET}
    >
      {children}
    </motion.div>
  );
}
