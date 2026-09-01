"use client";

import { useState } from "react";

/** Inline tags in the page-header meta row — the same pills a board card
 *  shows, so a card opened as a page keeps its tags visible and editable.
 *  `canAdd` gates the "+ Tag" affordance to pages that live on a board;
 *  ordinary pages only render pills they already have. */
export function TagRow({
  tags,
  canAdd,
  onSet,
  revealClass = "",
}: {
  tags: string[];
  canAdd: boolean;
  onSet: (tags: string[]) => void;
  /** hides the "+ Tag" affordance until the header is hovered; set tag pills
   *  stay visible */
  revealClass?: string;
}) {
  const [adding, setAdding] = useState(false);

  const commit = (value: string) => {
    const t = value.trim();
    if (t && !tags.includes(t)) onSet([...tags, t]);
    setAdding(false);
  };

  if (!tags.length && !canAdd) return null;

  return (
    <>
      {tags.map((t) => (
        <button
          key={t}
          onClick={() => onSet(tags.filter((x) => x !== t))}
          title="Remove tag"
          className="brain-touch-min flex shrink-0 items-center rounded-full bg-fill-active px-2 py-0.5 text-[12px] text-ink-2 transition-colors hover:text-ink"
        >
          {t}
        </button>
      ))}
      {canAdd &&
        (adding ? (
          <input
            autoFocus
            aria-label="Tag name"
            placeholder="tag"
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
              if (e.key === "Escape") setAdding(false);
            }}
            className="w-16 shrink-0 appearance-none rounded-full bg-fill-active px-2 py-0.5 text-[12px] text-ink outline-none placeholder:text-ink-3 max-md:text-[16px]"
          />
        ) : (
          <button
            onClick={() => setAdding(true)}
            className={`brain-touch-min shrink-0 rounded-full px-2 py-0.5 text-[12px] text-ink-3 transition-colors hover:bg-fill-hover hover:text-ink-2 ${revealClass}`}
          >
            + Tag
          </button>
        ))}
    </>
  );
}
