import type { TreeNode } from "./store/types";

export function isShareGrantExpired(
  expiresAt?: string | null,
  now = Date.now(),
): boolean {
  if (!expiresAt) return false;
  const deadline = Date.parse(expiresAt);
  return !Number.isFinite(deadline) || deadline <= now;
}

export function isActiveShareGrant(
  node: Pick<TreeNode, "public" | "shareExpiresAt">,
  now = Date.now(),
): boolean {
  return !!node.public && !isShareGrantExpired(node.shareExpiresAt, now);
}

/** Nearest configured ancestor of each kind. Expired grants are tracked
 * separately so a nearer expired parent never hides a higher active root. */
export function resolveInheritedShareGrants(
  path: TreeNode[],
  now = Date.now(),
): {
  active: TreeNode | null;
  expired: TreeNode | null;
} {
  const ancestors = [...path.slice(0, -1)]
    .reverse()
    .filter((node) => !!node.public);
  return {
    active:
      ancestors.find((node) => isActiveShareGrant(node, now)) ?? null,
    expired:
      ancestors.find((node) =>
        isShareGrantExpired(node.shareExpiresAt, now),
      ) ?? null,
  };
}
