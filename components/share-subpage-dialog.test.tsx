// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ShareSubpageDialog,
  SHARE_SUBPAGE_NOTE,
  type ShareSubpageOutcome,
} from "./share-subpage-dialog";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function open(
  onCreate: (title: string) => Promise<ShareSubpageOutcome>,
  onClose = () => {},
) {
  await act(async () => {
    root.render(<ShareSubpageDialog onCreate={onCreate} onClose={onClose} />);
  });
}

const dialog = () =>
  document.body.querySelector<HTMLElement>("[data-share-subpage-dialog]");
const field = () => dialog()!.querySelector<HTMLInputElement>("input")!;
const button = (name: string) =>
  [...dialog()!.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );

function typeTitle(value: string) {
  const input = field();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function press(name: string) {
  await act(async () => {
    button(name)!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
  });
  await settle();
}

const created = async (): Promise<ShareSubpageOutcome> => ({ ok: true });

describe("the visitor's naming step", () => {
  it("takes a title, cleans it by the route's own rule and closes on the answer", async () => {
    const onCreate = vi.fn(created);
    const onClose = vi.fn();
    await open(onCreate, onClose);
    await act(async () => typeTitle("  Meeting notes   "));
    await press("Create page");

    expect(onCreate).toHaveBeenCalledWith("Meeting notes");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("names a page it is creating and can address no other: the title is all it hands over", async () => {
    // The dialog takes no page id and never learns one. There is nothing here
    // to point at an existing page, which is what keeps naming at creation
    // from becoming a rename. The route the answer travels to has no PATCH
    // (app/api/share-edit/page/route.test.ts), and /api/page/* stays
    // session-only at every verb (middleware.test.ts).
    const onCreate = vi.fn(created);
    await open(onCreate);
    await act(async () => typeTitle("Notes"));
    await press("Create page");

    expect(onCreate.mock.calls).toEqual([["Notes"]]);
  });

  it("says the name is decided now, and waits for one it can use", async () => {
    await open(created);
    expect(dialog()!.textContent).toContain(SHARE_SUBPAGE_NOTE);
    expect(button("Create page")!.hasAttribute("disabled")).toBe(true);

    await act(async () => typeTitle("   "));
    expect(button("Create page")!.hasAttribute("disabled")).toBe(true);

    await act(async () => typeTitle("Grocery list"));
    expect(button("Create page")!.hasAttribute("disabled")).toBe(false);
  });

  it("keeps the form for a refusal another press could answer", async () => {
    const onCreate = vi
      .fn<(title: string) => Promise<ShareSubpageOutcome>>()
      .mockResolvedValueOnce({ ok: false, message: "Busy. Try again.", retry: true })
      .mockResolvedValueOnce({ ok: true });
    const onClose = vi.fn();
    await open(onCreate, onClose);
    await act(async () => typeTitle("Notes"));
    await press("Create page");

    expect(dialog()!.textContent).toContain("Busy. Try again.");
    expect(onClose).not.toHaveBeenCalled();
    expect(field().value).toBe("Notes");

    await press("Create page");
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves one way out of a refusal that a second press would make worse", async () => {
    const onCreate = vi.fn(
      async (): Promise<ShareSubpageOutcome> => ({
        ok: false,
        message: "The page was created, but its link could not be placed here.",
        retry: false,
      }),
    );
    const onClose = vi.fn();
    await open(onCreate, onClose);
    await act(async () => typeTitle("Notes"));
    await press("Create page");

    expect(button("Create page")).toBeUndefined();
    expect(button("Cancel")).toBeUndefined();
    await press("Close");
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("gives the editor back on Cancel without creating anything", async () => {
    const onCreate = vi.fn(created);
    const onClose = vi.fn();
    await open(onCreate, onClose);
    await act(async () => typeTitle("Notes"));
    await press("Cancel");

    expect(onCreate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
