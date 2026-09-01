"use client";

import type { Node as ProseNode } from "@milkdown/kit/prose/model";
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@milkdown/kit/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/kit/prose/view";
import { $prose } from "@milkdown/kit/utils";
import {
  uploadAttachmentWithProgress,
  type AttachmentUploadProgressOptions,
  type UploadedAttachment,
} from "./attachments";

type Upload = (
  file: File,
  options: AttachmentUploadProgressOptions,
) => Promise<UploadedAttachment>;

type UploadAction =
  | {
      type: "add";
      id: string;
      pos: number;
      previewUrl: string;
      progress: number;
      side: number;
    }
  | { type: "progress"; id: string; progress: number }
  | { type: "remove"; id: string }
  | { type: "fail"; id: string; errorId: string }
  | { type: "remove-error"; errorId: string };

type PendingTask = {
  id: string;
  previewUrl: string;
  controller: AbortController;
  batchId: string;
  sequence: number;
  side: number;
  lastProgress: number;
  anchor: BlockAnchor | null;
  range: { from: number; to: number } | null;
  outcome?:
    | { type: "success"; attachment: UploadedAttachment }
    | { type: "failure"; error: unknown };
};

type PendingBatch = { ids: string[]; next: number };
type BlockAnchor = { node: ProseNode; offset: number };
type StartUpload = (
  view: EditorView,
  files: File[],
  pos: number,
  range?: { from: number; to: number },
) => string[];

export interface ImageUploadControllerOptions {
  upload?: Upload;
  createPreviewUrl?: (file: File) => string;
  revokePreviewUrl?: (url: string) => void;
  makeId?: () => string;
  errorDurationMs?: number;
  onError?: (message: string) => void;
}

export const imageUploadPluginKey = new PluginKey<DecorationSet>("brainImageUpload");
const uploadControllerByView = new WeakMap<EditorView, StartUpload>();

let fallbackId = 0;

function nextId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  fallbackId += 1;
  return `image-upload-${fallbackId}`;
}

function progressLabel(progress: number) {
  return progress >= 100 ? "Processing image" : `Uploading image, ${progress}%`;
}

function uploadWidget(
  pos: number,
  action: Extract<UploadAction, { type: "add" }>,
) {
  return Decoration.widget(
    pos,
    () => {
      const root = document.createElement("span");
      root.className = "brain-image-upload";
      root.setAttribute("contenteditable", "false");
      root.dataset.uploadId = action.id;

      if (action.previewUrl) {
        const preview = document.createElement("img");
        preview.className = "brain-image-upload-preview";
        preview.src = action.previewUrl;
        preview.alt = "";
        preview.setAttribute("aria-hidden", "true");
        root.append(preview);
      }

      const veil = document.createElement("span");
      veil.className = "brain-image-upload-veil";
      veil.setAttribute("aria-hidden", "true");

      const meter = document.createElement("span");
      meter.className = "brain-image-upload-meter";
      meter.setAttribute("role", "progressbar");
      meter.setAttribute("aria-label", "Image upload progress");
      meter.setAttribute("aria-valuemin", "0");
      meter.setAttribute("aria-valuemax", "100");
      meter.setAttribute("aria-valuenow", String(action.progress));
      meter.setAttribute("aria-valuetext", progressLabel(action.progress));

      const fill = document.createElement("span");
      fill.className = "brain-image-upload-meter-fill";
      fill.style.transform = `scaleX(${action.progress / 100})`;
      meter.append(fill);

      const text = document.createElement("span");
      text.className = "brain-image-upload-label";
      text.textContent = action.progress >= 100 ? "Processing" : `${action.progress}%`;

      root.append(veil, meter, text);
      return root;
    },
    {
      id: action.id,
      kind: "upload",
      side: action.side,
      previewUrl: action.previewUrl,
      key: `${action.id}:${action.progress}`,
      stopEvent: () => true,
      ignoreSelection: true,
    },
  );
}

function errorWidget(pos: number, errorId: string) {
  return Decoration.widget(
    pos,
    () => {
      const error = document.createElement("span");
      error.className = "brain-image-upload-error";
      error.setAttribute("contenteditable", "false");
      error.setAttribute("role", "alert");
      error.textContent = "Couldn't upload image.";
      return error;
    },
    {
      id: errorId,
      kind: "error",
      side: 1,
      key: errorId,
      stopEvent: () => true,
      ignoreSelection: true,
    },
  );
}

function findDecoration(state: EditorState, id: string) {
  return imageUploadPluginKey
    .getState(state)
    ?.find(undefined, undefined, (spec) => spec.id === id)?.[0];
}

function updateDecorations(
  transaction: Transaction,
  decorations: DecorationSet,
): DecorationSet {
  let next = decorations.map(transaction.mapping, transaction.doc);
  const action = transaction.getMeta(imageUploadPluginKey) as UploadAction | undefined;
  if (!action) return next;

  if (action.type === "add") {
    return next.add(transaction.doc, [uploadWidget(action.pos, action)]);
  }

  const targetId = action.type === "remove-error" ? action.errorId : action.id;
  const target = next.find(undefined, undefined, (spec) => spec.id === targetId);
  const pos = target[0]?.from;
  if (target.length) next = next.remove(target);

  if (action.type === "progress" && pos !== undefined) {
    const previous = target[0]?.spec as Record<string, unknown> | undefined;
    const previewUrl = typeof previous?.previewUrl === "string" ? previous.previewUrl : "";
    const side = typeof previous?.side === "number" ? previous.side : 1;
    return next.add(transaction.doc, [
      uploadWidget(pos, {
        type: "add",
        id: action.id,
        pos,
        previewUrl,
        progress: action.progress,
        side,
      }),
    ]);
  }

  if (action.type === "fail" && pos !== undefined) {
    return next.add(transaction.doc, [errorWidget(pos, action.errorId)]);
  }

  return next;
}

function imageFiles(files: FileList | File[] | null | undefined) {
  return Array.from(files ?? []).filter((file) => file.type.startsWith("image/"));
}

function blockAnchor(doc: ProseNode, pos: number): BlockAnchor | null {
  const safePos = Math.max(0, Math.min(pos, doc.content.size));
  const resolved = doc.resolve(safePos);
  for (let depth = resolved.depth; depth >= 1; depth -= 1) {
    const node = resolved.node(depth);
    if (!node.isBlock) continue;
    return { node, offset: safePos - resolved.before(depth) };
  }
  return null;
}

function nodePosition(doc: ProseNode, target: ProseNode) {
  let found = -1;
  doc.descendants((node, pos) => {
    if (node !== target) return true;
    found = pos;
    return false;
  });
  return found;
}

function taskWidget(task: PendingTask, pos: number) {
  return uploadWidget(pos, {
    type: "add",
    id: task.id,
    pos,
    previewUrl: task.previewUrl,
    progress: task.lastProgress,
    side: task.side,
  });
}

export function startImageUploadInView(
  view: EditorView,
  files: File[],
  pos: number,
  range?: { from: number; to: number },
) {
  return uploadControllerByView.get(view)?.(view, files, pos, range) ?? [];
}

export function handleWrapperImageDrop(
  view: EditorView,
  event: Pick<DragEvent, "clientX" | "clientY" | "preventDefault" | "stopPropagation">,
  files: File[],
) {
  const accepted = imageFiles(files);
  if (!accepted.length) return false;
  event.preventDefault();
  event.stopPropagation();
  const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  startImageUploadInView(view, accepted, pos ?? view.state.doc.content.size);
  return true;
}

export function createImageUploadController(
  options: ImageUploadControllerOptions = {},
) {
  const upload = options.upload ?? uploadAttachmentWithProgress;
  const createPreviewUrl =
    options.createPreviewUrl ??
    ((file: File) =>
      typeof URL !== "undefined" && "createObjectURL" in URL
        ? URL.createObjectURL(file)
        : "");
  const revokePreviewUrl =
    options.revokePreviewUrl ??
    ((url: string) => {
      if (url && typeof URL !== "undefined" && "revokeObjectURL" in URL) {
        URL.revokeObjectURL(url);
      }
    });
  const makeId = options.makeId ?? nextId;
  const tasks = new Map<string, PendingTask>();
  const batches = new Map<string, PendingBatch>();
  const errorTimers = new Set<ReturnType<typeof setTimeout>>();
  let destroyed = false;
  let taskSequence = 0;

  const cleanupTask = (task: PendingTask) => {
    tasks.delete(task.id);
    revokePreviewUrl(task.previewUrl);
  };

  const failTask = (view: EditorView, task: PendingTask) => {
    const errorId = `image-upload-error:${task.id}`;
    view.dispatch(
      view.state.tr.setMeta(imageUploadPluginKey, {
        type: "fail",
        id: task.id,
        errorId,
      } satisfies UploadAction),
    );
    options.onError?.("Couldn't upload image.");
    const timer = setTimeout(() => {
      errorTimers.delete(timer);
      if (destroyed) return;
      view.dispatch(
        view.state.tr.setMeta(imageUploadPluginKey, {
          type: "remove-error",
          errorId,
        } satisfies UploadAction),
      );
    }, options.errorDurationMs ?? 3200);
    errorTimers.add(timer);
    cleanupTask(task);
  };

  const completeTask = (view: EditorView, task: PendingTask, attachment: UploadedAttachment) => {
    const placeholder = findDecoration(view.state, task.id);
    const image = view.state.schema.nodes.brain_image;
    if (!placeholder || !image) {
      cleanupTask(task);
      return;
    }

    try {
      const imageNode: ProseNode = image.create({
        src: attachment.url,
        alt: "",
        width: null,
        align: null,
        title: null,
      });
      const replaceFrom = task.range?.from ?? placeholder.from;
      const replaceTo = task.range?.to ?? placeholder.from;
      const transaction = view.state.tr
        .replaceWith(replaceFrom, replaceTo, imageNode)
        .setMeta(imageUploadPluginKey, {
          type: "remove",
          id: task.id,
        } satisfies UploadAction)
        .scrollIntoView();
      let insertedPos = transaction.mapping.map(placeholder.from, 1);
      transaction.doc.descendants((node, pos) => {
        if (node === imageNode) insertedPos = pos;
      });
      // A block insertion can structurally split a paragraph. ProseMirror then
      // drops widgets at that exact split even when their side is positive.
      // Remember every other in-flight position and restore only decorations
      // lost by our own insertion, preserving concurrent upload order.
      const remaining = Array.from(tasks.values())
        .filter((candidate) => candidate.id !== task.id)
        .map((candidate) => {
          const decoration = findDecoration(view.state, candidate.id);
          return decoration
            ? {
                task: candidate,
                pos:
                  candidate.sequence > task.sequence &&
                  decoration.from === placeholder.from
                    ? insertedPos + imageNode.nodeSize
                    : transaction.mapping.map(decoration.from, 1),
                range:
                  candidate.sequence > task.sequence &&
                  decoration.from === placeholder.from
                    ? {
                        from: insertedPos + imageNode.nodeSize,
                        to: insertedPos + imageNode.nodeSize,
                      }
                    : candidate.range
                      ? {
                          from: transaction.mapping.map(candidate.range.from, 1),
                          to: transaction.mapping.map(candidate.range.to, -1),
                        }
                      : null,
              }
            : null;
        })
        .filter((item): item is {
          task: PendingTask;
          pos: number;
          range: { from: number; to: number } | null;
        } => Boolean(item));

      view.dispatch(transaction);
      for (const item of remaining) {
        item.task.range = item.range;
        if (findDecoration(view.state, item.task.id)) continue;
        view.dispatch(
          view.state.tr.setMeta(imageUploadPluginKey, {
            type: "add",
            id: item.task.id,
            pos: Math.max(0, Math.min(item.pos, view.state.doc.content.size)),
            previewUrl: item.task.previewUrl,
            progress: item.task.lastProgress,
            side: item.task.side,
          } satisfies UploadAction),
        );
      }
      cleanupTask(task);
    } catch (error) {
      task.outcome = { type: "failure", error };
      failTask(view, task);
    }
  };

  const hasOlderUploadAtSamePosition = (view: EditorView, task: PendingTask) => {
    const current = findDecoration(view.state, task.id);
    if (!current) return false;
    return Array.from(tasks.values()).some((candidate) => {
      if (candidate.sequence >= task.sequence) return false;
      return findDecoration(view.state, candidate.id)?.from === current.from;
    });
  };

  const flushBatch = (view: EditorView, batchId: string) => {
    const batch = batches.get(batchId);
    if (!batch) return false;
    let progressed = false;
    while (batch.next < batch.ids.length) {
      const task = tasks.get(batch.ids[batch.next]);
      if (!task) {
        batch.next += 1;
        progressed = true;
        continue;
      }
      if (!task.outcome) break;
      if (hasOlderUploadAtSamePosition(view, task)) break;
      batch.next += 1;
      progressed = true;
      if (task.outcome.type === "success") {
        completeTask(view, task, task.outcome.attachment);
      } else if (task.outcome.error instanceof Error && task.outcome.error.name === "AbortError") {
        cleanupTask(task);
      } else {
        failTask(view, task);
      }
    }
    if (batch.next >= batch.ids.length) batches.delete(batchId);
    return progressed;
  };

  const flushUploads = (view: EditorView) => {
    let progressed = false;
    do {
      progressed = false;
      for (const batchId of Array.from(batches.keys())) {
        if (flushBatch(view, batchId)) progressed = true;
      }
    } while (progressed);
  };

  const start: StartUpload = (view, files, pos, range) => {
    const accepted = imageFiles(files);
    if (!accepted.length || destroyed) return [];

    const batchId = makeId();
    const ids = accepted.map(() => makeId());
    batches.set(batchId, { ids, next: 0 });

    accepted.forEach((file, order) => {
      const id = ids[order];
      const sequence = taskSequence++;
      const previewUrl = createPreviewUrl(file);
      const controller = new AbortController();
      const task: PendingTask = {
        id,
        previewUrl,
        controller,
        batchId,
        sequence,
        side: sequence + 1,
        lastProgress: 0,
        anchor: blockAnchor(view.state.doc, pos),
        range:
          range && range.to > range.from
            ? { from: range.from, to: range.to }
            : null,
      };
      tasks.set(id, task);
      view.dispatch(
        view.state.tr.setMeta(imageUploadPluginKey, {
          type: "add",
          id,
          pos,
          previewUrl,
          progress: 0,
          side: task.side,
        } satisfies UploadAction),
      );

      void upload(file, {
        signal: controller.signal,
        onProgress: (progress) => {
          const current = tasks.get(id);
          const rounded = Math.max(0, Math.min(100, Math.round(progress)));
          if (!current || destroyed || rounded === current.lastProgress) return;
          current.lastProgress = rounded;
          view.dispatch(
            view.state.tr.setMeta(imageUploadPluginKey, {
              type: "progress",
              id,
              progress: rounded,
            } satisfies UploadAction),
          );
        },
      }).then(
        (attachment) => {
          const current = tasks.get(id);
          if (!current || destroyed) return;
          current.outcome = { type: "success", attachment };
          flushUploads(view);
        },
        (error: unknown) => {
          const current = tasks.get(id);
          if (!current || destroyed) return;
          current.outcome = { type: "failure", error };
          flushUploads(view);
        },
      );
    });

    return ids;
  };

  const applyDecorations = (
    transaction: Transaction,
    decorations: DecorationSet,
  ) => {
    for (const task of tasks.values()) {
      const current = decorations.find(
        undefined,
        undefined,
        (spec) => spec.id === task.id,
      )[0];
      if (current) task.anchor = blockAnchor(transaction.before, current.from);
      if (task.range && transaction.docChanged) {
        const from = transaction.mapping.map(task.range.from, 1);
        const to = transaction.mapping.map(task.range.to, -1);
        task.range = { from: Math.min(from, to), to: Math.max(from, to) };
      }
    }

    let next = updateDecorations(transaction, decorations);
    const action = transaction.getMeta(imageUploadPluginKey) as UploadAction | undefined;
    const removedId =
      action?.type === "remove" || action?.type === "fail" ? action.id : null;

    for (const task of tasks.values()) {
      if (task.id === removedId) continue;
      const current = next.find(
        undefined,
        undefined,
        (spec) => spec.id === task.id,
      )[0];
      if (current) {
        task.anchor = blockAnchor(transaction.doc, current.from);
        continue;
      }
      if (!task.anchor) continue;
      const anchorPos = nodePosition(transaction.doc, task.anchor.node);
      if (anchorPos < 0) continue;
      const pos = Math.max(
        anchorPos,
        Math.min(
          anchorPos + task.anchor.node.nodeSize,
          anchorPos + task.anchor.offset,
        ),
      );
      next = next.add(transaction.doc, [taskWidget(task, pos)]);
      task.anchor = blockAnchor(transaction.doc, pos);
    }

    return next;
  };

  const plugin = new Plugin<DecorationSet>({
    key: imageUploadPluginKey,
    state: {
      init: () => DecorationSet.empty,
      apply: applyDecorations,
    },
    props: {
      decorations(state) {
        return imageUploadPluginKey.getState(state) ?? null;
      },
      handlePaste(view, event) {
        const files = imageFiles(event.clipboardData?.files);
        if (!files.length) return false;
        const { from, to } = view.state.selection;
        if (from !== to) {
          view.dispatch(
            view.state.tr
              .setSelection(TextSelection.create(view.state.doc, to))
              .setMeta("addToHistory", false),
          );
        }
        start(view, files, from, { from, to });
        return true;
      },
      handleDrop(view, event) {
        const files = imageFiles(event.dataTransfer?.files);
        if (!files.length) return false;
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        start(view, files, pos ?? view.state.selection.from);
        return true;
      },
    },
    view: (view) => {
      uploadControllerByView.set(view, start);
      return {
        update: () => undefined,
        destroy: () => {
          uploadControllerByView.delete(view);
          destroyed = true;
          for (const timer of errorTimers) clearTimeout(timer);
          errorTimers.clear();
          for (const task of tasks.values()) {
            task.controller.abort();
            revokePreviewUrl(task.previewUrl);
          }
          tasks.clear();
          batches.clear();
        },
      };
    },
  });

  return { plugin, start };
}

export const imageUploadProgress = $prose(
  () => createImageUploadController().plugin,
);
