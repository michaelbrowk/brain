/** One "time ago" voice for the whole app. `compact` gives the tight trailing
 *  chips the hub uses ("now / 5m / yesterday"); the default is the fuller
 *  phrasing for inline sentences ("just now / 5m ago"). */
export function formatAgo(iso: string, opts: { compact?: boolean } = {}): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  const c = opts.compact;
  if (s < 90) return c ? "now" : "just now";
  if (s < 3600) return `${Math.round(s / 60)}m${c ? "" : " ago"}`;
  if (s < 86400) return `${Math.round(s / 3600)}h${c ? "" : " ago"}`;
  if (c && s < 172800) return "yesterday";
  return `${Math.round(s / 86400)}d${c ? "" : " ago"}`;
}
