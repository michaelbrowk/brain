/**
 * How the mail column moves when a New senders decision rearranges it.
 *
 * A decision changes which section a row stands in, and a React tree cannot
 * move an element from one section to another: the row unmounts under New
 * senders and mounts again under People. So the column is measured before the
 * change and again after it, and what moved is played back from where it was
 * (FLIP): the decided row travels to its new place on `TRAVEL`, everything it
 * leaves behind closes up on `TRAVEL_NEIGHBOUR`, and what leaves the column
 * leaves as a ghost, a copy of its last frame, since the real node is already
 * gone. The Web Animations API drives all of it on the compositor, and a
 * browser (or a test's DOM) without it simply shows the new arrangement.
 *
 * Every element that takes part carries `data-flip` with a key that names
 * the same thing before and after: `row:<account>:<thread>` for a row and
 * `section:<name>` for a group. A row's own movement is played relative to
 * its section's, since the section's transform already carries it that far.
 * Keys are compared as strings and never put into a selector, so no escaping
 * rule can make two of them meet.
 *
 * Reduced motion keeps opacity and nothing else, 120ms: nothing travels,
 * ghosts and returning rows fade where they stand.
 */

import { DUR, EASE_DRAWER, EASE_OUT, SLIDE_OUT, TRAVEL, TRAVEL_NEIGHBOUR } from "@/lib/motion";

export type FlipSnapshot = ReadonlyMap<
  string,
  { readonly left: number; readonly top: number }
>;

const FLIP = "[data-flip]";

/** How far a row rises as it enters the merged list (`UnifiedRow`'s `y: 4`). */
const ROW_RISE = 4;

function cubic(curve: readonly number[]): string {
  return `cubic-bezier(${curve.join(", ")})`;
}

function canAnimate(element: Element): element is HTMLElement {
  return element instanceof HTMLElement && typeof element.animate === "function";
}

/** A row's key. An account id carries no colon and a thread id is a safe
 *  resource id, so the pair cannot be read two ways. */
export function flipRowKey(item: {
  readonly accountId: string;
  readonly threadId: string;
}): string {
  return `row:${item.accountId}:${item.threadId}`;
}

/** The elements that carry one of these keys, first of each. */
export function flipElements(
  root: ParentNode,
  keys: ReadonlySet<string>,
): HTMLElement[] {
  const found = new Map<string, HTMLElement>();
  for (const element of root.querySelectorAll<HTMLElement>(FLIP)) {
    const key = element.dataset.flip;
    if (key && keys.has(key) && !found.has(key)) found.set(key, element);
  }
  return [...found.values()];
}

/**
 * Takes the keyboard focus off a row that is about to leave its place, before
 * it goes: a focused node that unmounts drops the focus on the body, and the
 * next Tab starts from the top of the page. It lands on the same control of
 * the next waiting row (Accept on Accept, Block on Block, the row on the
 * row), else on the next row the column keeps, else on any row it keeps,
 * else on the column itself.
 */
export function handFocusOn(root: HTMLElement, leaving: ReadonlySet<string>): void {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !root.contains(active)) return;
  const row = active.closest<HTMLElement>('[data-flip^="row:"]');
  if (!row || !leaving.has(row.dataset.flip ?? "")) return;
  const control = active.closest<HTMLElement>("[data-gate]")?.dataset.gate ?? null;
  const rows = [...root.querySelectorAll<HTMLElement>('[data-flip^="row:"]')];
  const kept = (candidate: HTMLElement) => !leaving.has(candidate.dataset.flip ?? "");
  const after = rows.slice(rows.indexOf(row) + 1).filter(kept);
  const nextWaiting = after.find((candidate) => candidate.hasAttribute("data-waiting"));
  const target =
    (nextWaiting &&
      (control
        ? nextWaiting.querySelector<HTMLElement>(`[data-gate="${control}"]`)
        : nextWaiting.querySelector<HTMLElement>("button.brain-mail-row"))) ??
    after[0]?.querySelector<HTMLElement>("button.brain-mail-row") ??
    rows.filter(kept)[0]?.querySelector<HTMLElement>("button.brain-mail-row") ??
    root;
  target.focus({ preventScroll: true });
}

/** Where every flipping element stands now. */
export function snapshotFlip(root: ParentNode): FlipSnapshot {
  const rects = new Map<string, { readonly left: number; readonly top: number }>();
  for (const element of root.querySelectorAll<HTMLElement>(FLIP)) {
    const key = element.dataset.flip;
    if (!key || rects.has(key)) continue;
    const rect = element.getBoundingClientRect();
    rects.set(key, { left: rect.left, top: rect.top });
  }
  return rects;
}

/**
 * Copies of what is about to leave, drawn where it stands and faded out after
 * the change: `left` slides it away as a Block does, `fade` only fades.
 * Taken BEFORE the change, while the nodes still exist, and let go after it.
 */
export function ghostFlip(
  root: HTMLElement,
  elements: readonly HTMLElement[],
  mode: "left" | "fade",
  reduce: boolean,
): () => void {
  const host = root.getBoundingClientRect();
  const ghosts: HTMLElement[] = [];
  for (const element of elements) {
    if (!canAnimate(element)) continue;
    const rect = element.getBoundingClientRect();
    const ghost = element.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-flip");
    for (const inner of ghost.querySelectorAll("[data-flip]")) {
      inner.removeAttribute("data-flip");
    }
    ghost.setAttribute("aria-hidden", "true");
    ghost.inert = true;
    Object.assign(ghost.style, {
      position: "absolute",
      left: `${rect.left - host.left}px`,
      top: `${rect.top - host.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: "0",
      pointerEvents: "none",
    });
    ghosts.push(ghost);
  }
  return () => {
    for (const ghost of ghosts) {
      root.append(ghost);
      const width = Number.parseFloat(ghost.style.width) || 0;
      const slide = mode === "left" && !reduce;
      const animation = ghost.animate(
        slide
          ? [
              { transform: "none", opacity: 1 },
              { transform: `translateX(${-width * SLIDE_OUT.distance}px)`, opacity: 0 },
            ]
          : [{ opacity: 1 }, { opacity: 0 }],
        {
          duration: (slide ? SLIDE_OUT.duration : DUR.fast) * 1000,
          easing: cubic(EASE_OUT),
          fill: "forwards",
        },
      );
      void animation.finished.then(
        () => ghost.remove(),
        () => ghost.remove(),
      );
    }
  };
}

/**
 * Plays the change back. `travel` names the rows that changed sections (they
 * lift and take the longer curve), `arrive` the rows that should flash the
 * selection tint once they land, and `enter` the keys that come back into the
 * column, which slide in from the left they left by. `rise` names keys that
 * come back after leaving on a fade, as a section's Done takes them: they
 * rise the 4px a row rises when it enters the list, on the same `DUR.fast`.
 */
export function playFlip(
  root: ParentNode,
  before: FlipSnapshot,
  options: {
    readonly travel?: ReadonlySet<string>;
    readonly arrive?: ReadonlySet<string>;
    readonly enter?: ReadonlySet<string>;
    readonly rise?: ReadonlySet<string>;
    readonly reduce: boolean;
  },
): void {
  const travel = options.travel ?? new Set<string>();
  const arrive = options.arrive ?? new Set<string>();
  const enter = options.enter ?? new Set<string>();
  const rise = options.rise ?? new Set<string>();
  const after = new Map<string, { element: HTMLElement; rect: DOMRect }>();
  for (const element of root.querySelectorAll<HTMLElement>(FLIP)) {
    const key = element.dataset.flip;
    if (key && !after.has(key)) {
      after.set(key, { element, rect: element.getBoundingClientRect() });
    }
  }
  for (const [key, { element, rect }] of after) {
    if (!canAnimate(element)) continue;
    const from = before.get(key);
    if (from === undefined) {
      if (rise.has(key)) {
        element.animate(
          options.reduce
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                { opacity: 0, transform: `translateY(${ROW_RISE}px)` },
                { opacity: 1, transform: "none" },
              ],
          { duration: DUR.fast * 1000, easing: cubic(EASE_OUT) },
        );
        continue;
      }
      if (!enter.has(key)) continue;
      element.animate(
        options.reduce
          ? [{ opacity: 0 }, { opacity: 1 }]
          : [
              {
                opacity: 0,
                transform: `translateX(${-rect.width * SLIDE_OUT.distance * 0.5}px)`,
              },
              { opacity: 1, transform: "none" },
            ],
        {
          duration: (options.reduce ? DUR.fast : SLIDE_OUT.duration) * 1000,
          easing: cubic(EASE_OUT),
        },
      );
      if (arrive.has(key)) markArrived(element);
      continue;
    }
    let dx = from.left - rect.left;
    let dy = from.top - rect.top;
    const parent = element.parentElement?.closest<HTMLElement>(FLIP) ?? null;
    const parentKey = parent?.dataset.flip;
    if (parent && parentKey) {
      const parentFrom = before.get(parentKey);
      const parentAfter = after.get(parentKey);
      if (parentFrom && parentAfter?.element === parent) {
        dx -= parentFrom.left - parentAfter.rect.left;
        dy -= parentFrom.top - parentAfter.rect.top;
      }
    }
    const moved = Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5;
    if (!moved || options.reduce) {
      if (arrive.has(key)) markArrived(element);
      continue;
    }
    const travelling = travel.has(key);
    if (travelling) element.dataset.travelling = "";
    const curve = travelling ? TRAVEL : TRAVEL_NEIGHBOUR;
    const animation = element.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
      { duration: curve.duration * 1000, easing: cubic(EASE_DRAWER) },
    );
    void animation.finished.then(
      () => {
        delete element.dataset.travelling;
        if (arrive.has(key)) markArrived(element);
      },
      () => {
        delete element.dataset.travelling;
      },
    );
  }
}

/** The arriving row wears the selection tint for a moment and lets it go
 *  (`mail-row-arrive` in globals.css): here is where it went. */
function markArrived(element: HTMLElement) {
  // The open letter already wears the tint, and for good.
  if (element.querySelector('[aria-current="true"]')) return;
  element.dataset.arrived = "";
  element.addEventListener(
    "animationend",
    () => {
      delete element.dataset.arrived;
    },
    { once: true },
  );
}
