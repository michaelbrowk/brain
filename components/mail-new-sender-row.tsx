"use client";

import { useRef, useState } from "react";
import {
  animate,
  motion,
  useDragControls,
  useMotionValue,
  useMotionValueEvent,
} from "framer-motion";
import {
  DUR,
  EASE_OUT,
  ROW_SWIPE_ARM,
  ROW_SWIPE_MIN,
  ROW_SWIPE_VELOCITY,
  SPRING_SHEET_GESTURE,
} from "@/lib/motion";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { ActionContextMenu, type PageMenuAction } from "./tree/row-menu";
import { MailRow } from "./mail-row";
import { flipRowKey } from "./mail-flip";
import {
  senderDomain,
  senderName,
  type SenderScope,
  type SenderVerdict,
} from "./mail-new-senders";
import type { MailAddress, MailThreadListItem } from "@/lib/mail/message-types";

/** What a row hands the surface. `dragged` is how far a swipe carried the row
 *  when it decided, so the travel can start from where the reader let go. */
export type SenderDecide = (
  thread: MailThreadListItem,
  verdict: SenderVerdict,
  scope: SenderScope,
  options?: { readonly dragged?: number },
) => void;

/**
 * A row under New senders: the ordinary row, naming the sender the decision
 * is about with its domain after the name, and Block and Accept standing
 * where the time would be. The same object in both lists, like `MailRow`.
 *
 * It answers three gestures besides the two buttons, and none of them is the
 * only way in. A right click or a long press opens the row menu, which is the
 * one place "everyone at the domain" lives. A sideways swipe on a touch screen
 * decides like the buttons do (right Accept, left Block) with the word under
 * the row saying which, and the buttons stay for anyone who does not swipe.
 * Reduced motion turns the swipe off rather than show a row that moves.
 *
 * It carries no exit of its own. A decided row leaves either for another
 * section, where the column plays its travel, or out of the column, where a
 * ghost of it slides away (`mail-flip.ts`), because the node itself is gone
 * before either could start.
 */
export function NewSenderRow({
  thread,
  from,
  active,
  avatar,
  index,
  entrance,
  reduce,
  domainScope,
  waitingHere,
  onSelect,
  onDecide,
}: {
  thread: MailThreadListItem;
  from: MailAddress;
  active: boolean;
  /** The 32 sender avatar in the merged list; the single list has none. */
  avatar?: React.ReactNode;
  index: number;
  entrance: boolean;
  reduce: boolean | null;
  /** Whether "everyone at the domain" may be offered: never for the big mail
   *  providers or the owner's own domains (the service refuses both). */
  domainScope: boolean;
  /** Different senders waiting at this domain, counted for the menu. */
  waitingHere: number;
  onSelect: () => void;
  onDecide: SenderDecide;
}) {
  const key = flipRowKey(thread);
  const name = senderName(from);
  const domain = senderDomain(from.address);
  const actions: PageMenuAction[] = [
    {
      key: "accept",
      icon: "user-check-rounded-linear",
      label: `Accept ${name}`,
      onSelect: () => onDecide(thread, "accept", "address"),
    },
    ...(domainScope
      ? [
          {
            key: "accept-domain",
            icon: "users-group-rounded-linear",
            label: `Accept everyone at ${domain}`,
            tail: waitingHere > 1 ? String(waitingHere) : undefined,
            onSelect: () => onDecide(thread, "accept", "domain"),
          },
        ]
      : []),
    {
      key: "block",
      icon: "user-block-rounded-linear",
      label: `Block ${name}`,
      divider: true,
      onSelect: () => onDecide(thread, "block", "address"),
    },
    ...(domainScope
      ? [
          {
            key: "block-domain",
            icon: "user-block-rounded-linear",
            label: `Block everyone at ${domain}`,
            onSelect: () => onDecide(thread, "block", "domain"),
          },
        ]
      : []),
  ];
  return (
    <motion.div
      role="listitem"
      data-flip={key}
      data-waiting={key}
      className="brain-mail-row-item"
      initial={entrance ? (reduce ? { opacity: 0 } : { opacity: 0, y: 4 }) : false}
      animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0 }}
      transition={{
        duration: DUR.fast,
        ease: EASE_OUT,
        delay: reduce || index >= 8 ? 0 : index * 0.025,
      }}
    >
      <ActionContextMenu actions={actions} wide>
        <SwipeBody
          swipe={!reduce}
          onSwipe={(verdict, dragged) => onDecide(thread, verdict, "address", { dragged })}
        >
          <MailRow
            thread={thread}
            active={active}
            avatar={avatar}
            timeLabel=""
            waitingOn={from}
            onSelect={onSelect}
          />
          <span className="brain-mail-gate">
            <Button
              type="button"
              variant="quiet"
              aria-label={`Block ${name}`}
              title={`Block ${name}`}
              className="brain-touch-hit"
              onClick={() => onDecide(thread, "block", "address")}
            >
              Block
            </Button>
            <Button
              type="button"
              variant="quiet"
              aria-label={`Accept ${name}`}
              title={`Accept ${name}`}
              className="brain-mail-accept tint-hover brain-touch-hit"
              onClick={() => onDecide(thread, "accept", "address")}
            >
              Accept
            </Button>
          </span>
        </SwipeBody>
      </ActionContextMenu>
    </motion.div>
  );
}

/**
 * The part of the row a finger can carry sideways, and the word it uncovers.
 * The drag starts only for a touch pointer (a mouse drag on a list row would
 * be a surprise) and locks to whichever axis moved first, so a vertical
 * scroll that begins on a row is still a scroll. `touch-action: pan-y` on the
 * body hands the vertical axis to the browser and keeps the horizontal one.
 */
function SwipeBody({
  swipe,
  onSwipe,
  children,
  ...trigger
}: {
  swipe: boolean;
  onSwipe: (verdict: SenderVerdict, dragged: number) => void;
  children: React.ReactNode;
} & React.HTMLAttributes<HTMLDivElement>) {
  const x = useMotionValue(0);
  const controls = useDragControls();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [reveal, setReveal] = useState<{
    readonly side: SenderVerdict;
    readonly armed: boolean;
  } | null>(null);
  useMotionValueEvent(x, "change", (value) => {
    const width = bodyRef.current?.offsetWidth ?? 0;
    const side: SenderVerdict | null = value > 0 ? "accept" : value < 0 ? "block" : null;
    const armed = width > 0 && Math.abs(value) >= width * ROW_SWIPE_ARM;
    setReveal((current) => {
      if (side === null) return null;
      if (current?.side === side && current.armed === armed) return current;
      return { side, armed };
    });
  });
  return (
    // Radix's context-menu trigger lands its handlers on this element, so it
    // spreads what it is given: a long press is heard where the swipe is.
    <div {...trigger} className="brain-mail-swipe">
      {reveal && (
        <span
          aria-hidden
          className="brain-mail-swipe-word"
          data-side={reveal.side}
          data-armed={reveal.armed ? "" : undefined}
        >
          {reveal.side === "accept" ? (
            <>
              <Icon name="user-check-rounded-linear" size={16} />
              Accept
            </>
          ) : (
            <>
              Block
              <Icon name="user-block-rounded-linear" size={16} />
            </>
          )}
        </span>
      )}
      <motion.div
        ref={bodyRef}
        className="brain-mail-swipe-body"
        style={{ x }}
        drag={swipe ? "x" : false}
        dragListener={false}
        dragControls={controls}
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={1}
        dragMomentum={false}
        onPointerDown={(event) => {
          if (swipe && event.pointerType === "touch") controls.start(event);
        }}
        onDragEnd={(_event, info) => {
          const width = bodyRef.current?.offsetWidth ?? 0;
          const offset = info.offset.x;
          const velocity = info.velocity.x;
          const far = width > 0 && Math.abs(offset) >= width * ROW_SWIPE_ARM;
          const flicked =
            Math.abs(offset) >= ROW_SWIPE_MIN &&
            Math.abs(velocity) >= ROW_SWIPE_VELOCITY &&
            Math.sign(velocity) === Math.sign(offset);
          if (far || flicked) {
            onSwipe(offset > 0 ? "accept" : "block", x.get());
            return;
          }
          // Not far enough and not fast enough: the row goes home on the
          // one spring that carries a gesture's momentum.
          animate(x, 0, SPRING_SHEET_GESTURE);
        }}
      >
        {children}
      </motion.div>
    </div>
  );
}
