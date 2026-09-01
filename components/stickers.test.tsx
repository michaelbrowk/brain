// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sticker } from "@/lib/store/types";
import { StickersLayer } from "./stickers";

function pointer(type: string, x: number, y: number) {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
}

async function frames(count: number) {
  for (let i = 0; i < count; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe("StickersLayer", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("PointerEvent", MouseEvent);
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  async function render(stickers: Sticker[], onChange = vi.fn()) {
    await act(async () => root.render(<StickersLayer stickers={stickers} onChange={onChange} />));
    return onChange;
  }

  const card = () => host.querySelector<HTMLElement>(".brain-sticker")!;
  const strip = () => host.querySelector<HTMLElement>(".brain-sticker-chrome")!;

  it("rests flat on its committed position and keeps the print mirror's variables", async () => {
    await render([{ id: "a", x: 40, y: 60, text: "" }]);
    const el = card();
    expect(el.style.left).toBe("40px");
    expect(el.style.top).toBe("60px");
    expect(el.style.getPropertyValue("--brain-sticker-x")).toBe("40px");
    expect(el.style.getPropertyValue("--brain-sticker-y")).toBe("60px");
    // DESIGN.md v2: the sticker rests on its own warm shadow (the .brain-sticker
    // class, an object on the desk); the LIFT belongs to the active drag only
    // and rides a separate layer that stays transparent at rest
    expect(el.classList.contains("brain-sticker")).toBe(true);
    expect(el.className).not.toContain("shadow-[var(--lift)]");
    const lift = el.querySelector<HTMLElement>("span.shadow-\\[var\\(--lift\\)\\]")!;
    expect(lift).not.toBeNull();
    expect(lift.style.opacity).toBe("0");
  });

  it("commits the frontmatter position once, on drag end, from the motion values", async () => {
    const onChange = await render([{ id: "a", x: 40, y: 60, text: "hi" }]);
    await act(async () => {
      strip().dispatchEvent(pointer("pointerdown", 100, 100));
    });
    await act(async () => {
      window.dispatchEvent(pointer("pointermove", 110, 104));
      window.dispatchEvent(pointer("pointermove", 130, 117));
    });
    await frames(2);
    // the drag itself never re-renders the layer — no commit per pointer move
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(pointer("pointerup", 130, 117));
    });
    await frames(3);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith([{ id: "a", x: 70, y: 77, text: "hi" }]);
    // left/top absorbed the travel, the transform offset went back to zero
    const el = card();
    expect(el.style.left).toBe("70px");
    expect(el.style.top).toBe("77px");
    expect(el.style.transform).not.toMatch(/translate[XY]?\((?!0px)/);
  });

  it("does not write when the pointer comes back to where it started", async () => {
    const onChange = await render([{ id: "a", x: 40, y: 60, text: "" }]);
    await act(async () => {
      strip().dispatchEvent(pointer("pointerdown", 100, 100));
    });
    await act(async () => {
      window.dispatchEvent(pointer("pointermove", 120, 120));
      window.dispatchEvent(pointer("pointermove", 100, 100));
    });
    await frames(2);
    await act(async () => {
      window.dispatchEvent(pointer("pointerup", 100, 100));
    });
    await frames(3);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps text edits and deletes on the plain change path", async () => {
    const onChange = await render([{ id: "a", x: 40, y: 60, text: "" }]);
    const textarea = host.querySelector<HTMLTextAreaElement>("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(textarea, "note");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith([{ id: "a", x: 40, y: 60, text: "note" }]);
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('[aria-label="Delete sticker"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onChange).toHaveBeenLastCalledWith([]);
  });
});
