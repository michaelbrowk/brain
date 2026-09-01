import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  on: vi.fn(),
  off: vi.fn(),
  register: vi.fn(),
}));

vi.mock("@/lib/store/events", () => ({
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
    expect(mocks.on).toHaveBeenCalledTimes(1);
    expect(mocks.off).toHaveBeenCalledTimes(1);
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

    expect(mocks.off).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(removeAbort).toHaveBeenCalledTimes(1);
  });
});
