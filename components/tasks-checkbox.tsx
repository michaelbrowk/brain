"use client";

import { animate } from "framer-motion/dom";

import { EASE_OUT, PRESS_ICON, SPRING_MATERIALIZE } from "@/lib/motion";

/** The one checkbox drawing. The note editor mounts it from a ProseMirror
 *  NodeView; the Tasks surface mounts the same object from React. It returns
 *  DOM rather than JSX so a NodeView can own it directly, and the box, the
 *  stroke and every timing live here so the two surfaces cannot drift apart.
 *
 *  The check is a stroked path driven by `stroke-dashoffset`, not a rotated
 *  box scaled into view. Completion on the Tasks surface draws the same
 *  stroke, and a draw has to be interruptible mid-flight, which a CSS
 *  transition cannot be from an arbitrary point, so the dash runs on WAAPI.
 *  Only the fill is a transition: it is colour, not movement. */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Dash length of the tick. The path measures about 13, so an offset of DASH
 *  hides the whole stroke and an offset of 0 has it fully drawn. */
const DASH = 14;
/** The tick inside a 16 box, inset so a 2px round cap never touches an edge. */
const TICK = "M3.5 8.5L6.5 11.5L12.5 5";

const DRAW_MS = 200;
const ERASE_MS = 120;
const FADE_MS = 120;
/** The fill leads, the check follows into a box that is already ink. */
const CHECK_DELAY_MS = 60;

const EASE = `cubic-bezier(${EASE_OUT.join(", ")})`;

export interface TaskCheckboxOptions {
  checked: boolean;
  onToggle?: () => void;
  reduce: boolean;
}

/** Read once per call at the call site, so a reader who changes the setting
 *  mid-session gets the new behaviour on the next press. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const ticks = new WeakMap<HTMLButtonElement, SVGPathElement>();
const running = new WeakMap<HTMLButtonElement, Animation>();

/** jsdom and any browser without WAAPI get the resting state and no motion. */
function canAnimate(node: Element): boolean {
  return typeof (node as Element & { animate?: unknown }).animate === "function";
}

function rest(tick: SVGPathElement, checked: boolean) {
  tick.style.strokeDashoffset = checked ? "0" : String(DASH);
  tick.style.opacity = "1";
}

function draw(button: HTMLButtonElement, checked: boolean, reduce: boolean, animated: boolean) {
  const tick = ticks.get(button);
  if (!tick) return;
  running.get(button)?.cancel();
  running.delete(button);
  rest(tick, checked);
  if (!animated || !canAnimate(tick)) return;

  // Under reduced motion the stroke is held fully drawn and crossfaded, so
  // nothing travels. The fill stays either way: it is colour, not movement.
  const frames = reduce
    ? [
        { strokeDashoffset: 0, opacity: checked ? 0 : 1 },
        { strokeDashoffset: 0, opacity: checked ? 1 : 0 },
      ]
    : [{ strokeDashoffset: checked ? DASH : 0 }, { strokeDashoffset: checked ? 0 : DASH }];
  const options: KeyframeAnimationOptions = reduce
    ? { duration: FADE_MS, easing: EASE, fill: "backwards" }
    : checked
      ? { duration: DRAW_MS, easing: EASE, delay: CHECK_DELAY_MS, fill: "backwards" }
      : { duration: ERASE_MS, easing: "ease-in" };

  running.set(button, tick.animate(frames, options));
}

/** Repaint an existing control. Use this rather than a second render: the
 *  transition between the two states is the drawing, and a fresh element
 *  would start it from nothing. */
export function setTaskCheckboxChecked(
  button: HTMLButtonElement,
  checked: boolean,
  reduce: boolean,
): void {
  if (button.getAttribute("aria-checked") === String(checked)) return;
  button.setAttribute("aria-checked", String(checked));
  draw(button, checked, reduce, true);
}

/** The label is the item's own text, so a reader hears what is being ticked
 *  instead of the word checkbox. */
export function setTaskCheckboxLabel(button: HTMLButtonElement, label: string): void {
  button.setAttribute("aria-label", label.trim() || "Empty task");
}

export function renderTaskCheckbox(opts: TaskCheckboxOptions): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "brain-task-box brain-touch-min";
  button.setAttribute("role", "checkbox");
  button.setAttribute("aria-checked", String(opts.checked));
  button.tabIndex = 0;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");

  const tick = document.createElementNS(SVG_NS, "path");
  tick.setAttribute("d", TICK);
  tick.setAttribute("stroke", "var(--paper)");
  tick.setAttribute("stroke-width", "2");
  tick.setAttribute("stroke-linecap", "round");
  tick.setAttribute("stroke-linejoin", "round");
  tick.setAttribute("stroke-dasharray", String(DASH));

  svg.append(tick);
  button.append(svg);
  ticks.set(button, tick);
  draw(button, opts.checked, opts.reduce, false);

  const toggle = () => opts.onToggle?.();

  // The press answers pointer-down, the way every other control here does.
  // `pressed` is what keeps a pointer crossing a list of tasks from springing
  // every box it passes over, since pointer-leave fires on all of them.
  let pressed = false;
  button.addEventListener("pointerdown", () => {
    if (opts.reduce || !canAnimate(button)) return;
    pressed = true;
    animate(button, { scale: PRESS_ICON.scale }, { duration: PRESS_ICON.duration, ease: EASE_OUT });
  });
  const release = () => {
    if (!pressed) return;
    pressed = false;
    animate(button, { scale: 1 }, SPRING_MATERIALIZE);
  };
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("pointerleave", release);

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggle();
  });

  // A focused button already turns Enter and Space into a click, but this one
  // sits inside a contenteditable region: an unhandled Space reaches the
  // editor and types one. Cancelling the key event cancels the browser's own
  // activation with it, so the toggle has to be made here.
  button.addEventListener("keydown", (event) => {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    event.stopPropagation();
    toggle();
  });

  return button;
}
