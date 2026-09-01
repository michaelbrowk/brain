export const NESTED_TABLE_BLOCKED_EVENT = "brain:nested-table-blocked";

export function notifyNestedTableBlocked() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(NESTED_TABLE_BLOCKED_EVENT));
}
