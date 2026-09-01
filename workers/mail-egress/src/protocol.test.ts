import { describe, expect, it } from "vitest";

import {
  RELAY_MAX_CONTROL_BYTES,
  RELAY_MAX_FRAME_BYTES,
  RELAY_SEQUENCE_MAX,
  authorizationPayload,
  canonicalizeLiteralAddress,
  canonicalizeRelayAuthorization,
  createRelayChallenge,
  decodeDataFrame,
  encodeAckControl,
  encodeDataFrame,
  encodeEofControl,
  isForbiddenAddress,
  nextSequence,
  parseAckControl,
  parseAuthorizeControl,
  parseControlJson,
  parseEofControl,
  projectRelayAuthorization,
  verifyRelayAuthorizationHmac,
  type RelayAuthorization,
  type RelayChallenge,
} from "./protocol";

const challenge: RelayChallenge = {
  version: 1,
  audience: "brain-mail-smtp-egress-v1",
  challenge: "a".repeat(64),
  issuedAt: 1_000,
  expiresAt: 6_000,
};

const authorization: RelayAuthorization = {
  ...challenge,
  transport: "authenticated_byte_relay",
  sessionId: "relay-session",
  attemptId: "relay-attempt",
  resolutionId: "relay-resolution",
  address: "1.1.1.1",
  family: 4,
  port: 465,
  targetExpiresAt: 61_000,
  deadlineAt: 31_000,
  hmacSha256: "b".repeat(64),
};

describe("Mail egress relay wire protocol", () => {
  it("creates an exact five-second 256-bit challenge", () => {
    expect(createRelayChallenge(1_000, new Uint8Array(32).fill(0xab))).toEqual({
      version: 1,
      audience: "brain-mail-smtp-egress-v1",
      challenge: "ab".repeat(32),
      issuedAt: 1_000,
      expiresAt: 6_000,
    });
    expect(() => createRelayChallenge(1_000, new Uint8Array(31))).toThrow(/32 random/i);
  });

  it("matches Brain's canonical HMAC payload byte for byte", () => {
    expect(canonicalizeRelayAuthorization(authorizationPayload(authorization))).toBe(
      [
        "brain-mail-smtp-egress-hmac-v1",
        "1",
        "brain-mail-smtp-egress-v1",
        "authenticated_byte_relay",
        "a".repeat(64),
        "1000",
        "6000",
        "relay-session",
        "relay-attempt",
        "relay-resolution",
        "1.1.1.1",
        "4",
        "465",
        "61000",
        "31000",
      ].join("\n"),
    );
  });

  it("verifies HMAC with SubtleCrypto and rejects a modified signature", async () => {
    const key = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
    const signed = {
      ...authorization,
      hmacSha256: "3a97c31941f5b7af55317999fee117ed051e589d2ba54d59dfa7fc5bc8096cef",
    };
    await expect(verifyRelayAuthorizationHmac(key, signed)).resolves.toBe(true);
    await expect(
      verifyRelayAuthorizationHmac(key, { ...signed, hmacSha256: "0".repeat(64) }),
    ).resolves.toBe(false);
  });

  it("binds authorization to this connection challenge and exact target", () => {
    const control = JSON.stringify({ type: "authorize", authorization });
    expect(parseAuthorizeControl(control, challenge, 1_000).authorization).toEqual(
      authorization,
    );
    expect(() =>
      parseAuthorizeControl(
        control,
        { ...challenge, challenge: "c".repeat(64) },
        1_000,
      ),
    ).toThrow(/this connection/i);
    expect(() =>
      projectRelayAuthorization({ ...authorization, port: 25 }, challenge, 1_000),
    ).toThrow(/port/i);
    expect(() =>
      projectRelayAuthorization(
        { ...authorization, address: "127.0.0.1" },
        challenge,
        1_000,
      ),
    ).toThrow(/public literal/i);
    expect(() =>
      projectRelayAuthorization(
        { ...authorization, deadlineAt: 61_001 },
        challenge,
        1_000,
      ),
    ).toThrow(/deadline/i);
    expect(() =>
      projectRelayAuthorization(
        { ...authorization, secret: "must-not-cross" },
        challenge,
        1_000,
      ),
    ).toThrow(/unknown field/i);
    expect(() => projectRelayAuthorization(authorization, challenge, 6_000)).toThrow(
      /not fresh/i,
    );
  });

  it("accepts only canonical public literals in both address families", () => {
    expect(canonicalizeLiteralAddress("2606:4700:4700:0:0:0:0:1111", 6)).toBe(
      "2606:4700:4700::1111",
    );
    expect(isForbiddenAddress("1.1.1.1")).toBe(false);
    expect(isForbiddenAddress("2606:4700:4700::1111")).toBe(false);
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.0.2.1",
      "::1",
      "fc00::1",
      "fe80::1",
      "2001:db8::1",
      "3fff::1",
      "64:ff9b::7f00:1",
      "::ffff:1.1.1.1",
    ]) {
      expect(isForbiddenAddress(address), address).toBe(true);
    }
  });

  it("frames only non-empty 16 KiB DATA chunks with uint32 sequences", () => {
    const payload = new Uint8Array(RELAY_MAX_FRAME_BYTES).fill(7);
    const frame = encodeDataFrame(RELAY_SEQUENCE_MAX, payload);
    const decoded = decodeDataFrame(frame);
    expect(decoded.sequence).toBe(RELAY_SEQUENCE_MAX);
    expect(decoded.payload).toEqual(payload);
    expect(() => encodeDataFrame(0, new Uint8Array())).toThrow(/size/i);
    expect(() => encodeDataFrame(0, new Uint8Array(RELAY_MAX_FRAME_BYTES + 1))).toThrow(
      /size/i,
    );
    expect(() => decodeDataFrame(new ArrayBuffer(4))).toThrow(/size/i);
    expect(() => nextSequence(RELAY_SEQUENCE_MAX)).toThrow(/exhausted/i);
  });

  it("accepts only the exact ACK for the one in-flight sequence", () => {
    expect(encodeAckControl(7)).toBe('{"type":"ack","sequence":7}');
    expect(parseAckControl('{"type":"ack","sequence":7}', 7)).toEqual({
      type: "ack",
      sequence: 7,
    });
    expect(() => parseAckControl('{"type":"ack","sequence":6}', 7)).toThrow(
      /does not match/i,
    );
    expect(() =>
      parseAckControl('{"type":"ack","sequence":7,"extra":true}', 7),
    ).toThrow(/unknown field/i);
  });

  it("binds half-close controls to the next DATA sequence", () => {
    expect(encodeEofControl("client_eof", 8)).toBe(
      '{"type":"client_eof","sequence":8}',
    );
    expect(parseEofControl('{"type":"server_eof","sequence":9}', "server_eof", 9)).toEqual({
      type: "server_eof",
      sequence: 9,
    });
    expect(() =>
      parseEofControl('{"type":"server_eof","sequence":8}', "server_eof", 9),
    ).toThrow(/next DATA/i);
    expect(() =>
      parseEofControl('{"type":"client_eof_ack","sequence":9}', "server_eof", 9),
    ).toThrow(/type/i);
  });

  it("bounds and strictly parses text controls", () => {
    expect(parseControlJson("{}")).toEqual({});
    expect(() => parseControlJson("not json")).toThrow(/valid JSON/i);
    expect(() => parseControlJson(JSON.stringify("text"))).toThrow(/invalid/i);
    expect(() => parseControlJson("x".repeat(RELAY_MAX_CONTROL_BYTES + 1))).toThrow(
      /size/i,
    );
  });
});
