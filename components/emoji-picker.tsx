"use client";

import * as Popover from "@radix-ui/react-popover";
import { useEffect, useMemo, useState } from "react";
import { Field } from "./ui/field";
import { Skeleton } from "./ui/primitives";
import { ScrollEdge } from "./ui/scroll-edge";

interface EmojiEntry {
  emoji: string;
  name: string;
}
interface EmojiGroup {
  name: string;
  emojis: EmojiEntry[];
}

// the full unicode set (~1900) loads lazily on first open — not in the bundle
let cache: EmojiGroup[] | null = null;
async function loadEmojis(): Promise<EmojiGroup[]> {
  if (cache) return cache;
  const mod = await import("unicode-emoji-json/data-by-group.json");
  const raw = (mod.default ?? mod) as unknown as { name: string; emojis: EmojiEntry[] }[];
  cache = raw.map((g) => ({
    name: g.name,
    emojis: g.emojis.map((e) => ({ emoji: e.emoji, name: e.name })),
  }));
  return cache;
}

export function EmojiPicker({
  children,
  onPick,
  onRemove,
  hasIcon = false,
}: {
  children: React.ReactNode;
  onPick: (emoji: string) => void;
  onRemove: () => void;
  hasIcon?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<EmojiGroup[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (open && !groups) loadEmojis().then(setGroups);
  }, [open, groups]);

  const setPickerOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) setQuery("");
  };

  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!groups || !q) return null;
    const out: EmojiEntry[] = [];
    for (const g of groups) {
      for (const e of g.emojis) {
        if (e.name.toLowerCase().includes(q)) {
          out.push(e);
          if (out.length >= 96) return out;
        }
      }
    }
    return out;
  }, [groups, q]);

  const pick = (emoji: string) => {
    onPick(emoji);
    setPickerOpen(false);
  };

  return (
    <Popover.Root open={open} onOpenChange={setPickerOpen}>
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      {/* regular material r14 (.brain-menu); materializes on Radix's
          data-state and retraces on close — Radix keeps the panel mounted for
          the exit keyframe (the picker canon shared with category and the
          menus). The grid scrolls under an edge-fade; group names are Label
          11, sentence case. */}
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={16}
          className="brain-menu z-[var(--z-modal)] w-[min(calc(100vw-2rem),324px)]"
        >
          <Field
            on="glass"
            icon="magnifer"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setPickerOpen(false);
              if (e.key === "Enter") {
                const first = results?.[0];
                if (q && first) pick(first.emoji);
              }
            }}
            placeholder="Search emoji…"
            aria-label="Search emoji"
          />

          <ScrollEdge
            variant="fade"
            className="mt-1.5 max-h-[min(288px,calc(var(--radix-popover-content-available-height)-96px))] min-h-[144px] overscroll-contain"
          >
            {!groups && (
              <div>
                <div className="h-[27px] px-1 pt-2">
                  <Skeleton className="h-3 w-24" />
                </div>
                <div className="grid grid-cols-8">
                  {Array.from({ length: 64 }).map((_, i) => (
                    <div key={i} className="aspect-square w-full p-[3px]">
                      <Skeleton className="size-full" />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {groups && results && (
              <>
                {results.length === 0 && (
                  <p className="text-caption px-2 py-8 text-center font-medium text-ink-2">
                    No emoji for “{query.trim()}”
                  </p>
                )}
                <div className="grid grid-cols-8">
                  {results.map((e) => (
                    <EmojiCell key={e.emoji} entry={e} onPick={pick} />
                  ))}
                </div>
              </>
            )}

            {groups &&
              !results &&
              groups.map((g) => (
                <div
                  key={g.name}
                  style={{
                    contentVisibility: "auto",
                    containIntrinsicSize: `auto ${27 + Math.ceil(g.emojis.length / 8) * 36}px`,
                  }}
                >
                  <p className="brain-menu-label pt-2">{g.name}</p>
                  <div className="grid grid-cols-8">
                    {g.emojis.map((e) => (
                      <EmojiCell key={e.emoji} entry={e} onPick={pick} />
                    ))}
                  </div>
                </div>
              ))}
          </ScrollEdge>

          {hasIcon && (
            <>
              <div className="brain-menu-sep" />
              <Popover.Close onClick={onRemove} className="brain-menu-item w-full text-ink-2">
                Remove icon
              </Popover.Close>
            </>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function EmojiCell({
  entry,
  onPick,
}: {
  entry: EmojiEntry;
  onPick: (emoji: string) => void;
}) {
  return (
    <button
      title={entry.name}
      aria-label={entry.name}
      onClick={() => onPick(entry.emoji)}
      className="grid aspect-square w-full place-items-center rounded-block text-[19px] transition-[background-color,transform] duration-[80ms] hover:bg-[var(--fill-glass-hover)] active:scale-90 motion-reduce:active:scale-100"
    >
      {entry.emoji}
    </button>
  );
}
