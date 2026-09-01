import crypto from "node:crypto";
import net from "node:net";

export const OAUTH_EDGE_SECRET_HEADER = "x-brain-edge-secret";
export const OAUTH_EDGE_SOURCE_HEADER = "x-brain-rate-source";

function configuredEdgeSecret(): Buffer | null {
  const value = process.env.BRAIN_EDGE_RATE_SECRET;
  if (!value) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("OAuth trusted edge is not configured");
    }
    return null;
  }
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("BRAIN_EDGE_RATE_SECRET must be a 256-bit hex secret");
  }
  return Buffer.from(value, "hex");
}

/** Returns a non-reversible, stable source id only when nginx authenticated
 *  both the source address and the edge itself. Public headers alone are never
 *  trusted; production rejects requests that bypass the configured edge. */
export function trustedOAuthRateSource(request: Request): string {
  const expected = configuredEdgeSecret();
  if (!expected) return "development";

  const supplied = request.headers.get(OAUTH_EDGE_SECRET_HEADER) ?? "";
  const suppliedBytes = Buffer.from(supplied, "utf8");
  if (
    suppliedBytes.length !== 64 ||
    !crypto.timingSafeEqual(suppliedBytes, Buffer.from(expected.toString("hex")))
  ) {
    throw new Error("OAuth request did not pass through the trusted edge");
  }
  const source = request.headers.get(OAUTH_EDGE_SOURCE_HEADER) ?? "";
  if (source.length > 64 || net.isIP(source) === 0) {
    throw new Error("OAuth trusted edge source is invalid");
  }
  return crypto
    .createHmac("sha256", expected)
    .update(source, "utf8")
    .digest("base64url");
}
