import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MailDraftMutationInput } from "../draft-types";
import { MAIL_DRAFT_LIMITS } from "../draft-codec";
import {
  MailDraftError,
  ProviderNeutralMailDraftService,
  type MailDraftSendProcessor,
} from "./drafts";
import type {
  MailReplyContextResolver,
  MailSendAccount,
  MailSendAccountResolver,
} from "./outbound";
import { SqliteMailSendStore } from "./outbound-store";

const ACCOUNT_ID = `account-a${"1".repeat(32)}`;
const DRAFT_ID = "draft-00000000-0000-4000-8000-000000000001";
const MUTATION_ID =
  "draft-mutation-00000000-0000-4000-8000-000000000001";
const SEND_MUTATION_ID =
  "draft-mutation-00000000-0000-4000-8000-000000000002";
const DELETE_MUTATION_ID =
  "draft-mutation-00000000-0000-4000-8000-000000000003";
const SEND_OPERATION_ID = "send-00000000-0000-4000-8000-000000000001";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
  vi.restoreAllMocks();
});

describe("provider-neutral draft service", () => {
  it("persists trusted reply threading while exposing no storage-only fields", async () => {
    const fixture = await createFixture();
    const result = await fixture.service.create(
      {
        ...createInput(),
        intent: { kind: "reply", sourceMessageId: "cached-message-1" },
        to: "Friend <friend@",
        subject: "Re:",
      },
      requestContext(),
    );

    expect(result).toMatchObject({
      apiVersion: 1,
      created: true,
      draft: {
        revision: 0,
        state: "editing",
        intent: { kind: "reply", sourceMessageId: "cached-message-1" },
        to: "Friend <friend@",
        attachments: [],
      },
    });
    expect(result.draft).not.toHaveProperty("threading");
    expect(result.draft).not.toHaveProperty("sendIdempotencyKey");
    await expect(fixture.store.readDraft(ACCOUNT_ID, DRAFT_ID)).resolves.toMatchObject({
      threading: {
        providerThreadId: "gmail-thread-1",
        rfcMessageId: "<source@example.test>",
        references: ["<older@example.test>"],
      },
    });
    await fixture.store.close();
  });

  it("replays create without resolving a now-missing reply target", async () => {
    let available = true;
    const fixture = await createFixture({
      replies: {
        async resolveReplyContext() {
          return available
            ? {
                providerThreadId: "gmail-thread-1",
                rfcMessageId: "<source@example.test>",
                references: [],
              }
            : null;
        },
      },
    });
    const input = {
      ...createInput(),
      intent: { kind: "reply" as const, sourceMessageId: "cached-message-1" },
    };
    await expect(fixture.service.create(input, requestContext())).resolves.toMatchObject({
      created: true,
    });
    available = false;
    await expect(fixture.service.create(input, requestContext())).resolves.toMatchObject({
      created: false,
      draft: { intent: input.intent },
    });
    await fixture.store.close();
  });

  it("returns stable revision conflicts and never creates an outbox row", async () => {
    const fixture = await createFixture();
    await fixture.service.create(
      {
        ...createInput(),
        to: "friend@example.test",
      },
      requestContext(),
    );
    await expect(
      fixture.service.send(
        sendMutation({ expectedRevision: 7 }),
        requestContext(),
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_revision_conflict"));
    await expect(
      fixture.store.readByOperationId(SEND_OPERATION_ID),
    ).resolves.toBeNull();
    await fixture.store.close();
  });

  it("keeps draft-to-outbox handoff durable across a delivery crash and restart", async () => {
    const first = await createFixture({
      sender: {
        async processOperation() {
          throw new Error("simulated process crash after atomic commit");
        },
      },
    });
    await first.service.create(
      {
        ...createInput(),
        to: "friend@example.test",
        subject: "Durable draft",
        text: "Body",
      },
      requestContext(),
    );
    const mutation = sendMutation();
    await expect(
      first.service.send(mutation, requestContext()),
    ).resolves.toEqual({
      apiVersion: 1,
      replayed: false,
      appliedRevision: 1,
      operationId: SEND_OPERATION_ID,
      created: true,
      status: "queued",
    });
    const queued = await first.store.readByOperationId(SEND_OPERATION_ID);
    expect(queued).toMatchObject({
      accountId: ACCOUNT_ID,
      idempotencyKey: "draft-send-key-0001",
      status: "queued",
    });
    await expect(first.store.readDraft(ACCOUNT_ID, DRAFT_ID)).resolves.toMatchObject({
      revision: 1,
      state: "submitting",
      sendOperationId: SEND_OPERATION_ID,
    });
    if (queued === null) throw new Error("missing committed draft send");
    const sent = Object.freeze({
      ...queued,
      version: 1,
      status: "sent" as const,
      attemptCount: 1,
      providerMessageId: "gmail-message-1",
      providerThreadId: "gmail-thread-1",
      nextAttemptAt: null,
      updatedAt: queued.updatedAt + 1,
    });
    await expect(
      first.store.compareAndSwap(SEND_OPERATION_ID, 0, sent),
    ).resolves.toBe(true);
    await expect(first.store.readDraft(ACCOUNT_ID, DRAFT_ID)).resolves.toMatchObject({
      revision: 2,
      state: "sent",
      to: "",
      subject: "",
      text: "",
    });

    const cacheRoot = first.cacheRoot;
    await first.store.close();
    const reopened = new SqliteMailSendStore({ cacheRoot, now: () => 100 });
    await reopened.initialize();
    const processor = vi.fn(async () => ({
      apiVersion: 1 as const,
      operationId: SEND_OPERATION_ID,
      status: "sent" as const,
    }));
    const service = createService(reopened, { sender: { processOperation: processor } });
    await expect(service.send(mutation, requestContext())).resolves.toEqual({
      apiVersion: 1,
      replayed: true,
      appliedRevision: 1,
      operationId: SEND_OPERATION_ID,
      created: false,
      status: "sent",
    });
    expect(processor).not.toHaveBeenCalled();
    await reopened.close();
  });

  it("replays an accepted send after the account later requires reauthentication", async () => {
    let account = gmailAccount();
    const processor = vi.fn(async (operationId: string) =>
      Object.freeze({ apiVersion: 1 as const, operationId, status: "queued" as const }),
    );
    const fixture = await createFixture({
      accounts: {
        async readSendAccount(accountId) {
          return accountId === ACCOUNT_ID ? account : null;
        },
      },
      sender: { processOperation: processor },
    });
    await fixture.service.create(
      { ...createInput(), to: "friend@example.test" },
      requestContext(),
    );
    const mutation = sendMutation();
    await expect(
      fixture.service.send(mutation, requestContext()),
    ).resolves.toMatchObject({ replayed: false, created: true, status: "queued" });

    account = Object.freeze({ ...gmailAccount(), status: "reauth_required" });
    await expect(
      fixture.service.send(mutation, requestContext()),
    ).resolves.toEqual({
      apiVersion: 1,
      replayed: true,
      appliedRevision: 1,
      operationId: SEND_OPERATION_ID,
      created: false,
      status: "queued",
    });
    expect(processor).toHaveBeenCalledTimes(1);
    await fixture.store.close();
  });

  it("rejects exact-replay mutation reuse with changed send identity", async () => {
    const fixture = await createFixture();
    await fixture.service.create(
      {
        ...createInput(),
        to: "friend@example.test",
      },
      requestContext(),
    );
    await fixture.service.send(sendMutation(), requestContext());
    await expect(
      fixture.service.send(
        sendMutation({ sendIdempotencyKey: "changed-send-key-0001" }),
        requestContext(),
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_idempotency_conflict"));
    await fixture.store.close();
  });

  it("rejects providers without compose/send capabilities before persistence", async () => {
    const fixture = await createFixture({
      account: { ...gmailAccount(), providerKind: "imap" },
    });
    await expect(
      fixture.service.create(createInput(), requestContext()),
    ).rejects.toEqual(
      new MailDraftError("mail_draft_capability_unavailable"),
    );
    await expect(fixture.store.listDrafts(ACCOUNT_ID)).resolves.toEqual([]);
    await fixture.store.close();
  });

  it("lists bounded summaries without returning stored recipient or body data", async () => {
    const fixture = await createFixture();
    await fixture.service.create(
      {
        ...createInput(),
        to: "private@example.test",
        subject: "Large",
        text: "x".repeat(MAIL_DRAFT_LIMITS.maxBodyBytes),
      },
      requestContext(),
    );
    const result = await fixture.service.list(ACCOUNT_ID);
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]).toMatchObject({
      accountId: ACCOUNT_ID,
      draftId: DRAFT_ID,
      subject: "Large",
    });
    expect(result.drafts[0]).not.toHaveProperty("text");
    expect(result.drafts[0]).not.toHaveProperty("to");
    expect(result.drafts[0]).not.toHaveProperty("attachments");
    await fixture.store.close();
  });

  it("sends a large draft that still fits the final MIME payload limit", async () => {
    const fixture = await createFixture();
    await fixture.service.create(
      {
        ...createInput(),
        to: "friend@example.test",
        subject: "Large sendable draft",
        text: "x".repeat(700 * 1024),
      },
      requestContext(),
    );

    await expect(
      fixture.service.send(sendMutation(), requestContext()),
    ).resolves.toMatchObject({
      created: true,
      status: "queued",
    });
    await expect(
      fixture.store.readByOperationId(SEND_OPERATION_ID),
    ).resolves.toMatchObject({
      accountId: ACCOUNT_ID,
      status: "queued",
    });
    await fixture.store.close();
  });

  it("returns permanent validation when a valid draft expands beyond the MIME limit", async () => {
    const fixture = await createFixture();
    await fixture.service.create(
      {
        ...createInput(),
        to: "friend@example.test",
        subject: "Too large to send",
        text: "x".repeat(900 * 1024),
      },
      requestContext(),
    );

    await expect(
      fixture.service.send(sendMutation(), requestContext()),
    ).rejects.toEqual(new MailDraftError("mail_draft_request_invalid"));
    await expect(
      fixture.store.readDraft(ACCOUNT_ID, DRAFT_ID),
    ).resolves.toMatchObject({ revision: 0, state: "editing" });
    await expect(
      fixture.store.readByOperationId(SEND_OPERATION_ID),
    ).resolves.toBeNull();
    await fixture.store.close();
  });

  it("uses deterministic mutation receipts and distinguishes stale delete", async () => {
    let now = 100;
    const fixture = await createFixture({ now: () => now++ });
    await fixture.service.create(createInput(), requestContext());
    const mutation: MailDraftMutationInput = {
      accountId: ACCOUNT_ID,
      draftId: DRAFT_ID,
      mutationId: MUTATION_ID,
      expectedRevision: 0,
      kind: "patch",
      patch: { subject: "Saved" },
    };
    await expect(
      fixture.service.mutate(mutation, requestContext()),
    ).resolves.toEqual({
      apiVersion: 1,
      replayed: false,
      appliedRevision: 1,
      operationId: null,
    });
    await expect(
      fixture.service.mutate(mutation, requestContext()),
    ).resolves.toEqual({
      apiVersion: 1,
      replayed: true,
      appliedRevision: 1,
      operationId: null,
    });
    await expect(
      fixture.service.delete(
        {
          accountId: ACCOUNT_ID,
          draftId: DRAFT_ID,
          mutationId: DELETE_MUTATION_ID,
          expectedRevision: 0,
        },
        requestContext(),
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_revision_conflict"));
    await fixture.store.close();
  });

  it("rejects deleting a submitting draft and preserves exact send replay", async () => {
    const fixture = await createFixture();
    await fixture.service.create(
      { ...createInput(), to: "friend@example.test" },
      requestContext(),
    );
    await expect(
      fixture.service.send(sendMutation(), requestContext()),
    ).resolves.toMatchObject({
      replayed: false,
      appliedRevision: 1,
      operationId: SEND_OPERATION_ID,
    });

    await expect(
      fixture.service.delete(
        {
          accountId: ACCOUNT_ID,
          draftId: DRAFT_ID,
          mutationId: DELETE_MUTATION_ID,
          expectedRevision: 1,
        },
        requestContext(),
      ),
    ).rejects.toEqual(new MailDraftError("mail_draft_state_invalid"));
    await expect(
      fixture.store.readDraft(ACCOUNT_ID, DRAFT_ID),
    ).resolves.toMatchObject({ revision: 1, state: "submitting" });
    await expect(
      fixture.store.readByOperationId(SEND_OPERATION_ID),
    ).resolves.toMatchObject({ status: "queued" });
    await expect(
      fixture.service.send(sendMutation(), requestContext()),
    ).resolves.toMatchObject({
      replayed: true,
      appliedRevision: 1,
      operationId: SEND_OPERATION_ID,
    });
    await fixture.store.close();
  });

  it.each(["create", "patch", "delete", "send"] as const)(
    "rolls back a late-aborted %s mutation before its SQLite commit",
    async (kind) => {
      const fixture = await createFixture();
      if (kind !== "create") {
        await fixture.service.create(
          {
            ...createInput(),
            to: "friend@example.test",
            subject: "Before",
          },
          requestContext(),
        );
      }
      const method =
        kind === "create"
          ? "createDraft"
          : kind === "patch"
            ? "applyDraftMutation"
            : kind === "delete"
              ? "deleteDraft"
              : "commitDraftSend";
      const blocked = blockStoreMethod(fixture.store, method);
      const service = createService(blocked.store);
      const controller = new AbortController();
      const request = requestContext(controller);
      const operation =
        kind === "create"
          ? service.create(createInput(), request)
          : kind === "patch"
            ? service.mutate(
                {
                  accountId: ACCOUNT_ID,
                  draftId: DRAFT_ID,
                  mutationId: MUTATION_ID,
                  expectedRevision: 0,
                  kind: "patch",
                  patch: { subject: "After" },
                },
                request,
              )
            : kind === "delete"
              ? service.delete(
                  {
                    accountId: ACCOUNT_ID,
                    draftId: DRAFT_ID,
                    mutationId: DELETE_MUTATION_ID,
                    expectedRevision: 0,
                  },
                  request,
                )
              : service.send(sendMutation(), request);
      const rejection = expect(operation).rejects.toEqual(
        new MailDraftError("mail_draft_service_unavailable"),
      );

      await blocked.entered;
      controller.abort();
      blocked.release();
      await rejection;

      const stored = await fixture.store.readDraft(ACCOUNT_ID, DRAFT_ID);
      if (kind === "create") {
        expect(stored).toBeNull();
      } else if (kind === "delete") {
        expect(stored).toMatchObject({ revision: 0, subject: "Before" });
      } else if (kind === "patch") {
        expect(stored).toMatchObject({ revision: 0, subject: "Before" });
      } else {
        expect(stored).toMatchObject({ revision: 0, state: "editing" });
        await expect(
          fixture.store.readByOperationId(SEND_OPERATION_ID),
        ).resolves.toBeNull();
      }
      await fixture.store.close();
    },
  );

  it("rejects an expired mutation deadline before touching SQLite", async () => {
    const fixture = await createFixture();
    await expect(
      fixture.service.create(createInput(), {
        deadlineAt: 100,
        signal: new AbortController().signal,
      }),
    ).rejects.toEqual(new MailDraftError("mail_draft_service_unavailable"));
    await expect(
      fixture.store.readDraft(ACCOUNT_ID, DRAFT_ID),
    ).resolves.toBeNull();
    await fixture.store.close();
  });
});

/**
 * The composer stores raw address text and the service turns it into the
 * envelope at send. Both sides must accept exactly the same list, or the writer
 * gets an opaque `mail_draft_request_invalid` for a list the composer approved.
 */
describe("draft recipient contract", () => {
  it.each([
    ["a trailing separator", "friend@example.test,", ["friend@example.test"]],
    [
      "semicolon separated addresses",
      "one@example.test; two@example.test",
      ["one@example.test", "two@example.test"],
    ],
    [
      "a display name",
      "Alice Smith <alice@example.test>",
      ["alice@example.test"],
    ],
    [
      "a quoted display name holding a separator",
      '"Smith, Alice" <alice@example.test>, bob@example.test',
      ["alice@example.test", "bob@example.test"],
    ],
    [
      "surrounding whitespace and mixed case",
      "  Alice@Example.Test  ",
      ["alice@example.test"],
    ],
  ])("accepts %s", async (_label, to, expected) => {
    const fixture = await createFixture();
    await fixture.service.create(
      { ...createInput(), to, subject: "Contract", text: "Body" },
      requestContext(),
    );

    await expect(
      fixture.service.send(sendMutation(), requestContext()),
    ).resolves.toMatchObject({ operationId: SEND_OPERATION_ID });
    await expect(
      fixture.store.readByOperationId(SEND_OPERATION_ID),
    ).resolves.toMatchObject({ message: { envelope: { to: expected } } });
    await fixture.store.close();
  });

  it("drops a recipient the writer repeated across fields", async () => {
    const fixture = await createFixture();
    await fixture.service.create(
      {
        ...createInput(),
        to: "Alice <alice@example.test>",
        cc: "ALICE@example.test, bob@example.test",
        subject: "Contract",
        text: "Body",
      },
      requestContext(),
    );

    await expect(
      fixture.service.send(sendMutation(), requestContext()),
    ).resolves.toMatchObject({ operationId: SEND_OPERATION_ID });
    await expect(
      fixture.store.readByOperationId(SEND_OPERATION_ID),
    ).resolves.toMatchObject({
      message: {
        envelope: { to: ["alice@example.test"], cc: ["bob@example.test"] },
      },
    });
    await fixture.store.close();
  });

  it("sends a draft addressed only by blind copy", async () => {
    const fixture = await createFixture();
    await fixture.service.create(
      {
        ...createInput(),
        bcc: "friend@example.test",
        subject: "Contract",
        text: "Body",
      },
      requestContext(),
    );

    await expect(
      fixture.service.send(sendMutation(), requestContext()),
    ).resolves.toMatchObject({ operationId: SEND_OPERATION_ID });
    await expect(
      fixture.store.readByOperationId(SEND_OPERATION_ID),
    ).resolves.toMatchObject({
      message: { envelope: { to: [], bcc: ["friend@example.test"] } },
    });
    await fixture.store.close();
  });

  it("refuses to even store a header injection attempt", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.service.create(
        {
          ...createInput(),
          to: "friend@example.test>\r\nBcc: eve@evil.test",
        },
        requestContext(),
      ),
    ).rejects.toMatchObject({ code: "mail_draft_request_invalid" });
    await expect(
      fixture.store.readDraft(ACCOUNT_ID, DRAFT_ID),
    ).resolves.toBeNull();
    await fixture.store.close();
  });

  it.each([
    ["a token that is not an address", "not-an-address"],
    ["an unterminated angle bracket", "Alice <alice@example.test"],
    ["a domain without a dot", "friend@localhost"],
    ["a second address hidden in one token", "one@example.test two@evil.test"],
    [
      "a second mailbox hidden behind a display name",
      "Alice <alice@example.test> <eve@evil.test>",
    ],
    [
      "a bare address shadowed by an angle-bracketed one",
      "alice@example.test <eve@evil.test>",
    ],
    [
      "two adjacent angle-bracketed mailboxes",
      "<alice@example.test><eve@evil.test>",
    ],
    ["an empty list", "   "],
  ])("refuses %s without creating an outbox row", async (_label, to) => {
    const fixture = await createFixture();
    await fixture.service.create(
      { ...createInput(), to, subject: "Contract", text: "Body" },
      requestContext(),
    );

    await expect(
      fixture.service.send(sendMutation(), requestContext()),
    ).rejects.toEqual(new MailDraftError("mail_draft_request_invalid"));
    await expect(
      fixture.store.readByOperationId(SEND_OPERATION_ID),
    ).resolves.toBeNull();
    await fixture.store.close();
  });
});

function createInput() {
  return {
    draftId: DRAFT_ID,
    accountId: ACCOUNT_ID,
    intent: { kind: "compose" as const },
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    text: "",
  };
}

function sendMutation(
  patch: Partial<Extract<MailDraftMutationInput, { readonly kind: "send" }>> = {},
): Extract<MailDraftMutationInput, { readonly kind: "send" }> {
  return {
    accountId: ACCOUNT_ID,
    draftId: DRAFT_ID,
    mutationId: SEND_MUTATION_ID,
    expectedRevision: 0,
    kind: "send",
    sendIdempotencyKey: "draft-send-key-0001",
    sendOperationId: SEND_OPERATION_ID,
    ...patch,
  };
}

function gmailAccount(): MailSendAccount {
  return Object.freeze({
    accountId: ACCOUNT_ID,
    providerKind: "gmail" as const,
    emailAddress: "sender@example.test",
    status: "connected" as const,
  });
}

async function createFixture(options: {
  readonly account?: MailSendAccount;
  readonly accounts?: MailSendAccountResolver;
  readonly replies?: MailReplyContextResolver;
  readonly sender?: MailDraftSendProcessor;
  readonly now?: () => number;
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "brain-mail-draft-service-"));
  roots.push(root);
  const cacheRoot = path.join(root, "cache");
  const store = new SqliteMailSendStore({ cacheRoot, now: () => 100 });
  await store.initialize();
  return {
    cacheRoot,
    store,
    service: createService(store, options),
  };
}

function createService(
  store: SqliteMailSendStore,
  options: {
    readonly account?: MailSendAccount;
    readonly accounts?: MailSendAccountResolver;
    readonly replies?: MailReplyContextResolver;
    readonly sender?: MailDraftSendProcessor;
    readonly now?: () => number;
  } = {},
) {
  const account = options.account ?? gmailAccount();
  const accounts: MailSendAccountResolver = options.accounts ?? {
    async readSendAccount(accountId) {
      return accountId === account.accountId ? account : null;
    },
  };
  const replies: MailReplyContextResolver = options.replies ?? {
    async resolveReplyContext() {
      return Object.freeze({
        providerThreadId: "gmail-thread-1",
        rfcMessageId: "<source@example.test>",
        references: Object.freeze(["<older@example.test>"]),
      });
    },
  };
  const sender: MailDraftSendProcessor = options.sender ?? {
    async processOperation(operationId) {
      return Object.freeze({ apiVersion: 1, operationId, status: "queued" });
    },
  };
  return new ProviderNeutralMailDraftService({
    store,
    accounts,
    replies,
    sender,
    now: options.now ?? (() => 100),
  });
}

function requestContext(controller = new AbortController()) {
  return Object.freeze({
    deadlineAt: Date.now() + 10_000,
    signal: controller.signal,
  });
}

function blockStoreMethod(
  store: SqliteMailSendStore,
  method:
    | "createDraft"
    | "applyDraftMutation"
    | "deleteDraft"
    | "commitDraftSend",
) {
  let markEntered!: () => void;
  let unblock!: () => void;
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const proxy = new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === method && typeof value === "function") {
        return async (...args: unknown[]) => {
          markEntered();
          await released;
          return Reflect.apply(value, target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return Object.freeze({
    store: proxy,
    entered,
    release: unblock,
  });
}
