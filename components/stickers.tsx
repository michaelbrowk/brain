"use client";

import { useEffect, useState } from "react";
import {
  AnimatePresence,
  motion,
  useDragControls,
  useMotionValue,
  useReducedMotion,
  type MotionStyle,
} from "framer-motion";
import { nanoid } from "nanoid";
import type { Sticker } from "@/lib/store/types";
import { DUR, fade, pop } from "@/lib/motion";
import { Icon } from "./ui/icon";

/** Post-it stickers pinned on the page (desktop: absolute + draggable;
 *  mobile renders them inline above the content). Stored in frontmatter. */

export function newSticker(): Sticker {
  return { id: nanoid(8), x: 40, y: 40, text: "" };
}

const PRINT_STICKER_MIN_HEIGHT = 100;
const PRINT_STICKER_LINE_HEIGHT = 21;
const PRINT_STICKER_CHARS_PER_LINE = 10;

function stickerPrintHeight(text: string): number {
  const lines = text.split("\n").reduce((count, line) => {
    return (
      count +
      Math.max(1, Math.ceil(Array.from(line).length / PRINT_STICKER_CHARS_PER_LINE))
    );
  }, 0);
  return Math.max(PRINT_STICKER_MIN_HEIGHT, 24 + lines * PRINT_STICKER_LINE_HEIGHT);
}

/** Keep the printable article tall enough for absolutely positioned stickers
 *  without moving the page header or body. The estimate is deliberately
 *  conservative so wrapped/CJK text has room in the print-only mirror. */
export function stickerPrintCanvasHeight(stickers: Sticker[]): number {
  return stickers.reduce(
    (bottom, sticker) => Math.max(bottom, sticker.y + stickerPrintHeight(sticker.text)),
    0,
  );
}

export function StickersLayer({
  stickers,
  onChange,
}: {
  stickers: Sticker[];
  onChange: (next: Sticker[]) => void;
}) {
  const reduce = useReducedMotion();

  const update = (id: string, patch: Partial<Sticker>) =>
    onChange(stickers.map((s) => (s.id === id ? { ...s, ...patch } : s)));

  return (
    <div className="brain-stickers-layer pointer-events-none absolute inset-0 z-[var(--z-stickers)] hidden md:block">
      <AnimatePresence initial={false}>
        {stickers.map((s) => (
          <StickerCard
            key={s.id}
            sticker={s}
            reduce={!!reduce}
            onText={(text) => update(s.id, { text })}
            onMove={(x, y) => update(s.id, { x, y })}
            onDelete={() => onChange(stickers.filter((x) => x.id !== s.id))}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

/** One post-it. The drag rides framer's x/y motion values (compositor-only
 *  transform, zero React renders per pointer move); the committed position is
 *  left/top. On drag end both are swapped in the same framer frame — left/top
 *  absorb the travel, x/y return to 0 — and the frontmatter is written once.
 *  Print keeps reading the committed position through the CSS variables. */
function StickerCard({
  sticker,
  reduce,
  onText,
  onMove,
  onDelete,
}: {
  sticker: Sticker;
  reduce: boolean;
  onText: (text: string) => void;
  onMove: (x: number, y: number) => void;
  onDelete: () => void;
}) {
  const dragControls = useDragControls();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const left = useMotionValue(sticker.x);
  const top = useMotionValue(sticker.y);
  const [dragging, setDragging] = useState(false);
  const presence = reduce ? fade : pop;

  // external moves (draft recovery, another client) land on the rest position
  useEffect(() => {
    left.set(sticker.x);
    top.set(sticker.y);
  }, [left, top, sticker.x, sticker.y]);

  return (
    <motion.div
      {...presence}
      drag
      dragControls={dragControls}
      dragListener={false}
      dragMomentum={false}
      dragElastic={0}
      dragConstraints={{ left: -sticker.x, top: -sticker.y }}
      whileDrag={reduce ? undefined : { scale: 1.03 }}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => {
        // framer starts a zero-velocity settle on x/y at release — stop it so
        // the swap below is the only write this frame
        x.stop();
        y.stop();
        const nextX = Math.max(0, Math.round(left.get() + x.get()));
        const nextY = Math.max(0, Math.round(top.get() + y.get()));
        left.set(nextX);
        top.set(nextY);
        x.set(0);
        y.set(0);
        setDragging(false);
        if (nextX !== sticker.x || nextY !== sticker.y) onMove(nextX, nextY);
      }}
      style={
        {
          left,
          top,
          x,
          y,
          rotate: -1,
          "--brain-sticker-x": `${sticker.x}px`,
          "--brain-sticker-y": `${sticker.y}px`,
        } as MotionStyle
      }
      className="brain-sticker group/st pointer-events-auto absolute w-[180px]"
    >
      {/* the sticker rests on its own warm shadow (an object on the desk,
          DESIGN.md v2 → Elevation); the drag adds the lift on top */}
      <motion.span
        aria-hidden
        initial={false}
        animate={{ opacity: dragging ? 1 : 0 }}
        transition={{ duration: DUR.fast }}
        className="pointer-events-none absolute inset-0 rounded-sticker shadow-[var(--lift)]"
      />
      {/* drag strip: Label 11 header with a dot */}
      <div
        onPointerDown={(e) => {
          e.preventDefault();
          dragControls.start(e);
        }}
        className="brain-sticker-chrome relative flex h-7 cursor-grab touch-none select-none items-center justify-between pl-3 pr-1.5 active:cursor-grabbing"
      >
        <span className="brain-sticker-label">Note</span>
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onDelete}
          aria-label="Delete sticker"
          className="brain-touch-min grid size-5 place-items-center rounded-full text-[var(--sticker-ink)] opacity-0 transition-[opacity,background-color,transform] duration-[80ms] hover:bg-[var(--sticker-ink)]/10 active:scale-90 group-hover/st:opacity-100 group-focus-within/st:opacity-100 motion-reduce:active:scale-100"
        >
          <Icon name="close-linear" size={13} />
        </button>
      </div>
      <textarea
        aria-label="Sticker text"
        value={sticker.text}
        onChange={(e) => onText(e.target.value)}
        placeholder="Note…"
        rows={3}
        className="brain-sticker-editor relative w-full resize-none bg-transparent px-3 pb-3 font-mono text-[12.5px] leading-relaxed text-[var(--sticker-ink)] outline-none placeholder:text-[var(--sticker-ink)]/65"
      />
      <div
        aria-hidden
        className="brain-sticker-print-text hidden whitespace-pre-wrap break-words px-3 py-3 font-mono text-[12.5px] leading-relaxed text-[var(--sticker-ink)]"
      >
        {sticker.text}
      </div>
    </motion.div>
  );
}

/** Mobile view — the draggable post-it doesn't work on touch, so stickers show
 *  inline above the content and are fully editable + deletable here. */
export function StickersInline({
  stickers,
  onChange,
}: {
  stickers: Sticker[];
  onChange: (next: Sticker[]) => void;
}) {
  if (!stickers.length) return null;
  const update = (id: string, patch: Partial<Sticker>) =>
    onChange(stickers.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  return (
    <div className="brain-stickers-inline mb-5 space-y-2 md:hidden">
      {stickers.map((s) => (
        <div key={s.id} className="brain-sticker-inline">
          <div className="flex items-center justify-between pl-3 pr-1 pt-1">
            <span className="brain-sticker-label">Note</span>
            <button
              onClick={() => onChange(stickers.filter((x) => x.id !== s.id))}
              aria-label="Delete sticker"
              className="grid size-8 place-items-center rounded-full text-[var(--sticker-ink)] active:bg-[var(--sticker-ink)]/10"
            >
              <Icon name="close-linear" size={16} />
            </button>
          </div>
          <textarea
            aria-label="Sticker text"
            value={s.text}
            onChange={(e) => update(s.id, { text: e.target.value })}
            placeholder="Note…"
            rows={3}
            className="w-full resize-none bg-transparent px-3 pb-3 font-mono text-[13px] leading-relaxed text-[var(--sticker-ink)] outline-none placeholder:text-[var(--sticker-ink)]/65"
          />
        </div>
      ))}
    </div>
  );
}
