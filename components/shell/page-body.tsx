"use client";

// The body of an open page under the head: a collection view, a board, or
// the editor (right-click page menu → Milkdown → subpages). Presentational —
// every piece of state and every handler comes from <Shell> as a prop. The
// editor `key` is composed here exactly as Shell composed it: a page switch,
// a history restore (`editorEpoch`), a page-ref nesting operation and a
// page-ref restore each remount the editor; nothing else does.
// Extracted verbatim from shell.tsx (S4b of the shell extraction).

import type { ComponentProps, MouseEvent } from "react";
import dynamic from "next/dynamic";
import type { TreeNode } from "@/lib/store/types";
import { Skeleton } from "../ui/primitives";
import { PageContextMenu, type PageMenuHandlers } from "../tree/row-menu";
import { Board } from "../board";
import { CollectionView } from "../collection-view";
import { Subpages } from "../subpages";
import type { LoadedPage } from "./helpers";

// code-split the heavy Milkdown editor out of the shell bundle — home/hub paints
// without it; the chunk loads on first page open, then is cached
const MilkdownEditor = dynamic(
  () => import("../editor/milkdown-editor").then((m) => m.MilkdownEditor),
  {
    ssr: false,
    // first-ever page open downloads the chunk — mirror the paragraph
    // skeleton so the editor slot isn't a blank hole meanwhile
    loading: () => (
      <div className="space-y-3">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-5/6" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    ),
  },
);

type EditorProps = ComponentProps<typeof MilkdownEditor>;
type BoardProps = ComponentProps<typeof Board>;

export interface PageBodyProps {
  page: LoadedPage;
  /** The tree node of the open page. Null while the tree is catching up. */
  currentNode: TreeNode | null;
  isBoard: boolean;
  isCollection: boolean;
  onSelect: (id: string) => void;
  onMoveCard: BoardProps["onMoveCard"];
  onAddCard: BoardProps["onAddCard"];
  onAddColumn: BoardProps["onAddColumn"];
  onRenameColumn: BoardProps["onRenameColumn"];
  onDeleteColumn: BoardProps["onDeleteColumn"];
  onSetTags: BoardProps["onSetTags"];
  /** Right-click page menu over the editor: target resolution and the
   *  conflict guard live in Shell. */
  contextMenu: PageMenuHandlers;
  /** Records which page-ref (if any) the right-click landed on before the
   *  menu opens. */
  onEditorContextMenuCapture: (event: MouseEvent<HTMLDivElement>) => void;
  /** Bumped by a history restore to remount the editor on new content. */
  editorEpoch: number;
  /** A page-ref nesting operation in flight for `pageId`. */
  nestingEditor: {
    pageId: string;
    sourceId: string;
    occurrence: number;
  } | null;
  /** A removed page-ref is being restored into this page: the editor is
   *  remounted read-only until the restore lands. */
  pageRefRestorePending: boolean;
  editorValue: string;
  onChange: (pageId: string, md: string) => void;
  onEditorDirty: (pageId: string) => void;
  onEditorSerialized: (pageId: string) => void;
  registerFlush: NonNullable<EditorProps["registerFlush"]>;
  pages: NonNullable<EditorProps["pages"]>;
  searchHighlight: EditorProps["searchHighlight"];
  onSearchHighlightStatus: NonNullable<EditorProps["onSearchHighlightStatus"]>;
  onReparentPageRef: NonNullable<EditorProps["onReparentPageRef"]>;
  onRequestRemovePageRef: NonNullable<EditorProps["onRequestRemovePageRef"]>;
  onCreatePageAtCursor: NonNullable<EditorProps["onCreatePageAtCursor"]>;
  /** Children listed under the editor (collection rows excluded). */
  subpages: readonly TreeNode[];
}

export function PageBody({
  page,
  currentNode,
  isBoard,
  isCollection,
  onSelect,
  onMoveCard,
  onAddCard,
  onAddColumn,
  onRenameColumn,
  onDeleteColumn,
  onSetTags,
  contextMenu,
  onEditorContextMenuCapture,
  editorEpoch,
  nestingEditor,
  pageRefRestorePending,
  editorValue,
  onChange,
  onEditorDirty,
  onEditorSerialized,
  registerFlush,
  pages,
  searchHighlight,
  onSearchHighlightStatus,
  onReparentPageRef,
  onRequestRemovePageRef,
  onCreatePageAtCursor,
  subpages,
}: PageBodyProps) {
  if (isCollection && currentNode) {
    return (
      <div className="mt-6">
        <CollectionView node={currentNode} onSelect={onSelect} />
      </div>
    );
  }
  if (isBoard && currentNode) {
    return (
      <div className="mt-6">
        <Board
          node={currentNode}
          onSelect={onSelect}
          onMoveCard={onMoveCard}
          onAddCard={onAddCard}
          onAddColumn={onAddColumn}
          onRenameColumn={onRenameColumn}
          onDeleteColumn={onDeleteColumn}
          onSetTags={onSetTags}
        />
      </div>
    );
  }
  return (
    <PageContextMenu returnFocusToActiveElement {...contextMenu}>
      <div onContextMenuCapture={onEditorContextMenuCapture}>
        <MilkdownEditor
          key={`ed-${page.id}-${editorEpoch}-${
            nestingEditor?.pageId === page.id ? "nesting" : "ready"
          }-${pageRefRestorePending ? "restoring" : "editable"}`}
          value={editorValue}
          onChange={(md) => onChange(page.id, md)}
          onDirty={() => onEditorDirty(page.id)}
          onSerialized={() => onEditorSerialized(page.id)}
          registerFlush={registerFlush}
          pages={pages}
          onNavigate={onSelect}
          searchHighlight={
            searchHighlight?.pageId === page.id
              ? searchHighlight
              : null
          }
          onSearchHighlightStatus={onSearchHighlightStatus}
          onReparentPageRef={onReparentPageRef}
          onRequestRemovePageRef={onRequestRemovePageRef}
          mutationsFrozen={pageRefRestorePending}
          pageRefNestingPending={nestingEditor?.pageId === page.id}
          pageRefNestingSource={
            nestingEditor?.pageId === page.id
              ? {
                  id: nestingEditor.sourceId,
                  occurrence: nestingEditor.occurrence,
                }
              : undefined
          }
          onCreatePageAtCursor={onCreatePageAtCursor}
        />
        <Subpages
          pages={subpages}
          markdown={editorValue}
          onNavigate={onSelect}
        />
      </div>
    </PageContextMenu>
  );
}
