import type { TreeNode } from "./store/types";
import { isShareExpired } from "./sharing";

/** The expiry rule under the name the grant side reads it by, and the same
 *  function: this module and `lib/sharing.ts` held the same predicate written
 *  twice, and the fold path asks both — the store's refusal through one, the
 *  browser's read-back through the other — so two bodies were a skew between
 *  them waiting for the first change to either. */
export const isShareGrantExpired = isShareExpired;

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
