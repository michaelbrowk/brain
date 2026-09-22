// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_KIT_CSS, APP_KIT_JS, injectAppKit } from "./kit";
import { BRIDGE_VERSION } from "./bridge";
import { APP_TOKEN_NAMES } from "./tokens";
import { lintAppEntry } from "./lint";

describe("the Brain app kit", () => {
  it("defines the register classes with the same names Brain uses", () => {
    for (const name of [".text-title", ".text-body", ".text-caption", ".text-label"]) {
      expect(APP_KIT_CSS).toContain(name);
    }
  });

  it("defines the five controls the spec named", () => {
    for (const name of [".btn", ".field", ".chip", ".card", ".row"]) {
      expect(APP_KIT_CSS).toContain(name);
    }
  });

  it("declares the colour scheme so the frame follows the theme", () => {
    expect(APP_KIT_CSS).toContain("color-scheme: light dark");
  });

  it("writes no colour of its own, only tokens", () => {
    expect(APP_KIT_CSS.replace(/var\(\s*--[^)]*\)/g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(APP_KIT_CSS.replace(/var\(\s*--[^)]*\)/g, "")).not.toMatch(/\b(rgba?|hsla?|oklch)\(/);
  });

  it("gives every control a 44px touch target", () => {
    expect(APP_KIT_CSS).toContain("min-height: 44px");
  });

  it("names every token it reads", () => {
    for (const token of ["--paper", "--ink", "--ink-3", "--r-md", "--font-sf"]) {
      expect(APP_TOKEN_NAMES).toContain(token);
      expect(APP_KIT_CSS).toContain(`var(${token}`);
    }
  });

  it("gives the app one method per bridge request", () => {
    for (const method of [
      "readTree",
      "readPage",
      "readPages",
      "writePage",
      "createPage",
      "getState",
      "setState",
      "open",
      "toast",
      // `docs/apps.md` promises this one, and a mutation that removed it
      // survived the first version of this list.
      "on",
    ]) {
      expect(APP_KIT_JS).toContain(method);
    }
  });

  it("reads no token the host does not hand over", () => {
    // A `var(--muted-ink)` in the kit is a property nobody sets, so the
    // declaration falls back to nothing and the rule paints the initial
    // value. Checking five names by hand let that through.
    const used = new Set(
      Array.from(APP_KIT_CSS.matchAll(/var\(\s*(--[A-Za-z0-9-]+)/g), (match) => match[1]),
    );
    expect(used.size).toBeGreaterThan(10);
    for (const token of used) expect(APP_TOKEN_NAMES).toContain(token);
  });

  it("gives the touch target to every control that takes a press", () => {
    // Three declarations, not one string anywhere: `.btn`, `.field` and
    // `.row` each carry it, and a mutation that shrank one of them survived
    // an assertion that only asked whether the text appeared.
    expect(APP_KIT_CSS.match(/min-height: 44px/g)).toHaveLength(3);
  });

  it("applies the tokens it is given and repaints on a theme event", () => {
    expect(APP_KIT_JS).toContain("setProperty");
    expect(APP_KIT_JS).toContain('"theme"');
    expect(APP_KIT_JS).toContain('"visibility"');
  });

  it("speaks the protocol's own version rather than a copy of the number", () => {
    // The kit is a string, so a literal 1 in it is a second place the version
    // lives and the two can part company at the next bump with nothing red.
    expect(APP_KIT_JS).toContain(`v: ${BRIDGE_VERSION}`);
    expect(APP_KIT_JS).toContain(`!== ${BRIDGE_VERSION}`);
  });

  it("keeps asking for hello until the host answers", () => {
    // The frame's script runs before the host's message listener is
    // guaranteed to be attached: React mounts the iframe and the effect that
    // installs the listener runs after the load. One unanswered hello would
    // leave an app with no tokens and no theme, painted in the browser's
    // defaults, forever.
    expect(APP_KIT_JS).toContain("setTimeout");
    expect(APP_KIT_JS).toContain("HELLO_RETRY_MS");
  });

  it("replaces the kit link with the kit itself and leaves anything else alone", () => {
    const html =
      '<!doctype html><meta name="color-scheme" content="light dark"><link rel="brain-kit"><p>x</p>';
    const injected = injectAppKit(html);
    expect(injected).not.toContain("brain-kit");
    expect(injected).toContain("<style>");
    expect(injected).toContain("<script>");
    expect(injected).toContain("<p>x</p>");

    const bare = "<!doctype html><p>x</p>";
    expect(injectAppKit(bare)).toBe(bare);
  });

  it("passes its own lint, so the example cannot be refused by the kit it uses", () => {
    expect(
      lintAppEntry(
        `<!doctype html><meta name="color-scheme" content="light dark"><style>${APP_KIT_CSS}</style>`,
      ),
    ).toBeNull();
  });

  it("carries no em-dash in a string an app's user could see", () => {
    expect(APP_KIT_JS).not.toContain("—");
  });
});

/** THE KIT, RUN.
 *
 *  Everything above asks what the string contains, which is a test a mutation
 *  walks past: a kit that answers a message from any window, or stops
 *  applying its tokens, or reuses one request id, still contains every word.
 *  So the string is evaluated here exactly as a frame evaluates it — one
 *  classic script in the page's own global scope, with `parent` replaced by a
 *  stub that records what it is posted.
 *
 *  `window.parent` is the window itself in jsdom, so the stub is defined over
 *  it. That is also what makes the source check testable: a message whose
 *  `source` is anything else is a message from a window the kit did not send
 *  to, and it must be ignored. */
interface MountedKit {
  readonly posted: Record<string, unknown>[];
  readonly parent: object;
  readonly brain: Record<string, (...args: never[]) => Promise<unknown>> & {
    ready: Promise<unknown>;
    on: (name: string, handler: (detail: unknown) => void) => void;
  };
  readonly send: (data: unknown, source?: unknown) => void;
  readonly lastRid: () => string;
}

const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});

function mountKit(): MountedKit {
  const posted: Record<string, unknown>[] = [];
  const parent = {
    postMessage: (message: Record<string, unknown>) => {
      posted.push(message);
    },
  };
  Object.defineProperty(window, "parent", {
    value: parent,
    configurable: true,
    writable: true,
  });

  // The kit's own `message` listener, captured so the next test starts with
  // a window this one left nothing on.
  const captured: Array<[string, EventListenerOrEventListenerObject]> = [];
  const add = window.addEventListener.bind(window);
  window.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    captured.push([type, listener]);
    add(type, listener, options);
  }) as typeof window.addEventListener;
  new Function(APP_KIT_JS)();
  window.addEventListener = add;
  disposers.push(() => {
    for (const [type, listener] of captured) window.removeEventListener(type, listener);
    delete (window as unknown as Record<string, unknown>).brain;
  });

  const send = (data: unknown, source: unknown = parent): void => {
    const event = new MessageEvent("message", { data });
    Object.defineProperty(event, "source", { value: source, configurable: true });
    window.dispatchEvent(event);
  };
  return {
    posted,
    parent,
    brain: (window as unknown as { brain: MountedKit["brain"] }).brain,
    send,
    lastRid: () => String(posted[posted.length - 1].rid),
  };
}

const answer = (kit: MountedKit, rid: string, data: unknown): void =>
  kit.send({ v: 1, rid, ok: true, data });

describe("the kit, evaluated the way a frame evaluates it", () => {
  it("posts hello the moment it loads, and keeps asking until it is answered", () => {
    vi.useFakeTimers();
    const kit = mountKit();
    expect(kit.posted).toHaveLength(1);
    expect(kit.posted[0]).toMatchObject({ v: 1, type: "hello" });

    vi.advanceTimersByTime(50);
    expect(kit.posted).toHaveLength(2);
    vi.advanceTimersByTime(100);
    expect(kit.posted).toHaveLength(4);
  });

  it("stops the moment the host answers, and schedules nothing after", async () => {
    vi.useFakeTimers();
    const kit = mountKit();
    answer(kit, kit.lastRid(), { theme: "dark", kit: { tokens: {} } });
    await kit.brain.ready;
    const settled = kit.posted.length;
    vi.advanceTimersByTime(1000);
    expect(kit.posted).toHaveLength(settled);
  });

  it("gives up after five seconds rather than retrying for the life of the page", async () => {
    vi.useFakeTimers();
    const kit = mountKit();
    const failure = expect(kit.brain.ready).rejects.toThrow("Brain did not answer");
    await vi.advanceTimersByTimeAsync(6000);
    await failure;
    const given = kit.posted.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(kit.posted).toHaveLength(given);
  });

  it("ignores a message from a window that is not its parent", async () => {
    // The host does the same in reverse and says why: an opaque origin makes
    // `event.origin` the string "null", so the window reference is the only
    // fact either side can check. Without this, a nested frame or anything
    // else with a handle on this window answers the app's reads.
    const kit = mountKit();
    const spoof = kit.brain.readPage("words1" as never);
    const rid = kit.lastRid();
    kit.send({ v: 1, rid, ok: true, data: { markdown: "spoofed" } }, { notTheParent: true });

    let settled = false;
    void spoof.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    answer(kit, rid, { markdown: "real" });
    await expect(spoof).resolves.toEqual({ markdown: "real" });
  });

  it("ignores a message that speaks another version of the protocol", async () => {
    const kit = mountKit();
    const pending = kit.brain.readTree();
    const rid = kit.lastRid();
    kit.send({ v: 2, rid, ok: true, data: { tree: [] } });

    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it("gives every request its own id, and forgets one once it is answered", async () => {
    const kit = mountKit();
    const first = kit.brain.readTree();
    const one = kit.lastRid();
    const second = kit.brain.readTree();
    const two = kit.lastRid();
    expect(one).not.toBe(two);

    answer(kit, one, { tree: ["a"] });
    answer(kit, two, { tree: ["b"] });
    await expect(first).resolves.toEqual({ tree: ["a"] });
    await expect(second).resolves.toEqual({ tree: ["b"] });

    // A second reply on a spent id reaches nothing and throws nothing.
    expect(() => answer(kit, one, { tree: ["again"] })).not.toThrow();
  });

  it("rejects a refusal with the reason the host named", async () => {
    const kit = mountKit();
    const write = kit.brain.writePage("p1" as never, "x" as never, "r1" as never);
    kit.send({
      v: 1,
      rid: kit.lastRid(),
      ok: false,
      error: "that app does not own that page",
      reason: "not_owned",
    });
    await expect(write).rejects.toMatchObject({
      message: "that app does not own that page",
      reason: "not_owned",
    });
  });

  it("resolves a state.get that answered null as null, not as a misunderstanding", async () => {
    const kit = mountKit();
    const state = kit.brain.getState();
    answer(kit, kit.lastRid(), null);
    await expect(state).resolves.toBeNull();
  });

  it("writes the tokens it is handed onto the document at hello", async () => {
    vi.useFakeTimers();
    const kit = mountKit();
    answer(kit, kit.lastRid(), {
      theme: "dark",
      kit: { tokens: { "--paper": "#101010", "--ink": "#f0f0f0" } },
    });
    await kit.brain.ready;
    expect(document.documentElement.style.getPropertyValue("--paper")).toBe("#101010");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("repaints from a theme event that carries the tokens, with no round trip", async () => {
    vi.useFakeTimers();
    const kit = mountKit();
    answer(kit, kit.lastRid(), { theme: "light", kit: { tokens: { "--paper": "#ffffff" } } });
    await kit.brain.ready;
    const before = kit.posted.length;

    kit.send({ v: 1, event: "theme", theme: "dark", tokens: { "--paper": "#101010" } });
    expect(document.documentElement.style.getPropertyValue("--paper")).toBe("#101010");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(kit.posted).toHaveLength(before);
  });

  it("asks again when a theme event carries no tokens, because the values are what changed", async () => {
    vi.useFakeTimers();
    const kit = mountKit();
    answer(kit, kit.lastRid(), { theme: "light", kit: { tokens: { "--paper": "#ffffff" } } });
    await kit.brain.ready;
    const before = kit.posted.length;

    kit.send({ v: 1, event: "theme", theme: "dark" });
    expect(kit.posted).toHaveLength(before + 1);
    expect(kit.posted[before]).toMatchObject({ type: "hello" });

    answer(kit, kit.lastRid(), { theme: "dark", kit: { tokens: { "--paper": "#101010" } } });
    await Promise.resolve();
    await Promise.resolve();
    expect(document.documentElement.style.getPropertyValue("--paper")).toBe("#101010");
  });

  it("hands both events to brain.on", () => {
    const kit = mountKit();
    const themes: unknown[] = [];
    const visibility: unknown[] = [];
    kit.brain.on("theme", (detail) => themes.push(detail));
    kit.brain.on("visibility", (detail) => visibility.push(detail));

    kit.send({ v: 1, event: "theme", theme: "dark", tokens: {} });
    kit.send({ v: 1, event: "visibility", visible: false });
    expect(themes).toEqual(["dark"]);
    expect(visibility).toEqual([false]);
  });
});
