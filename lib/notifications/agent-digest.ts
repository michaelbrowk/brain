/** Browser-safe digest contract. Id sets survive restarts; only the most
 * recently touched targets retain display detail. Counts saturate explicitly. */
export const DIGEST_KINDS = ["page", "task", "thread", "message"] as const;
export type DigestKind = (typeof DIGEST_KINDS)[number];
export const DIGEST_ID_CAP = 200;
export const DIGEST_TARGET_CAP = 50;
export interface DigestTarget {
  readonly id: string;
  readonly kind: DigestKind;
  readonly title: string;
  readonly href: string;
  readonly at: string;
}
export interface AgentDigest {
  readonly agent: string;
  readonly day: string;
  readonly ids: Record<DigestKind, string[]>;
  readonly saturated: DigestKind[];
  readonly targets: DigestTarget[];
}

export function digestTargetCount(digest: AgentDigest): number {
  return DIGEST_KINDS.reduce((sum, kind) => sum + digest.ids[kind].length, 0);
}

export function digestTitle(digest: AgentDigest): string {
  const labels = { page: "page", task: "task", thread: "thread", message: "message" };
  const counts = DIGEST_KINDS.flatMap((kind) => {
    const n = digest.ids[kind].length;
    if (n === 0) return [];
    return `${n}${digest.saturated.includes(kind) ? "+" : ""} ${labels[kind]}${n === 1 ? "" : "s"}${kind === "message" ? " sent" : ""}`;
  });
  return `${digest.agent.slice(0, 80)} · ${counts.join(", ")}`;
}

/** Agent activity is a quiet history, including unconvertible legacy rows. */
export function isUnreadNotification(row: { readonly kind: string; readonly readAt?: string }): boolean {
  return row.kind !== "agent-action" && row.readAt === undefined;
}
