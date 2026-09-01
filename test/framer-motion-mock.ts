// Shared framer-motion stub for vitest.
//
// Every `motion.<tag>` renders the plain DOM element with the framer props
// stripped, `AnimatePresence` renders its children, `useReducedMotion`
// returns a fixed value. Animation playback is never under test here — only
// structure and the props the components hand to framer.
//
// Default usage (no options):
//
//   vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));
//
// When a test needs to inspect motion props or control reduced-motion:
//
//   vi.mock("framer-motion", async () => {
//     const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
//     return createFramerMotionMock({
//       reducedMotion: () => harness.reduce,
//       onRender: ({ tag, motion }) => { if (tag === "span") harness.spans.push(motion); },
//     });
//   });

import {
  createElement,
  forwardRef,
  type ElementType,
  type ForwardRefExoticComponent,
  type ReactNode,
  type RefAttributes,
} from "react";

/** The framer props the stub removes before the element reaches the DOM. */
export const MOTION_PROP_NAMES = [
  "initial",
  "animate",
  "exit",
  "transition",
  "layout",
  "layoutId",
  "whileHover",
  "whileTap",
  "onAnimationComplete",
  "drag",
  "dragControls",
  "dragListener",
  "dragConstraints",
  "dragElastic",
  "dragMomentum",
  "onDragStart",
  "onDrag",
  "onDragEnd",
] as const;

export type MotionPropName = (typeof MOTION_PROP_NAMES)[number];

/** The stripped framer props of one render, keyed by prop name. */
export type MotionProps = Partial<Record<MotionPropName, unknown>>;

export interface MotionRender {
  /** The HTML tag (`"div"`, `"span"`, …). */
  tag: string;
  /** The framer props removed from this render. */
  motion: MotionProps;
  /** The remaining props, the ones that reach the DOM element. */
  props: Record<string, unknown>;
}

export interface AnimatePresenceProps {
  children?: ReactNode;
  mode?: string;
  initial?: boolean;
}

export interface FramerMotionMockOptions {
  /** What `useReducedMotion()` returns. A function is read on every call. Default `true`. */
  reducedMotion?: boolean | (() => boolean);
  /**
   * Runs in the body of every stubbed motion element on every render — so
   * React hooks are allowed — and may return extra DOM props (for example
   * `data-*` attributes that surface a framer prop for assertions).
   */
  onRender?: (render: MotionRender) => Record<string, unknown> | void;
  /** Replaces the passthrough `AnimatePresence`. */
  AnimatePresence?: (props: AnimatePresenceProps) => ReactNode;
}

type MotionComponent = ForwardRefExoticComponent<
  Record<string, unknown> & RefAttributes<HTMLElement>
>;

export interface FramerMotionMock {
  motion: Record<string, MotionComponent>;
  AnimatePresence: (props: AnimatePresenceProps) => ReactNode;
  useReducedMotion: () => boolean;
  useDragControls: () => DragControlsStub;
  useMotionValue: <T>(initial: T) => MotionValueStub<T>;
  animate: (...args: unknown[]) => { stop: () => void };
}

/** Enough of framer's DragControls for a component that starts a drag. */
export interface DragControlsStub {
  start: (event: unknown) => void;
}

/** Enough of framer's MotionValue for components that hold one. */
export interface MotionValueStub<T> {
  get: () => T;
  set: (next: T) => void;
  on: (event: string, handler: (value: T) => void) => () => void;
  stop: () => void;
}

const dragControlsStub: DragControlsStub = { start: () => {} };

function motionValueStub<T>(initial: T): MotionValueStub<T> {
  let value = initial;
  return {
    get: () => value,
    set: (next: T) => {
      value = next;
    },
    on: () => () => {},
    stop: () => {},
  };
}

const animateStub: FramerMotionMock["animate"] = () => ({ stop: () => {} });

function splitMotionProps(input: Record<string, unknown>) {
  const motion: MotionProps = {};
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if ((MOTION_PROP_NAMES as readonly string[]).includes(key)) {
      motion[key as MotionPropName] = value;
    } else {
      props[key] = value;
    }
  }
  return { motion, props };
}

const passthroughPresence = ({ children }: AnimatePresenceProps) => children;

export function createFramerMotionMock(
  options: FramerMotionMockOptions = {},
): FramerMotionMock {
  const { reducedMotion = true, onRender, AnimatePresence } = options;
  const cache = new Map<string, MotionComponent>();

  const motionComponent = (tag: string): MotionComponent => {
    const cached = cache.get(tag);
    if (cached) return cached;
    const component = forwardRef<HTMLElement, Record<string, unknown>>(
      function MotionComponent(input, ref) {
        const { motion, props } = splitMotionProps(input);
        const extra = onRender?.({ tag, motion, props }) ?? undefined;
        return createElement(tag as ElementType, { ...props, ...extra, ref });
      },
    ) as MotionComponent;
    cache.set(tag, component);
    return component;
  };

  const motion = new Proxy({} as Record<string, MotionComponent>, {
    get(_target, key) {
      if (typeof key !== "string") return undefined;
      return motionComponent(key);
    },
  });

  return {
    motion,
    AnimatePresence: AnimatePresence ?? passthroughPresence,
    useReducedMotion:
      typeof reducedMotion === "function" ? reducedMotion : () => reducedMotion,
    useDragControls: () => dragControlsStub,
    useMotionValue: motionValueStub,
    animate: animateStub,
  };
}

const defaultMock = createFramerMotionMock();

export const motion = defaultMock.motion;
export const AnimatePresence = defaultMock.AnimatePresence;
export const useReducedMotion = defaultMock.useReducedMotion;
export const useDragControls = defaultMock.useDragControls;
export const useMotionValue = defaultMock.useMotionValue;
export const animate = defaultMock.animate;
