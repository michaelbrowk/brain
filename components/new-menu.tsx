"use client";

// THE MENU UNDER THE PLUS.
//
// It was a template menu: one act, seven ways of spelling it. But the plus is
// the one control in this product that means MAKE SOMETHING, and Brain now
// keeps three kinds of something: a task, a message and a page. A reader who
// wanted the first two had to know that Tasks has a field at the top of a list
// and that Mail has a Compose pill inside its own column, which is two pieces
// of furniture knowledge standing in for one button.
//
// TWO GROUPS, IN THE ORDER OF THE ASK. "New" holds the two nouns that have no
// other way in from here; "Page" holds the blank page and the templates,
// unchanged, because a template is a KIND of page and not a fourth thing. The
// rule between them is the ordinary `brain-menu-sep`.
//
// MESSAGE IS ABSENT, NOT DIMMED, when no account can send: a row that can only
// apologise is worse than no row (the same argument "Mark all read" makes in
// the notification centre). `useMailComposeAvailable` is the one place that
// decides it, and the mail surface checks capabilities again before it opens a
// composer, so a stale yes costs a toast and never a wrong window.
//
// ON A PHONE IT IS A SHEET, the form the When picker and the composer already
// take below md: the same `brain-menu` material, the grip, `SPRING_SHEET` in
// and the drag out. The rows and their order do not change, because a sheet is
// a shape and not a second menu.

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { animate, motion, useDragControls, useMotionValue, useReducedMotion } from "framer-motion";
import { useCallback, useRef, useState } from "react";

import {
  SHEET_DISMISS_OFFSET,
  SHEET_DISMISS_VELOCITY,
  SHEET_ENTER_Y,
  SPRING_SHEET,
  SPRING_SHEET_GESTURE,
} from "@/lib/motion";
import { TEMPLATES, requestTemplateCaret, type Template } from "@/lib/templates";

import { useMailComposeAvailable } from "./mail-compose-available";
import { useSheetGesture } from "./use-sheet-gesture";
import { useDeferredMenuAction } from "./ui/deferred-menu-action";
import { Icon } from "./ui/icon";

export function NewMenu({
  children,
  onPickTemplate,
  onNewTask,
  onNewMessage,
}: {
  children: React.ReactNode;
  /** May resolve to the created page id; a template page then opens with the
   *  caret in its first empty section (a blank page focuses the title). */
  onPickTemplate: (t: Template) => void | Promise<string | null>;
  onNewTask: () => void;
  onNewMessage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion() ?? false;
  const sheet = useSheetGesture();
  const canSend = useMailComposeAvailable();
  const dragControls = useDragControls();
  const sheetY = useMotionValue(0);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  /** TASK AND MESSAGE RUN AFTER THE MENU HAS GONE, the way the row menu runs
   *  the actions that open a dialog. Both of them put a caret somewhere, the
   *  capture field or the composer's To, and a caret moved while Radix's focus
   *  scope is still up is a caret Radix takes straight back: the surface
   *  focused its field inside the trapped layer, the layer tore down, and the
   *  reader was left on `body` with a field that looked ready and was not.
   *  The page rows are unchanged: nothing there focuses inside this commit. */
  const focusAction = useDeferredMenuAction();

  /** The one way out, so the sheet leaves the same way whichever gesture asked
   *  it to. The When picker's rule, for the When picker's reason. The travel
   *  off the bottom starts from wherever the drag left it. */
  const close = useCallback(() => {
    if (sheet && !reduce) {
      const height = sheetRef.current?.offsetHeight ?? 0;
      const away = sheetY.get() + (height > 0 ? height : window.innerHeight);
      animate(sheetY, away, SPRING_SHEET);
    }
    setOpen(false);
  }, [reduce, sheet, sheetY]);

  const body = (
    <>
      <p className="brain-menu-label">New</p>
      {/* The glyph each surface already wears: the tab bar's Tasks slot and
          the sidebar's Mail row. One surface, one drawing. */}
      <Dropdown.Item
        className="brain-menu-item"
        onSelect={() => focusAction.defer(onNewTask)}
      >
        <Icon name="checklist-linear" size={16} className="brain-menu-icon" />
        Task
      </Dropdown.Item>
      {canSend && (
        <Dropdown.Item
          className="brain-menu-item"
          onSelect={() => focusAction.defer(onNewMessage)}
        >
          <Icon name="letter-linear" size={16} className="brain-menu-icon" />
          Message
        </Dropdown.Item>
      )}
      <Dropdown.Separator className="brain-menu-sep" />
      <p className="brain-menu-label">Page</p>
      {TEMPLATES.map((t) => (
        <Dropdown.Item
          key={t.id}
          onSelect={() => {
            const created = onPickTemplate(t);
            if (t.id === "blank" || !created) return;
            void created.then((id) => {
              if (id) requestTemplateCaret(id);
            });
          }}
          className="brain-menu-item"
        >
          <span className="grid size-4 place-items-center text-[14px] leading-none">
            {t.emoji || <Icon name="add-linear" size={16} className="brain-menu-icon" />}
          </span>
          {t.name}
        </Dropdown.Item>
      ))}
    </>
  );

  return (
    <Dropdown.Root
      open={open}
      onOpenChange={(next) => {
        // A tap outside, Escape and a picked row all arrive here; the sheet
        // leaves on the one spring whichever of them it was.
        if (!next) {
          close();
          return;
        }
        // a sheet carried away last time starts its next arrival at rest
        sheetY.set(0);
        setOpen(true);
      }}
    >
      <Dropdown.Trigger asChild>{children}</Dropdown.Trigger>
      <Dropdown.Portal>
        {/* regular material r14, materialized by a keyframe on data-state.
            `asChild` below md makes the CONTENT the moving element, so what
            leaves the screen is the whole sheet and not a box inside a pane of
            glass that stays put (the C3 finding on the When picker). */}
        <Dropdown.Content
          asChild={sheet}
          side={sheet ? "top" : "bottom"}
          align={sheet ? "end" : "start"}
          sideOffset={sheet ? 8 : 4}
          collisionPadding={8}
          onCloseAutoFocus={focusAction.runAfterClose}
          className={sheet ? undefined : "brain-menu z-[var(--z-modal)] w-[210px]"}
        >
          {sheet ? (
            <motion.div
              ref={sheetRef}
              className="brain-menu brain-menu-sheet z-[var(--z-modal)]"
              style={{ y: sheetY }}
              initial={reduce ? false : { y: SHEET_ENTER_Y }}
              animate={{ y: 0 }}
              transition={reduce ? { duration: 0 } : SPRING_SHEET}
              drag="y"
              dragControls={dragControls}
              dragListener={false}
              dragConstraints={{ top: 0 }}
              dragElastic={0}
              dragMomentum={false}
              onDragEnd={(_, info) => {
                if (
                  info.offset.y > SHEET_DISMISS_OFFSET ||
                  info.velocity.y > SHEET_DISMISS_VELOCITY
                ) {
                  // the grip is a close, the same close every other dismissal
                  // of this menu runs
                  close();
                  return;
                }
                animate(sheetY, 0, reduce ? { duration: 0 } : SPRING_SHEET_GESTURE);
              }}
            >
              <div
                aria-hidden
                className="brain-composer-grip"
                onPointerDown={(event) => dragControls.start(event)}
              >
                <span />
              </div>
              {body}
            </motion.div>
          ) : (
            body
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
