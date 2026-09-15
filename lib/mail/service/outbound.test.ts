import { describe, expect, it, vi } from "vitest";

import type { MailSendInput } from "../message-types";
import {
  createMailSendSubmissionProposal,
  fingerprintMailSendInput,
  MailSendError,
  ProviderNeutralMailSendService,
  runExclusiveOutboundBuild,
  validateMailSendInput,
  type MailReplyContextResolver,
  type MailSendAccountResolver,
  type MailSendEnqueueResult,
  type MailSendProvider,
  type MailSendStore,
  type StoredMailSendSubmission,
} from "./outbound";

const now = Date.parse("2026-07-15T10:00:00.000Z");
const accountId = `account-a${"1".repeat(32)}`;

describe("mail send input", () => {
  it("normalizes and freezes the exact public DTO", () => {
    const value = validateMailSendInput(composeInput());
    expect(value).toEqual(composeInput());
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.to)).toBe(true);
  });

  it.each([
    ["unknown field", { ...composeInput(), extra: true }],
    ["header injection", { ...composeInput(), subject: "Hi\r\nBcc: x@y.z" }],
    ["duplicate recipient", { ...composeInput(), cc: ["FRIEND@example.net"] }],
    ["compose reply target", { ...composeInput(), replyToMessageId: "message-1" }],
    [
      "reply without target",
      { ...composeInput(), mode: "reply", replyToMessageId: null },
    ],
    ["no recipient", { ...composeInput(), to: [] }],
    ["an origin nothing produces", { ...composeInput(), origin: "cron" }],
    ["an agent line that is not a flag", { ...composeInput(), agentLine: "yes" }],
    [
      "an attachment naming a path",
      {
        ...composeInput(),
        attachments: [
          {
            filename: "a/b.pdf",
            mimeType: "application/pdf",
            dataBase64: "AQID",
          },
        ],
      },
    ],
  ])("rejects %s", (_name, value) => {
    expect(() => validateMailSendInput(value)).toThrow(
      new MailSendError("mail_send_request_invalid"),
    );
  });
});

describe("outgoing attachments and the agent mark on a proposal", () => {
  const account = {
    accountId,
    providerKind: "gmail",
    emailAddress: "me@example.com",
    status: "connected",
  } as const;

  function proposalFor(input: MailSendInput) {
    return createMailSendSubmissionProposal({
      account,
      input: validateMailSendInput(input),
      reply: null,
      operationId: "send-00000000-0000-4000-8000-000000000001",
      createdAt: now,
    });
  }

  function rawOf(submission: { readonly message: { readonly rawRfc2822Base64Url: string } }) {
    return Buffer.from(submission.message.rawRfc2822Base64Url, "base64url").toString(
      "utf8",
    );
  }

  it("carries a page's file into the multipart body the provider submits", () => {
    const raw = rawOf(
      proposalFor({
        ...composeInput(),
        attachments: [
          {
            filename: "invoice.pdf",
            mimeType: "application/pdf",
            dataBase64: Buffer.from("PDF-BYTES").toString("base64"),
          },
        ],
      }),
    );
    expect(raw).toContain("Content-Type: multipart/mixed; boundary=");
    expect(raw).toContain('Content-Disposition: attachment; filename="invoice.pdf"');
    expect(raw).toContain(Buffer.from("PDF-BYTES").toString("base64"));
  });

  it("marks an agent's own message and leaves a person's unmarked", () => {
    expect(rawOf(proposalFor({ ...composeInput(), origin: "mcp" }))).toContain(
      "X-Brain-Agent: mcp\r\n",
    );
    expect(rawOf(proposalFor(composeInput()))).not.toContain("X-Brain-Agent");
  });

  it("separates two sends that differ only in the three new fields", () => {
    const person = fingerprintMailSendInput(validateMailSendInput(composeInput()));
    const agent = fingerprintMailSendInput(
      validateMailSendInput({ ...composeInput(), origin: "mcp" }),
    );
    const told = fingerprintMailSendInput(
      validateMailSendInput({ ...composeInput(), origin: "mcp", agentLine: true }),
    );
    const withFile = fingerprintMailSendInput(
      validateMailSendInput({
        ...composeInput(),
        attachments: [
          {
            filename: "invoice.pdf",
            mimeType: "application/pdf",
            dataBase64: "AQID",
          },
        ],
      }),
    );
    expect(new Set([person, agent, told, withFile]).size).toBe(4);
  });

  /** Two different files of the same size used to fold to the same
   *  fingerprint, so a second send under the first key replayed the first
   *  message instead of being refused as a conflict: the caller reads
   *  `created: false` and believes the message it wrote went out. */
  it("separates two files of the same size under one key", () => {
    const fingerprintWith = (dataBase64: string) =>
      fingerprintMailSendInput(
        validateMailSendInput({
          ...composeInput(),
          attachments: [
            { filename: "invoice.pdf", mimeType: "application/pdf", dataBase64 },
          ],
        }),
      );

    expect(fingerprintWith("AQID")).not.toEqual(fingerprintWith("BAUG"));
  });
});

describe("provider-neutral mail send service", () => {
  it("queues SMTP-owned IMAP sends without letting the legacy provider path claim them", async () => {
    const store = new MemoryMailSendStore();
    const service = new ProviderNeutralMailSendService({
      store,
      accounts: {
        readSendAccount: async () => ({
          accountId,
          providerKind: "imap",
          emailAddress: "me@example.com",
          status: "connected",
          sendConfigured: true,
        }),
      },
      replies: { resolveReplyContext: async () => null },
      providers: [],
      now: () => now,
      createOperationId: () =>
        "send-00000000-0000-4000-8000-000000000099",
    });

    const queued = await service.send(composeInput(), request());
    expect(queued).toEqual({
      apiVersion: 1,
      operationId: "send-00000000-0000-4000-8000-000000000099",
      created: true,
      status: "queued",
    });
    await expect(
      service.processOperation(queued.operationId, request()),
    ).resolves.toEqual({
      apiVersion: 1,
      operationId: queued.operationId,
      status: "queued",
      threadId: null,
    });
    expect(store.first()).toMatchObject({
      providerKind: "imap",
      version: 0,
      status: "queued",
      attemptCount: 0,
    });
  });

  it("rejects IMAP sending until that account has SMTP configured", async () => {
    const service = new ProviderNeutralMailSendService({
      store: new MemoryMailSendStore(),
      accounts: {
        readSendAccount: async () => ({
          accountId,
          providerKind: "imap",
          emailAddress: "me@example.com",
          status: "connected",
          sendConfigured: false,
        }),
      },
      replies: { resolveReplyContext: async () => null },
      providers: [],
      now: () => now,
    });
    const refused = await service.send(composeInput(), request()).catch((e) => e);
    expect(refused).toEqual(new MailSendError("mail_send_service_unavailable"));
    // Nothing was written, so a caller may say "refused" and use a fresh key.
    expect(refused.enqueued).toBe(false);
  });

  /** WHICH SIDE OF THE ENQUEUE A FAILURE FELL ON.
   *
   *  `/v1/send` makes the message durable and only then delivers, so a failure
   *  after that point is not "nothing happened": the outbox holds the message
   *  and will send it. The service is the only thing that knows which side it
   *  was, and it used to answer both with the same bare 503, which a caller
   *  reads as a refusal and answers with a fresh key. Two copies. */
  it("marks a failure raised after the durable enqueue as enqueued", async () => {
    const kept = new MemoryMailSendStore();
    const store: MailSendStore = {
      enqueue: (submission) => kept.enqueue(submission),
      readByOperationId: (operationId) => kept.readByOperationId(operationId),
      // The outbox write that claims the operation for this attempt. It runs
      // after the enqueue and before the provider is called.
      compareAndSwap: async () => {
        throw new Error("outbox write failed");
      },
    };
    const service = serviceFixture(store, acceptedProvider());

    const failure = await service.send(composeInput(), request()).catch((e) => e);

    expect(failure).toBeInstanceOf(MailSendError);
    expect(failure.code).toBe("mail_send_service_unavailable");
    expect(failure.enqueued).toBe(true);
    // And the message really is durable, which is what the flag claims.
    expect(kept.first()).toMatchObject({ status: "queued" });
  });

  /** The enqueue itself failing is the other side of the same line. */
  it("leaves a failure raised by the enqueue itself unmarked", async () => {
    const store: MailSendStore = {
      enqueue: async () => {
        throw new Error("outbox write failed");
      },
      readByOperationId: async () => null,
      compareAndSwap: async () => false,
    };
    const service = serviceFixture(store, acceptedProvider());

    const failure = await service.send(composeInput(), request()).catch((e) => e);

    expect(failure.code).toBe("mail_send_service_unavailable");
    expect(failure.enqueued).toBe(false);
  });

  it("sends once, persists the result, and deduplicates the same request", async () => {
    const store = new MemoryMailSendStore();
    let rawReference: Buffer | null = null;
    const provider: MailSendProvider = {
      providerKind: "gmail",
      send: vi.fn(async (message, hooks) => {
        expect(message.providerThreadId).toBeNull();
        expect(message.rawRfc2822.toString("utf8")).toContain(
          "To: friend@example.net\r\n",
        );
        rawReference = message.rawRfc2822;
        await hooks.beforeDelivery();
        return {
          kind: "accepted",
          providerMessageId: "gmail-message-1",
          providerThreadId: "gmail-thread-1",
        } as const;
      }),
    };
    const service = serviceFixture(store, provider);

    const first = await service.send(composeInput(), request());
    const repeated = await service.send(composeInput(), request());

    expect(first).toEqual({
      apiVersion: 1,
      operationId: "send-00000000-0000-4000-8000-000000000001",
      created: true,
      status: "sent",
    });
    expect(repeated).toEqual({ ...first, created: false });
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(rawReference).not.toBeNull();
    expect((rawReference as unknown as Buffer).every((byte: number) => byte === 0)).toBe(true);
    await expect(service.status(first.operationId)).resolves.toEqual({
      apiVersion: 1,
      operationId: first.operationId,
      status: "sent",
      threadId: "gmail-thread-1",
    });
  });

  it("rejects an idempotency key reused for different content", async () => {
    const store = new MemoryMailSendStore();
    const service = serviceFixture(store, acceptedProvider());
    await service.send(composeInput(), request());

    await expect(
      service.send({ ...composeInput(), text: "Different" }, request()),
    ).rejects.toEqual(new MailSendError("mail_send_idempotency_conflict"));
  });

  it("resolves reply headers server-side for the exact account and cached message", async () => {
    const store = new MemoryMailSendStore();
    const provider: MailSendProvider = {
      providerKind: "gmail",
      send: vi.fn(async (message, hooks) => {
        expect(message.providerThreadId).toBe("gmail-thread-parent");
        const source = message.rawRfc2822.toString("utf8");
        expect(source).toContain("In-Reply-To: <parent@example.net>\r\n");
        expect(source).toContain(
          "References: <root@example.net>\r\n <parent@example.net>\r\n",
        );
        await hooks.beforeDelivery();
        return {
          kind: "accepted",
          providerMessageId: "gmail-message-reply",
          providerThreadId: "gmail-thread-parent",
        } as const;
      }),
    };
    const resolveReplyContext = vi.fn(async () => ({
        providerThreadId: "gmail-thread-parent",
        rfcMessageId: "<parent@example.net>",
        references: ["<root@example.net>"],
      }));
    const service = serviceFixture(store, provider, { resolveReplyContext });

    const result = await service.send(
      {
        ...composeInput(),
        mode: "reply",
        replyToMessageId: "cached-message-1",
      },
      request(),
    );

    expect(result.status).toBe("sent");
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(resolveReplyContext).toHaveBeenCalledWith(
      accountId,
      "cached-message-1",
    );
  });

  it("makes a transport loss after the durable barrier terminally unknown", async () => {
    const store = new MemoryMailSendStore();
    const provider: MailSendProvider = {
      providerKind: "gmail",
      send: vi.fn(async (_message, hooks) => {
        await hooks.beforeDelivery();
        throw new Error("network detail that must not escape");
      }),
    };
    const service = serviceFixture(store, provider);

    const result = await service.send(composeInput(), request());
    const repeated = await service.send(composeInput(), request());

    expect(result.status).toBe("delivery_unknown");
    expect(repeated.status).toBe("delivery_unknown");
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("network detail");
  });

  it("keeps a pre-delivery failure queued and allows a safe retry", async () => {
    const store = new MemoryMailSendStore();
    let calls = 0;
    const provider: MailSendProvider = {
      providerKind: "gmail",
      send: vi.fn(async (_message, hooks) => {
        calls += 1;
        if (calls === 1) throw new Error("token service unavailable");
        await hooks.beforeDelivery();
        return {
          kind: "accepted",
          providerMessageId: "gmail-message-2",
          providerThreadId: "gmail-thread-2",
        } as const;
      }),
    };
    let currentNow = now;
    const service = serviceFixture(
      store,
      provider,
      undefined,
      () => currentNow,
    );

    const queued = await service.send(composeInput(), request());
    expect(queued).toMatchObject({ created: true, status: "queued" });
    currentNow += 5_000;
    await expect(
      service.processOperation(queued.operationId, request()),
    ).resolves.toMatchObject({
      status: "sent",
    });
    expect(provider.send).toHaveBeenCalledTimes(2);
  });

  it("recovers an expired pre-delivery lease without a second user action", async () => {
    const store = new MemoryMailSendStore();
    let currentNow = now;
    let calls = 0;
    const provider: MailSendProvider = {
      providerKind: "gmail",
      send: vi.fn(async (_message, hooks) => {
        calls += 1;
        if (calls === 1) throw new Error("before barrier");
        await hooks.beforeDelivery();
        return {
          kind: "accepted",
          providerMessageId: "gmail-message-recovered",
          providerThreadId: "gmail-thread-recovered",
        } as const;
      }),
    };
    const service = serviceFixture(store, provider, undefined, () => currentNow);
    const queued = await service.send(composeInput(), request());
    const durable = store.first()!;
    const expired = {
      ...durable,
      version: durable.version + 1,
      status: "sending" as const,
      lease: {
        attemptId: "attempt-00000000-0000-4000-8000-000000000099",
        expiresAt: currentNow - 1,
        deliveryRisk: false,
      },
      nextAttemptAt: null,
    };
    await expect(
      store.compareAndSwap(durable.operationId, durable.version, expired),
    ).resolves.toBe(true);

    currentNow += 1;
    await expect(
      service.processOperation(queued.operationId, request()),
    ).resolves.toMatchObject({ status: "sent" });
    expect(provider.send).toHaveBeenCalledTimes(2);
  });

  it("never retries an expired lease after the delivery barrier", async () => {
    const store = new MemoryMailSendStore();
    let currentNow = now;
    const provider: MailSendProvider = {
      providerKind: "gmail",
      send: vi.fn(async () => {
        throw new Error("before barrier");
      }),
    };
    const service = serviceFixture(store, provider, undefined, () => currentNow);
    const queued = await service.send(composeInput(), request());
    const durable = store.first()!;
    const expired = {
      ...durable,
      version: durable.version + 1,
      status: "sending" as const,
      lease: {
        attemptId: "attempt-00000000-0000-4000-8000-000000000098",
        expiresAt: currentNow - 1,
        deliveryRisk: true,
      },
      nextAttemptAt: null,
    };
    await store.compareAndSwap(durable.operationId, durable.version, expired);

    currentNow += 1;
    await expect(
      service.processOperation(queued.operationId, request()),
    ).resolves.toMatchObject({ status: "delivery_unknown" });
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it("lets an HTTP retry race the worker without a duplicate provider call", async () => {
    const store = new MemoryMailSendStore();
    let currentNow = now;
    let calls = 0;
    const provider: MailSendProvider = {
      providerKind: "gmail",
      send: vi.fn(async (_message, hooks) => {
        calls += 1;
        if (calls === 1) throw new Error("temporary token outage");
        await hooks.beforeDelivery();
        return {
          kind: "accepted",
          providerMessageId: "gmail-message-race",
          providerThreadId: "gmail-thread-race",
        } as const;
      }),
    };
    const service = serviceFixture(store, provider, undefined, () => currentNow);
    const queued = await service.send(composeInput(), request());
    currentNow += 5_000;

    const [requestResult, workerResult] = await Promise.all([
      service.send(composeInput(), request()),
      service.processOperation(queued.operationId, request()),
    ]);
    expect([requestResult.status, workerResult.status]).toContain("sent");
    expect(provider.send).toHaveBeenCalledTimes(2);
    await expect(service.status(queued.operationId)).resolves.toMatchObject({
      status: "sent",
    });
  });

  it("persists and returns a definite provider rejection as a failed operation", async () => {
    const store = new MemoryMailSendStore();
    const provider: MailSendProvider = {
      providerKind: "gmail",
      send: vi.fn(async (_message, hooks) => {
        await hooks.beforeDelivery();
        return {
          kind: "rejected",
          errorCode: "mail_send_account_reauth_required",
        } as const;
      }),
    };
    const service = serviceFixture(store, provider);

    await expect(service.send(composeInput(), request())).resolves.toMatchObject({
      created: true,
      status: "failed",
    });
    const operationId = store.first()!.operationId;
    await expect(service.status(operationId)).resolves.toEqual({
      apiVersion: 1,
      operationId,
      status: "failed",
      threadId: null,
    });
  });

  it("requeues a definite rate limit even after the durable barrier", async () => {
    const store = new MemoryMailSendStore();
    const provider: MailSendProvider = {
      providerKind: "gmail",
      send: vi.fn(async (_message, hooks) => {
        await hooks.beforeDelivery();
        return {
          kind: "retryable_rejection",
          errorCode: "mail_send_rate_limited",
          retryAfterMs: 120_000,
        } as const;
      }),
    };
    const service = serviceFixture(store, provider);

    await expect(service.send(composeInput(), request())).resolves.toMatchObject({
      status: "queued",
    });
    expect(store.first()).toMatchObject({
      status: "queued",
      lease: null,
      lastErrorCode: "mail_send_rate_limited",
      nextAttemptAt: now + 120_000,
    });
  });

  it("fails closed when a reply target is missing", async () => {
    const service = serviceFixture(
      new MemoryMailSendStore(),
      acceptedProvider(),
      { resolveReplyContext: vi.fn(async () => null) },
    );
    await expect(
      service.send(
        {
          ...composeInput(),
          mode: "reply",
          replyToMessageId: "missing-message",
        },
        request(),
      ),
    ).rejects.toEqual(new MailSendError("mail_send_reply_target_not_found"));
  });

  it("fails closed when cached reply metadata is not safe for RFC headers", async () => {
    const service = serviceFixture(
      new MemoryMailSendStore(),
      acceptedProvider(),
      {
        resolveReplyContext: vi.fn(async () => ({
          providerThreadId: "gmail-thread-parent",
          rfcMessageId: "missing-angle-brackets",
          references: [],
        })),
      },
    );
    await expect(
      service.send(
        {
          ...composeInput(),
          mode: "reply",
          replyToMessageId: "cached-message-1",
        },
        request(),
      ),
    ).rejects.toEqual(new MailSendError("mail_send_reply_target_not_found"));
  });
});

describe("one outbound build at a time", () => {
  it("starts a build only once the build before it has ended", async () => {
    const steps: string[] = [];
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runExclusiveOutboundBuild(async () => {
      steps.push("first in");
      await firstDone;
      steps.push("first out");
      return 1;
    });
    const second = runExclusiveOutboundBuild(() => {
      steps.push("second in");
      return 2;
    });

    await Promise.resolve();
    expect(steps).toEqual(["first in"]);
    releaseFirst();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(steps).toEqual(["first in", "first out", "second in"]);
  });

  it("keeps the queue moving after a build throws", async () => {
    const failed = runExclusiveOutboundBuild(() => {
      throw new Error("build failed");
    });
    await expect(failed).rejects.toThrow("build failed");
    await expect(runExclusiveOutboundBuild(() => "next")).resolves.toBe("next");
  });

  it("holds a second send's build until the first send has finished its own", async () => {
    const store = new MemoryMailSendStore();
    const enqueued: string[] = [];
    const record = store.enqueue.bind(store);
    vi.spyOn(store, "enqueue").mockImplementation(async (submission) => {
      enqueued.push(submission.idempotencyKey);
      return record(submission);
    });
    const service = serviceFixture(store, acceptedProvider());

    let release!: () => void;
    const held = runExclusiveOutboundBuild(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const first = service.send(
      { ...composeInput(), idempotencyKey: "queued-send-one" },
      request(),
    );
    const second = service.send(
      {
        ...composeInput(),
        idempotencyKey: "queued-send-two",
        text: "Second body",
      },
      request(),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(enqueued).toEqual([]);

    release();
    await held;
    await Promise.all([first, second]);
    expect(enqueued).toEqual(["queued-send-one", "queued-send-two"]);
  });
});

function composeInput(): MailSendInput {
  return {
    accountId,
    idempotencyKey: "compose-action-1",
    mode: "compose",
    to: ["friend@example.net"],
    cc: [],
    bcc: [],
    subject: "Hello",
    text: "Body",
    replyToMessageId: null,
    attachments: [],
    origin: "app",
    agentLine: false,
  };
}

function request() {
  return {
    deadlineAt: now + 5 * 60_000,
    signal: new AbortController().signal,
  };
}

function acceptedProvider(): MailSendProvider {
  return {
    providerKind: "gmail",
    send: vi.fn(async (_message, hooks) => {
      await hooks.beforeDelivery();
      return {
        kind: "accepted",
        providerMessageId: "gmail-message-1",
        providerThreadId: "gmail-thread-1",
      } as const;
    }),
  };
}

function serviceFixture(
  store: MailSendStore,
  provider: MailSendProvider,
  replies: MailReplyContextResolver | undefined = undefined,
  readTime: () => number = () => now,
) {
  const replyResolver = replies ?? {
    resolveReplyContext: vi.fn(async () => null),
  };
  const accounts: MailSendAccountResolver = {
    readSendAccount: vi.fn(async () => ({
      accountId,
      providerKind: "gmail",
      emailAddress: "me@example.com",
      status: "connected",
    }) as const),
  };
  let nextOperation = 1;
  return new ProviderNeutralMailSendService({
    store,
    accounts,
    replies: replyResolver,
    providers: [provider],
    now: readTime,
    createOperationId: () =>
      `send-00000000-0000-4000-8000-${String(nextOperation++).padStart(12, "0")}`,
  });
}

class MemoryMailSendStore implements MailSendStore {
  private readonly records = new Map<string, StoredMailSendSubmission>();
  private readonly operations = new Map<string, string>();

  async enqueue(
    submission: StoredMailSendSubmission,
  ): Promise<MailSendEnqueueResult> {
    const key = `${submission.accountId}:${submission.idempotencyKey}`;
    const operationId = this.operations.get(key);
    if (operationId !== undefined) {
      const existing = this.records.get(operationId)!;
      if (existing.requestFingerprint !== submission.requestFingerprint) {
        throw new MailSendError("mail_send_idempotency_conflict");
      }
      return { created: false, submission: clone(existing) };
    }
    this.records.set(submission.operationId, clone(submission));
    this.operations.set(key, submission.operationId);
    return { created: true, submission: clone(submission) };
  }

  async readByOperationId(
    operationId: string,
  ): Promise<StoredMailSendSubmission | null> {
    const value = this.records.get(operationId);
    return value === undefined ? null : clone(value);
  }

  async compareAndSwap(
    operationId: string,
    expectedVersion: number,
    next: StoredMailSendSubmission,
  ): Promise<boolean> {
    const current = this.records.get(operationId);
    if (current === undefined || current.version !== expectedVersion) return false;
    if (next.version !== expectedVersion + 1) throw new Error("invalid version");
    this.records.set(operationId, clone(next));
    return true;
  }

  first(): StoredMailSendSubmission | null {
    const value = this.records.values().next().value as
      | StoredMailSendSubmission
      | undefined;
    return value === undefined ? null : clone(value);
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
