// @vitest-environment jsdom
//
// The visitor's side of the same door. It reads in the sign-in screen's idiom
// and says the same four sentences, and it says nothing about the page behind
// it: `app/share/[id]/page.tsx` withholds the title from `generateMetadata`
// until the password has been proven, and a gate that printed the title would
// hand back what that decision holds.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ reduce: false }));

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({ reducedMotion: () => harness.reduce });
});

import { ShareGate } from "./share-gate";

function response(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({}),
  } as Response;
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

describe("the share gate", () => {
  let container: HTMLDivElement;
  let root: Root;

  const field = () => container.querySelector("input") as HTMLInputElement;
  const form = () => container.querySelector("form") as HTMLFormElement;
  const submit = () =>
    container.querySelector('button[type="submit"]') as HTMLButtonElement;

  const attempt = async (password: string) => {
    await act(async () => typeInto(field(), password));
    await act(async () => {
      form().dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();
  };

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    harness.reduce = false;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
      run(0);
      return 1;
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("names the lock and nothing about the page behind it", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await act(async () => root.render(<ShareGate id="shared-page" />));

    expect(container.textContent).toContain(
      "This page is shared with a password",
    );
    expect(container.textContent).toContain("Brain");
    expect(container.textContent).not.toContain("shared-page");
    expect(field().placeholder).toBe("Password");
    expect(submit().textContent).toContain("Open");
  });

  it.each([
    [401, "That password did not match."],
    [429, "Too many tries. Wait a minute."],
    [503, "The server did not answer. Try again."],
  ])(
    "answers %i in the same words the sign-in screen uses",
    async (status, sentence) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(status)));
      await act(async () => root.render(<ShareGate id="shared-page" />));
      await attempt("wrong-password");

      const message = document.getElementById(
        "share-error-shared-page",
      ) as HTMLElement;
      expect(message.textContent).toBe(sentence);
      expect(message.getAttribute("role")).toBe("alert");
      expect(field().getAttribute("aria-invalid")).toBe("true");
    },
  );

  it("keeps the field, its value and the caret after a wrong try", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(401)));
    await act(async () => root.render(<ShareGate id="shared-page" />));
    await attempt("nearly-right");
    await act(async () => submit().focus());
    await attempt("nearly-right");

    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("nearly-right");
    expect(field().selectionEnd).toBe("nearly-right".length);
    expect(submit().disabled).toBe(false);
  });

  it("re-opens the form after the connection failed", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await act(async () => root.render(<ShareGate id="shared-page" />));
    await attempt("keep-this-password");

    expect(container.textContent).toContain(
      "No connection to the server. Try again.",
    );
    expect(field().value).toBe("keep-this-password");
    expect(submit().disabled).toBe(false);
  });

  it("asks for the password it was given, for the page it stands on", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(401));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => root.render(<ShareGate id="shared-page" />));
    await attempt("a-password");

    expect(fetchMock).toHaveBeenCalledWith("/api/share-auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "shared-page", password: "a-password" }),
    });
  });
});
