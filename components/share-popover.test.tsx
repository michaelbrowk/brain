// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareScopeSnapshot } from "@/lib/store/types";
import { SharePopover } from "./share-popover";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("Expected a clickable element");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle();
}

function inputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(name: string) {
  return [...document.body.querySelectorAll("button, label")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
}

/** The review's confirm button: the verb alone, the count lives in the title. */
function shareButton() {
  return [
    ...document.body.querySelectorAll('[data-share-state="review"] button'),
  ].find((candidate) => candidate.textContent?.trim() === "Share");
}

function snapshot(
  values: Partial<ShareScopeSnapshot> = {},
): ShareScopeSnapshot {
  return {
    rootId: "page-a",
    descendantCount: 0,
    overlappingRoots: [],
    scopeToken: "a".repeat(64),
    public: false,
    shareLocked: false,
    shareExpiresAt: null,
    shareVersion: 0,
    ...values,
  };
}

describe("SharePopover redesign", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    vi.stubGlobal("PointerEvent", MouseEvent);
    Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
      configurable: true,
      value: () => false,
    });
    Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
      configurable: true,
      value: () => undefined,
    });
    Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
      configurable: true,
      value: () => undefined,
    });
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    host.remove();
    document.body
      .querySelectorAll("[data-radix-popper-content-wrapper]")
      .forEach((node) => node.remove());
    vi.unstubAllGlobals();
  });

  function popover(
    isPublic: boolean,
    options: Partial<
      Omit<ComponentProps<typeof SharePopover>, "children" | "isPublic" | "pageId">
    > = {},
  ) {
    const fallback = snapshot({
      rootId:
        options.inheritedFrom?.id ?? options.expiredInheritedFrom?.id ?? "page-a",
      public:
        isPublic || !!options.inheritedFrom || !!options.expiredInheritedFrom,
      shareLocked: !!options.hasPassword,
      shareExpiresAt:
        options.expiredInheritedFrom?.expiresAt ?? options.expiresAt ?? null,
      shareVersion: isPublic ? 1 : 0,
    });
    return (
      <SharePopover
        isPublic={isPublic}
        pageId="page-a"
        hasPassword={!!options.hasPassword}
        expiresAt={options.expiresAt}
        inheritedFrom={options.inheritedFrom}
        expiredInheritedFrom={options.expiredInheritedFrom}
        scopeRevision={options.scopeRevision}
        onPrepareShare={
          options.onPrepareShare ??
          ((rootId) =>
            Promise.resolve({
              ...fallback,
              rootId,
              public: rootId === "page-a" ? isPublic : true,
            }))
        }
        onEnableShare={
          options.onEnableShare ??
          (() =>
            Promise.resolve({
              status: "enabled",
              snapshot: { ...fallback, rootId: "page-a", public: true },
            }))
        }
        onDisableShare={
          options.onDisableShare ??
          (() => Promise.resolve({ ...fallback, rootId: "page-a", public: false }))
        }
        onCopyLink={options.onCopyLink ?? (() => {})}
        onOpenShareSettings={options.onOpenShareSettings}
        onSetProtection={options.onSetProtection ?? (() => {})}
      >
        <button aria-label="Share trigger">Share</button>
      </SharePopover>
    );
  }

  async function renderAndOpen(
    isPublic: boolean,
    options: Parameters<typeof popover>[1] = {},
  ) {
    await act(async () => root.render(popover(isPublic, options)));
    await click(host.querySelector('[aria-label="Share trigger"]'));
  }

  it("opens an exact private review with password protection off by default", async () => {
    const onPrepareShare = vi
      .fn()
      .mockResolvedValue(snapshot({ descendantCount: 2 }));
    await renderAndOpen(false, { onPrepareShare });

    expect(onPrepareShare).toHaveBeenCalledWith("page-a");
    const dialog = document.body.querySelector(
      '[role="dialog"][aria-label="Share settings"]',
    );
    expect(dialog).not.toBeNull();
    expect(dialog?.contains(document.activeElement)).toBe(true);
    // the count is said once, in the title: the button is the verb and the
    // description does not restate the scope
    expect(document.body.querySelector("h2")?.textContent).toBe("Share 3 pages");
    expect(document.body.textContent?.match(/Share 3 pages/g)).toHaveLength(1);
    expect(shareButton()).not.toBeUndefined();
    expect(document.body.textContent).toContain("Anyone with the link can read them.");
    expect(document.body.textContent).not.toContain("its subpages");
    expect(document.body.textContent).not.toContain(
      "Pages added to or moved into this page later will also be shared automatically.",
    );
    expect(document.body.querySelector('[aria-label="Share to web"]')).toBeNull();
    const passwordToggle = document.body.querySelector(
      '[role="switch"][aria-label="Password protection"]',
    );
    expect(passwordToggle?.getAttribute("aria-checked")).toBe("false");
    expect(document.body.querySelector('fieldset[aria-label="Link expiry"]')).toBeNull();
    expect(document.body.querySelector("[data-share-confirmation]")).toBeNull();
  });

  // Materialize is CSS-owned (the .brain-menu canon): Radix data-state drives
  // the keyframes and keeps the panel mounted for the 120ms exit retrace in a
  // real browser — e2e/design-audit.spec.ts asserts the live animation. jsdom
  // runs no CSS animations, so here the contract is the material class, the
  // open state, and the synchronous unmount.
  it("is a regular-material popover that materializes on Radix data-state", async () => {
    await renderAndOpen(false);
    const surface = document.body.querySelector("[data-share-surface]") as HTMLElement;
    expect(surface).not.toBeNull();
    expect(surface.className).toContain("brain-share-popover");
    expect(surface.getAttribute("data-state")).toBe("open");
    expect(surface.getAttribute("role")).toBe("dialog");
    // no framer wrapper: the Radix Content is the material itself, and the
    // transform-origin comes from the class (the Radix CSS variable), never
    // an inline style
    expect(surface.style.transformOrigin).toBe("");
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await settle();
    expect(document.body.querySelector("[data-share-surface]")).toBeNull();
  });

  it("reveals and focuses password settings, then clears draft and expiry when off", async () => {
    await renderAndOpen(false);
    const toggle = document.body.querySelector(
      '[role="switch"][aria-label="Password protection"]',
    );
    // the knob is pinned and travels on transform (compositor), never `left`
    const knob = () => toggle?.querySelector("span > span") as HTMLElement;
    // the OFF track must read against paper and the regular glass (WCAG
    // 1.4.11 non-text contrast): ink-3 is 5.06:1 light / 4.92:1 dark; the
    // ON track is the v2 blue (DESIGN.md v2 → Colour: "toggle on")
    const track = () => toggle?.querySelector(":scope > span") as HTMLElement;
    expect(track().className).toContain("bg-ink-3");
    expect(track().className).not.toContain("bg-fill-active");
    expect(knob().className).toContain("left-[3px]");
    expect(knob().className).toContain("translate-x-0");
    expect(knob().className).toContain("transition-transform");
    expect(knob().className).not.toContain("transition-[left]");
    await click(toggle);
    expect(track().className).toContain("bg-blue");
    expect(track().className).not.toContain("bg-ink-3");
    expect(knob().className).toContain("left-[3px]");
    expect(knob().className).toContain("translate-x-4");

    let input = document.body.querySelector(
      'input[aria-label="Share password"]',
    ) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(document.body.querySelector('fieldset[aria-label="Link expiry"]')).not.toBeNull();
    expect(
      (document.body.querySelector('input[type="radio"]:checked') as HTMLInputElement).value,
    ).toBe("never");
    const firstExpiry = document.body.querySelector(
      'input[type="radio"][value="1"]',
    ) as HTMLInputElement;
    expect(firstExpiry.className).toContain("sr-only");
    // the checked segment carries the white-capsule box-shadow (a plain
    // class), so the focus indicator is an outline — a ring would lose
    expect(firstExpiry.closest("label")?.className).toContain(
      "has-[:focus-visible]:outline-2",
    );
    await act(async () => inputValue(input, "plain draft"));
    await click(button("7 days"));
    await click(document.body.querySelector('[aria-label="Show password"]'));
    expect(input.type).toBe("text");

    await click(toggle);
    expect(document.body.querySelector('input[aria-label="Share password"]')).toBeNull();
    expect(document.body.querySelector('fieldset[aria-label="Link expiry"]')).toBeNull();

    await click(toggle);
    input = document.body.querySelector(
      'input[aria-label="Share password"]',
    ) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.type).toBe("password");
    expect(
      (document.body.querySelector('input[type="radio"]:checked') as HTMLInputElement).value,
    ).toBe("never");
  });

  it("enables the disclosed exact scope with the chosen password and expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
    const disclosed = snapshot({ descendantCount: 1 });
    const onEnableShare = vi.fn().mockResolvedValue({
      status: "enabled",
      snapshot: snapshot({
        descendantCount: 1,
        public: true,
        shareLocked: true,
        shareExpiresAt: "2026-08-20T12:00:00.000Z",
      }),
    });
    const onPrepareShare = vi
      .fn()
      .mockResolvedValueOnce(disclosed)
      .mockResolvedValueOnce(
        snapshot({
          descendantCount: 1,
          public: true,
          shareLocked: true,
          shareExpiresAt: "2026-08-20T12:00:00.000Z",
        }),
      );
    await renderAndOpen(false, {
      onPrepareShare,
      onEnableShare,
    });
    await click(
      document.body.querySelector('[role="switch"][aria-label="Password protection"]'),
    );
    const input = document.body.querySelector(
      'input[aria-label="Share password"]',
    ) as HTMLInputElement;
    await act(async () => inputValue(input, "  secret  "));
    await click(button("7 days"));
    await click(shareButton());

    expect(onEnableShare).toHaveBeenCalledWith({
      expectedScopeToken: disclosed.scopeToken,
      password: "secret",
      expiresAt: "2026-08-20T12:00:00.000Z",
    });
    expect(document.body.textContent).toContain("Shared to web");
  });

  it("keeps the updated exact scope in review after a conflict", async () => {
    const initial = snapshot({ descendantCount: 2 });
    const changed = snapshot({ descendantCount: 3, scopeToken: "b".repeat(64) });
    const onEnableShare = vi.fn().mockResolvedValue({
      status: "conflict",
      snapshot: changed,
    });
    await renderAndOpen(false, {
      onPrepareShare: vi.fn().mockResolvedValue(initial),
      onEnableShare,
    });
    await click(shareButton());

    expect(onEnableShare).toHaveBeenCalledWith({
      expectedScopeToken: initial.scopeToken,
      password: null,
      expiresAt: null,
    });
    expect(document.body.querySelector("h2")?.textContent).toBe("Share 4 pages");
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "Review the updated count and confirm again",
    );
  });

  it("blocks a new overlapping nested grant using the authoritative scope read", async () => {
    const onEnableShare = vi.fn();
    const onOpenShareSettings = vi.fn();
    await renderAndOpen(false, {
      onPrepareShare: vi.fn().mockResolvedValue(
        snapshot({
          descendantCount: 2,
          overlappingRoots: [
            {
              rootId: "nested",
              title: "Already shared child",
              relation: "descendant",
              shareExpiresAt: null,
            },
          ],
        }),
      ),
      onEnableShare,
      onOpenShareSettings,
    });

    expect(document.body.textContent).toContain("This scope already overlaps another shared page.");
    expect(document.body.textContent).toContain("Already shared child · shared nested page");
    expect(document.body.textContent).toContain("Resolve the existing grant");
    expect(document.body.querySelector('[aria-label="Password protection"]')).toBeNull();
    expect(shareButton()).toBeUndefined();
    await click(button("Review shared links"));
    expect(onOpenShareSettings).toHaveBeenCalledTimes(1);
    expect(onEnableShare).not.toHaveBeenCalled();
  });

  it("shows a status-first loading state while exact scope is pending", async () => {
    const pending = deferred<ShareScopeSnapshot>();
    await renderAndOpen(false, {
      onPrepareShare: vi.fn().mockReturnValue(pending.promise),
    });
    expect(document.body.textContent).toContain("Checking which pages will be shared…");
    expect(document.body.textContent).not.toContain("Only you can see this page");
    await act(async () => pending.resolve(snapshot()));
    await settle();
    expect(document.body.textContent).toContain("Anyone with the link can read this page.");
  });

  it("renders the active share as a header, the link well, and one controls row", async () => {
    const onCopyLink = vi.fn();
    await renderAndOpen(true, {
      onPrepareShare: vi
        .fn()
        .mockResolvedValue(snapshot({ public: true, descendantCount: 2 })),
      onCopyLink,
    });
    const surface = document.body.querySelector("[data-share-surface]") as HTMLElement;
    const rows = [...surface.querySelectorAll("[data-share-primary-row]")];
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.getAttribute("data-share-primary-row"))).toEqual([
      "status",
      "link",
      "controls",
    ]);
    // the header block says the state once and the exact scope under it
    expect(rows[0].querySelector("h2")?.textContent).toBe("Shared to web");
    expect(rows[0].textContent).toContain("This page + 2 subpages");
    expect(document.body.querySelector(".brain-share-link-field")).toBeNull();
    // the Radix Content IS the material (regular glass r14, materialize on
    // data-state) — no framer wrapper, no inline transform-origin
    expect(surface.className).toContain("brain-share-popover");
    expect(surface.getAttribute("role")).toBe("dialog");
    expect(surface.className).not.toContain("transition-opacity");
    expect(surface.style.transformOrigin).toBe("");
    for (const row of rows) {
      expect(row.className).not.toContain("bg-");
      expect(row.className).not.toContain("border");
    }
    const link = rows[1] as HTMLElement;
    // the URL sits in the quiet field-like well, a fill — never a material
    expect(link.querySelector(".brain-share-url-well")).not.toBeNull();
    const url = link.querySelector("[data-share-url]") as HTMLElement;
    expect(url.title).toContain("/share/page-a");
    expect(document.body.querySelector('[aria-label="Copy link"]')?.getAttribute("title")).toBe(
      "Copy link",
    );
    expect(document.body.querySelector('[aria-label="Open public page"]')?.getAttribute("title")).toBe(
      "Open public page",
    );
    const focusOrder = [...surface.querySelectorAll("button, a")].map(
      (node) => node.getAttribute("aria-label") ?? node.textContent?.trim(),
    );
    expect(focusOrder.slice(0, 4)).toEqual([
      "Copy link",
      "Open public page",
      "Password protection",
      "Stop sharing",
    ]);
    await click(document.body.querySelector('[aria-label="Copy link"]'));
    expect(onCopyLink).toHaveBeenCalledWith("page-a");
  });

  it("uses singular and page-only scope labels for active direct shares", async () => {
    const onPrepareShare = vi
      .fn()
      .mockResolvedValueOnce(snapshot({ public: true, descendantCount: 0 }))
      .mockResolvedValueOnce(snapshot({ public: true, descendantCount: 1 }));
    await renderAndOpen(true, { scopeRevision: "zero", onPrepareShare });
    expect(document.body.textContent).toContain("This page only");
    await act(async () => {
      root.render(popover(true, { scopeRevision: "one", onPrepareShare }));
    });
    await settle();
    expect(document.body.textContent).toContain("This page + 1 subpage");
  });

  it("refreshes the exact active count when the scope revision changes", async () => {
    const first = snapshot({ public: true, descendantCount: 1 });
    const second = snapshot({
      public: true,
      descendantCount: 2,
      scopeToken: "b".repeat(64),
    });
    const onPrepareShare = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    await renderAndOpen(true, { scopeRevision: "tree-1", onPrepareShare });
    expect(document.body.textContent).toContain("This page + 1 subpage");

    await act(async () => {
      root.render(popover(true, { scopeRevision: "tree-2", onPrepareShare }));
    });
    await settle();
    expect(document.body.textContent).toContain("This page + 2 subpages");
    expect(onPrepareShare).toHaveBeenCalledTimes(2);
    expect(document.body.querySelector("[data-share-surface]")).not.toBeNull();
  });

  it("saves active password settings and turning them off clears password and expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T12:00:00.000Z"));
    const onSetProtection = vi.fn();
    await renderAndOpen(true, { onSetProtection });
    const toggle = document.body.querySelector(
      '[role="switch"][aria-label="Password protection"]',
    );
    await click(toggle);
    const input = document.body.querySelector(
      'input[aria-label="Share password"]',
    ) as HTMLInputElement;
    await act(async () => inputValue(input, "active secret"));
    await click(button("1 day"));
    await click(button("Save protection"));
    expect(onSetProtection).toHaveBeenCalledWith({
      password: "active secret",
      expiresAt: "2026-08-14T12:00:00.000Z",
    });

    await click(toggle);
    expect(onSetProtection).toHaveBeenLastCalledWith({
      password: null,
      expiresAt: null,
    });
    expect(document.body.querySelector('input[aria-label="Share password"]')).toBeNull();
    // compact switch: 3px pin, 16px travel (19 − 3), transform-driven
    const knob = toggle?.querySelector("span > span") as HTMLElement;
    expect(knob.className).toContain("left-[3px]");
    expect(knob.className).toContain("translate-x-0");
    expect(knob.className).toContain("transition-transform");
  });

  it("preserves configured password and exact expiry unless the owner replaces them", async () => {
    const onSetProtection = vi.fn();
    await renderAndOpen(true, {
      hasPassword: true,
      expiresAt: "2026-09-01T15:30:00.000Z",
      onPrepareShare: vi.fn().mockResolvedValue(
        snapshot({
          public: true,
          shareLocked: true,
          shareExpiresAt: "2026-09-01T15:30:00.000Z",
        }),
      ),
      onSetProtection,
    });
    expect(document.body.textContent).toContain("Leave blank to keep the current password.");
    await click(button("Save protection"));
    expect(onSetProtection).toHaveBeenCalledWith({
      password: undefined,
      expiresAt: undefined,
    });
  });

  it("keeps a legacy expiry visible when no password exists", async () => {
    const onSetProtection = vi.fn();
    await renderAndOpen(true, {
      expiresAt: "2026-09-01T00:00:00.000Z",
      onPrepareShare: vi.fn().mockResolvedValue(
        snapshot({
          public: true,
          shareLocked: false,
          shareExpiresAt: "2026-09-01T00:00:00.000Z",
        }),
      ),
      onSetProtection,
    });
    expect(document.body.textContent).toContain("Legacy link expiry: 2026-09-01");
    expect(document.body.textContent).toContain("It still applies without a password.");
    await click(button("Remove expiry"));
    expect(onSetProtection).toHaveBeenCalledWith({
      password: null,
      expiresAt: null,
    });
  });

  it("shows inherited access status-first without a disabled sharing switch", async () => {
    const onCopyLink = vi.fn();
    const onOpenShareSettings = vi.fn();
    await renderAndOpen(false, {
      inheritedFrom: { id: "root", title: "Shared root" },
      onPrepareShare: vi
        .fn()
        .mockResolvedValue(snapshot({ rootId: "root", public: true, descendantCount: 4 })),
      onCopyLink,
      onOpenShareSettings,
    });
    expect(document.body.textContent).toContain("Shared through Shared root");
    expect(document.body.textContent).toContain("Parent share: 4 descendants");
    expect(document.body.querySelector('[role="switch"]')).toBeNull();
    await click(document.body.querySelector('[aria-label="Copy link"]'));
    expect(onCopyLink).toHaveBeenCalledWith("root");
    await click(button("Go to shared parent"));
    expect(onOpenShareSettings).toHaveBeenCalledTimes(1);
  });

  it("keeps direct and inherited grants visible through replace-state stop confirmation", async () => {
    const onDisableShare = vi.fn().mockResolvedValue(snapshot({ public: false }));
    await renderAndOpen(true, {
      inheritedFrom: { id: "root", title: "Parent root" },
      onPrepareShare: vi
        .fn()
        .mockImplementation((rootId: string) =>
          Promise.resolve(
            snapshot({ rootId, public: true, descendantCount: rootId === "root" ? 5 : 1 }),
          ),
        ),
      onDisableShare,
    });
    expect(document.body.textContent).toContain("Also shared through Parent root");
    await click(button("Stop sharing"));
    expect(document.body.querySelector('[data-share-state="manage"]')).toBeNull();
    expect(document.body.querySelector('[data-share-state="revoke"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Access through Parent root will remain.");
    await click(button("Stop sharing"));
    expect(onDisableShare).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("Shared through Parent root");
    expect(document.body.textContent).toContain("Parent share: 5 descendants");
  });

  it("lists every legacy parent and child overlap and names the active residual links", async () => {
    const overlaps: ShareScopeSnapshot["overlappingRoots"] = [
      {
        rootId: "parent",
        title: "Public parent",
        relation: "ancestor",
        shareExpiresAt: null,
      },
      {
        rootId: "child",
        title: "Public child",
        relation: "descendant",
        shareExpiresAt: null,
      },
    ];
    await renderAndOpen(true, {
      onPrepareShare: vi.fn().mockResolvedValue(
        snapshot({ public: true, overlappingRoots: overlaps }),
      ),
    });

    expect(document.body.textContent).toContain("Public parent · shared parent · active");
    expect(document.body.textContent).toContain("Public child · shared nested page · active");
    await click(button("Stop sharing"));
    expect(document.body.textContent).toContain(
      "Stopping this root link will leave 1 parent public link active.",
    );
    expect(document.body.textContent).toContain(
      "Stopping this root link will leave 1 nested public link active.",
    );
  });

  it("keeps expired legacy overlaps visible without counting them as residual access", async () => {
    await renderAndOpen(true, {
      onPrepareShare: vi.fn().mockResolvedValue(
        snapshot({
          public: true,
          overlappingRoots: [
            {
              rootId: "expired-child",
              title: "Expired child",
              relation: "descendant",
              shareExpiresAt: "2000-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
    });

    expect(document.body.textContent).toContain(
      "Expired child · shared nested page · expired",
    );
    await click(button("Stop sharing"));
    expect(document.body.textContent).toContain(
      "The expired nested link remains recorded but does not provide access.",
    );
    expect(document.body.textContent).not.toContain("nested public link active");
  });

  it("keeps an active link visible when revocation fails", async () => {
    const pending = deferred<ShareScopeSnapshot>();
    await renderAndOpen(true, {
      onDisableShare: vi.fn().mockReturnValue(pending.promise),
    });
    await click(button("Stop sharing"));
    await click(button("Stop sharing"));
    expect(document.body.textContent).toContain("Stopping sharing…");
    expect(document.body.textContent).toContain("Waiting for durable confirmation…");
    await act(async () => pending.reject(new Error("offline")));
    await settle();
    expect(document.body.textContent).toContain("localhost:3000/share/page-a");
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "still shown as active",
    );
  });

  it("shows an expired inherited grant and never exposes it as an active link", async () => {
    const onCopyLink = vi.fn();
    await renderAndOpen(false, {
      expiredInheritedFrom: {
        id: "parent",
        title: "Expired parent",
        expiresAt: "2000-01-01T00:00:00.000Z",
      },
      onPrepareShare: vi.fn().mockResolvedValue(
        snapshot({
          rootId: "parent",
          public: true,
          shareExpiresAt: "2000-01-01T00:00:00.000Z",
        }),
      ),
      onCopyLink,
    });
    expect(document.body.textContent).toContain("Link expired");
    expect(document.body.textContent).toContain("No active public link");
    const copy = document.body.querySelector('[aria-label="Copy link"]') as HTMLButtonElement;
    expect(copy.disabled).toBe(true);
    expect(document.body.querySelector('[aria-label="Open public page"]')).toBeNull();
    copy.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(onCopyLink).not.toHaveBeenCalled();
  });

  it("uses a real mobile dialog sheet with safe-area and reduced-motion classes", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      media: "(max-width: 639px)",
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }));
    await renderAndOpen(false);
    const surface = document.body.querySelector("[data-share-mobile-surface]") as HTMLElement;
    expect(surface.className).toContain("brain-sheet");
    expect(surface.className).not.toContain("transition-opacity");
    const backdrop = document.body.querySelector("[data-share-mobile-backdrop]") as HTMLElement;
    expect(backdrop.className).toContain("brain-dialog-overlay");
    expect(backdrop.className).not.toContain("bg-black");
    expect(surface.className).toContain("fixed");
    expect(surface.className).toContain("inset-x-0");
    expect(surface.className).toContain("bottom-0");
    expect(surface.className).toContain("w-screen");
    expect(surface.className).toContain("env(safe-area-inset-bottom)");
    // sheet motion is the shared .brain-sheet keyframes (globals.css), which
    // the global prefers-reduced-motion block zeroes — no per-surface transition
    expect(surface.className).not.toContain("transition-");
    expect(surface.className).not.toContain("height");
    expect(surface.querySelectorAll(".border")).toHaveLength(0);
    // thick-material sheet: .brain-dialog carries the material, .brain-sheet
    // the slide keyframes (zeroed by the global reduced-motion block)
    expect(surface.className).toContain("brain-dialog");
    const toggle = document.body.querySelector(
      '[aria-label="Password protection"]',
    ) as HTMLElement;
    expect(toggle.className).toContain("max-sm:h-11");
    expect(toggle.querySelector(":scope > span")?.className).toContain(
      "motion-reduce:transition-none",
    );
    expect(shareButton()?.className).toContain("max-sm:min-h-11");
  });

  it("hydrates deterministically before switching to the mobile trigger", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      media: "(max-width: 639px)",
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => true,
    }));
    const hydrationHost = document.createElement("div");
    const element = popover(false);
    hydrationHost.innerHTML = renderToString(element);
    document.body.appendChild(hydrationHost);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let hydratedRoot: ReturnType<typeof hydrateRoot> | undefined;

    await act(async () => {
      hydratedRoot = hydrateRoot(hydrationHost, element);
      await Promise.resolve();
    });

    expect(
      consoleError.mock.calls.some((call) =>
        call.some((value) => String(value).toLowerCase().includes("hydration")),
      ),
    ).toBe(false);
    expect(hydrationHost.querySelector('[aria-label="Share trigger"]')).not.toBeNull();

    await act(async () => hydratedRoot?.unmount());
    consoleError.mockRestore();
    hydrationHost.remove();
  });
});
