import { describe, expect, it, vi } from "vitest";

import type {
  ProvisionedImapAccount,
  StoredGmailMailAccount,
  StoredImapMailAccount,
  StoredMailAccount,
} from "./account-types";
import { MailAccountError } from "./account-types";
import type {
  MailAccountStore,
  MultiMailAccountStore,
} from "./account-store";
import {
  CompositeMailAccountRemovalGuard,
  MultiMailAccountService,
  SingleMailAccountService,
} from "./accounts";
import type { ImapCredentialVerifier } from "./imapflow-adapter";

describe("single mail account service", () => {
  it("tests DNS/TLS/auth before save and rotates refs without changing account id", async () => {
    const events: string[] = [];
    const store = memoryStore(events);
    const verifier: ImapCredentialVerifier = {
      verify: vi.fn(async () => {
        events.push("verified");
      }),
    };
    let now = 1_000;
    const service = new SingleMailAccountService({ store, verifier, now: () => now });

    const first = await service.connect(inputFixture(), requestFixture());
    expect(events).toEqual(["verified", "saved"]);
    expect(first.configured).toBe(true);
    expect(JSON.stringify(first)).not.toContain("test-only-password");
    const firstInternal = await store.readAccount();

    events.length = 0;
    now = 2_000;
    await service.connect(
      { ...inputFixture(), emailAddress: "updated@example.test" },
      requestFixture(),
    );
    const secondInternal = await store.readAccount();
    expect(events).toEqual(["verified", "saved"]);
    expect(secondInternal?.accountId).toBe(firstInternal?.accountId);
    expect(secondInternal?.credentialRef.version).toBe(2);
    expect(secondInternal?.transportBindingRef.version).toBe(2);
  });

  it("preserves the previous account when verification fails", async () => {
    const events: string[] = [];
    const previous = accountFixture();
    const store = memoryStore(events, previous);
    const verifier: ImapCredentialVerifier = {
      verify: async () => {
        throw new MailAccountError("imap_authentication_failed");
      },
    };
    const service = new SingleMailAccountService({ store, verifier, now: () => 2_000 });

    await expect(
      service.connect(inputFixture(), requestFixture()),
    ).rejects.toMatchObject({ code: "imap_authentication_failed" });
    expect(events).toEqual([]);
    expect(await store.readAccount()).toEqual(previous);
  });

  it("re-checks abort after verification and never persists a late result", async () => {
    const events: string[] = [];
    const store = memoryStore(events);
    const controller = new AbortController();
    const verifier: ImapCredentialVerifier = {
      verify: async () => {
        events.push("verified");
        controller.abort();
      },
    };
    const service = new SingleMailAccountService({ store, verifier, now: () => 1_000 });

    await expect(
      service.connect(inputFixture(), {
        deadlineAt: 11_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "imap_connection_timeout" });
    expect(events).toEqual(["verified"]);
    expect(await store.readAccount()).toBeNull();
  });

  it("wipes a loaded password when the request aborts immediately after load", async () => {
    const controller = new AbortController();
    const loadedPassword = Buffer.from("saved-test-password");
    const store: MailAccountStore = {
      readAccount: async () => accountFixture(),
      loadProvisionedAccount: async () => {
        controller.abort();
        return { account: accountFixture(), password: loadedPassword };
      },
      save: vi.fn(),
      disconnect: vi.fn(),
    };
    const verifier: ImapCredentialVerifier = { verify: vi.fn() };
    const service = new SingleMailAccountService({
      store,
      verifier,
      now: () => 1_000,
    });

    await expect(
      service.connect(inputFixture(), {
        deadlineAt: 11_000,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "imap_connection_timeout" });
    expect(loadedPassword.every((byte) => byte === 0)).toBe(true);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("reuses the saved password only for a metadata edit", async () => {
    const events: string[] = [];
    const store = memoryStore(events, accountFixture());
    const seenPasswords: string[] = [];
    const verifier: ImapCredentialVerifier = {
      verify: async (request) => {
        seenPasswords.push(request.password.toString("utf8"));
      },
    };
    const service = new SingleMailAccountService({ store, verifier, now: () => 2_000 });

    const input = inputFixture();
    await expect(
      service.connect(
        {
          ...input,
          emailAddress: "updated@example.test",
          imap: { ...input.imap, password: null },
        },
        requestFixture(),
      ),
    ).resolves.toMatchObject({ configured: true });
    expect(seenPasswords).toEqual(["saved-test-password"]);
    expect(JSON.stringify(await service.status())).not.toContain("saved-test-password");
  });

  it("never sends a saved password after connection identity changes", async () => {
    const mutations = [
      { hostname: "attacker.example.test" },
      { port: 143 },
      { tls: "starttls" as const },
      { username: "attacker@example.test" },
    ];
    for (const mutation of mutations) {
      const events: string[] = [];
      const store = memoryStore(events, accountFixture());
      const verifier: ImapCredentialVerifier = { verify: vi.fn() };
      const service = new SingleMailAccountService({
        store,
        verifier,
        now: () => 2_000,
      });
      const input = inputFixture();

      await expect(
        service.connect(
          {
            ...input,
            imap: { ...input.imap, ...mutation, password: null },
          },
          requestFixture(),
        ),
      ).rejects.toMatchObject({ code: "account_request_invalid" });
      expect(verifier.verify).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    }
  });

  it("rejects a blank password for the first account before verification", async () => {
    const events: string[] = [];
    const store = memoryStore(events);
    const verifier: ImapCredentialVerifier = { verify: vi.fn() };
    const service = new SingleMailAccountService({ store, verifier, now: () => 1_000 });
    const input = inputFixture();

    await expect(
      service.connect(
        { ...input, imap: { ...input.imap, password: null } },
        requestFixture(),
      ),
    ).rejects.toMatchObject({ code: "account_request_invalid" });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("disconnect is serialized, idempotent, and never opens IMAP", async () => {
    const events: string[] = [];
    const store = memoryStore(events, accountFixture());
    const verifier: ImapCredentialVerifier = { verify: vi.fn() };
    const service = new SingleMailAccountService({
      store,
      verifier,
      now: () => 1_000,
    });

    await expect(service.disconnect(requestFixture())).resolves.toEqual({
      apiVersion: 1,
      configured: false,
      account: null,
    });
    await expect(service.disconnect(requestFixture())).resolves.toMatchObject({ configured: false });
    expect(events).toEqual(["disconnected", "disconnected"]);
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("never executes a queued disconnect after that request expires", async () => {
    const events: string[] = [];
    const store = memoryStore(events, accountFixture());
    let releaseVerification: (() => void) | undefined;
    const verifier: ImapCredentialVerifier = {
      verify: async () => {
        events.push("verification-started");
        await new Promise<void>((resolve) => {
          releaseVerification = resolve;
        });
        events.push("verification-finished");
      },
    };
    const service = new SingleMailAccountService({
      store,
      verifier,
      now: () => 1_000,
    });

    const connect = service.connect(inputFixture(), requestFixture());
    await vi.waitFor(() =>
      expect(events).toEqual(["verification-started"]),
    );

    const disconnectController = new AbortController();
    const disconnect = service.disconnect({
      deadlineAt: 11_000,
      signal: disconnectController.signal,
    });
    disconnectController.abort();
    releaseVerification?.();

    await expect(connect).resolves.toMatchObject({ configured: true });
    await expect(disconnect).rejects.toMatchObject({
      code: "imap_connection_timeout",
    });
    expect(events).toEqual([
      "verification-started",
      "verification-finished",
      "saved",
    ]);
    expect(await store.readAccount()).toMatchObject({
      credentialRef: { version: 2 },
      transportBindingRef: { version: 2 },
    });
  });

  it("finishes an admitted disconnect even when its request aborts", async () => {
    const events: string[] = [];
    let releaseDisconnect: (() => void) | undefined;
    const base = memoryStore(events, accountFixture());
    const store: MailAccountStore = {
      ...base,
      disconnect: async () => {
        events.push("disconnect-started");
        await new Promise<void>((resolve) => {
          releaseDisconnect = resolve;
        });
        events.push("disconnect-committed");
        return true;
      },
    };
    const service = new SingleMailAccountService({
      store,
      verifier: { verify: vi.fn() },
      now: () => 1_000,
    });
    const controller = new AbortController();
    const disconnect = service.disconnect({
      deadlineAt: 11_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(events).toEqual(["disconnect-started"]));
    controller.abort();
    releaseDisconnect?.();

    await expect(disconnect).resolves.toMatchObject({ configured: false });
    expect(events).toEqual(["disconnect-started", "disconnect-committed"]);
  });
});

describe("multi mail account service", () => {
  it("serializes legacy v1 connects onto one account", async () => {
    const store = memoryMultiStore();
    const service = new MultiMailAccountService({
      store,
      verifier: { verify: vi.fn(async () => undefined) },
      now: incrementingNow(),
    });

    await Promise.all([
      service.connect(inputFixture(), requestFixture()),
      service.connect(inputFixture(), requestFixture()),
    ]);

    const accounts = await store.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(accounts[0].account.credentialRef.version).toBe(2);
    expect(accounts[0].providerKind).toBe("imap");
    if (accounts[0].providerKind !== "imap") throw new Error("expected IMAP");
    expect(accounts[0].account.transportBindingRef.version).toBe(2);
  });

  it("lists exact redacted v2 accounts and caps additions at three", async () => {
    const store = memoryMultiStore();
    const verifier: ImapCredentialVerifier = { verify: vi.fn(async () => undefined) };
    const service = new MultiMailAccountService({
      store,
      verifier,
      now: incrementingNow(),
    });
    for (let index = 1; index <= 3; index += 1) {
      await service.add(createInput(index), requestFixture());
    }
    const listed = await service.list();
    expect(listed.apiVersion).toBe(2);
    expect(listed.accounts).toHaveLength(3);
    expect(Object.keys(listed.accounts[0]).sort()).toEqual([
      "accountId",
      "connectedAt",
      "createdAt",
      "displayName",
      "emailAddress",
      "imap",
      "providerKind",
      "status",
      "updatedAt",
    ]);
    expect(JSON.stringify(listed)).not.toContain("password");
    await expect(
      service.add(createInput(4), requestFixture()),
    ).rejects.toMatchObject({ code: "account_limit_reached" });
    expect(verifier.verify).toHaveBeenCalledTimes(3);
  });

  it("publishes exact provider capabilities without changing the v2 account list", async () => {
    const imap = storedMultiFixture(1);
    const gmail = storedGmailFixture(2);
    const service = new MultiMailAccountService({
      store: memoryMultiStore([imap, gmail]),
      verifier: { verify: vi.fn() },
      now: () => 2_000,
    });

    await expect(service.listCapabilities()).resolves.toEqual({
      apiVersion: 3,
      accounts: [
        expect.objectContaining({
          accountId: imap.account.accountId,
          providerKind: "imap",
          capabilities: {
            mailboxes: ["inbox"],
            listThreads: true,
            sync: true,
            headerPreview: true,
            messageBodies: true,
            threadMutations: true,
            compose: false,
            send: false,
            reply: false,
          },
        }),
        expect.objectContaining({
          accountId: gmail.account.accountId,
          providerKind: "gmail",
          capabilities: {
            mailboxes: ["inbox", "starred", "sent", "all", "spam", "trash"],
            listThreads: true,
            sync: true,
            headerPreview: true,
            messageBodies: true,
            threadMutations: true,
            compose: true,
            send: true,
            reply: true,
          },
        }),
      ],
    });
    expect((await service.list()).apiVersion).toBe(2);
  });

  it("publishes compose/send/reply only after SMTP is configured", async () => {
    const receiveOnly = storedMultiFixture(1);
    const sendCapable: StoredImapMailAccount = {
      ...storedMultiFixture(2),
      account: {
        ...storedMultiFixture(2).account,
        smtp: {
          endpoint: {
            hostname: "smtp.example.test",
            port: 587,
            tls: "starttls",
          },
          username: "smtp-user@example.test",
          credentialRef: storedMultiFixture(2).account.credentialRef,
          transportBindingRef: {
            id: `binding-r${"9".repeat(32)}`,
            version: 1,
          },
        },
      },
    };
    const service = new MultiMailAccountService({
      store: memoryMultiStore([receiveOnly, sendCapable]),
      verifier: { verify: vi.fn() },
    });

    const capabilities = await service.listCapabilities();
    expect(capabilities.accounts[0].capabilities).toMatchObject({
      compose: false,
      send: false,
      reply: false,
    });
    expect(capabilities.accounts[1].capabilities).toMatchObject({
      compose: true,
      send: true,
      reply: true,
    });

    const relayDisabled = new MultiMailAccountService({
      store: memoryMultiStore([sendCapable]),
      verifier: { verify: vi.fn() },
      smtpSubmissionReady: false,
    });
    await expect(relayDisabled.listCapabilities()).resolves.toMatchObject({
      accounts: [
        {
          smtp: expect.objectContaining({ hostname: "smtp.example.test" }),
          capabilities: { compose: false, send: false, reply: false },
        },
      ],
    });

    let runtimeReady = false;
    const liveReadiness = new MultiMailAccountService({
      store: memoryMultiStore([sendCapable]),
      verifier: { verify: vi.fn() },
      smtpSubmissionReady: () => runtimeReady,
    });
    await expect(liveReadiness.listCapabilities()).resolves.toMatchObject({
      accounts: [
        { capabilities: { compose: false, send: false, reply: false } },
      ],
    });
    runtimeReady = true;
    await expect(liveReadiness.listCapabilities()).resolves.toMatchObject({
      accounts: [
        { capabilities: { compose: true, send: true, reply: true } },
      ],
    });

    const reauthRequired = new MultiMailAccountService({
      store: memoryMultiStore([
        { ...sendCapable, status: "reauth_required" as const },
      ]),
      verifier: { verify: vi.fn() },
    });
    await expect(reauthRequired.listCapabilities()).resolves.toMatchObject({
      accounts: [
        {
          status: "reauth_required",
          capabilities: { compose: false, send: false, reply: false },
        },
      ],
    });
  });

  it("updates a display name without opening IMAP or rotating credentials", async () => {
    const store = memoryMultiStore([storedMultiFixture(1)]);
    const verifier: ImapCredentialVerifier = { verify: vi.fn() };
    const service = new MultiMailAccountService({
      store,
      verifier,
      now: () => 2_000,
    });

    const result = await service.update(
      storedMultiFixture(1).account.accountId,
      { displayName: "Personal" },
      requestFixture(),
    );
    expect(result.account).toMatchObject({
      displayName: "Personal",
      status: "connected",
    });
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(
      (await store.readAccount(storedMultiFixture(1).account.accountId))?.account
        .credentialRef.version,
    ).toBe(1);
  });

  it("runs connection edits behind the protocol mutation barrier", async () => {
    const existing = storedMultiFixture(1);
    const store = memoryMultiStore([existing]);
    const verifier: ImapCredentialVerifier = { verify: vi.fn() };
    const protocolMutationGuard = {
      run: vi.fn(async () => {
        throw new MailAccountError("account_state_unavailable");
      }),
    };
    const service = new MultiMailAccountService({
      store,
      verifier,
      protocolMutationGuard,
      now: () => 2_000,
    });

    await expect(
      service.update(
        existing.account.accountId,
        { imap: { password: "rotated-test-password" } },
        requestFixture(),
      ),
    ).rejects.toMatchObject({ code: "account_state_unavailable" });
    expect(protocolMutationGuard.run).toHaveBeenCalledWith(
      existing.account.accountId,
      { preservesBindings: true },
      expect.any(Function),
    );
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(await store.readAccount(existing.account.accountId)).toEqual(existing);
  });

  it("adds, redacts, rotates, and removes a separate SMTP endpoint safely", async () => {
    const store = memoryMultiStore();
    const smtpVerifier = { verify: vi.fn(async () => undefined) };
    const service = new MultiMailAccountService({
      store,
      verifier: { verify: vi.fn(async () => undefined) },
      smtpVerifier,
      now: incrementingNow(),
    });
    const created = await service.add(
      {
        ...createInput(1),
        smtp: {
          hostname: "smtp.example.test",
          port: 587,
          tls: "starttls",
          username: "smtp-person@example.test",
        },
      },
      requestFixture(),
    );
    expect(created.account).toMatchObject({
      smtp: {
        hostname: "smtp.example.test",
        port: 587,
        tls: "starttls",
        username: "smtp-person@example.test",
      },
    });
    expect(JSON.stringify(created)).not.toMatch(/password|credential|binding/i);
    const first = await store.readAccount(created.account.accountId);
    expect(first?.providerKind).toBe("imap");
    if (first?.providerKind !== "imap") throw new Error("expected IMAP");
    expect(first.account.smtp?.credentialRef).toEqual(
      first.account.credentialRef,
    );
    expect(first.account.smtp?.transportBindingRef.id).not.toBe(
      first.account.transportBindingRef.id,
    );
    expect(smtpVerifier.verify).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: expect.objectContaining({
          hostname: "smtp.example.test",
        }),
        username: "smtp-person@example.test",
      }),
    );

    await service.update(
      first.account.accountId,
      {
        imap: { password: "rotated-test-password" },
        smtp: { hostname: "smtp-2.example.test" },
      },
      requestFixture(),
    );
    const second = await store.readAccount(first.account.accountId);
    expect(second?.providerKind).toBe("imap");
    if (second?.providerKind !== "imap") throw new Error("expected IMAP");
    expect(second.account.smtp?.endpoint.hostname).toBe("smtp-2.example.test");
    expect(second.account.smtp?.credentialRef.version).toBe(2);
    expect(second.account.smtp?.transportBindingRef.version).toBe(2);
    expect(smtpVerifier.verify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        endpoint: expect.objectContaining({
          hostname: "smtp-2.example.test",
        }),
      }),
    );

    await service.update(
      first.account.accountId,
      { smtp: null },
      requestFixture(),
    );
    const receiveOnly = await store.readAccount(first.account.accountId);
    expect(receiveOnly?.providerKind).toBe("imap");
    if (receiveOnly?.providerKind !== "imap") throw new Error("expected IMAP");
    expect(receiveOnly.account.smtp).toBeUndefined();
    expect(smtpVerifier.verify).toHaveBeenCalledTimes(2);
  });

  it("never saves SMTP configuration when AUTH preflight fails", async () => {
    const store = memoryMultiStore();
    const smtpVerifier = {
      verify: vi.fn(async () => {
        throw new MailAccountError("smtp_authentication_failed");
      }),
    };
    const service = new MultiMailAccountService({
      store,
      verifier: { verify: vi.fn(async () => undefined) },
      smtpVerifier,
      now: () => 2_000,
    });

    await expect(
      service.add(
        {
          ...createInput(1),
          smtp: {
            hostname: "smtp.example.test",
            port: 587,
            tls: "starttls",
            username: "smtp-person@example.test",
          },
        },
        requestFixture(),
      ),
    ).rejects.toMatchObject({ code: "smtp_authentication_failed" });
    expect(await store.countAccounts()).toBe(0);
  });

  it("requires the mailbox password before adding or redirecting SMTP", async () => {
    const existing = storedMultiFixture(1);
    const store = memoryMultiStore([existing]);
    const service = new MultiMailAccountService({
      store,
      verifier: { verify: vi.fn() },
      now: () => 2_000,
    });
    await expect(
      service.update(
        existing.account.accountId,
        {
          smtp: {
            hostname: "smtp.example.test",
            port: 587,
            tls: "starttls",
            username: "person@example.test",
          },
        },
        requestFixture(),
      ),
    ).rejects.toMatchObject({ code: "account_request_invalid" });
  });

  it("requires a new password when a patch redirects the saved credential", async () => {
    const store = memoryMultiStore([storedMultiFixture(1)]);
    const verifier: ImapCredentialVerifier = { verify: vi.fn() };
    const service = new MultiMailAccountService({
      store,
      verifier,
      now: () => 2_000,
    });

    await expect(
      service.update(
        storedMultiFixture(1).account.accountId,
        { imap: { hostname: "other.example.test" } },
        requestFixture(),
      ),
    ).rejects.toMatchObject({ code: "account_request_invalid" });
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it("rejects a duplicate normalized email before opening IMAP", async () => {
    const first = storedMultiFixture(1);
    const second = storedMultiFixture(2);
    const store = memoryMultiStore([first, second]);
    const verifier: ImapCredentialVerifier = { verify: vi.fn() };
    const service = new MultiMailAccountService({
      store,
      verifier,
      now: () => 2_000,
    });

    await expect(
      service.update(
        first.account.accountId,
        { emailAddress: second.account.emailAddress.toUpperCase() },
        requestFixture(),
      ),
    ).rejects.toMatchObject({ code: "account_already_exists" });
    expect(verifier.verify).not.toHaveBeenCalled();
    expect(await store.readAccount(first.account.accountId)).toEqual(first);
  });

  it("removes one account without touching another", async () => {
    const first = storedMultiFixture(1);
    const second = storedMultiFixture(2);
    const store = memoryMultiStore([first, second]);
    const service = new MultiMailAccountService({
      store,
      verifier: { verify: vi.fn() },
      now: () => 2_000,
    });

    await expect(
      service.remove(first.account.accountId, requestFixture()),
    ).resolves.toMatchObject({
      apiVersion: 2,
      account: { accountId: first.account.accountId },
    });
    expect(await store.readAccount(first.account.accountId)).toBeNull();
    expect(await store.readAccount(second.account.accountId)).toEqual(second);
  });

  it("invalidates account workers before local deletion and leaves them blocked", async () => {
    const first = storedMultiFixture(1);
    const store = memoryMultiStore([first]);
    const removalGuard = {
      invalidateAccount: vi.fn(async () => undefined),
      restoreInvalidatedAccount: vi.fn(async () => undefined),
    };
    const service = new MultiMailAccountService({
      store,
      verifier: { verify: vi.fn() },
      removalGuard,
      now: () => 2_000,
    });

    await service.remove(first.account.accountId, requestFixture());

    expect(removalGuard.invalidateAccount).toHaveBeenCalledWith(
      first.account.accountId,
    );
    expect(removalGuard.restoreInvalidatedAccount).not.toHaveBeenCalled();
    expect(await store.readAccount(first.account.accountId)).toBeNull();
  });

  it("restores account workers when authoritative deletion does not commit", async () => {
    const first = storedMultiFixture(1);
    const base = memoryMultiStore([first]);
    const store: MultiMailAccountStore = {
      ...base,
      deleteAccount: vi.fn(async () => {
        throw new MailAccountError("account_state_unavailable");
      }),
    };
    const removalGuard = {
      invalidateAccount: vi.fn(async () => undefined),
      restoreInvalidatedAccount: vi.fn(async () => undefined),
    };
    const service = new MultiMailAccountService({
      store,
      verifier: { verify: vi.fn() },
      removalGuard,
      now: () => 2_000,
    });

    await expect(
      service.remove(first.account.accountId, requestFixture()),
    ).rejects.toMatchObject({ code: "account_state_unavailable" });

    expect(removalGuard.invalidateAccount).toHaveBeenCalledTimes(1);
    expect(removalGuard.restoreInvalidatedAccount).toHaveBeenCalledWith(
      first.account.accountId,
    );
    expect(await store.readAccount(first.account.accountId)).toEqual(first);
  });

  it("fails closed for stale v1 mutations once multiple accounts exist", async () => {
    const first = storedMultiFixture(1);
    const second = storedMultiFixture(2);
    const store = memoryMultiStore([first, second]);
    const verifier: ImapCredentialVerifier = { verify: vi.fn() };
    const service = new MultiMailAccountService({
      store,
      verifier,
      now: () => 2_000,
    });

    await expect(
      service.connect(inputFixture(), requestFixture()),
    ).rejects.toMatchObject({ code: "account_selection_required" });
    await expect(service.disconnect(requestFixture())).rejects.toMatchObject({
      code: "account_selection_required",
    });
    expect(await store.listAccounts()).toEqual([first, second]);
    expect(verifier.verify).not.toHaveBeenCalled();
  });
});

describe("composite mail account removal guard", () => {
  const accountId = `account-a${"9".repeat(32)}`;

  it("rolls back completed layers when a later invalidation fails", async () => {
    const events: string[] = [];
    const first = {
      invalidateAccount: vi.fn(async () => {
        events.push("first:invalidate");
      }),
      restoreInvalidatedAccount: vi.fn(async () => {
        events.push("first:restore");
      }),
    };
    const second = {
      invalidateAccount: vi.fn(async () => {
        events.push("second:invalidate");
        throw new Error("blocked");
      }),
      restoreInvalidatedAccount: vi.fn(async () => {
        events.push("second:restore");
      }),
    };
    const guard = new CompositeMailAccountRemovalGuard([first, second]);

    await expect(guard.invalidateAccount(accountId)).rejects.toThrow("blocked");
    expect(events).toEqual([
      "first:invalidate",
      "second:invalidate",
      "first:restore",
    ]);
    expect(second.restoreInvalidatedAccount).not.toHaveBeenCalled();
  });

  it("restores every layer in reverse order and fails closed afterwards", async () => {
    const events: string[] = [];
    const first = {
      invalidateAccount: vi.fn(async () => undefined),
      restoreInvalidatedAccount: vi.fn(async () => {
        events.push("first:restore");
        throw new Error("first failed");
      }),
    };
    const second = {
      invalidateAccount: vi.fn(async () => undefined),
      restoreInvalidatedAccount: vi.fn(async () => {
        events.push("second:restore");
      }),
    };
    const guard = new CompositeMailAccountRemovalGuard([first, second]);

    await expect(guard.restoreInvalidatedAccount(accountId)).rejects.toMatchObject({
      code: "account_state_unavailable",
    });
    expect(events).toEqual(["second:restore", "first:restore"]);
  });
});

function memoryStore(
  events: string[],
  initial: ProvisionedImapAccount | null = null,
): MailAccountStore {
  let account = initial;
  let password = initial ? Buffer.from("saved-test-password") : null;
  return {
    readAccount: async () => account,
    loadProvisionedAccount: async () =>
      account && password
        ? { account, password: Buffer.from(password) }
        : null,
    save: async (next, nextPassword, signal) => {
      if (signal.aborted) throw new MailAccountError("imap_connection_timeout");
      events.push("saved");
      account = next;
      password?.fill(0);
      password = Buffer.from(nextPassword);
    },
    disconnect: async () => {
      events.push("disconnected");
      const existed = account !== null;
      account = null;
      password?.fill(0);
      password = null;
      return existed;
    },
  };
}

function requestFixture() {
  return {
    deadlineAt: 11_000,
    signal: new AbortController().signal,
  };
}

function inputFixture() {
  return {
    emailAddress: "person@example.test",
    imap: {
      hostname: "imap.example.test",
      port: 993,
      tls: "implicit" as const,
      username: "person@example.test",
      password: "test-only-password",
    },
  };
}

function accountFixture(): ProvisionedImapAccount {
  return {
    accountId: "account-a11111111111111111111111111111111",
    emailAddress: "person@example.test",
    endpoint: { hostname: "imap.example.test", port: 993, tls: "implicit" },
    username: "person@example.test",
    credentialRef: {
      id: "credential-r22222222222222222222222222222222",
      version: 1,
    },
    transportBindingRef: {
      id: "binding-r33333333333333333333333333333333",
      version: 1,
    },
    connectedAt: 1,
  };
}

function memoryMultiStore(
  initial: readonly StoredMailAccount[] = [],
): MultiMailAccountStore {
  const accounts = new Map<string, StoredMailAccount>(
    initial.map((stored) => [stored.account.accountId, stored]),
  );
  const passwords = new Map(
    initial.map((stored) => [
      stored.account.accountId,
      Buffer.from(`saved-${stored.account.accountId}`),
    ]),
  );
  return {
    localSchemaVersion: 2,
    initialize: async () => undefined,
    close: () => undefined,
    countAccounts: async () => accounts.size,
    listAccounts: async () => [...accounts.values()],
    readAccount: async (accountId) => accounts.get(accountId) ?? null,
    loadProvisionedAccount: async (accountId) => {
      const stored = accounts.get(accountId);
      const password = passwords.get(accountId);
      return stored?.providerKind === "imap" && password
        ? { stored, password: Buffer.from(password) }
        : null;
    },
    loadGmailCredential: async () => null,
    save: async (stored, password, signal) => {
      if (signal.aborted) throw new MailAccountError("imap_connection_timeout");
      accounts.set(stored.account.accountId, stored);
      passwords.get(stored.account.accountId)?.fill(0);
      passwords.set(stored.account.accountId, Buffer.from(password));
    },
    updateMetadata: async (stored, signal) => {
      if (signal.aborted) throw new MailAccountError("imap_connection_timeout");
      accounts.set(stored.account.accountId, stored);
    },
    deleteAccount: async (accountId) => {
      const existed = accounts.delete(accountId);
      passwords.get(accountId)?.fill(0);
      passwords.delete(accountId);
      return existed;
    },
  };
}

function storedGmailFixture(index: number): StoredGmailMailAccount {
  const digit = String(index);
  return {
    account: {
      accountId: `account-a${digit.repeat(32)}`,
      emailAddress: `person-${index}@gmail.test`,
      subject: `google-subject-${index}`,
      credentialRef: {
        id: `credential-r${digit.repeat(32)}`,
        version: 1,
      },
      connectedAt: 1_000,
      grantedAt: 1_000,
    },
    providerKind: "gmail",
    displayName: null,
    status: "connected",
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function storedMultiFixture(index: number): StoredImapMailAccount {
  const digit = String(index);
  return {
    account: {
      ...accountFixture(),
      accountId: `account-a${digit.repeat(32)}`,
      emailAddress: `person-${index}@example.test`,
      credentialRef: {
        id: `credential-r${digit.repeat(32)}`,
        version: 1,
      },
      transportBindingRef: {
        id: `binding-r${digit.repeat(32)}`,
        version: 1,
      },
    },
    providerKind: "imap",
    displayName: null,
    status: "connected",
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

function createInput(index: number) {
  return {
    providerKind: "imap" as const,
    displayName: null,
    emailAddress: `person-${index}@example.test`,
    imap: {
      hostname: "imap.example.test",
      port: 993,
      tls: "implicit" as const,
      username: `person-${index}@example.test`,
      password: `test-password-${index}`,
    },
  };
}

function incrementingNow(): () => number {
  let value = 1_000;
  return () => value++;
}
