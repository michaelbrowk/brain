// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetUpdateStatusForTests, useUpdateStatus } from "./use-update-status";

const status = {
  apiVersion: 1,
  version: "0.9.0",
  commit: "a".repeat(40),
  buildTime: "2026-09-01T18:00:00Z",
  updateCheck: "on",
  checkedAt: "2026-09-02T09:00:00Z",
  latest: null,
  updateAvailable: false,
  error: null,
};

function Probe({ label }: { label: string }) {
  const { state, refresh, refreshing } = useUpdateStatus();
  return (
    <span data-probe={label} data-refreshing={refreshing ? "" : undefined}>
      {state.kind === "ready" ? state.status.version : state.kind}
      <button type="button" data-refresh={label} onClick={() => void refresh()} />
    </span>
  );
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useUpdateStatus", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    resetUpdateStatusForTests();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function pressRefresh(label: string) {
    await act(async () => {
      host.querySelector<HTMLButtonElement>(`[data-refresh="${label}"]`)?.click();
    });
    await settle();
  }

  it("fetches once for two consumers", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(status), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () =>
      root.render(
        <>
          <Probe label="a" />
          <Probe label="b" />
        </>,
      ),
    );
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("GET");
    expect(host.textContent).toBe("0.9.00.9.0");
  });

  it("a refresh POSTs and both consumers see the new status", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ ...status, version: "0.9.1" }), { status: 200 })
        : new Response(JSON.stringify(status), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () =>
      root.render(
        <>
          <Probe label="a" />
          <Probe label="b" />
        </>,
      ),
    );
    await settle();
    expect(host.textContent).toBe("0.9.00.9.0");

    await pressRefresh("a");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(host.textContent).toBe("0.9.10.9.1");
    expect(host.querySelector("[data-refreshing]")).toBeNull();
  });

  it("keeps the last good status when a refresh fails", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? new Response(JSON.stringify({ error: "update check is off" }), { status: 409 })
        : new Response(JSON.stringify(status), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => root.render(<Probe label="a" />));
    await settle();
    expect(host.textContent).toBe("0.9.0");

    await pressRefresh("a");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe("0.9.0");
  });

  it("reports an error when the first read fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    await act(async () => root.render(<Probe label="a" />));
    await settle();

    expect(host.textContent).toBe("error");
  });
});
