// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deviceZone } from "../tasks-client";
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
      .fn(
        async (_input: RequestInfo | URL) =>
          new Response(JSON.stringify(base), { status: 200 }),
      )
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

    // The mount reads the zone too, so count the update reads and not every
    // request the section makes.
    const updateReads = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("/api/settings/update"),
    );
    expect(updateReads).toHaveLength(2);
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

// The zone group answers a second route, so the stub routes by URL: the
// update status and the zone are two reads of one mount. A PUT echoes the name
// it was sent, the way the route does.
function stubZone(zone: { timeZone: string | null }) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/settings/zone")) {
      if (init?.method === "PUT") {
        const sent = JSON.parse(String(init.body)) as { timeZone: string };
        return new Response(JSON.stringify({ timeZone: sent.timeZone }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify(zone), { status: 200 });
    }
    return new Response(JSON.stringify(base), { status: 200 });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

/** Radix measures and captures the pointer; jsdom does neither. The stubs are
 *  `share-popover.test.tsx`'s, which opens a popover the same way. */
function stubPopoverPlatform() {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("PointerEvent", MouseEvent);
  for (const name of [
    "hasPointerCapture",
    "setPointerCapture",
    "releasePointerCapture",
  ]) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      value: () => (name === "hasPointerCapture" ? false : undefined),
    });
  }
}

describe("AccountSection · Time zone", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    resetUpdateStatusForTests();
    stubPopoverPlatform();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body
      .querySelectorAll("[data-radix-popper-content-wrapper]")
      .forEach((node) => node.remove());
    vi.unstubAllGlobals();
  });

  it("shows the captured zone", async () => {
    stubZone({ timeZone: "Europe/Lisbon" });
    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();
    expect(host.textContent).toContain("Time zone");
    expect(host.textContent).toContain("Europe/Lisbon");
  });

  it("says so when nothing has been captured yet", async () => {
    stubZone({ timeZone: null });
    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();
    expect(host.textContent).toContain("Not set yet");
  });

  it("sets this device's zone in one press", async () => {
    const fetchMock = stubZone({ timeZone: "Europe/Lisbon" });
    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();
    const use = host.querySelector<HTMLButtonElement>(
      '[aria-label="Use this device\'s zone"]',
    );
    await act(async () => use?.click());
    await settle();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/zone",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ timeZone: deviceZone() }),
      }),
    );
  });

  it("offers UTC, which the platform's own list leaves out", async () => {
    // Intl.supportedValuesOf("timeZone") answers canonical regions only and
    // carries no Etc/* entry, so without the prepended name a server-hosted
    // notebook could never be set to UTC.
    const fetchMock = stubZone({ timeZone: "Europe/Lisbon" });
    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();

    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(".brain-settings-row[data-stack] .btn-quiet")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();

    const utc = [...document.body.querySelectorAll(".brain-menu-item")].find(
      (row) => row.textContent === "UTC",
    );
    expect(utc).toBeDefined();

    await act(async () => {
      utc?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/settings/zone",
      expect.objectContaining({ body: JSON.stringify({ timeZone: "UTC" }) }),
    );
    expect(host.textContent).toContain("UTC");
  });

  it("keeps the action whole beside the longest zone name there is", async () => {
    // America/Argentina/Buenos_Aires is 30 characters, the longest canonical
    // name. Beside a label on a 375px phone the row runs out of width around
    // 17, and .brain-settings-group clips rather than scrolls, so the row
    // stacks and the name is the part that gives.
    stubZone({ timeZone: "America/Argentina/Buenos_Aires" });
    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();

    const row = host.querySelector<HTMLElement>(
      ".brain-settings-row[data-stack]",
    );
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Reminders fire in");

    const value = row?.querySelector<HTMLElement>(".btn-quiet .truncate");
    expect(value?.textContent).toBe("America/Argentina/Buenos_Aires");
    expect(row?.querySelector(".btn-quiet")?.className).toContain("min-w-0");

    const use = host.querySelector<HTMLElement>(
      '[aria-label="Use this device\'s zone"]',
    );
    expect(use?.textContent).toBe("Use this device");
    expect(use?.className).toContain("shrink-0");
  });

  it("toasts when the zone cannot be saved and keeps the one on screen", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/settings/zone")) {
          return init?.method === "PUT"
            ? new Response("", { status: 503 })
            : new Response(JSON.stringify({ timeZone: "Europe/Lisbon" }), { status: 200 });
        }
        return new Response(JSON.stringify(base), { status: 200 });
      }),
    );
    const onToast = vi.fn();

    await act(async () => root.render(<AccountSection onToast={onToast} />));
    await settle();
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('[aria-label="Use this device\'s zone"]')
        ?.click();
    });
    await settle();

    expect(onToast).toHaveBeenCalledWith("Could not save the time zone");
    expect(host.textContent).toContain("Europe/Lisbon");
  });

  it("says nothing is set when the zone route fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("/api/settings/zone")
          ? new Response("nope", { status: 500 })
          : new Response(JSON.stringify(base), { status: 200 }),
      ),
    );
    await act(async () => root.render(<AccountSection onToast={() => {}} />));
    await settle();
    expect(host.textContent).toContain("Not set yet");
  });
});
