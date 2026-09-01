import { createHash } from "node:crypto";

import type { FetchMessageObject, MailboxObject } from "imapflow";
import { describe, expect, it, vi } from "vitest";

import type { MailBlobDescriptor, MailIncomingBlobStorePort } from "../../ports";
import {
  MailAccountError,
  type StoredImapMailAccount,
} from "../../service/account-types";
import { MailContentSourceError } from "../../service/content-source";
import {
  MAX_IMAP_READ_LITERAL_BYTES,
  type ImapSessionClient,
} from "../../service/imapflow-adapter";
import { MailProviderSyncError } from "../../service/message-service";
import { ImapContentSourceAdapter, type ImapReadSessions } from "./sync-adapter";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const OTHER_ACCOUNT_ID = "account-a22222222222222222222222222222222";
const UID_VALIDITY = BigInt(77);
const MESSAGE_ID = "i77u21";
const CHUNK = MAX_IMAP_READ_LITERAL_BYTES;

describe("IMAP provider-neutral content source", () => {
  it("streams BODY.PEEK slices through one read-only Inbox session into the staged blob", async () => {
    const raw = Buffer.alloc(CHUNK + 100, 0x41);
    const fixture = adapterFixture({ raw });

    const result = await fixture.adapter.fetchRaw(fetchInput());

    expect(result).toEqual({ descriptor: describe_(raw) });
    expect(fixture.store.received()).toEqual(raw);
    expect(fixture.store.maxBytes).toEqual([40 * 1024 * 1024]);
    expect(fixture.client.getMailboxLock).toHaveBeenCalledWith(
      "INBOX",
      expect.objectContaining({ readOnly: true }),
    );
    expect(fixture.lock.release).toHaveBeenCalledTimes(1);
    expect(fixture.client.fetchAll.mock.calls).toEqual([
      [
        [21],
        { uid: true, size: true, source: { start: 0, maxLength: CHUNK } },
        { uid: true },
      ],
      [[21], { uid: true, source: { start: CHUNK, maxLength: CHUNK } }, { uid: true }],
    ]);
    expect(fixture.sessions.calls).toEqual([
      [fixture.account, expect.any(AbortSignal)],
    ]);
    // The descriptor is returned only after the provider session has closed,
    // so the isolated parse step never overlaps an open IMAP connection.
    expect(fixture.sessions.closedSessions).toBe(1);
  });

  it("stops after an exact chunk multiple when the next slice is empty", async () => {
    const raw = Buffer.alloc(CHUNK * 2, 0x42);
    const fixture = adapterFixture({ raw });

    const result = await fixture.adapter.fetchRaw(fetchInput());

    expect(result.descriptor).toEqual(describe_(raw));
    expect(fixture.client.fetchAll).toHaveBeenCalledTimes(3);
    expect(fixture.store.received()).toEqual(raw);
  });

  it("treats a UIDVALIDITY change or a vanished UID as permanently unavailable", async () => {
    const changed = adapterFixture({ raw: Buffer.from("hello"), uidValidity: BigInt(78) });
    await expect(changed.adapter.fetchRaw(fetchInput())).rejects.toEqual(
      new MailContentSourceError("mail_content_source_permanent"),
    );
    expect(changed.client.fetchAll).not.toHaveBeenCalled();
    expect(changed.lock.release).toHaveBeenCalledTimes(1);

    const vanished = adapterFixture({ raw: Buffer.from("hello") });
    vanished.client.fetchAll.mockResolvedValue([]);
    await expect(vanished.adapter.fetchRaw(fetchInput())).rejects.toEqual(
      new MailContentSourceError("mail_content_source_permanent"),
    );
    expect(vanished.store.received()).toEqual(Buffer.alloc(0));
  });

  it("rejects an oversized message before retaining bytes and a lying server mid-stream", async () => {
    const advertised = adapterFixture({
      raw: Buffer.alloc(10, 0x43),
      maxBytes: 1_024,
      advertisedSize: 2_048,
    });
    await expect(advertised.adapter.fetchRaw(fetchInput())).rejects.toEqual(
      new MailContentSourceError("mail_content_source_invalid_response"),
    );
    expect(advertised.store.received()).toEqual(Buffer.alloc(0));

    const lying = adapterFixture({
      raw: Buffer.alloc(CHUNK + 10, 0x44),
      maxBytes: CHUNK + 5,
      advertisedSize: CHUNK,
    });
    await expect(lying.adapter.fetchRaw(fetchInput())).rejects.toEqual(
      new MailContentSourceError("mail_content_source_invalid_response"),
    );
    expect(lying.store.received().byteLength).toBe(CHUNK);
  });

  it("rejects a response that names another UID or carries no source", async () => {
    const wrongUid = adapterFixture({ raw: Buffer.from("hello") });
    wrongUid.client.fetchAll.mockResolvedValue([
      { seq: 22, uid: 22, source: Buffer.from("hello") } as FetchMessageObject,
    ]);
    await expect(wrongUid.adapter.fetchRaw(fetchInput())).rejects.toEqual(
      new MailContentSourceError("mail_content_source_invalid_response"),
    );

    const missing = adapterFixture({ raw: Buffer.from("hello") });
    missing.client.fetchAll.mockResolvedValue([
      { seq: 21, uid: 21 } as FetchMessageObject,
    ]);
    await expect(missing.adapter.fetchRaw(fetchInput())).rejects.toEqual(
      new MailContentSourceError("mail_content_source_invalid_response"),
    );
  });

  it("fails closed on an expired deadline, a prior abort, or an abort mid-stream", async () => {
    const expired = adapterFixture({ raw: Buffer.from("hello") });
    await expect(
      expired.adapter.fetchRaw(fetchInput({ deadlineAt: 100 })),
    ).rejects.toEqual(new MailContentSourceError("mail_content_source_transient"));
    expect(expired.sessions.calls).toEqual([]);

    const aborted = new AbortController();
    aborted.abort();
    const prior = adapterFixture({ raw: Buffer.from("hello") });
    await expect(
      prior.adapter.fetchRaw(fetchInput({ signal: aborted.signal })),
    ).rejects.toEqual(new MailContentSourceError("mail_content_source_transient"));
    expect(prior.sessions.calls).toEqual([]);

    const controller = new AbortController();
    const midway = adapterFixture({ raw: Buffer.alloc(CHUNK * 3, 0x45) });
    const original = midway.client.fetchAll.getMockImplementation()!;
    midway.client.fetchAll.mockImplementation(async (...args) => {
      const messages = await original(...args);
      controller.abort();
      return messages;
    });
    await expect(
      midway.adapter.fetchRaw(fetchInput({ signal: controller.signal })),
    ).rejects.toEqual(new MailContentSourceError("mail_content_source_transient"));
    expect(midway.client.fetchAll).toHaveBeenCalledTimes(1);
    const sessionSignal = midway.sessions.calls[0]?.[1];
    expect(sessionSignal?.aborted).toBe(true);
  });

  it.each<readonly [unknown, MailContentSourceError["code"]]>([
    [new MailAccountError("imap_authentication_failed"), "mail_content_source_reauth_required"],
    [new MailAccountError("account_state_invalid"), "mail_content_source_reauth_required"],
    [new MailAccountError("account_not_found"), "mail_content_source_reauth_required"],
    [new MailAccountError("imap_connection_timeout"), "mail_content_source_transient"],
    [new MailAccountError("imap_tls_failed"), "mail_content_source_transient"],
    [new MailAccountError("imap_connection_failed"), "mail_content_source_transient"],
    [new MailProviderSyncError("mail_provider_response_invalid"), "mail_content_source_invalid_response"],
    [new MailProviderSyncError("mail_provider_reauth_required"), "mail_content_source_reauth_required"],
    [new MailProviderSyncError("mail_provider_unavailable"), "mail_content_source_transient"],
    [new Error("NoConnection"), "mail_content_source_transient"],
  ])("maps a session failure %o to %s", async (failure, code) => {
    const fixture = adapterFixture({ raw: Buffer.from("hello") });
    fixture.sessions.failure = failure;

    await expect(fixture.adapter.fetchRaw(fetchInput())).rejects.toEqual(
      new MailContentSourceError(code),
    );
  });

  it("fails closed on a crossed account, a foreign identity scheme, or a foreign blob store", async () => {
    const fixture = adapterFixture({ raw: Buffer.from("hello") });

    await expect(
      fixture.adapter.fetchRaw(fetchInput({ accountId: OTHER_ACCOUNT_ID })),
    ).rejects.toEqual(new MailContentSourceError("mail_content_source_permanent"));
    for (const providerMessageId of ["message-a", "i0u21", "i77u0", "../i77u21", ""]) {
      await expect(
        fixture.adapter.fetchRaw(fetchInput({ providerMessageId })),
      ).rejects.toEqual(
        new MailContentSourceError("mail_content_source_permanent"),
      );
    }
    expect(fixture.sessions.calls).toEqual([]);

    const foreign = blobStoreFixture(OTHER_ACCOUNT_ID);
    expect(
      () =>
        new ImapContentSourceAdapter({
          account: accountFixture(),
          sessions: fixture.sessions,
          blobStore: foreign,
        }),
    ).toThrow(new MailContentSourceError("mail_content_source_permanent"));
    expect(
      () =>
        new ImapContentSourceAdapter({
          account: accountFixture(),
          sessions: fixture.sessions,
          blobStore: blobStoreFixture(ACCOUNT_ID),
          maxBytes: 40 * 1024 * 1024 + 1,
        }),
    ).toThrow(new MailContentSourceError("mail_content_source_permanent"));
  });
});

function fetchInput(overrides?: {
  readonly accountId?: string;
  readonly providerMessageId?: string;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}) {
  return {
    accountId: overrides?.accountId ?? ACCOUNT_ID,
    providerMessageId: overrides?.providerMessageId ?? MESSAGE_ID,
    signal: overrides?.signal ?? new AbortController().signal,
    deadlineAt: overrides?.deadlineAt ?? 10_000,
  };
}

function adapterFixture(input: {
  readonly raw: Buffer;
  readonly uidValidity?: bigint;
  readonly maxBytes?: number;
  readonly advertisedSize?: number;
}) {
  const mailbox: MailboxObject = {
    path: "INBOX",
    delimiter: "/",
    flags: new Set(),
    uidValidity: input.uidValidity ?? UID_VALIDITY,
    uidNext: 22,
    exists: 21,
  };
  const lock = { path: "INBOX", release: vi.fn() };
  const fetchAll = vi.fn(
    async (
      range: unknown,
      query: { readonly source?: { readonly start: number; readonly maxLength: number } },
    ): Promise<FetchMessageObject[]> => {
      if (!Array.isArray(range) || range[0] !== 21) return [];
      const start = query.source?.start ?? 0;
      const end = Math.min(input.raw.byteLength, start + (query.source?.maxLength ?? 0));
      return [
        {
          seq: 21,
          uid: 21,
          size: input.advertisedSize ?? input.raw.byteLength,
          source: input.raw.subarray(start, end),
        },
      ];
    },
  );
  const client = {
    secureConnection: true,
    authenticated: true,
    mailbox,
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    on: vi.fn().mockReturnThis(),
    unbind: vi.fn(),
    getMailboxLock: vi.fn().mockResolvedValue(lock),
    fetchAll,
  } as unknown as ImapSessionClient & { readonly fetchAll: typeof fetchAll };
  const sessions: ImapReadSessions & {
    closedSessions: number;
    readonly calls: Array<readonly [StoredImapMailAccount, AbortSignal]>;
    failure: unknown;
  } = {
    closedSessions: 0,
    calls: [],
    failure: null,
    async withSession<T>(
      account: StoredImapMailAccount,
      signal: AbortSignal,
      operation: (value: ImapSessionClient) => Promise<T>,
    ): Promise<T> {
      sessions.calls.push([account, signal]);
      if (sessions.failure !== null) throw sessions.failure;
      try {
        return await operation(client);
      } finally {
        sessions.closedSessions += 1;
      }
    },
  };
  const store = blobStoreFixture(ACCOUNT_ID);
  const account = accountFixture();
  const adapter = new ImapContentSourceAdapter({
    account,
    sessions,
    blobStore: store,
    ...(input.maxBytes === undefined ? {} : { maxBytes: input.maxBytes }),
    now: () => 1_000,
  });
  return { adapter, account, client, lock, sessions, store };
}

function blobStoreFixture(accountId: string): MailIncomingBlobStorePort & {
  readonly accountId: string;
  readonly maxBytes: number[];
  received(): Buffer;
} {
  const chunks: Buffer[] = [];
  const maxBytes: number[] = [];
  return {
    accountId,
    maxBytes,
    received: () => Buffer.concat(chunks),
    has: vi.fn(),
    put: vi.fn(),
    read: vi.fn(),
    remove: vi.fn(),
    async putIncoming(source, limit) {
      maxBytes.push(limit);
      let bytes = 0;
      for await (const chunk of source) {
        if (chunk.byteLength > limit - bytes) throw new Error("blob store overflow");
        bytes += chunk.byteLength;
        chunks.push(Buffer.from(chunk));
      }
      return describe_(Buffer.concat(chunks));
    },
  };
}

function describe_(value: Uint8Array): MailBlobDescriptor {
  return Object.freeze({
    sha256: createHash("sha256").update(value).digest("hex"),
    bytes: value.byteLength,
  });
}

function accountFixture(): StoredImapMailAccount {
  return Object.freeze({
    account: Object.freeze({
      accountId: ACCOUNT_ID,
      emailAddress: "reader@example.test",
      endpoint: Object.freeze({
        hostname: "imap.example.test",
        port: 993,
        tls: "implicit" as const,
      }),
      username: "reader@example.test",
      credentialRef: Object.freeze({
        id: "credential-r11111111111111111111111111111111",
        version: 1,
      }),
      transportBindingRef: Object.freeze({
        id: "binding-r11111111111111111111111111111111",
        version: 1,
      }),
      connectedAt: 1,
    }),
    providerKind: "imap",
    displayName: null,
    status: "connected",
    createdAt: 1,
    updatedAt: 1,
  });
}
