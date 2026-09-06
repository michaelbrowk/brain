// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

import { ShareNameDialog } from "./share-name-dialog";

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
  vi.restoreAllMocks();
});

type Seen = { url: string; method: string; body: unknown };

function recordFetch(answers: Array<() => Response | Promise<Response>>) {
  const seen: Seen[] = [];
  let calls = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    seen.push({
      url: typeof input === "string" ? input : String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    return (answers[calls++] ?? answers.at(-1)!)();
  });
  return seen;
}

const json = (body: unknown, status: number) => () =>
  new Response(JSON.stringify(body), { status });

async function mount(props: { onMinted?: () => void } = {}) {
  await act(async () => {
    root.render(<ShareNameDialog id="root-1" {...props} />);
  });
}

const input = (name: string) =>
  host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
const button = () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!;
const alert = () => host.querySelector('[role="alert"]');
const alertText = () => alert()?.textContent ?? null;
/** The visible text of the <label> that owns an input, through htmlFor. */
const labelOf = (field: HTMLInputElement) =>
  host.querySelector(`label[for="${field.id}"]`)?.textContent ?? null;

async function type(field: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit() {
  await act(async () => {
    host.querySelector("form")!.dispatchEvent(
      new Event("submit", { bubbles: true, cancelable: true }),
    );
  });
}

describe("the name dialog", () => {
  it("mints the edit cookie with the name and hands over on success", async () => {
    const seen = recordFetch([json({ ok: true }, 200)]);
    const onMinted = vi.fn();
    await mount({ onMinted });

    expect(host.textContent).toContain("Who is editing?");
    expect(host.textContent).toContain("Your name shows on the pages you edit.");
    expect(button().disabled).toBe(true);
    await submit();
    expect(seen).toEqual([]);

    await type(input("name")!, "  Ann  ");
    expect(button().disabled).toBe(false);
    await submit();

    expect(seen).toEqual([
      {
        url: "/api/share-auth",
        method: "POST",
        body: { intent: "edit", id: "root-1", name: "  Ann  " },
      },
    ]);
    expect(onMinted).toHaveBeenCalledTimes(1);
    expect(alertText()).toBeNull();
  });

  // Locked or open, the server renders the same form. Any 401 is the mint
  // saying a password is wanted now -- the read cookie expired, the share was
  // re-issued, or the owner added a password under an open page -- and the
  // field appears for all three rather than for a prop read at render.
  it("draws the password field on any 401, and only then", async () => {
    const seen = recordFetch([
      json({ error: "wrong password" }, 401),
      json({ error: "wrong password" }, 401),
      json({ ok: true }, 200),
    ]);
    const onMinted = vi.fn();
    await mount({ onMinted });
    expect(input("password")).toBeNull();

    await type(input("name")!, "Ann");
    await submit();
    expect(seen[0]!.body).toEqual({ intent: "edit", id: "root-1", name: "Ann" });
    expect(alertText()).toBe("Enter the password to edit.");
    expect(input("password")).not.toBeNull();
    expect(onMinted).not.toHaveBeenCalled();

    await type(input("password")!, "nope");
    await submit();
    expect(seen[1]!.body).toEqual({
      intent: "edit",
      id: "root-1",
      name: "Ann",
      password: "nope",
    });
    expect(alertText()).toBe("Wrong password");
    expect(input("password")!.value).toBe("");
    expect(input("password")!.getAttribute("aria-invalid")).toBe("true");

    await type(input("password")!, "right");
    await submit();
    expect(seen[2]!.body).toMatchObject({ password: "right" });
    expect(onMinted).toHaveBeenCalledTimes(1);
  });

  it("keeps a name the server would refuse from ever being sent", async () => {
    const seen = recordFetch([json({ ok: true }, 200)]);
    await mount();

    // Control characters are what normalizeVisitorName strips, so a name made
    // only of them is empty to the server while trim() still sees length.
    await type(input("name")!, "\u0001\u0002\u007f");
    expect(button().disabled).toBe(true);
    await submit();
    expect(seen).toEqual([]);

    await type(input("name")!, "\u0001Ann");
    expect(button().disabled).toBe(false);
  });

  it("names its fields visibly and points the alert at them", async () => {
    recordFetch([json({ error: "wrong password" }, 401)]);
    await mount();

    const nameField = input("name")!;
    expect(labelOf(nameField)).toBe("Your name");
    expect(nameField.getAttribute("aria-describedby")).toBeNull();

    await type(nameField, "Ann");
    await submit();

    const passwordField = input("password")!;
    expect(labelOf(passwordField)).toBe("Password");
    const errorId = alert()!.id;
    expect(errorId).not.toBe("");
    expect(input("name")!.getAttribute("aria-describedby")).toBe(errorId);
    expect(passwordField.getAttribute("aria-describedby")).toBe(errorId);
  });

  it("says why when the mint is refused or unreachable", async () => {
    recordFetch([
      json({ error: "too many attempts" }, 429),
      json({ error: "not found" }, 404),
      json({ error: "bad request" }, 400),
      () => Promise.reject(new TypeError("Failed to fetch")),
    ]);
    const onMinted = vi.fn();
    await mount({ onMinted });
    await type(input("name")!, "Ann");

    await submit();
    expect(alertText()).toBe("Too many attempts. Wait a bit.");
    // The owner closed editing while this page stood open: trying again
    // cannot fix that, so the message does not ask for it.
    await submit();
    expect(alertText()).toBe("This page is no longer open for editing.");
    await submit();
    expect(alertText()).toBe("Couldn't start editing. Try again.");
    await submit();
    expect(alertText()).toBe("Couldn't connect. Try again.");
    expect(onMinted).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
  });
});
