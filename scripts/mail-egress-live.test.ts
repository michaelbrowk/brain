import { beforeAll, describe, expect, it } from "vitest";

import {
  probeImplicitTls,
  probeStartTls,
  probeWrongHostname,
  readLiveProbeConfig,
  type LiveProbeConfig,
} from "./mail-egress-live-probe";

const liveEnabled = process.env.BRAIN_MAIL_EGRESS_LIVE === "1";
if (process.env.BRAIN_MAIL_EGRESS_REQUIRE_LIVE === "1" && !liveEnabled) {
  throw new Error("BRAIN_MAIL_EGRESS_LIVE=1 is required for the live probe command");
}
const liveDescribe = liveEnabled ? describe.sequential : describe.skip;

liveDescribe("Cloudflare SMTP egress live no-AUTH probe", () => {
  let config: LiveProbeConfig;

  beforeAll(() => {
    config = readLiveProbeConfig(process.env);
  });

  it("proves implicit TLS on port 465 with original SNI", async () => {
    const result = await probeImplicitTls(config);
    expect(result).toEqual({
      port: 465,
      family: config.family,
      tlsAuthorized: true,
      originalSni: true,
      startTls: false,
      heldFor31Seconds: false,
      authCommandsSent: 0,
    });
  }, 90_000);

  it("proves greeting, EHLO, STARTTLS and inner TLS on port 587", async () => {
    const result = await probeStartTls(config);
    expect(result).toEqual({
      port: 587,
      family: config.family,
      tlsAuthorized: true,
      originalSni: true,
      startTls: true,
      heldFor31Seconds: config.holdSeconds === 31,
      authCommandsSent: 0,
    });
  }, 90_000);

  it("rejects a wrong hostname before any authentication command", async () => {
    const result = await probeWrongHostname(config);
    expect(result).toMatchObject({
      port: 587,
      rejectedBeforeAuth: true,
      authCommandsSent: 0,
    });
  }, 90_000);
});
