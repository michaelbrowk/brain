/** Stable per-tab client id, sent as `x-brain-client` on every API call. The
 *  store tags its SSE events with the originating client (`src`), so a tab can
 *  ignore the echo of its own writes instead of round-tripping a reload — the
 *  root of the "Also changed elsewhere" toast storm. */
function newClientId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
}

// Document-lifetime identity: duplicated/opener-created tabs may inherit
// sessionStorage, so persisting this id would merge their draft namespaces and
// make them ignore each other's SSE events. Reload recovery scans prior keys.
export const CLIENT_ID: string = newClientId();

export const apiFetch: typeof fetch = (input, init = {}) =>
  fetch(input, {
    ...init,
    headers: {
      ...((init.headers as Record<string, string>) ?? {}),
      "x-brain-client": CLIENT_ID,
    },
  });
