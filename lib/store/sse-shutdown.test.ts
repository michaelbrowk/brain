import { describe, expect, it, vi } from "vitest";
import { SseShutdownRegistry } from "./sse-shutdown";

describe("SseShutdownRegistry", () => {
  it("registers every active stream and closes each one once", () => {
    const registry = new SseShutdownRegistry();
    const first = vi.fn();
    const second = vi.fn();

    registry.register(first);
    registry.register(second);
    expect(registry.size()).toBe(2);

    expect(registry.beginShutdown()).toEqual({ started: true, closed: 2 });
    expect(registry.beginShutdown()).toEqual({ started: false, closed: 0 });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
    expect(registry.isShuttingDown()).toBe(true);
  });

  it("unregisters a stream idempotently before shutdown", () => {
    const registry = new SseShutdownRegistry();
    const close = vi.fn();
    const unregister = registry.register(close);

    unregister();
    unregister();
    registry.beginShutdown();

    expect(close).not.toHaveBeenCalled();
    expect(registry.size()).toBe(0);
  });

  it("continues draining when one stream close callback throws", () => {
    const registry = new SseShutdownRegistry();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const second = vi.fn();
    registry.register(() => {
      throw new Error("synthetic close failure");
    });
    registry.register(second);

    registry.beginShutdown();

    expect(second).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it("synchronously closes late registrations and returns an idempotent noop", () => {
    const registry = new SseShutdownRegistry();
    expect(registry.beginShutdown()).toEqual({ started: true, closed: 0 });
    const late = vi.fn();

    const unregister = registry.register(late);
    unregister();
    unregister();
    registry.beginShutdown();

    expect(late).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
  });

  it("closes registrations added reentrantly during the first drain", () => {
    const registry = new SseShutdownRegistry();
    const late = vi.fn();
    registry.register(() => {
      registry.register(late);
    });

    expect(registry.beginShutdown()).toEqual({ started: true, closed: 1 });

    expect(late).toHaveBeenCalledTimes(1);
    expect(registry.size()).toBe(0);
  });
});
