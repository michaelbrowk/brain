import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  register: vi.fn(),
}));

vi.mock("@/lib/store/events", () => ({
  MAIL_EVENT: "mail",
  brainEvents: { on: mocks.on, off: mocks.off },
  latestStoreEventSequence: () => 7,
  replayStoreEvents: () => ({
    reconcile: false,
    events: [],
    latestSequence: 7,
  }),
}));

vi.mock("@/lib/store/sse-shutdown", () => ({
  registerActiveSseClose: mocks.register,
}));

import { GET } from "./route";

describe("GET /api/events shutdown registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.BRAIN_STANDALONE_SSE_BARRIER_TOKEN;
  });

  it("does not attach an abort listener when the shutdown latch closes it synchronously", async () => {
    const unregister = vi.fn();
    mocks.register.mockImplementation((close: () => void) => {
      close();
      return unregister;
    });
    const controller = new AbortController();
    const request = new Request("https://brain.test/api/events", {
      signal: controller.signal,
    });
    const addAbort = vi.spyOn(request.signal, "addEventListener");

    const response = await GET(request);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    expect((await reader?.read())?.done).toBe(false);
    expect((await reader?.read())?.done).toBe(true);

    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(addAbort).not.toHaveBeenCalled();
    // The store's `change` events and the mail service's `mail` events.
    expect(mocks.on).toHaveBeenCalledTimes(2);
    expect(mocks.off).toHaveBeenCalledTimes(2);
    expect(unregister).not.toHaveBeenCalled();
  });

  it("cleans up a registered stream exactly once", async () => {
    const unregister = vi.fn();
    let shutdownClose: (() => void) | undefined;
    mocks.register.mockImplementation((close: () => void) => {
      shutdownClose = close;
      return unregister;
    });
    const controller = new AbortController();
    const request = new Request("https://brain.test/api/events", {
      signal: controller.signal,
    });
    const removeAbort = vi.spyOn(request.signal, "removeEventListener");

    const response = await GET(request);
    shutdownClose?.();
    shutdownClose?.();
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    expect((await reader?.read())?.done).toBe(false);
    expect((await reader?.read())?.done).toBe(true);

    expect(mocks.off).toHaveBeenCalledTimes(2);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(removeAbort).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/events mail events", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.register.mockImplementation(() => () => {});
  });

  it("carries each mail event as a named event with no replay id", async () => {
    const controller = new AbortController();
    const response = await GET(
      new Request("https://brain.test/api/events", { signal: controller.signal }),
    );
    const onMail = mocks.on.mock.calls.find(([name]) => name === "mail")?.[1] as
      | ((event: unknown) => void)
      | undefined;
    expect(onMail).toBeDefined();
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    // The ready frame first.
    expect(decoder.decode((await reader.read()).value)).toContain("event: ready");

    const event = {
      kind: "mail",
      changeKind: "sync",
      accountId: `account-a${"1".repeat(32)}`,
      mailboxIds: ["inbox"],
    };
    onMail!(event);

    // No `id:` line: a mail event is not in the replay journal, so it must not
    // move the tab's Last-Event-ID off the store's sequence.
    expect(decoder.decode((await reader.read()).value)).toBe(
      `event: mail\ndata: ${JSON.stringify(event)}\n\n`,
    );
    controller.abort();
    expect(mocks.off).toHaveBeenCalledWith("mail", onMail);
  });
});
