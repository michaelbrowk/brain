// @vitest-environment jsdom
//
// The first screen a new installation shows, and the one the release e2e's
// `login` helper drives. What is pinned here is what a person reads and what
// their hands find: the product's own sentence rather than a slogan, the four
// error sentences by the status that causes each one, the caret back in the
// field after a wrong try, a pending button that says so, and an entrance that
// drops its 8px rise when the reader has asked for less motion.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MotionRender } from "@/test/framer-motion-mock";

const harness = vi.hoisted(() => ({
  reduce: false,
  renders: [] as MotionRender[],
}));

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({
    reducedMotion: () => harness.reduce,
    onRender: (render) => {
      harness.renders.push(render);
    },
  });
});

vi.mock("next/navigation", () => ({ useRouter: () => navigation }));

import { LoginForm } from "./login-form";

function response(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("the sign-in screen", () => {
  let container: HTMLDivElement;
  let root: Root;

  const field = () => container.querySelector("input") as HTMLInputElement;
  const form = () => container.querySelector("form") as HTMLFormElement;
  const submit = () =>
    container.querySelector('button[type="submit"]') as HTMLButtonElement;
  const eye = () =>
    container.querySelector(
      'button[aria-label="Show password"], button[aria-label="Hide password"]',
    ) as HTMLButtonElement;

  const send = async () => {
    await act(async () => {
      form().dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
  };

  const attempt = async (password: string) => {
    await act(async () => typeInto(field(), password));
    await send();
  };

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    harness.reduce = false;
    harness.renders.length = 0;
    navigation.replace.mockReset();
    navigation.refresh.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    // the component reads the caret back on the next frame
    vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
      run(0);
      return 1;
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    window.history.replaceState({}, "", "/");
  });

  it("says what Brain is in the product's own words, and its version at the foot", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await act(async () => root.render(<LoginForm version="0.14.0" />));

    expect(container.textContent).toContain("Brain");
    // README.md's first line, not a slogan written for this screen
    expect(container.textContent).toContain(
      "A notes app you keep on your own server",
    );
    expect(container.textContent).toContain("Brain 0.14.0");
    // the placeholder the release e2e's login helper reaches the field by
    expect(field().placeholder).toBe("Password");
    expect(submit().textContent).toContain("Sign in");
    // and the attribute every password manager fills through. Nothing else
    // on this screen notices if it goes, so it is pinned where it is read.
    expect(field().getAttribute("autocomplete")).toBe("current-password");
  });

  it("asks the server the one question it answers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(401));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<LoginForm version={null} />));
    await attempt("a-password");

    // The release e2e is the only other guard on this call, and this is the
    // one screen a wrong body cannot be hot-fixed from inside the app.
    expect(fetchMock).toHaveBeenCalledWith("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "a-password" }),
    });
  });

  it("says nothing at the foot when the running release is unknown", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await act(async () => root.render(<LoginForm version={null} />));

    expect(container.textContent).not.toContain("unknown");
    expect(container.textContent).not.toMatch(/Brain \d/);
  });

  it("puts the caret in the field on arrival", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await act(async () => root.render(<LoginForm version={null} />));

    expect(document.activeElement).toBe(field());
  });

  it.each([
    [401, "That password did not match."],
    [429, "Too many tries. Wait a minute."],
    [500, "The server did not answer. Try again."],
  ])("answers %i with a sentence a person reads", async (status, sentence) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status)));
    await act(async () => root.render(<LoginForm version={null} />));
    await attempt("wrong-password");

    const message = container.querySelector("#login-error") as HTMLElement;
    expect(message.textContent).toBe(sentence);
    expect(message.getAttribute("role")).toBe("alert");
    expect(field().getAttribute("aria-invalid")).toBe("true");
    expect(field().getAttribute("aria-describedby")).toBe("login-error");
  });

  it("says the connection failed when the request never left", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await act(async () => root.render(<LoginForm version={null} />));
    await attempt("keep-this-password");

    expect(container.textContent).toContain(
      "No connection to the server. Try again.",
    );
    // the value stays and the form is usable again: a failed attempt is not a
    // reason to make somebody type a password they already typed
    expect(field().value).toBe("keep-this-password");
    expect(submit().disabled).toBe(false);
  });

  it("takes the caret back and selects what was typed after a refusal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401)));
    await act(async () => root.render(<LoginForm version={null} />));
    await attempt("nearly-right");
    // the press moved focus to the button, the way a real click does
    await act(async () => submit().focus());
    await attempt("nearly-right");

    expect(document.activeElement).toBe(field());
    expect(field().selectionStart).toBe(0);
    expect(field().selectionEnd).toBe("nearly-right".length);
  });

  it("shows the button working, and does not send twice", async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValue(pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<LoginForm version={null} />));
    await act(async () => typeInto(field(), "right-password"));
    await act(async () => {
      form().dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect(submit().textContent).toContain("Signing in");
    expect(submit().getAttribute("aria-busy")).toBe("true");

    await send();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(response(200));
      await pending.promise;
    });
  });

  it("shows and hides the password behind one glyph", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await act(async () => root.render(<LoginForm version={null} />));

    // Inside a form a button with no type submits it, so "let me check what
    // I typed" would spend one of the five tries a minute the rate limiter
    // allows, and on a share it would lock the page for everyone.
    expect(eye().type).toBe("button");
    expect(field().type).toBe("password");
    expect(eye().getAttribute("aria-pressed")).toBe("false");
    await act(async () => eye().click());
    expect(field().type).toBe("text");
    expect(eye().getAttribute("aria-label")).toBe("Hide password");
    expect(eye().getAttribute("aria-pressed")).toBe("true");
  });

  it("rises 8px into place, and only crossfades under reduced motion", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await act(async () => root.render(<LoginForm version={null} />));
    const moving = harness.renders.filter(
      (render) =>
        typeof render.motion.initial === "object" &&
        render.motion.initial !== null &&
        "y" in (render.motion.initial as Record<string, unknown>),
    );
    expect(moving.length).toBe(1);
    expect(moving[0].motion.initial).toEqual({ opacity: 0, y: 8 });

    harness.reduce = true;
    harness.renders.length = 0;
    await act(async () => root.render(<LoginForm version={null} />));
    for (const render of harness.renders) {
      expect(render.motion.initial ?? {}).not.toHaveProperty("y");
      expect(render.motion.animate ?? {}).not.toHaveProperty("height");
    }
  });

  it("opens the error slot by its height, and by opacity alone under reduced motion", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401)));
    await act(async () => root.render(<LoginForm version={null} />));
    await attempt("wrong-password");
    const slot = harness.renders.find(
      (render) =>
        typeof render.motion.animate === "object" &&
        render.motion.animate !== null &&
        "height" in (render.motion.animate as Record<string, unknown>),
    );
    expect(slot?.motion.animate).toEqual({ opacity: 1, height: "auto" });
  });
});
