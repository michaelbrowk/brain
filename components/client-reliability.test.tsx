// @vitest-environment jsdom

import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/client";
import LoginPage from "@/app/login/page";
import { ShareGate } from "./share-gate";
import { TrashDialog } from "./trash-dialog";
import { HistoryDialog } from "./history-dialog";
import { SharingSection } from "./settings/sharing-section";
import { ConnectionsSection } from "./settings/connections-section";
import { DataSection } from "./settings/data-section";
import type { DialogFocusLeaseRef } from "./ui/dialog-focus-return";
import { Snackbar } from "./ui/primitives";
import type { TreeNode } from "@/lib/store/types";

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/lib/client", () => ({
  apiFetch: vi.fn(),
  CLIENT_ID: "test-client",
}));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
}));

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function dialogFocusProps(owner = 1) {
  const returnFocusRef: DialogFocusLeaseRef = { current: null };
  return {
    returnFocusRef,
    focusOwner: owner,
    onFocusReturned: () => {},
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function inputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("client reliability states", () => {
  let container: HTMLDivElement;
  let root: Root;
  const apiFetchMock = vi.mocked(apiFetch);

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    apiFetchMock.mockReset();
    navigation.replace.mockReset();
    navigation.refresh.mockReset();
  });

  it("re-enables login after a network failure", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await act(async () => root.render(<LoginPage />));

    const input = container.querySelector("input") as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => inputValue(input, "keep-this-password"));
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();

    expect(container.textContent).toContain("Couldn't connect. Try again.");
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(input.value).toBe("keep-this-password");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(document.getElementById("login-error")?.getAttribute("role")).toBe(
      "alert",
    );
  });

  it.each([
    [
      "/oauth/authorize?client_id=client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback",
      "/oauth/authorize?client_id=client&redirect_uri=https%3A%2F%2Fclient.example%2Fcallback",
    ],
    ["//evil.example/oauth/authorize", "/"],
    ["/oauth/authorize%5c@evil.example", "/"],
  ])("navigates only to a strict OAuth return target", async (returnTo, expected) => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    );
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 200)));
    window.history.replaceState(
      {},
      "",
      `/login?returnTo=${encodeURIComponent(returnTo)}`,
    );
    await act(async () => root.render(<LoginPage />));

    const input = container.querySelector("input") as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => inputValue(input, "correct-password"));
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await act(async () => vi.advanceTimersByTime(200));

    expect(navigation.replace).toHaveBeenCalledWith(expected);
    expect(navigation.refresh).toHaveBeenCalledOnce();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    container.remove();
    window.history.replaceState({}, "", "/");
    vi.unstubAllGlobals();
  });

  it("re-enables a protected share form after a network failure", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<ShareGate id="shared-page" />));

    const input = container.querySelector("input") as HTMLInputElement;
    const form = container.querySelector("form") as HTMLFormElement;
    await act(async () => inputValue(input, "keep-this-password"));
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await settle();

    expect(container.textContent).toContain("Couldn't connect. Try again.");
    expect((container.querySelector("button") as HTMLButtonElement).disabled).toBe(false);
    expect(input.value).toBe("keep-this-password");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(
      document.getElementById("share-error-shared-page")?.getAttribute("role"),
    ).toBe("alert");
  });

  it("keeps a Settings share row active when durable revoke fails", async () => {
    const pending = deferred<void>();
    const onUnshare = vi.fn(() => pending.promise);
    const sharedPage: TreeNode = {
      id: "shared-page",
      parentId: null,
      title: "Shared page",
      order: "a0",
      public: true,
      shareExpiresAt: "2000-01-01T00:00:00.000Z",
      created: "2026-07-01T00:00:00.000Z",
      updated: "2026-07-01T00:00:00.000Z",
      hasChildren: false,
      children: [],
    };
    await act(async () =>
      root.render(
        <SharingSection
          tree={[sharedPage]}
          onUnshare={onUnshare}
          onCopyShareLink={() => {}}
        />,
      ),
    );
    await settle();

    const stop = document.body.querySelector(
      '[aria-label="Stop sharing Shared page"]',
    ) as HTMLButtonElement;
    expect(document.body.textContent).toContain("Expired");
    expect(
      (
        document.body.querySelector(
          '[aria-label="Copy link for Shared page"]',
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    await act(async () => stop.click());
    expect(document.body.textContent).toContain("Stopping…");
    expect(document.body.textContent).toContain("Shared page");
    expect(document.body.textContent).not.toContain(
      "The link is still active",
    );

    await act(async () => pending.reject(new Error("read-back failed")));
    await settle();
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "The link is still active",
    );
    expect(document.body.textContent).toContain("Shared page");
    expect(stop.disabled).toBe(false);
  });

  it("announces snackbar status without changing its visual geometry", async () => {
    await act(async () =>
      root.render(<Snackbar open title="Your draft is safe" />),
    );

    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("aria-atomic")).toBe("true");
    expect(status?.textContent).toContain("Your draft is safe");
  });

  // The two tests here were the Inbox dialog's: a failed triage stayed
  // retryable, and AI never took away the manual "File…" escape hatch. Both
  // surfaces are gone. What is left to hold is the promise the settings
  // disclosure makes about what the app sends — it must name what still runs
  // and nothing else.
  it("discloses only the AI requests the app still makes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          endpoint: "https://brain.test/api/mcp",
          token: "secret-token",
          oauth: {
            issuer: "https://brain.test",
            authorizationEndpoint: "https://brain.test/oauth/authorize",
          },
          connectedApps: [],
        }),
      ),
    );
    await act(async () =>
      root.render(<ConnectionsSection onToast={() => {}} />),
    );
    await settle();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Smart sort and emoji suggestions send only");
    expect(text).not.toContain("triage");
  });

  it("validates MCP settings and offers a working retry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ error: "unavailable" }, 500))
      .mockResolvedValueOnce(
        response({
          endpoint: "https://brain.test/api/mcp",
          token: "secret-token",
          oauth: {
            issuer: "https://brain.test",
            authorizationEndpoint: "https://brain.test/oauth/authorize",
          },
          connectedApps: [
            {
              grantId: "grant-a",
              clientId: "client-a",
              clientName: "Claude Code",
              scopes: ["brain:read", "brain:write"],
              connectedAt: 1_700_000_000_000,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          endpoint: "https://brain.test/api/mcp",
          token: "secret-token",
          oauth: {
            issuer: "https://brain.test",
            authorizationEndpoint: "https://brain.test/oauth/authorize",
          },
          connectedApps: [],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<ConnectionsSection onToast={() => {}} />),
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await settle();

    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't load MCP settings.",
    );
    expect(
      (document.body.querySelector('[aria-label="Copy endpoint"]') as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    const retry = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    ) as HTMLButtonElement;
    await act(async () => retry.click());
    await settle();

    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain("https://brain.test/api/mcp");
    expect(
      (document.body.querySelector('[aria-label="Copy endpoint"]') as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      document.body.querySelector('[aria-label="Copy verification prompt"]'),
    ).not.toBeNull();
    expect(document.body.textContent).toContain("Claude Code");
    expect(document.body.textContent).toContain("Read · Write");

    const refresh = document.body.querySelector(
      'button[aria-label="Refresh connected apps"]',
    ) as HTMLButtonElement;
    await act(async () => refresh.click());
    await settle();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(document.body.textContent).toContain("No apps connected with OAuth yet");
  });

  it("preflights a portable import before enabling the apply action", async () => {
    const onToast = vi.fn();
    const summary = {
      title: "Project Notes",
      pages: 3,
      rootPages: 1,
      attachments: 2,
      attachmentBytes: 2_048,
      collections: 0,
    };
    const portableResponses = [
      response({ ok: true, mode: "dry-run", summary }),
      response({
        ok: true,
        mode: "apply",
        summary,
        result: { rootIds: ["new-root"], created: 3 },
      }),
    ];
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === "/api/settings/backup") {
        return Promise.resolve(response({ error: "unavailable" }, 503));
      }
      const next = portableResponses.shift();
      if (!next) throw new Error("Unexpected portable import request");
      return Promise.resolve(next);
    });
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<DataSection onToast={onToast} />));
    await settle();
    const input = document.body.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(
      [new Uint8Array([31, 139, 8, 0])],
      "project.brain.tar.gz",
      { type: "application/gzip" },
    );
    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();

    expect(document.body.textContent).toContain("Project Notes");
    expect(document.body.textContent).toContain("3 pages · 2 attachments · 2 KB");
    const portableCalls = () =>
      fetchMock.mock.calls.filter(
        ([input]) => String(input) === "/api/portable/import",
      );
    expect(portableCalls()).toHaveLength(1);
    const apply = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Import new pages",
    ) as HTMLButtonElement;
    await act(async () => apply.click());
    await settle();

    expect(portableCalls()).toHaveLength(2);
    const modes = portableCalls().map((call) =>
      (call[1]?.body as FormData).get("mode"),
    );
    expect(modes).toEqual(["dry-run", "apply"]);
    expect(document.body.textContent).toContain("Import complete");
    expect(onToast).toHaveBeenCalledWith("Imported 3 pages");
  });

  it("keeps a trash item visible when restore fails", async () => {
    apiFetchMock
      .mockResolvedValueOnce(
        response({
          trash: [
            {
              id: "page-a",
              title: "Still here",
              deleted: new Date().toISOString(),
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response({}, 500));
    const changed = vi.fn();
    await act(async () =>
      root.render(
        <TrashDialog open onOpenChange={() => {}} onChanged={changed} />,
      ),
    );
    await settle();

    const restore = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === "Restore",
    ) as HTMLButtonElement;
    await act(async () => restore.click());
    await settle();

    expect(document.body.textContent).toContain("Still here");
    expect(document.body.textContent).toContain("Couldn't restore this page. Try again.");
    expect(changed).not.toHaveBeenCalled();
    expect(restore.disabled).toBe(false);
  });

  it("sends the captured revision and keeps history open on a restore conflict", async () => {
    const versions = [
      { sha: "current", date: "2026-07-11T08:00:00.000Z", msg: "current" },
      { sha: "older", date: "2026-07-10T08:00:00.000Z", msg: "older" },
    ];
    apiFetchMock
      .mockResolvedValueOnce(response({ history: versions }))
      .mockResolvedValueOnce(response({ markdown: "current body" }))
      .mockResolvedValueOnce(response({ markdown: "older body" }))
      .mockResolvedValueOnce(response({}, 409));
    const onOpenChange = vi.fn();
    const onRestored = vi.fn();
    await act(async () =>
      root.render(
        <HistoryDialog
          pageId="page-a"
          baseRevision="rev-current"
          open
          onOpenChange={onOpenChange}
          onRestored={onRestored}
          {...dialogFocusProps()}
        />,
      ),
    );
    await settle();

    const timelineButtons = document.body.querySelectorAll("nav button");
    expect(timelineButtons[0].getAttribute("aria-current")).toBe("true");
    expect(timelineButtons[0].getAttribute("aria-pressed")).toBe("true");
    await act(async () => (timelineButtons[1] as HTMLButtonElement).click());
    await settle();
    expect(timelineButtons[0].getAttribute("aria-pressed")).toBe("false");
    expect(timelineButtons[1].getAttribute("aria-pressed")).toBe("true");
    const restore = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Restore this version"),
    ) as HTMLButtonElement;
    await act(async () => restore.click());
    await settle();

    const [, restoreOptions] = apiFetchMock.mock.calls[3];
    expect(restoreOptions).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(JSON.parse(String(restoreOptions?.body))).toEqual({
      rev: "rev-current",
    });
    expect(document.body.textContent).toContain(
      "Page changed elsewhere. Close History and review the current page.",
    );
    expect(document.body.textContent).toContain("older body");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
    expect(restore.disabled).toBe(false);
  });

  it("keeps History open on Escape until a successful restore reload is scheduled", async () => {
    const versions = [
      { sha: "current", date: "2026-07-11T08:00:00.000Z", msg: "current" },
      { sha: "older", date: "2026-07-10T08:00:00.000Z", msg: "older" },
    ];
    const restoreResponse = deferred<Response>();
    apiFetchMock
      .mockResolvedValueOnce(response({ history: versions }))
      .mockResolvedValueOnce(response({ markdown: "current body" }))
      .mockResolvedValueOnce(response({ markdown: "older body" }))
      .mockReturnValueOnce(restoreResponse.promise);
    const onOpenChange = vi.fn();
    const onRestored = vi.fn();

    await act(async () =>
      root.render(
        <HistoryDialog
          pageId="page-a"
          baseRevision="rev-current"
          open
          onOpenChange={onOpenChange}
          onRestored={onRestored}
          {...dialogFocusProps()}
        />,
      ),
    );
    await settle();

    const timelineButtons = document.body.querySelectorAll("nav button");
    await act(async () => (timelineButtons[1] as HTMLButtonElement).click());
    await settle();
    const restore = [...document.body.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("Restore this version"),
    ) as HTMLButtonElement;
    await act(async () => restore.click());
    await settle();
    expect(restore.disabled).toBe(true);

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          code: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
      await Promise.resolve();
    });
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    await act(async () => {
      restoreResponse.resolve(response({}));
      await restoreResponse.promise;
    });
    await settle();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it("ignores a stale StrictMode history load after selecting an older version", async () => {
    const versions = [
      { sha: "current", date: "2026-07-11T08:00:00.000Z", msg: "current" },
      { sha: "older", date: "2026-07-10T08:00:00.000Z", msg: "older" },
    ];
    const staleHistory = deferred<Response>();
    const latestHistory = deferred<Response>();
    apiFetchMock
      .mockReturnValueOnce(staleHistory.promise)
      .mockReturnValueOnce(latestHistory.promise)
      .mockResolvedValueOnce(response({ markdown: "current body" }))
      .mockResolvedValueOnce(response({ markdown: "older body" }))
      .mockResolvedValueOnce(response({ markdown: "stale current body" }));

    await act(async () =>
      root.render(
        <StrictMode>
          <HistoryDialog
            pageId="page-a"
            baseRevision="rev-current"
            open
            onOpenChange={() => {}}
            onRestored={() => {}}
            {...dialogFocusProps()}
          />
        </StrictMode>,
      ),
    );
    await settle();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      latestHistory.resolve(response({ history: versions }));
      await latestHistory.promise;
    });
    await settle();
    expect(document.body.textContent).toContain("current body");

    const timelineButtons = document.body.querySelectorAll("nav button");
    await act(async () => (timelineButtons[1] as HTMLButtonElement).click());
    await settle();
    expect(document.body.textContent).toContain("older body");

    await act(async () => {
      staleHistory.resolve(response({ history: versions }));
      await staleHistory.promise;
    });
    await settle();

    expect(document.body.textContent).toContain("older body");
    expect(document.body.textContent).not.toContain("stale current body");
    expect(apiFetchMock).toHaveBeenCalledTimes(4);
  });

  it("ignores a late preview response after switching to another page", async () => {
    const pageAPreview = deferred<Response>();
    const onOpenChange = vi.fn();
    const onRestored = vi.fn();
    apiFetchMock
      .mockResolvedValueOnce(
        response({
          history: [
            {
              sha: "current-a",
              date: "2026-07-11T08:00:00.000Z",
              msg: "current a",
            },
          ],
        }),
      )
      .mockReturnValueOnce(pageAPreview.promise)
      .mockResolvedValueOnce(
        response({
          history: [
            {
              sha: "current-b",
              date: "2026-07-11T09:00:00.000Z",
              msg: "current b",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ markdown: "body from page B" }));

    await act(async () =>
      root.render(
        <HistoryDialog
          pageId="page-a"
          baseRevision="rev-a"
          open
          onOpenChange={onOpenChange}
          onRestored={onRestored}
          {...dialogFocusProps()}
        />,
      ),
    );
    await settle();
    expect(apiFetchMock).toHaveBeenCalledTimes(2);

    await act(async () =>
      root.render(
        <HistoryDialog
          pageId="page-b"
          baseRevision="rev-b"
          open
          onOpenChange={onOpenChange}
          onRestored={onRestored}
          {...dialogFocusProps()}
        />,
      ),
    );
    await settle();
    expect(document.body.textContent).toContain("body from page B");

    await act(async () => {
      pageAPreview.resolve(response({ markdown: "stale body from page A" }));
      await pageAPreview.promise;
    });
    await settle();

    expect(document.body.textContent).toContain("body from page B");
    expect(document.body.textContent).not.toContain("stale body from page A");
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });
});
