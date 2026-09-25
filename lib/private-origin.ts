/** WHERE PLAIN HTTP IS THE OWNER'S OWN NETWORK, AND WHERE IT IS THE INTERNET.
 *
 *  `oauthIssuer()` refused any origin that was not https, and everything MCP
 *  is sits behind it: the two discovery documents, every tool, the static
 *  bearer. So a house install on the name a home router hands out, or on the
 *  box's address, had no MCP at all and no way to get one, because nobody is
 *  going to terminate TLS for `brain.lan`. That is the whole install Brain is
 *  written for, turned away by a rule written for the internet.
 *
 *  The rule that replaces it is about reach rather than about the scheme. A
 *  loopback address, a private or link-local address, and the four suffixes a
 *  home or office network is allowed to invent are all names that cannot be
 *  resolved from outside the network they belong to, so a token on the wire
 *  there is on the owner's own wire. Everything else stays https-only, which
 *  includes every public name somebody could point at a box of their own:
 *  `http://evil.example` is refused, and so is `http://brain.example.com`.
 *
 *  What this does NOT do is make plain http safe. Anything on the same network
 *  reads the tokens, so `warnPlainHttpOriginOnce` says so out loud once per
 *  process and `.env.example` says it beside the variable.
 *
 *  One reading of the rule, in one place, so a second caller cannot end up
 *  with a second opinion about what counts as private. */

/** The private IPv4 ranges, as the first two octets settle them, plus the
 *  loopback block. Written out rather than as masks because every one of these
 *  is a /8, a /12 or a /16 and the arithmetic would be the only hard part. */
function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets: number[] = [];
  for (const part of parts) {
    // The URL parser has already normalised a dotted quad, so anything here
    // that is not plain decimal is not an address at all.
    if (!/^\d{1,3}$/.test(part)) return false;
    const value = Number(part);
    if (value > 255) return false;
    octets.push(value);
  }
  const a = octets[0] ?? -1;
  const b = octets[1] ?? -1;
  if (a === 127) return true; // 127.0.0.0/8, loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16, link-local
  return false;
}

/** An IPv6 literal, brackets included, which is the shape `URL.hostname` hands
 *  back. `::1` is loopback, `fc00::/7` is a unique local address and
 *  `fe80::/10` is link-local. `fec0::/10` is site-local, which was deprecated
 *  in 2004 and is not in the /10 that replaced it, so it is refused.
 *
 *  An IPv4-mapped address such as `::ffff:7f00:1` is refused too. It reaches
 *  the same loopback, but an owner writing one into a config file is doing
 *  something this rule does not have to guess at, and `127.0.0.1` is there.
 *
 *  Four hex digits exactly in the first group, in both patterns. The parser
 *  hands back the canonical form, which omits leading zeros, so `fc::1` is the
 *  address `00fc::1` and is no more inside `fc00::/7` than `0100::1` is. A
 *  pattern that let the group be short would take it. */
function isPrivateIPv6(hostname: string): boolean {
  if (!hostname.startsWith("[") || !hostname.endsWith("]")) return false;
  const address = hostname.slice(1, -1).toLowerCase();
  if (address === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true; // fc00::/7
  if (/^fe[89ab][0-9a-f]:/.test(address)) return true; // fe80::/10
  return false;
}

/** The suffixes a network is allowed to invent. `.local` is what Bonjour hands
 *  out, `.lan` is what a home router hands out, `.home.arpa` is what RFC 8375
 *  reserves for exactly this, and `.internal` is the one a private zone uses.
 *  A suffix on its own is not a private name: `internal` is a single label
 *  somebody could register, so only a name with something in front of the dot
 *  counts. */
const PRIVATE_SUFFIXES = [".local", ".lan", ".home.arpa", ".internal"] as const;

export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost") return true;
  if (isPrivateIPv4(host)) return true;
  if (isPrivateIPv6(host)) return true;
  return PRIVATE_SUFFIXES.some(
    (suffix) => host.endsWith(suffix) && host.length > suffix.length,
  );
}

/** Said once per process, at the first use rather than at import: the module is
 *  loaded long before the server's environment is what it will be, and a line
 *  printed per request is a line nobody reads. */
let warned = false;

export function warnPlainHttpOriginOnce(origin: string): void {
  if (warned) return;
  warned = true;
  console.warn(
    `Brain is serving ${origin}: MCP over plain http on a private origin; ` +
      "tokens travel unencrypted on your network.",
  );
}
