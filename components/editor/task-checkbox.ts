import { listItemSchema } from "@milkdown/kit/preset/commonmark";
import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import type {
  EditorView,
  NodeView,
  NodeViewConstructor,
  ViewMutationRecord,
} from "@milkdown/kit/prose/view";
import { $view } from "@milkdown/kit/utils";

import {
  prefersReducedMotion,
  renderTaskCheckbox,
  setTaskCheckboxChecked,
  setTaskCheckboxLabel,
} from "@/components/tasks-checkbox";

/** A real control on a task list item.
 *
 *  The gfm preset already carries the state: `list_item` gets a `checked`
 *  attribute, null on an ordinary bullet and a boolean on a task, and it
 *  parses and serializes `* [ ] text` without loss. What it never rendered was
 *  anything to press, so a checkbox in a note could be read and not ticked.
 *  This is the missing half: the same node, drawn with the one checkbox from
 *  `components/tasks-checkbox.tsx` and toggled through a transaction.
 *
 *  Ticking writes the attribute and stops. It does not touch markdown and it
 *  does not reach the store: inside one tab the change travels the ordinary
 *  document path and autosave carries it out, the same as typing a letter. */

function itemText(node: ProseNode): string {
  return node.textBetween(0, node.content.size, " ", " ");
}

export const taskCheckboxView = $view(listItemSchema.node, () =>
  ((initial: ProseNode, view: EditorView, getPos: () => number | undefined): NodeView => {
    // `checked` is null on a plain bullet. Returning no view hands the item
    // back to the preset's own `toDOM`, so an ordinary list item renders
    // exactly what it rendered before this plugin existed, with no copy of
    // the preset's markup here to drift. ProseMirror reads the absent spec
    // and takes the default path; the constructor's type says it always
    // returns a view, which is the one place this has to say otherwise.
    if (initial.attrs.checked == null) return undefined as unknown as NodeView;

    const dom = document.createElement("li");
    dom.className = "brain-task-item";
    dom.setAttribute("data-item-type", "task");

    const contentDOM = document.createElement("div");
    contentDOM.className = "brain-task-body";

    const toggle = () => {
      const pos = getPos();
      if (pos == null) return;
      const node = view.state.doc.nodeAt(pos);
      if (!node || node.type.name !== "list_item" || node.attrs.checked == null) return;
      view.dispatch(
        view.state.tr.setNodeMarkup(pos, undefined, {
          ...node.attrs,
          checked: !node.attrs.checked,
        }),
      );
    };

    const box = renderTaskCheckbox({
      checked: Boolean(initial.attrs.checked),
      onToggle: toggle,
      reduce: prefersReducedMotion(),
    });
    box.setAttribute("contenteditable", "false");

    // The data attributes are the preset's own, and they are load bearing
    // rather than decoration: a DOM change inside the item is recovered by
    // re-parsing it, and gfm's `parseDOM` reads `checked` back off the `li`.
    // An item that carried none of them would come back a plain bullet.
    const render = (node: ProseNode) => {
      dom.setAttribute("data-label", String(node.attrs.label));
      dom.setAttribute("data-list-type", String(node.attrs.listType));
      dom.setAttribute("data-spread", String(node.attrs.spread));
      dom.setAttribute("data-checked", String(Boolean(node.attrs.checked)));
      setTaskCheckboxChecked(box, Boolean(node.attrs.checked), prefersReducedMotion());
      setTaskCheckboxLabel(box, itemText(node));
    };

    render(initial);
    dom.append(box, contentDOM);

    return {
      dom,
      contentDOM,
      update: (node: ProseNode) => {
        // A bullet that becomes a task, or a task that becomes a bullet, is a
        // different control. Refusing the update has ProseMirror build the
        // right one from scratch.
        if (node.type.name !== "list_item" || node.attrs.checked == null) return false;
        render(node);
        return true;
      },
      ignoreMutation: (mutation: ViewMutationRecord) => {
        if (mutation.target === contentDOM || contentDOM.contains(mutation.target)) return false;
        return true;
      },
      stopEvent: (event: Event) =>
        event.target instanceof Node && (event.target === box || box.contains(event.target)),
    };
  }) satisfies NodeViewConstructor,
);

export const taskCheckbox = [taskCheckboxView];
