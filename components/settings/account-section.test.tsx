// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountSection } from "./account-section";
import { resetUpdateStatusForTests } from "./use-update-status";

const base = {
  apiVersion: 1,
  version: "0.9.0",
  commit: "a".repeat(40),
  buildTime: "2026-09-01T18:00:00Z",
  updateCheck: "on",
  checkedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  latest: null,
  updateAvailable: false,
  error: null,
};

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function stubStatus(body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
  );
}

describe("AccountSection · About", () => {
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

  it("shows the version and 'Up to date' with the check time", async () => {
    stubStatus(base);

    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();

    expect(host.textContent).toContain("Brain 0.9.0");
    expect(host.textContent).toContain("aaaaaaaaaaaa");
    expect(host.textContent).toContain("Up to date");
    expect(host.textContent).toContain("2h ago");
    expect(host.querySelector('[aria-label="Check for updates"]')).not.toBeNull();
  });

  it("links to the newer release", async () => {
    const latest = {
      version: "0.9.1",
      url: "https://github.com/michaelbrowk/brain/releases/tag/v0.9.1",
      publishedAt: "2026-09-02T08:00:00Z",
    };
    stubStatus({ ...base, latest, updateAvailable: true });

    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();

    expect(host.textContent).toContain("0.9.1 is available");
    const link = host.querySelector(
      'a[href="https://github.com/michaelbrowk/brain/releases/tag/v0.9.1"]',
    );
    expect(link?.textContent).toContain("What changed");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("says the check is off and hides the refresh", async () => {
    stubStatus({ ...base, updateCheck: "off", checkedAt: null });

    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();

    expect(host.textContent).toContain(
      "Off (BRAIN_UPDATE_CHECK=off). Remove the switch to check once a day.",
    );
    expect(host.querySelector('[aria-label="Check for updates"]')).toBeNull();
  });

  it("shows a development build without a version", async () => {
    stubStatus({ ...base, version: null });

    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();

    expect(host.textContent).toContain("development build");
  });

  it("says the first check has not run yet", async () => {
    stubStatus({ ...base, checkedAt: null });

    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();

    expect(host.textContent).toContain(
      "Not checked yet. The first check runs shortly after start.",
    );
  });

  it("says GitHub did not answer when the last check failed", async () => {
    stubStatus({ ...base, error: "github: 503" });

    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();

    expect(host.textContent).toContain("GitHub did not answer");
  });

  it("says it could not read the status when the route fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );

    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();

    expect(host.textContent).toContain("Could not read the update status");
    expect(host.querySelector('[aria-label="Check for updates"]')).toBeNull();
  });

  it("offers a retry when the route fails and recovers on the next read", async () => {
    const fetchMock = vi
      .fn(async () => new Response(JSON.stringify(base), { status: 200 }))
      .mockResolvedValueOnce(new Response("nope", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();
    expect(host.textContent).toContain("Could not read the update status");
    const retry = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    );
    expect(retry).toBeDefined();

    await act(async () => retry?.click());
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(host.textContent).toContain("Brain 0.9.0");
    expect(host.textContent).toContain("Up to date");
    expect(host.textContent).not.toContain("Try again");
  });

  it("names the latest release on a development build", async () => {
    const latest = {
      version: "0.9.1",
      url: "https://github.com/michaelbrowk/brain/releases/tag/v0.9.1",
      publishedAt: "2026-09-02T08:00:00Z",
    };
    stubStatus({ ...base, version: null, latest });

    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();

    expect(host.textContent).toContain("Latest release is 0.9.1");
    expect(host.textContent).toContain("checked 2h ago");
    expect(host.textContent).not.toContain("Up to date");
  });

  it("toasts when a refresh fails and keeps the last status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response("", { status: 503 })
          : new Response(JSON.stringify(base), { status: 200 }),
      ),
    );
    const onToast = vi.fn();

    await act(async () => root.render(<AccountSection onToast={onToast} />));
    await settle();
    expect(host.textContent).toContain("Up to date");

    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('[aria-label="Check for updates"]')
        ?.click();
    });
    await settle();

    expect(onToast).toHaveBeenCalledWith("Could not check for updates");
    expect(host.textContent).toContain("Up to date");
  });
});
