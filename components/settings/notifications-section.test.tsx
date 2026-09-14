// @vitest-environment jsdom

// The section a person opens when notifications are already not working, so
// every branch here is a sentence they can act on: the gesture, the iOS
// install, a refused permission, a device list with no endpoint in it, the
// two kind toggles, and the zone the scheduler reads.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_SECTION_META,
  SETTINGS_SECTION_ORDER,
  isSettingsSection,
  parseSettingsPath,
} from "./sections";
import { NotificationsSection } from "./notifications-section";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const { enable, pushSupportedMock } = vi.hoisted(() => ({
  enable: vi.fn(),
  pushSupportedMock: vi.fn(() => true),
}));
vi.mock("../push-client", async () => {
  const actual = await vi.importActual<typeof import("../push-client")>("../push-client");
  return { ...actual, enablePushOnThisDevice: enable, pushSupported: pushSupportedMock };
});

describe("the settings registry", () => {
  it("puts Notifications between Connections and Sharing", () => {
    expect(SETTINGS_SECTION_ORDER).toEqual([
      "appearance",
      "mail",
      "connections",
      "notifications",
      "sharing",
      "data",
      "account",
      "donate",
    ]);
  });

  it("names it with the bell", () => {
    expect(SETTINGS_SECTION_META.notifications).toEqual({ label: "Notifications", icon: "bell" });
  });

  it("accepts /settings/notifications as a deep link", () => {
    expect(isSettingsSection("notifications")).toBe(true);
    expect(parseSettingsPath("/settings/notifications")).toBe("notifications");
  });
});

let host: HTMLDivElement;
let root: Root;
let state: { devices: unknown[]; kinds: Record<string, boolean> };
let zone: string | null;
let testResponseBody: { sent: number; removed: number; skipped: string | null };
let patchShouldFail: boolean;

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  enable.mockReset();
  pushSupportedMock.mockReset();
  pushSupportedMock.mockReturnValue(true);
  state = { devices: [], kinds: { "task-reminder": true, "mail-new": true } };
  zone = "Europe/Lisbon";
  testResponseBody = { sent: 1, removed: 0, skipped: null };
  patchShouldFail = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/push/state" && (init?.method ?? "GET") === "GET") return response(state);
      if (url === "/api/push/state") {
        if (patchShouldFail) return response(null, 500);
        const patch = JSON.parse(String(init!.body)).kinds;
        state = { ...state, kinds: { ...state.kinds, ...patch } };
        return response({ kinds: state.kinds });
      }
      if (url === "/api/push/subscriptions") return response({ removed: true });
      if (url === "/api/push/test") return response(testResponseBody);
      if (url === "/api/settings/zone") return response({ timeZone: zone });
      throw new Error(`unexpected request: ${url}`);
    }),
  );
  Object.defineProperty(navigator, "userAgent", {
    configurable: true,
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
  });
  Object.defineProperty(navigator, "standalone", { configurable: true, value: undefined });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => root.render(<NotificationsSection onToast={() => {}} />));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const text = () => host.textContent ?? "";
const button = (name: string) =>
  [...host.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === name);

describe("Settings → Notifications", () => {
  it("offers the gesture that turns push on for this device", async () => {
    await render();
    expect(button("Turn on on this device")).toBeTruthy();
  });

  it("adds the device to the list when the gesture succeeds", async () => {
    enable.mockResolvedValue({
      ok: true,
      device: {
        id: "0123456789abcdef",
        deviceLabel: "Mac",
        createdAt: "2026-09-14T12:00:00.000Z",
        lastSeenAt: "2026-09-14T12:00:00.000Z",
      },
    });
    await render();
    await act(async () => button("Turn on on this device")!.click());
    expect(text()).toContain("Mac");
  });

  it("says what to do when the browser refused the permission", async () => {
    enable.mockResolvedValue({ ok: false, reason: "denied" });
    await render();
    await act(async () => button("Turn on on this device")!.click());
    expect(text()).toContain(
      "This browser refused notifications. Allow them for Brain in the browser's own settings, then try again.",
    );
  });

  it("asks for the Home Screen on an iPhone in Safari", async () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile Safari/604.1",
    });
    await render();
    expect(text()).toContain(
      "Add Brain to your Home Screen first. On iPhone and iPad, notifications reach a web app only once it is installed: open the share sheet and pick Add to Home Screen.",
    );
    expect(button("Turn on on this device")).toBeUndefined();
  });

  it("does not ask for the Home Screen once the app is installed", async () => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 Version/18.1 Mobile Safari/604.1",
    });
    Object.defineProperty(navigator, "standalone", { configurable: true, value: true });
    await render();
    expect(text()).not.toContain("Add Brain to your Home Screen first");
    expect(button("Turn on on this device")).toBeTruthy();
  });

  it("lists a registered device and removes it", async () => {
    state.devices = [
      {
        id: "0123456789abcdef",
        deviceLabel: "iPhone",
        createdAt: "2026-09-14T12:00:00.000Z",
        lastSeenAt: "2026-09-14T12:00:00.000Z",
      },
    ];
    await render();
    expect(text()).toContain("iPhone");
    const remove = host.querySelector<HTMLButtonElement>('[aria-label="Remove iPhone"]');
    await act(async () => remove!.click());
    expect(host.textContent).not.toContain("iPhone");
    const call = vi
      .mocked(fetch)
      .mock.calls.find(([input]) => String(input) === "/api/push/subscriptions")!;
    const init = call[1] as RequestInit;
    expect(init.method).toBe("DELETE");
    expect(JSON.parse(String(init.body))).toEqual({ id: "0123456789abcdef" });
  });

  it("never shows an endpoint", async () => {
    state.devices = [
      {
        id: "0123456789abcdef",
        deviceLabel: "iPhone",
        createdAt: "2026-09-14T12:00:00.000Z",
        lastSeenAt: "2026-09-14T12:00:00.000Z",
      },
    ];
    await render();
    expect(text()).not.toContain("https://");
  });

  it("turns one kind off and leaves the other", async () => {
    await render();
    const off = [...host.querySelectorAll('[role="radio"]')].filter(
      (node) => (node.textContent ?? "").trim() === "Off",
    );
    await act(async () => (off[1] as HTMLElement).click());
    expect(state.kinds).toEqual({ "task-reminder": true, "mail-new": false });
  });

  it("says what a push carries, in the owner's own words", async () => {
    await render();
    expect(text()).toContain(
      "A push carries the task's title, or the sender's name and the subject, and nothing else. It is encrypted to the device.",
    );
  });

  it("names the zone reminders are read in", async () => {
    await render();
    expect(text()).toContain("Reminders fire on Europe/Lisbon time.");
  });

  it("says the scheduler is idle when no zone is set", async () => {
    zone = null;
    await render();
    expect(text()).toContain("No time zone is set, so no reminder will fire. Set one in Account.");
  });

  it("sends a test and reports how many devices took it", async () => {
    state.devices = [
      {
        id: "0123456789abcdef",
        deviceLabel: "iPhone",
        createdAt: "2026-09-14T12:00:00.000Z",
        lastSeenAt: "2026-09-14T12:00:00.000Z",
      },
    ];
    await render();
    await act(async () => button("Send a test")!.click());
    expect(text()).toContain("Sent to 1 device.");
  });

  it("says push is unsupported when the browser cannot receive it", async () => {
    pushSupportedMock.mockReturnValue(false);
    await render();
    expect(text()).toContain("This browser cannot receive push notifications.");
    expect(button("Turn on on this device")).toBeUndefined();
  });

  it("reports the plural when more than one device took the test", async () => {
    testResponseBody = { sent: 3, removed: 0, skipped: null };
    await render();
    await act(async () => button("Send a test")!.click());
    expect(text()).toContain("Sent to 3 devices.");
  });

  it("says the kind is off when the test was skipped for it", async () => {
    testResponseBody = { sent: 0, removed: 0, skipped: "kind-off" };
    await render();
    await act(async () => button("Send a test")!.click());
    expect(text()).toContain("Task reminders are switched off, so nothing was sent.");
  });

  it("says no device is registered when none has ever subscribed", async () => {
    testResponseBody = { sent: 0, removed: 0, skipped: "no-devices" };
    await render();
    await act(async () => button("Send a test")!.click());
    expect(text()).toContain("No device is registered yet.");
  });

  it("says every device refused when devices exist but none took it", async () => {
    testResponseBody = { sent: 0, removed: 0, skipped: null };
    await render();
    await act(async () => button("Send a test")!.click());
    expect(text()).toContain("No device took the message. Try again.");
  });

  it("reverts a kind toggle when the save fails", async () => {
    patchShouldFail = true;
    await render();
    const group = host.querySelector('[role="radiogroup"][aria-label="New mail"]')!;
    const off = [...group.querySelectorAll('[role="radio"]')].find(
      (node) => (node.textContent ?? "").trim() === "Off",
    ) as HTMLElement;
    await act(async () => off.click());
    expect(text()).toContain("Couldn't save that. Try again.");
    const on = [...group.querySelectorAll('[role="radio"]')].find(
      (node) => (node.textContent ?? "").trim() === "On",
    )!;
    expect(on.getAttribute("aria-checked")).toBe("true");
  });
});
