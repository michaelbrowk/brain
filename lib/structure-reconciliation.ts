import type { TreeNode } from "@/lib/store/types";

function locate(
  nodes: TreeNode[],
  id: string,
): { node: TreeNode; siblings: TreeNode[] } | null {
  for (const node of nodes) {
    if (node.id === id) return { node, siblings: nodes };
    const child = locate(node.children, id);
    if (child) return child;
  }
  return null;
}

export function structureMutationConfirmed(
  tree: TreeNode[],
  id: string,
  parentId: string | null,
  beforeId: string | null,
): boolean {
  const placement = locate(tree, id);
  if (!placement || placement.node.parentId !== parentId) return false;

  const index = placement.siblings.findIndex((node) => node.id === id);
  if (beforeId === null) return index === placement.siblings.length - 1;
  const beforeIndex = placement.siblings.findIndex(
    (node) => node.id === beforeId,
  );
  return beforeIndex > 0 && index === beforeIndex - 1;
}
