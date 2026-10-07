import {
  ParserReady,
  editorStateTimerCtx,
  parserCtx,
  remarkCtx,
  schemaCtx,
} from "@milkdown/kit/core";
import { createTimer, type MilkdownPlugin } from "@milkdown/kit/ctx";
import type { Attrs, Node as ProseNode, NodeType, Schema } from "@milkdown/kit/prose/model";
import { Plugin, PluginKey } from "@milkdown/kit/prose/state";
import { ParserState } from "@milkdown/kit/transformer";
import { $prose } from "@milkdown/kit/utils";

/** A PAGE THAT WOULD LOSE CONTENT ON LOAD IS NEVER OPENED FOR EDITING.
 *
 *  Milkdown's parser catches the failure to build a node, logs it and carries
 *  on without that node and everything inside it. A remark pass that hands it
 *  a shape the schema cannot hold (an image made a block inside a heading was
 *  the one that happened) therefore opens the page with the heading gone, and
 *  the first keystroke saves the shorter document over the file. Nothing on
 *  the screen says so.
 *
 *  This parser is Milkdown's own with a count of those silent drops: a node
 *  closed or added that never reached its parent. The page's load is the first
 *  parse an editor makes, and when it drops anything `onLoss` hears how much,
 *  before the view exists, so the caller can open the page read-only and keep
 *  the file as it is on disk, and every change to the document is refused
 *  from then on. Later parses (a Markdown paste) are counted the
 *  same way and not reported: what they lose was never saved. */
class CountingParserState extends ParserState {
  dropped = 0;

  constructor(schema: Schema) {
    super(schema);
    const closeNode = this.closeNode;
    this.closeNode = () => {
      const parent = this.elements.at(-2);
      const before = parent?.content.length ?? 0;
      closeNode();
      if (parent && parent.content.length === before) this.dropped += 1;
      return this;
    };
    const addNode = this.addNode;
    this.addNode = (nodeType: NodeType, attrs?: Attrs, content?: ProseNode[]) => {
      const top = this.top();
      const before = top?.content.length ?? 0;
      addNode(nodeType, attrs, content);
      if (top && top.content.length === before) this.dropped += 1;
      return this;
    };
  }
}

export function loadGuard(onLoss: (dropped: number) => void): MilkdownPlugin[] {
  const ready = createTimer("BrainLoadGuardReady");
  let lossy = false;
  // Read-only stops typing and nothing else: a task checkbox, a callout's
  // icon, a file drop and every other control the page draws dispatch on
  // their own, and each one saved the shortened document. A lossy page
  // refuses every change to its document, whoever asks.
  const refuseChanges = $prose(
    () =>
      new Plugin({
        key: new PluginKey("brainLoadGuardRefuse"),
        filterTransaction: (transaction) => !(lossy && transaction.docChanged),
      }),
  );
  const countingParser: MilkdownPlugin = (ctx) => {
    ctx.record(ready);
    // The editor state parses the page as soon as its timers are done; this
    // one makes it wait until the counting parser is in place.
    ctx.update(editorStateTimerCtx, (timers) => timers.concat(ready));
    return async () => {
      await ctx.wait(ParserReady);
      const remark = ctx.get(remarkCtx);
      const state = new CountingParserState(ctx.get(schemaCtx));
      let loaded = false;
      ctx.set(parserCtx, (text: string) => {
        state.dropped = 0;
        state.run(remark, text);
        const doc = state.toDoc();
        if (!loaded) {
          loaded = true;
          if (state.dropped > 0) {
            lossy = true;
            onLoss(state.dropped);
          }
        }
        return doc;
      });
      ctx.done(ready);
      return () => {
        ctx.clearTimer(ready);
      };
    };
  };
  return [countingParser, refuseChanges];
}
