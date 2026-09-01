import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  IsolatedMailParserPort,
  MailBlobDescriptor,
  MailMimeParseOutcome,
} from "../ports";
import type { MultiMailAccountStore } from "./account-store";
import { AtomicMailBlobStore } from "./content-blob-store";
import { SqliteMailContentCache } from "./content-cache";
import {
  MailContentWorkError,
  type MailContentWorkInput,
} from "./content-coordinator";
import {
  createProductionMailContentSourceFactory,
  ProductionMailContentWorkRunner,
  type MailContentSourceFactoryPort,
} from "./content-work-runner";
import { MailContentSourceError } from "./content-source";
import { GmailContentSourceAdapter } from "../providers/gmail/content-source-adapter";
import { ImapContentSourceAdapter } from "../providers/imap/sync-adapter";
import {
  type CachedProviderMessage,
  type CachedProviderThread,
  SqliteMailMessageCache,
} from "./message-cache";
import type { MailThreadListItem } from "../message-types";

const ACCOUNT_ID = "account-a11111111111111111111111111111111";
const MESSAGE_ID = "message-a";
const roots: string[] = [];
const caches: SqliteMailMessageCache[] = [];
const contentCaches: SqliteMailContentCache[] = [];
const blobStores: AtomicMailBlobStore[] = [];

afterEach(async () => {
  await Promise.all(contentCaches.splice(0).map((cache) => cache.close()));
  await Promise.all(blobStores.splice(0).map((store) => store.close()));
  for (const cache of caches.splice(0)) cache.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("production mail content runner", () => {
  it("stages Gmail raw MIME, publishes isolated parser artifacts, and wipes parser buffers", async () => {
    const fixture = await createFixture();
    const raw = Buffer.from("From: sender@example.test\r\n\r\nHello");
    const text = Buffer.from("Hello");
    const attachment = Buffer.from("report bytes");
    const sourceFactory: MailContentSourceFactoryPort = {
      async create({ incomingBlobStore }) {
        return {
          source: {
            async fetchRaw() {
              return {
                descriptor: await incomingBlobStore.putIncoming(
                  chunks(raw),
                  40 * 1024 * 1024,
                ),
              };
            },
          },
          destroy() {},
        };
      },
    };
    const parser: IsolatedMailParserPort = {
      isolation: { networkAccess: false, credentialAccess: false, sandboxVersion: 1 },
      async parse(request): Promise<MailMimeParseOutcome> {
        expect(await collect(request.rawMimeStream)).toEqual(raw);
        return {
          kind: "parsed",
          artifacts: {
            text: { descriptor: descriptor(text), data: text },
            sanitizedHtml: null,
            remoteImages: [],
            attachments: [
              {
                filename: "report.txt",
                mimeType: "text/plain",
                disposition: "attachment",
                contentId: null,
                blob: { descriptor: descriptor(attachment), data: attachment },
              },
            ],
          },
        };
      },
    };
    const runner = new ProductionMailContentWorkRunner({
      sourceFactory,
      parser,
      now: () => fixture.now,
    });

    await runner.run(fixture.input, new AbortController().signal);

    await expect(fixture.cache.inspect(MESSAGE_ID)).resolves.toMatchObject({
      kind: "ready",
      content: {
        rawMime: descriptor(raw),
        text: descriptor(Buffer.from("Hello")),
        attachments: [
          {
            filename: "report.txt",
            mimeType: "text/plain",
            blob: descriptor(Buffer.from("report bytes")),
          },
        ],
      },
    });
    expect(text).toEqual(Buffer.alloc(text.length));
    expect(attachment).toEqual(Buffer.alloc(attachment.length));
  });

  it("does not publish remote-image work when the clean plain alternative wins", async () => {
    const fixture = await createFixture();
    const raw = Buffer.from("raw MIME");
    const text = Buffer.from("Clean readable plain message");
    const remoteImageId = `remote-image-a${"7".repeat(32)}`;
    const html = Buffer.from(
      `<p>Damaged \ufffd newsletter</p><img data-brain-remote-image="${remoteImageId}">`,
    );
    const runner = new ProductionMailContentWorkRunner({
      sourceFactory: sourceFactoryFor(raw),
      parser: parserReturning({
        kind: "parsed",
        artifacts: {
          text: { descriptor: descriptor(text), data: text },
          sanitizedHtml: { descriptor: descriptor(html), data: html },
          attachments: [],
          remoteImages: [
            {
              remoteImageId,
              sourceUrl: "https://images.example.com/newsletter.png",
            },
          ],
        },
      }),
      now: () => fixture.now,
    });

    await runner.run(fixture.input, new AbortController().signal);

    await expect(
      fixture.cache.inspectRemoteImage(remoteImageId, fixture.now),
    ).resolves.toBeNull();
    await expect(fixture.cache.inspect(MESSAGE_ID)).resolves.toMatchObject({
      kind: "ready",
    });
  });

  it("keeps source and parser failure classes visible to the coordinator", async () => {
    const fixture = await createFixture();
    const sourceRunner = new ProductionMailContentWorkRunner({
      sourceFactory: {
        async create() {
          return {
            source: {
              async fetchRaw() {
                throw new MailContentSourceError("mail_content_source_rate_limited");
              },
            },
            destroy() {},
          };
        },
      },
      parser: parserReturning({
        kind: "permanent_failure",
        errorCode: "mail_mime_limit_exceeded",
      }),
      now: () => fixture.now,
    });
    await expect(
      sourceRunner.run(fixture.input, new AbortController().signal),
    ).rejects.toEqual(
      new MailContentWorkError("transient", "mail_content_source_rate_limited"),
    );

    const reauthRunner = new ProductionMailContentWorkRunner({
      sourceFactory: {
        async create() {
          return {
            source: {
              async fetchRaw() {
                throw new MailContentSourceError(
                  "mail_content_source_reauth_required",
                );
              },
            },
            destroy() {},
          };
        },
      },
      parser: parserReturning({
        kind: "permanent_failure",
        errorCode: "mail_mime_limit_exceeded",
      }),
      now: () => fixture.now,
    });
    await expect(
      reauthRunner.run(fixture.input, new AbortController().signal),
    ).rejects.toEqual(
      new MailContentWorkError(
        "transient",
        "mail_content_source_reauth_required",
      ),
    );

    const raw = Buffer.from("raw");
    const parserRunner = new ProductionMailContentWorkRunner({
      sourceFactory: sourceFactoryFor(raw),
      parser: parserReturning({
        kind: "permanent_failure",
        errorCode: "mail_mime_limit_exceeded",
      }),
      now: () => fixture.now,
    });
    await expect(
      parserRunner.run(fixture.input, new AbortController().signal),
    ).rejects.toEqual(
      new MailContentWorkError("permanent", "mail_mime_limit_exceeded"),
    );
  });

  it("creates a provider-matched source and stops reauthentication-required accounts", async () => {
    const gmailStore = {
      readAccount: async () =>
        ({
          account: { accountId: ACCOUNT_ID, credentialRef: { id: "credential-r11111111111111111111111111111111", version: 1 } },
          providerKind: "gmail",
          status: "connected",
        }) as never,
    } as unknown as MultiMailAccountStore;
    const sourceFactory = createProductionMailContentSourceFactory({
      store: gmailStore,
      environment: {},
    });
    const fixture = await createFixture();
    const lease = await sourceFactory.create({
      accountId: ACCOUNT_ID,
      blobStore: fixture.blobStore,
      incomingBlobStore: fixture.cache.incomingBlobStore(fixture.input.lease),
    });
    expect(lease.source).toBeInstanceOf(GmailContentSourceAdapter);
    lease.destroy();

    const imapAccount = {
      account: {
        accountId: ACCOUNT_ID,
        emailAddress: "reader@example.test",
        endpoint: { hostname: "imap.example.test", port: 993, tls: "implicit" },
        username: "reader@example.test",
        credentialRef: { id: "credential-r11111111111111111111111111111111", version: 1 },
        transportBindingRef: { id: "binding-r11111111111111111111111111111111", version: 1 },
        connectedAt: 1,
      },
      providerKind: "imap",
      displayName: null,
      status: "connected",
      createdAt: 1,
      updatedAt: 1,
    };
    const imapStore = {
      readAccount: async () => imapAccount as never,
    } as unknown as MultiMailAccountStore;
    const withSession = vi.fn();
    const imapLease = await createProductionMailContentSourceFactory({
      store: imapStore,
      environment: {},
      imapSessions: { withSession },
    }).create({
      accountId: ACCOUNT_ID,
      blobStore: fixture.blobStore,
      incomingBlobStore: fixture.cache.incomingBlobStore(fixture.input.lease),
    });
    expect(imapLease.source).toBeInstanceOf(ImapContentSourceAdapter);
    imapLease.destroy();

    withSession.mockRejectedValue(new Error("provider offline"));
    await expect(
      imapLease.source.fetchRaw({
        accountId: ACCOUNT_ID,
        providerMessageId: "i77u21",
        signal: new AbortController().signal,
        deadlineAt: Date.now() + 10_000,
      }),
    ).rejects.toEqual(
      new MailContentSourceError("mail_content_source_transient"),
    );
    expect(withSession).toHaveBeenCalledWith(
      imapAccount,
      expect.any(AbortSignal),
      expect.any(Function),
    );

    await expect(
      createProductionMailContentSourceFactory({
        store: {
          readAccount: async () => ({ ...imapAccount, status: "reauth_required" }) as never,
        } as unknown as MultiMailAccountStore,
        environment: {},
        imapSessions: { withSession },
      }).create({
        accountId: ACCOUNT_ID,
        blobStore: fixture.blobStore,
        incomingBlobStore: fixture.cache.incomingBlobStore(fixture.input.lease),
      }),
    ).rejects.toEqual(
      new MailContentWorkError("transient", "mail_content_source_reauth_required"),
    );

    const reauthStore = {
      readAccount: async () =>
        ({
          account: { accountId: ACCOUNT_ID, credentialRef: { id: "credential-r11111111111111111111111111111111", version: 1 } },
          providerKind: "gmail",
          status: "reauth_required",
        }) as never,
    } as unknown as MultiMailAccountStore;
    await expect(
      createProductionMailContentSourceFactory({
        store: reauthStore,
        environment: {},
      }).create({
        accountId: ACCOUNT_ID,
        blobStore: fixture.blobStore,
        incomingBlobStore: fixture.cache.incomingBlobStore(fixture.input.lease),
      }),
    ).rejects.toEqual(
      new MailContentWorkError("transient", "mail_content_source_reauth_required"),
    );
  });
});

async function createFixture(): Promise<{
  readonly cache: SqliteMailContentCache;
  readonly blobStore: AtomicMailBlobStore;
  readonly input: MailContentWorkInput;
  readonly now: number;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-content-work-runner-"));
  roots.push(root);
  const cacheRoot = path.join(root, "cache");
  await mkdir(cacheRoot, { mode: 0o700 });
  const messages = new SqliteMailMessageCache({ cacheRoot, accountId: ACCOUNT_ID });
  caches.push(messages);
  await messages.initialize();
  const generation = messages.beginInitial("100");
  messages.putInitialPage(generation, [threadFixture()], null, null);
  messages.completeInitial(generation, 200);
  const blobStore = new AtomicMailBlobStore({ cacheRoot, accountId: ACCOUNT_ID });
  blobStores.push(blobStore);
  const cache = new SqliteMailContentCache({ cacheRoot, accountId: ACCOUNT_ID, blobStore });
  contentCaches.push(cache);
  await cache.initialize();
  const now = Date.now();
  const claim = await cache.claim(MESSAGE_ID, now);
  if (claim.kind !== "claimed") throw new Error("content lease was not claimed");
  return {
    cache,
    blobStore,
    now,
    input: {
      accountId: ACCOUNT_ID,
      providerMessageId: MESSAGE_ID,
      lease: claim.lease,
      cache,
      blobStore,
      deadlineAt: claim.lease.expiresAt,
    },
  };
}

function sourceFactoryFor(raw: Buffer): MailContentSourceFactoryPort {
  return {
    async create({ incomingBlobStore }) {
      return {
        source: {
          async fetchRaw() {
            return {
              descriptor: await incomingBlobStore.putIncoming(
                chunks(raw),
                40 * 1024 * 1024,
              ),
            };
          },
        },
        destroy() {},
      };
    },
  };
}

function parserReturning(outcome: MailMimeParseOutcome): IsolatedMailParserPort {
  return {
    isolation: { networkAccess: false, credentialAccess: false, sandboxVersion: 1 },
    async parse() {
      return outcome;
    },
  };
}

function threadFixture(): CachedProviderThread {
  const message: CachedProviderMessage = {
    accountId: ACCOUNT_ID,
    messageId: MESSAGE_ID,
    threadId: "thread-a",
    from: { name: "Sender", address: "sender@example.test" },
    replyTo: [],
    to: [{ name: null, address: "reader@example.test" }],
    cc: [],
    subject: "Subject",
    sentAt: 100,
    unread: true,
    inInbox: true,
    snippet: "Snippet",
    textBody: null,
    htmlBody: null,
    hasAttachments: true,
    rfcMessageId: null,
    references: [],
    listMessage: false,
    category: "people",
    sizeEstimate: null,
  };
  const thread: MailThreadListItem = {
    accountId: ACCOUNT_ID,
    threadId: "thread-a",
    subject: "Subject",
    participants: [message.from!],
    snippet: "Snippet",
    lastMessageAt: 100,
    messageCount: 1,
    unread: true,
    starred: false,
    hasAttachments: true,
    listMessage: false,
    sizeBytes: 0,
    category: "people",
  };
  return { thread, messages: [message], inInbox: true, mailboxes: ["all", "inbox"] };
}

function descriptor(value: Uint8Array): MailBlobDescriptor {
  return {
    sha256: createHash("sha256").update(value).digest("hex"),
    bytes: value.byteLength,
  };
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const values: Buffer[] = [];
  for await (const value of stream) values.push(Buffer.from(value));
  return Buffer.concat(values);
}

async function* chunks(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value;
}
