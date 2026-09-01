export const RELAY_AUDIENCE = "brain-mail-smtp-egress-v1" as const;
export const RELAY_TRANSPORT = "authenticated_byte_relay" as const;
export const RELAY_CHALLENGE_TTL_MS = 5_000;
export const RELAY_SESSION_MS = 60_000;
export const RELAY_DNS_MAX_AGE_MS = 5 * 60_000;
export const RELAY_MAX_CONTROL_BYTES = 8 * 1024;
export const RELAY_MAX_FRAME_BYTES = 16 * 1024;
export const RELAY_MAX_CLIENT_BYTES = 2 * 1024 * 1024;
export const RELAY_MAX_SERVER_BYTES = 128 * 1024;
export const RELAY_SEQUENCE_MAX = 0xffff_ffff;

export interface RelayChallenge {
  readonly version: 1;
  readonly audience: typeof RELAY_AUDIENCE;
  readonly challenge: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface RelayAuthorizationPayload extends RelayChallenge {
  readonly transport: typeof RELAY_TRANSPORT;
  readonly sessionId: string;
  readonly attemptId: string;
  readonly resolutionId: string;
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: 465 | 587;
  readonly targetExpiresAt: number;
  readonly deadlineAt: number;
}

export interface RelayAuthorization extends RelayAuthorizationPayload {
  readonly hmacSha256: string;
}

export interface ChallengeControl {
  readonly type: "challenge";
  readonly challenge: RelayChallenge;
}

export interface AuthorizeControl {
  readonly type: "authorize";
  readonly authorization: RelayAuthorization;
}

export interface AckControl {
  readonly type: "ack";
  readonly sequence: number;
}

export type RelayEofControlType =
  | "client_eof"
  | "client_eof_ack"
  | "server_eof"
  | "server_eof_ack";

export interface RelayEofControl {
  readonly type: RelayEofControlType;
  readonly sequence: number;
}

export interface ReadyControl {
  readonly type: "ready";
  readonly sessionId: string;
  readonly attemptId: string;
  readonly resolutionId: string;
  readonly address: string;
  readonly family: 4 | 6;
  readonly port: 465 | 587;
  readonly remoteAddress: string | null;
  readonly connectedAt: number;
}

export interface ErrorControl {
  readonly type: "error";
  readonly code: RelayErrorCode;
}

export type RelayErrorCode =
  | "bad_request"
  | "auth_failed"
  | "auth_replayed"
  | "target_rejected"
  | "connect_failed"
  | "protocol_violation"
  | "client_limit"
  | "server_limit"
  | "deadline_exceeded";

const CHALLENGE_FIELDS = Object.freeze([
  "version",
  "audience",
  "challenge",
  "issuedAt",
  "expiresAt",
] as const);
const AUTHORIZATION_FIELDS = Object.freeze([
  ...CHALLENGE_FIELDS,
  "transport",
  "sessionId",
  "attemptId",
  "resolutionId",
  "address",
  "family",
  "port",
  "targetExpiresAt",
  "deadlineAt",
  "hmacSha256",
] as const);
const AUTHORIZE_CONTROL_FIELDS = Object.freeze(["type", "authorization"] as const);
const ACK_CONTROL_FIELDS = Object.freeze(["type", "sequence"] as const);
const EOF_CONTROL_FIELDS = ACK_CONTROL_FIELDS;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX_256 = /^[a-f0-9]{64}$/;

export function createRelayChallenge(now: number, randomBytes: Uint8Array): RelayChallenge {
  assertWholeNumber(now, "relay challenge current time", 0);
  if (randomBytes.byteLength !== 32) {
    throw new Error("relay challenge requires exactly 32 random bytes");
  }
  return Object.freeze({
    version: 1,
    audience: RELAY_AUDIENCE,
    challenge: bytesToHex(randomBytes),
    issuedAt: now,
    expiresAt: now + RELAY_CHALLENGE_TTL_MS,
  });
}

export function projectRelayChallenge(value: unknown): RelayChallenge {
  assertExactDataProperties(value, CHALLENGE_FIELDS, "relay challenge");
  const challenge = value as unknown as RelayChallenge;
  if (challenge.version !== 1 || challenge.audience !== RELAY_AUDIENCE) {
    throw new Error("relay challenge version or audience is invalid");
  }
  if (!HEX_256.test(challenge.challenge)) {
    throw new Error("relay challenge must contain 32 lowercase-hex bytes");
  }
  assertWholeNumber(challenge.issuedAt, "relay challenge issue time", 0);
  assertWholeNumber(challenge.expiresAt, "relay challenge expiry", challenge.issuedAt + 1);
  if (challenge.expiresAt > challenge.issuedAt + RELAY_CHALLENGE_TTL_MS) {
    throw new Error("relay challenge lifetime is too long");
  }
  return Object.freeze({ ...challenge });
}

export function parseAuthorizeControl(
  text: string,
  expectedChallenge: RelayChallenge,
  now: number,
): AuthorizeControl {
  const value = parseControlJson(text);
  assertExactDataProperties(value, AUTHORIZE_CONTROL_FIELDS, "relay authorize control");
  if (value.type !== "authorize") throw new Error("relay control type is invalid");
  return Object.freeze({
    type: "authorize",
    authorization: projectRelayAuthorization(value.authorization, expectedChallenge, now),
  });
}

export function projectRelayAuthorization(
  value: unknown,
  expectedChallenge: RelayChallenge,
  now: number,
): RelayAuthorization {
  assertWholeNumber(now, "relay authorization current time", 0);
  const expected = projectRelayChallenge(expectedChallenge);
  if (now < expected.issuedAt || now >= expected.expiresAt) {
    throw new Error("relay challenge is not fresh");
  }
  assertExactDataProperties(value, AUTHORIZATION_FIELDS, "relay authorization");
  const authorization = value as unknown as RelayAuthorization;
  if (
    authorization.version !== expected.version ||
    authorization.audience !== expected.audience ||
    authorization.challenge !== expected.challenge ||
    authorization.issuedAt !== expected.issuedAt ||
    authorization.expiresAt !== expected.expiresAt
  ) {
    throw new Error("relay authorization challenge does not match this connection");
  }
  if (authorization.transport !== RELAY_TRANSPORT) {
    throw new Error("relay authorization transport is invalid");
  }
  assertIdentifier(authorization.sessionId, "relay session id");
  assertIdentifier(authorization.attemptId, "relay attempt id");
  assertIdentifier(authorization.resolutionId, "relay resolution id");
  const address = canonicalizeLiteralAddress(authorization.address, authorization.family);
  if (!address || address !== authorization.address || isForbiddenAddress(address)) {
    throw new Error("relay target must be a canonical public literal address");
  }
  if (authorization.port !== 465 && authorization.port !== 587) {
    throw new Error("relay target port is invalid");
  }
  assertWholeNumber(authorization.targetExpiresAt, "relay target expiry", now + 1);
  if (authorization.targetExpiresAt > now + RELAY_DNS_MAX_AGE_MS) {
    throw new Error("relay target expiry exceeds its freshness limit");
  }
  assertWholeNumber(authorization.deadlineAt, "relay deadline", now + 1);
  if (
    authorization.deadlineAt > authorization.targetExpiresAt ||
    authorization.deadlineAt > now + RELAY_SESSION_MS
  ) {
    throw new Error("relay deadline exceeds its limit");
  }
  if (!HEX_256.test(authorization.hmacSha256)) {
    throw new Error("relay authorization HMAC is invalid");
  }
  return Object.freeze({ ...authorization, address });
}

export function authorizationPayload(
  authorization: RelayAuthorization,
): RelayAuthorizationPayload {
  return Object.freeze({
    version: authorization.version,
    audience: authorization.audience,
    challenge: authorization.challenge,
    issuedAt: authorization.issuedAt,
    expiresAt: authorization.expiresAt,
    transport: authorization.transport,
    sessionId: authorization.sessionId,
    attemptId: authorization.attemptId,
    resolutionId: authorization.resolutionId,
    address: authorization.address,
    family: authorization.family,
    port: authorization.port,
    targetExpiresAt: authorization.targetExpiresAt,
    deadlineAt: authorization.deadlineAt,
  });
}

/** Must remain byte-for-byte identical to Brain's PR0 canonicalizer. */
export function canonicalizeRelayAuthorization(
  payload: RelayAuthorizationPayload,
): string {
  return [
    "brain-mail-smtp-egress-hmac-v1",
    payload.version,
    payload.audience,
    payload.transport,
    payload.challenge,
    payload.issuedAt,
    payload.expiresAt,
    payload.sessionId,
    payload.attemptId,
    payload.resolutionId,
    payload.address,
    payload.family,
    payload.port,
    payload.targetExpiresAt,
    payload.deadlineAt,
  ].join("\n");
}

export async function verifyRelayAuthorizationHmac(
  base64UrlKey: string,
  authorization: RelayAuthorization,
): Promise<boolean> {
  const keyBytes = decodeBase64Url32(base64UrlKey);
  const signature = hexToBytes(authorization.hmacSha256);
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(keyBytes),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(signature),
    toArrayBuffer(
      new TextEncoder().encode(
        canonicalizeRelayAuthorization(authorizationPayload(authorization)),
      ),
    ),
  );
}

export function encodeDataFrame(sequence: number, payload: Uint8Array): ArrayBuffer {
  assertSequence(sequence);
  if (payload.byteLength < 1 || payload.byteLength > RELAY_MAX_FRAME_BYTES) {
    throw new Error("relay DATA frame payload size is invalid");
  }
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, sequence, false);
  frame.set(payload, 4);
  return frame.buffer;
}

export function decodeDataFrame(value: ArrayBuffer): {
  readonly sequence: number;
  readonly payload: Uint8Array;
} {
  if (!(value instanceof ArrayBuffer)) throw new Error("relay DATA frame must be binary");
  if (value.byteLength < 5 || value.byteLength > 4 + RELAY_MAX_FRAME_BYTES) {
    throw new Error("relay DATA frame size is invalid");
  }
  return Object.freeze({
    sequence: new DataView(value).getUint32(0, false),
    payload: new Uint8Array(value, 4),
  });
}

export function encodeAckControl(sequence: number): string {
  assertSequence(sequence);
  return JSON.stringify({ type: "ack", sequence });
}

export function parseAckControl(text: string, expectedSequence: number): AckControl {
  assertSequence(expectedSequence);
  const value = parseControlJson(text);
  assertExactDataProperties(value, ACK_CONTROL_FIELDS, "relay ACK control");
  if (value.type !== "ack") throw new Error("relay ACK control type is invalid");
  assertSequence(value.sequence);
  if (value.sequence !== expectedSequence) {
    throw new Error("relay ACK sequence does not match the in-flight frame");
  }
  return Object.freeze({ type: "ack", sequence: value.sequence });
}

export function encodeEofControl(
  type: RelayEofControlType,
  sequence: number,
): string {
  assertSequence(sequence);
  return JSON.stringify({ type, sequence });
}

export function parseEofControl(
  text: string,
  expectedType: RelayEofControlType,
  expectedSequence: number,
): RelayEofControl {
  assertSequence(expectedSequence);
  const value = parseControlJson(text);
  assertExactDataProperties(value, EOF_CONTROL_FIELDS, "relay EOF control");
  if (value.type !== expectedType) throw new Error("relay EOF control type is invalid");
  assertSequence(value.sequence);
  if (value.sequence !== expectedSequence) {
    throw new Error("relay EOF sequence does not match the next DATA frame");
  }
  return Object.freeze({ type: expectedType, sequence: value.sequence });
}

export function nextSequence(sequence: number): number {
  assertSequence(sequence);
  if (sequence === RELAY_SEQUENCE_MAX) throw new Error("relay sequence is exhausted");
  return sequence + 1;
}

export function parseControlJson(text: string): Record<string, unknown> {
  if (
    typeof text !== "string" ||
    text.length > RELAY_MAX_CONTROL_BYTES ||
    new TextEncoder().encode(text).byteLength > RELAY_MAX_CONTROL_BYTES
  ) {
    throw new Error("relay control frame size is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("relay control frame is not valid JSON");
  }
  if (!isPlainRecord(value)) throw new Error("relay control frame is invalid");
  return value;
}

export function canonicalizeLiteralAddress(address: unknown, family: unknown): string | null {
  if (typeof address !== "string" || address.includes("%")) return null;
  if (family === 4) {
    const octets = parseIpv4(address);
    return octets ? octets.join(".") : null;
  }
  if (family !== 6) return null;
  const bytes = parseIpv6(address);
  if (!bytes) return null;
  const groups = Array.from({ length: 8 }, (_, index) =>
    ((bytes[index * 2] << 8) | bytes[index * 2 + 1]).toString(16),
  );
  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < groups.length; ) {
    if (groups[index] !== "0") {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < groups.length && groups[end] === "0") end += 1;
    const length = end - index;
    if (length >= 2 && length > bestLength) {
      bestStart = index;
      bestLength = length;
    }
    index = end;
  }
  if (bestStart === -1) return groups.join(":");
  const left = groups.slice(0, bestStart).join(":");
  const right = groups.slice(bestStart + bestLength).join(":");
  if (!left && !right) return "::";
  if (!left) return `::${right}`;
  if (!right) return `${left}::`;
  return `${left}::${right}`;
}

export function isForbiddenAddress(address: string): boolean {
  const ipv4 = parseIpv4(address);
  if (ipv4) return isForbiddenIpv4(ipv4);
  const bytes = parseIpv6(address);
  if (!bytes) return true;

  const ipv4Mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  const ipv4Compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  if (ipv4Mapped || ipv4Compatible) return true;

  const nat64WellKnown =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0 &&
    bytes[5] === 0;
  const nat64Local =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0 &&
    bytes[5] === 0x01;
  if (nat64WellKnown || nat64Local) return true;

  const globalUnicast = (bytes[0] & 0xe0) === 0x20;
  const ietfSpecial =
    bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2] & 0xfe) === 0;
  const documentation2001 =
    bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
  const documentation3fff =
    bytes[0] === 0x3f && bytes[1] === 0xff && (bytes[2] & 0xf0) === 0;
  const uniqueLocal = (bytes[0] & 0xfe) === 0xfc;
  const linkLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80;
  const siteLocal = bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0xc0;
  const multicast = bytes[0] === 0xff;
  const sixToFour = bytes[0] === 0x20 && bytes[1] === 0x02;
  const teredo = bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0 && bytes[3] === 0;
  return (
    !globalUnicast ||
    ietfSpecial ||
    documentation2001 ||
    documentation3fff ||
    uniqueLocal ||
    linkLocal ||
    siteLocal ||
    multicast ||
    sixToFour ||
    teredo
  );
}

function assertExactDataProperties(
  value: unknown,
  fields: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!isPlainRecord(value)) throw new Error(`${label} is invalid`);
  const allowed = new Set(fields);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error(`${label} contains an unknown field`);
    }
  }
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor || !("value" in descriptor)) {
      throw new Error(`${label} fields must be own data properties`);
    }
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${label} is invalid`);
  }
}

function assertWholeNumber(value: unknown, label: string, minimum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}`);
  }
}

function assertSequence(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > RELAY_SEQUENCE_MAX) {
    throw new Error("relay sequence is invalid");
  }
}

function parseIpv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

function isForbiddenIpv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv6(address: string): number[] | null {
  let source = address.toLowerCase();
  let ipv4Tail: number[] = [];
  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    if (lastColon < 0) return null;
    const ipv4 = parseIpv4(source.slice(lastColon + 1));
    if (!ipv4) return null;
    ipv4Tail = ipv4;
    source = `${source.slice(0, lastColon)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }
  if ((source.match(/::/g) ?? []).length > 1) return null;
  const hasCompression = source.includes("::");
  const [leftSource, rightSource = ""] = source.split("::");
  const left = leftSource ? leftSource.split(":") : [];
  const right = rightSource ? rightSource.split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  if ((!hasCompression && left.length !== 8) || (hasCompression && left.length + right.length >= 8)) {
    return null;
  }
  const zeros = hasCompression ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array.from({ length: zeros }, () => "0"), ...right];
  if (groups.length !== 8) return null;
  const bytes = groups.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
  if (ipv4Tail.length > 0 && bytes.slice(12).join(",") !== ipv4Tail.join(",")) return null;
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  if (!HEX_256.test(hex)) throw new Error("relay HMAC must be lowercase hex");
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

function decodeBase64Url32(value: string): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new Error("relay HMAC key must be a canonical 32-byte base64url value");
  }
  const base64 = `${value.replace(/-/g, "+").replace(/_/g, "/") }=`;
  let decoded: string;
  try {
    decoded = atob(base64);
  } catch {
    throw new Error("relay HMAC key is invalid");
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32 || encodeBase64Url(bytes) !== value) {
    throw new Error("relay HMAC key must be canonical");
  }
  return bytes;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
