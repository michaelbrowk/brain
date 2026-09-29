export const MAIL_THREAD_STATE_CONTRACT_HEADER = "x-brain-mail-thread-state";
export const MAIL_THREAD_STATE_CONTRACT_VALUE = "5";

export type MailThreadStateContractTier = 1 | 2 | 3 | 4 | 5;

/**
 * Additive thread-state fields ship in tiers so old exact-record clients keep
 * working: tier 1 is the original apiVersion 1 shape, tier 2 added starred,
 * tier 3 added listMessage and sizeBytes, tier 4 added category, tier 5 added
 * newSender. A client states its tier with the header above; anything
 * unrecognized gets the original shape.
 */
export function mailThreadStateContractTier(
  value: string | readonly string[] | null | undefined,
): MailThreadStateContractTier {
  if (value === "5") return 5;
  if (value === "4") return 4;
  if (value === "3") return 3;
  if (value === "2") return 2;
  return 1;
}

export function projectMailThreadStateContract(
  value: unknown,
  tier: MailThreadStateContractTier,
): unknown {
  if (tier === 5) return value;
  if (tier === 4) return omitFields(value, ["newSender"]);
  if (tier === 3) return omitFields(value, ["newSender", "category"]);
  if (tier === 2) {
    return omitFields(value, ["newSender", "category", "listMessage", "sizeBytes"]);
  }
  return omitFields(value, [
    "newSender",
    "category",
    "listMessage",
    "sizeBytes",
    "starred",
  ]);
}

function omitFields(value: unknown, keys: readonly string[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => omitFields(entry, keys));
  if (value === null || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !keys.includes(key))
      .map(([key, nested]) => [key, omitFields(nested, keys)]),
  );
}
