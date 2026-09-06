"use client";

import * as Dialog from "@radix-ui/react-dialog";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useReducedMotion,
} from "framer-motion";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { DEFAULT_PAGE_ICON } from "@/lib/constants";
import { sectionPageIds } from "@/lib/dated-sections";
import { DUR, EASE_OUT, SPRING_DEAL, SPRING_MATERIALIZE } from "@/lib/motion";
import type { TreeNode } from "@/lib/store/types";
import { Button } from "./ui/button";
import { DialogBody, DialogHeader } from "./ui/dialog-header";

export interface SmartSortResult {
  sections: string[];
  assignments: Record<string, string>;
  /** Reading order across all sections. Advisory: `assignments` decides
   *  membership, and `sectionPageIds` is the only reader of both. */
  order?: string[];
  count: number;
}

interface DealtSection {
  label: string;
  /** Its place in the reading order, which is what its own delay is off. */
  index: number;
  chips: { page: TreeNode; arrival: number }[];
}

/** `dialog-pop` runs 220ms on the Content's own transform. A cached answer
 *  landing inside that window would put the chips' projection against a box
 *  that is still moving, so the deal never starts before this. */
const DEAL_HOLD_MS = 240;
/** The stagger's ceiling plus one spring: what the whole deal costs. */
const DEAL_MS = (0.36 + SPRING_DEAL.duration) * 1000;
/** Above this the arc comes off and the flight carries it alone. Sixty-one
 *  tiles each doing a lift as well as a crossing is more motion than the
 *  event has meaning for. */
const ARC_LIMIT = 40;
/** Under this the box has not changed shape, it has settled. */
const GROWTH_FLOOR = 12;
/** The width this dialog becomes `.brain-sheet` (app/globals.css). */
const SHEET_QUERY = "(max-width: 767px)";
/** The width `.brain-cols` stacks at (components/editor/milkdown.css), which
 *  is what the preview's own columns have to agree with. */
const STACKED_COLUMNS_QUERY = "(max-width: 640px)";

/** The proposal, from the press to the answer.
 *
 *  The dialog opens in the same tick as the click, because the client already
 *  holds everything the answer rearranges: the titles and icons are in the
 *  tree, and the server adds only where each page goes. So the wait is not a
 *  skeleton standing in for content nobody has — it is the content, in the
 *  order it is stacked today, with one band reading down it.
 *
 *  When the answer lands, the same chips fly into their sections on a shared
 *  layout, and they fly into a structure that already exists: the sections
 *  land first, with the hairlines and the two columns Apply is about to
 *  write. That is what makes sixty-one tiles moving read as filing rather
 *  than as a shuffle. Nothing is written until Apply, and the dialog stays up
 *  through that write so a refused save can answer where the reader
 *  pressed. */
export function SmartSortPreview({
  session,
  applying = false,
  applyError = null,
  onApply,
  onCancel,
}: {
  session: { pages: TreeNode[]; result: SmartSortResult | null } | null;
  /** The Apply write is in flight: the dialog holds, and both ways out close. */
  applying?: boolean;
  /** What the failed write left the reader with, said where they pressed. */
  applyError?: string | null;
  onApply: () => void;
  onCancel: () => void;
}) {
  const open = !!session;
  const pages = useMemo(() => session?.pages ?? [], [session]);
  const result = session?.result ?? null;
  const reduce = useReducedMotion();
  const compact = useMediaQuery(SHEET_QUERY);
  const stacked = useMediaQuery(STACKED_COLUMNS_QUERY);
  /* The deal is a desktop gesture. Below 768 this dialog is `.brain-sheet`,
     where a heap-to-sections reshuffle is a tall vertical move that happens
     mostly off screen, so the phone takes the crossfade the reduced-motion
     reader takes. One flag, and everything that moves reads it. */
  const still = !!reduce || compact;
  const labelBase = useId();

  const openedAt = useRef(0);
  // Armed by identity rather than by a flag, so a second run cannot inherit
  // the first one's arming and start its deal on the frame it opens.
  const [armed, setArmed] = useState<SmartSortResult | null>(null);
  useEffect(() => {
    openedAt.current = open ? Date.now() : 0;
  }, [open]);
  useEffect(() => {
    if (!result) return;
    const wait = Math.max(
      0,
      DEAL_HOLD_MS - (Date.now() - (openedAt.current || Date.now())),
    );
    const hold = setTimeout(() => setArmed(result), wait);
    return () => clearTimeout(hold);
  }, [result]);
  const dealArmed = !!result && armed === result;

  /* Sections in the order Apply will write them, each chip carrying its index
     in the final reading order rather than in its own section, so the deal
     reads as one section filling and then the next. A page that has gone
     since the dialog opened is dropped: Apply drops it from the markdown for
     the same reason, and its uuid is not a thing to show a reader. */
  const dealt = useMemo(() => {
    if (!result || !dealArmed) return null;
    const byId = new Map(pages.map((page) => [page.id, page]));
    let arrival = 0;
    return result.sections
      .map((label) => ({
        label,
        chips: sectionPageIds(result, label)
          .map((id) => byId.get(id))
          .filter((page): page is TreeNode => !!page)
          .map((page) => ({ page, arrival: arrival++ })),
      }))
      .filter((section) => section.chips.length > 0)
      .map((section, index) => ({ ...section, index }));
  }, [dealArmed, pages, result]);
  /* An answer can come back with nothing in it: a malformed grouping, or
     every page gone between the press and the response. The pile stays
     standing rather than the box emptying out, and the header says so. */
  const sections = dealt && dealt.length > 0 ? dealt : null;
  const emptyAnswer = !!dealt && dealt.length === 0;

  /* Two columns whenever Apply will write two, split where Apply splits
     them, reading order left first (`applySmartSort`). The dialog's resting
     frame is then a small true picture of the document, which is the whole
     reason the chips have somewhere legible to land. It drops to one column
     at exactly the width `.brain-cols` stacks at, not at the sheet's, so the
     picture stays true in the band between the two. */
  const columns = useMemo(() => {
    if (!sections) return null;
    if (sections.length < 2 || stacked) return [sections];
    const mid = Math.ceil(sections.length / 2);
    return [sections.slice(0, mid), sections.slice(mid)];
  }, [sections, stacked]);

  const counts = useSectionCounts(sections, still);
  /* A standing refusal speaks for itself in the footer, so this holds its
     tongue rather than reading the old result over the top of it. */
  const announcement = applyError
    ? ""
    : applying
      ? "Saving the sorted page."
      : emptyAnswer
        ? "No sections came back. Try again."
        : sections
          ? `${sectionCount(sections.length)} proposed. Nothing saved yet.`
          : "";
  const bodyRef = useBodyHeight(still);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !applying) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="brain-dialog-overlay fixed inset-0 z-[var(--z-modal)]" />
        <Dialog.Content
          /* Apply commits: the dialog expands as it dissolves, because what
             it was holding has just been put on the page underneath. Cancel
             keeps `dialog-pop-out` and retreats, because nothing happened.
             The flag outlives the write on purpose — it has to still be on
             the element when the closed-state keyframe starts. */
          data-commit={applying ? "" : undefined}
          className="brain-dialog brain-sheet fixed left-1/2 top-1/2 z-[var(--z-modal)] flex max-h-[80dvh] w-[min(calc(100vw-2rem),560px)] flex-col overflow-hidden outline-none"
        >
          <DialogHeader
            title="Smart sort"
            subtitle={
              sections ? (
                <>
                  <span className="font-medium text-ink">
                    {sectionCount(sections.length)}
                  </span>
                  <span className="text-ink-3"> · Nothing saved yet</span>
                </>
              ) : emptyAnswer ? (
                <span className="font-medium text-ink">No sections came back</span>
              ) : (
                <>Reading {pages.length === 1 ? "1 page" : `${pages.length} pages`}</>
              )
            }
            closeLabel="Close smart sort"
            closeDisabled={applying}
          />

          {/* The dialog's own subtitle is a `Dialog.Description`, which is
              spoken once, when the dialog opens. It used to open WITH the
              answer, so the open was the announcement; it now opens on the
              press, and the sections landing, the subtitle changing and Apply
              coming alive would all be silent. So the result is spoken here,
              the way the failure below speaks in its own line. `status`
              rather than `alert`: `alert` is this codebase's mark for the
              refusal inside a form or a dialog. */}
          <span
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {announcement}
          </span>

          {/* `data-edge="chips"`: a wrapped tile flow ends in a partial row,
              so the bottom fade carries a whole chip and its gap. Twenty
              pixels under a 28px chip read as one chip dimming, which is how
              a cut section came to look like the end of the list. */}
          <DialogBody className="px-5 py-4" data-edge="chips">
            <div className="smart-body" ref={bodyRef}>
              <AnimatePresence>
                {!dealt && !still && (
                  <motion.span
                    key="band"
                    aria-hidden
                    className="smart-heap-band"
                    style={
                      {
                        "--smart-sweep": `${pages.length * 24 + 600}ms`,
                      } as CSSProperties
                    }
                    initial={{ opacity: 1 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: DUR.fast }}
                  />
                )}
              </AnimatePresence>

              {columns ? (
                <div className={columns.length === 2 ? "flex gap-10" : undefined}>
                  {columns.map((column, columnIndex) => (
                    <div
                      key={columnIndex}
                      className="min-w-0 flex-1 space-y-4"
                    >
                      {column.map((section) => (
                        <DealtSectionBlock
                          key={section.label}
                          section={section}
                          labelId={`${labelBase}-${section.index}`}
                          countRef={counts.ref(section.index)}
                          still={still}
                          arc={!still && pages.length <= ARC_LIMIT}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <ul aria-label="Child pages" className="flex flex-wrap gap-1.5">
                  {pages.map((page, index) => (
                    <HeapChip
                      key={page.id}
                      page={page}
                      index={index}
                      still={still}
                    />
                  ))}
                </ul>
              )}
            </div>
          </DialogBody>

          {/* Footer of the twin (page-move-dialog): no hairline over the fade
              scroller, quiet beside ink, and the refusal above both. */}
          <div className="px-5 pb-4 pt-3">
            {applyError && (
              <p role="alert" className="mb-2 text-[12px] text-ink-2">
                {applyError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="quiet"
                disabled={applying}
                onClick={onCancel}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="ink"
                /* An answer with nothing in it (a page whose children went
                   between the press and the response) would write an empty
                   body, so there is nothing to press. */
                disabled={applying || !sections}
                onClick={onApply}
              >
                {applying ? "Applying…" : "Apply"}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** One section of the answer: the label with its count, the hairline the
 *  document draws under an `h2`, and the tiles. The header lands before the
 *  chips do and at full height — a header opening on `height: auto` would
 *  keep moving the boxes the chips are flying toward, and framer measures
 *  those once. */
function DealtSectionBlock({
  section,
  labelId,
  countRef,
  still,
  arc,
}: {
  section: DealtSection;
  labelId: string;
  countRef: (element: HTMLSpanElement | null) => void;
  still: boolean;
  arc: boolean;
}) {
  const delay = still ? 0 : 0.05 * section.index;
  return (
    <div>
      <motion.p
        id={labelId}
        className="text-label pb-1.5 text-ink-3"
        initial={still ? { opacity: 0 } : { opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={
          still
            ? { duration: DUR.fast }
            : { duration: DUR.base, ease: EASE_OUT, delay }
        }
      >
        {section.label} ·{" "}
        <span ref={countRef} className="tabular-nums">
          {section.chips.length}
        </span>
      </motion.p>
      {/* The hairline draws rather than appears, which is what makes a
          section read as closed instead of as text that turned up. */}
      <motion.div
        aria-hidden
        className="mb-2 h-px origin-left bg-line"
        initial={still ? { opacity: 0 } : { scaleX: 0 }}
        animate={still ? { opacity: 1 } : { scaleX: 1 }}
        transition={
          still
            ? { duration: DUR.fast }
            : { duration: DUR.page, ease: EASE_OUT, delay: delay + 0.06 }
        }
      />
      <ul aria-labelledby={labelId} className="flex flex-wrap gap-1.5">
        {section.chips.map(({ page, arrival }) => (
          <DealtChip
            key={page.id}
            page={page}
            arrival={arrival}
            still={still}
            arc={arc}
          />
        ))}
      </ul>
    </div>
  );
}

/** One page as a tile, and only that. This proposal is read, not operated —
 *  a page that landed wrong is fixed in the document afterwards, where drag
 *  already works — so the chips take the `.chip` treatment from globals.css
 *  without the atom's button semantics: sixty-one controls with nothing
 *  behind them would be sixty-one dead tab stops and sixty-one announcements
 *  for a keyboard path that leads nowhere. `components/ui/chip.tsx` is
 *  untouched; the visual contract is the class, and `data-static` drops the
 *  pointer and the press that only a control should have. */
function ChipFace({ page }: { page: TreeNode }) {
  return (
    <>
      <span className="chip-glyph" aria-hidden>
        {page.icon ?? DEFAULT_PAGE_ICON}
      </span>
      <span className="truncate">{page.title || "Untitled page"}</span>
    </>
  );
}

/** The pile, before the answer. The entrance is `materialize`'s own spring
 *  with no `y`: a vertical offset inside a wrapped flow reads as jitter
 *  rather than as a row falling in, and scale from a tile's own centre is
 *  what a tile arrives on. The stagger is capped in time, not at an index —
 *  sixty-one chips with the mail list's `index >= 8 ? 0` would deal eight and
 *  dump the rest in one frame. Scale sits on the inner node because the outer
 *  one is projection-managed and the two would fight. */
function HeapChip({
  page,
  index,
  still,
}: {
  page: TreeNode;
  index: number;
  still: boolean;
}) {
  const enter = still
    ? { duration: DUR.fast }
    : { ...SPRING_MATERIALIZE, delay: Math.min(index * 0.012, 0.42) };
  return (
    <motion.li
      className="min-w-0"
      layout={!still}
      layoutId={still ? undefined : chipLayoutId(page.id)}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={enter}
    >
      <motion.span
        className="chip max-w-[220px]"
        data-static
        initial={still ? false : { scale: 0.96 }}
        animate={still ? undefined : { scale: 1 }}
        transition={enter}
      >
        <ChipFace page={page} />
      </motion.span>
    </motion.li>
  );
}

/** The same tile, arrived. It does not enter: it carries the heap chip's
 *  `layoutId`, so framer flows it from where it was standing to where it
 *  belongs. The stagger walks the final reading order, not the source order,
 *  so the deal reads as one section filling and then the next. */
function DealtChip({
  page,
  arrival,
  still,
  arc,
}: {
  page: TreeNode;
  arrival: number;
  still: boolean;
  arc: boolean;
}) {
  const delay = Math.min(0.018 * arrival, 0.36);
  return (
    <motion.li
      className="min-w-0"
      layout={!still}
      layoutId={still ? undefined : chipLayoutId(page.id)}
      initial={still ? { opacity: 0 } : false}
      animate={{ opacity: 1 }}
      transition={
        still
          ? { duration: DUR.fast }
          : { layout: { ...SPRING_DEAL, delay } }
      }
    >
      <motion.span
        className="chip max-w-[220px]"
        data-static
        /* The lift is z and the flight is xy, so they sit on different
           elements: both are projection-managed on a `layout` node and would
           fight for the same matrix. */
        animate={arc ? { scale: [1, 1.05, 1] } : undefined}
        transition={
          arc
            ? {
                duration: SPRING_DEAL.duration,
                times: [0, 0.3, 1],
                ease: EASE_OUT,
                delay,
              }
            : undefined
        }
      >
        <ChipFace page={page} />
      </motion.span>
    </motion.li>
  );
}

function sectionCount(count: number) {
  return count === 1 ? "1 section" : `${count} sections`;
}

function chipLayoutId(pageId: string) {
  return `smart-sort-chip-${pageId}`;
}

/** Every section's count off one clock, written straight to the DOM: three
 *  writes a frame rather than sixty-one re-renders. The clock runs the deal's
 *  own length and the sections take their turns off it in reading order, so
 *  each number races up and stops and the next one starts. It is a race
 *  alongside the chips, not a readout of them: it does not wait for a tile to
 *  land, and at sixty-one it is ahead of the first one. */
function useSectionCounts(dealt: DealtSection[] | null, still: boolean) {
  const arrived = useMotionValue(0);
  const spans = useRef<(HTMLSpanElement | null)[]>([]);
  const ranges = useMemo(() => {
    if (!dealt) return [];
    let start = 0;
    return dealt.map((section) => {
      const range = { start, size: section.chips.length };
      start += section.chips.length;
      return range;
    });
  }, [dealt]);
  const total = ranges.reduce((sum, range) => sum + range.size, 0);

  const paint = useCallback(
    (value: number) => {
      const landed = Math.round(value);
      ranges.forEach((range, index) => {
        const span = spans.current[index];
        if (!span) return;
        const shown = Math.max(0, Math.min(range.size, landed - range.start));
        const text = String(shown);
        if (span.textContent !== text) span.textContent = text;
      });
    },
    [ranges],
  );
  useMotionValueEvent(arrived, "change", paint);

  // Before paint, so the first frame of the deal shows an empty section
  // rather than its answer for one frame and then zero.
  useLayoutEffect(() => {
    if (!dealt) return;
    if (still) {
      arrived.set(total);
      paint(total);
      return;
    }
    arrived.set(0);
    paint(0);
  }, [arrived, dealt, paint, still, total]);

  useEffect(() => {
    if (!dealt || still) return;
    const controls = animate(arrived, total, {
      duration: DEAL_MS / 1000,
      ease: "linear",
    });
    return () => controls.stop();
  }, [arrived, dealt, still, total]);

  return {
    ref: (index: number) => (element: HTMLSpanElement | null) => {
      spans.current[index] = element;
    },
  };
}

/** The answer is a taller thing than the pile: the same tiles, one per line,
 *  under headers, in the two columns the document will use. This dialog is
 *  centred, so letting that land in one frame moves its top edge by about a
 *  hundred pixels while the chips are in the air — the reader's eye is pulled
 *  off the thing that is moving on purpose. So the box takes the growth as a
 *  height of its own, over `DUR.page` and the app's one ease, and the chips
 *  fly inside a frame that is opening rather than one that has jumped. The
 *  height is handed back to the content the moment it lands, so nothing here
 *  owns a number for longer than the animation.
 *
 *  A real height animation, not `layout`: `layout` corrects a height change
 *  with a scale and would stretch every title inside it. */
function useBodyHeight(still: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const previous = useRef(0);
  const growing = useRef<ReturnType<typeof setTimeout> | null>(null);
  // No dependency list on purpose. The measurement has to happen on the
  // commit the element appears (Radix mounts the Content on a commit of its
  // own, after the props that opened it) and on the commit the answer
  // replaces the pile, and those are not the same dependency.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) {
      previous.current = 0;
      return;
    }
    // A growth already running is where the box is now, so a second one
    // takes over from there rather than being refused by it.
    const live = growing.current ? element.getBoundingClientRect().height : 0;
    if (growing.current) {
      clearTimeout(growing.current);
      growing.current = null;
    }
    element.style.height = "";
    const to = element.getBoundingClientRect().height;
    const from = live || previous.current;
    previous.current = to;
    // A few pixels is the pile settling, not the answer arriving. Animating
    // that would arm the guard against the growth that matters.
    if (still || !from || Math.abs(to - from) < GROWTH_FLOOR) return;
    element.style.height = `${from}px`;
    void element.offsetHeight;
    element.style.height = `${to}px`;
    growing.current = setTimeout(() => {
      growing.current = null;
      element.style.height = "";
    }, DUR.page * 1000 + 40);
  });
  useEffect(
    () => () => {
      if (growing.current) clearTimeout(growing.current);
    },
    [],
  );
  return ref;
}

/** A media query read on the first render, not corrected on the second: the
 *  frame this dialog opens on is the one that decides whether the pile deals
 *  in or crossfades, and a phone must not paint the desktop entrance once
 *  before settling. */
function useMediaQuery(query: string) {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(query);
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    },
    [query],
  );
  const read = useCallback(
    () =>
      typeof window.matchMedia === "function"
        ? window.matchMedia(query).matches
        : false,
    [query],
  );
  return useSyncExternalStore(subscribe, read, () => false);
}
