import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeProbeTlsRelay,
  createTlsRelayTransport,
  probeHeartbeatIntervals,
  readLiveProbeConfig,
} from "./mail-egress-live-probe";

const KEY = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("Mail egress live-probe configuration", () => {
  it("never leaves more than five seconds between 31-second hold heartbeats", () => {
    expect(probeHeartbeatIntervals(31)).toEqual([
      5_000,
      5_000,
      5_000,
      5_000,
      5_000,
      5_000,
      1_000,
    ]);
    expect(probeHeartbeatIntervals(0)).toEqual([]);
  });

  it("loads the one-time HMAC only from an owner-only strict JSON file", async () => {
    const path = await keyFile(JSON.stringify({ MAIL_EGRESS_HMAC_KEY: KEY }), 0o600);
    expect(readLiveProbeConfig(environment(path)).relay.hmacKeyBase64Url).toBe(KEY);
  });

  it("rejects literal HMAC values and key/key-file ambiguity", async () => {
    const path = await keyFile(JSON.stringify({ MAIL_EGRESS_HMAC_KEY: KEY }), 0o600);
    expect(() =>
      readLiveProbeConfig({ ...environment(path), BRAIN_MAIL_EGRESS_HMAC_KEY: KEY }),
    ).toThrow(/config_hmac_ambiguous/);
    expect(() =>
      readLiveProbeConfig({
        ...environment(path),
        BRAIN_MAIL_EGRESS_HMAC_KEY_FILE: undefined,
        BRAIN_MAIL_EGRESS_HMAC_KEY: KEY,
      }),
    ).toThrow(/config_hmac_literal_forbidden/);
  });

  it("rejects broad permissions and extended JSON", async () => {
    const broad = await keyFile(JSON.stringify({ MAIL_EGRESS_HMAC_KEY: KEY }), 0o644);
    expect(() => readLiveProbeConfig(environment(broad))).toThrow(/permissions_invalid/);

    const extended = await keyFile(
      JSON.stringify({ MAIL_EGRESS_HMAC_KEY: KEY, secret: "must-not-cross" }),
      0o600,
    );
    expect(() => readLiveProbeConfig(environment(extended))).toThrow(/shape_invalid/);

    const nonCanonical = await keyFile(
      JSON.stringify({ MAIL_EGRESS_HMAC_KEY: `${KEY}=` }),
      0o600,
    );
    expect(() => readLiveProbeConfig(environment(nonCanonical))).toThrow(/shape_invalid/);
  });

  it("waits for SMTP 221 before relay EOF and still requires server EOF", async () => {
    const events: string[] = [];
    const tls = lifecycleDuplex("tls", events);
    const relay = lifecycleDuplex("relay", events);
    let resolveQuit!: () => void;
    const quitReply = new Promise<void>((resolve) => {
      resolveQuit = resolve;
    });
    let resolveRelayClosed!: () => void;
    const relayClosed = new Promise<void>((resolve) => {
      resolveRelayClosed = resolve;
    });
    let settled = false;
    const closing = closeProbeTlsRelay(
      tls as unknown as TLSSocket,
      relay,
      quitReply,
      relayClosed,
      Date.now() + 5_000,
    ).then(() => {
      settled = true;
    });

    await turn();
    expect(events).toEqual(["tls:write:QUIT\r\n"]);
    expect(settled).toBe(false);
    resolveQuit();
    await turn();
    expect(events).toEqual([
      "tls:write:QUIT\r\n",
      "relay:final",
      "relay:finish",
    ]);
    expect(settled).toBe(false);
    relay.resume();
    relay.push(null);
    tls.destroy();
    await turn();
    expect(settled).toBe(false);
    resolveRelayClosed();
    await closing;
    relay.destroy();
  });

  it("rejects a late abnormal WebSocket close after both local relay EOFs", async () => {
    const events: string[] = [];
    const tls = lifecycleDuplex("tls", events);
    const relay = lifecycleDuplex("relay", events);
    let resolveQuit!: () => void;
    const quitReply = new Promise<void>((resolve) => {
      resolveQuit = resolve;
    });
    let rejectRelayClosed!: (error: Error) => void;
    const relayClosed = new Promise<void>((_resolve, reject) => {
      rejectRelayClosed = reject;
    });
    const closing = closeProbeTlsRelay(
      tls as unknown as TLSSocket,
      relay,
      quitReply,
      relayClosed,
      Date.now() + 5_000,
    );
    void closing.catch(() => undefined);

    await turn();
    resolveQuit();
    relay.resume();
    relay.push(null);
    await turn();
    rejectRelayClosed(new Error("late WebSocket 1006"));
    await expect(closing).rejects.toThrow(/1006/);
    relay.destroy();
  });

  it("keeps the raw relay alive when a remote-first TLS close destroys its adapter", async () => {
    const events: string[] = [];
    const relay = lifecycleDuplex("relay", events);
    const tlsTransport = createTlsRelayTransport(relay);
    tlsTransport.on("error", () => undefined);
    tlsTransport.destroy(new Error("remote-first TLS close"));
    await turn();
    expect(relay.destroyed).toBe(false);
    expect(relay.writableEnded).toBe(false);
    const relayEnded = new Promise<void>((resolve) => relay.once("end", resolve));
    relay.push(Buffer.from("remaining encrypted close"));
    relay.push(null);
    await relayEnded;
    expect(relay.writableEnded).toBe(false);
    relay.end();
    relay.destroy();
  });
});

function lifecycleDuplex(name: string, events: string[]): Duplex {
  const stream = new Duplex({
    read() {},
    write(chunk: Buffer, _encoding, callback) {
      events.push(`${name}:write:${chunk.toString("ascii")}`);
      callback();
    },
    final(callback) {
      events.push(`${name}:final`);
      callback();
    },
  });
  stream.on("finish", () => events.push(`${name}:finish`));
  return stream;
}

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function keyFile(source: string, mode: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "brain-mail-probe-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "key.json");
  await writeFile(path, source, { mode });
  await chmod(path, mode);
  return path;
}

function environment(path: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    BRAIN_MAIL_EGRESS_URL: "wss://relay.example.test/v1/tunnel",
    BRAIN_MAIL_EGRESS_HMAC_KEY_FILE: path,
    BRAIN_MAIL_EGRESS_SMTP_HOST: "smtp.example.test",
  };
}
