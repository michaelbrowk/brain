import { EventEmitter } from "node:events";
import type net from "node:net";

import { describe, expect, it, vi } from "vitest";

import type { MailDnsResolverPort } from "../ports";
import { validateResolvedMailTargets } from "../security";
import type { SqliteMailAccountStore } from "./account-store";
import type { SqliteMailSendStore } from "./outbound-store";
import { createOptionalProductionSmtpRuntime } from "./smtp-runtime";
import { MailSmtpSubmissionWorker } from "./smtp-worker";

const PUBLIC_ADDRESS = "93.184.216.34";

/**
 * The runtime only holds the stores until a worker pass or a send resolves
 * an account, and this file never runs either. Composition is what is under
 * test, so the stores are empty stand-ins rather than SQLite files.
 */
const accountStore = {} as SqliteMailAccountStore;
const outboxStore = {} as SqliteMailSendStore;

class FakeDirectSocket extends EventEmitter {
  destroyed = false;
  remoteAddress: string | undefined;

  setNoDelay(): this {
    return this;
  }

  destroy(): void {
    this.destroyed = true;
  }
}

function pinnedDns(): MailDnsResolverPort {
  return {
    async resolve(protocol, endpoint) {
      const now = Date.now();
      return validateResolvedMailTargets(
        protocol,
        endpoint,
        {
          resolutionId: "dns-r1",
          resolvedAt: now,
          expiresAt: now + 60_000,
          addresses: [{ address: PUBLIC_ADDRESS, family: 4 as const }],
        },
        now,
      );
    },
  };
}

describe("production SMTP runtime composition", () => {
  it("stays absent when no transport flag is set", async () => {
    await expect(
      createOptionalProductionSmtpRuntime({
        environment: {},
        accountStore,
        outboxStore,
        dns: pinnedDns(),
        onEvent: () => undefined,
      }),
    ).resolves.toBeNull();
  });

  it("dials the provider itself when direct submission is enabled", async () => {
    const dialed: Array<{ host: string; port: number; family: 4 | 6 }> = [];
    const createConnection = vi.fn((options: {
      readonly host: string;
      readonly port: number;
      readonly family: 4 | 6;
    }) => {
      dialed.push({ ...options });
      const socket = new FakeDirectSocket();
      queueMicrotask(() => socket.emit("error", new Error("refused")));
      return socket as unknown as net.Socket;
    });
    const runtime = await createOptionalProductionSmtpRuntime({
      environment: { BRAIN_MAIL_SMTP_DIRECT_ENABLED: "1" },
      accountStore,
      outboxStore,
      dns: pinnedDns(),
      onEvent: () => undefined,
      createConnection,
    });

    expect(runtime).not.toBeNull();
    if (runtime === null) throw new Error("expected a runtime");
    expect(runtime.transport).toBe("direct");
    expect(runtime.worker).toBeInstanceOf(MailSmtpSubmissionWorker);
    // The verifier reaches the injected dialer with the validated literal
    // address, which is only possible through the direct factory: the relay
    // factory would open a WebSocket to a URL that was never configured.
    await expect(
      runtime.verifier.verify({
        endpoint: { hostname: "smtp.example.test", port: 465, tls: "implicit" },
        username: "person@example.test",
        password: Buffer.from("test-only-password", "utf8"),
        deadlineAt: Date.now() + 5_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "smtp_connection_failed" });
    expect(dialed).toEqual([{ host: PUBLIC_ADDRESS, port: 465, family: 4 }]);
  });
});
