// @vitest-environment jsdom

// THE MENU UNDER THE PLUS.
//
// It used to offer a page and six ways of making one. It offers three nouns
// now, and the shape of that offer is what these cases pin: two groups with a
// rule between them, the Message row absent rather than dimmed when there is
// no account to send from, and every row a menu item so the arrow keys reach
// all of them.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEMPLATES } from "@/lib/templates";
import { NewMenu } from "./new-menu";
import { resetMailComposeAvailable } from "./mail-compose-available";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

let host: HTMLDivElement;
let root: Root;
let accounts: unknown[];
const pickTemplate = vi.fn();
const newTask = vi.fn();
const newMessage = vi.fn();

/** The exact shape `readAccounts` accepts (apiVersion 3, exact records). A
 *  gmail account can always send; a custom-domain IMAP with no SMTP transport
 *  never can, which is the "connected, but nothing to send from" case. */
function gmailAccount() {
  return {
    accountId: "account-a0123456789abcdef0123456789abcdef",
    capabilities: {
      compose: true,
      headerPreview: true,
      listThreads: true,
      mailboxes: ["inbox", "starred", "sent", "all", "spam", "trash"],
      messageBodies: true,
      reply: true,
      send: true,
      sync: true,
      threadMutations: true,
    },
    emailAddress: "person@example.test",
    displayName: null,
    status: "connected",
    connectedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    providerKind: "gmail",
  };
}

function readOnlyImapAccount() {
  return {
    accountId: "account-ab0123456789abcdef0123456789abcde",
    capabilities: {
      compose: false,
      headerPreview: true,
      listThreads: true,
      mailboxes: ["inbox"],
      messageBodies: true,
      reply: false,
      send: false,
      sync: true,
      threadMutations: true,
    },
    emailAddress: "reader@example.test",
    displayName: null,
    status: "connected",
    connectedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    providerKind: "imap",
    imap: {
      hostname: "imap.example.test",
      port: 993,
      tls: "implicit",
      username: "reader@example.test",
    },
  };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  resetMailComposeAvailable();
  pickTemplate.mockReset();
  newTask.mockReset();
  newMessage.mockReset();
  accounts = [gmailAccount()];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/mail/accounts")) {
        return { ok: true, status: 200, json: async () => ({ apiVersion: 3, accounts }) } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  // Radix's popper measures its content and captures the pointer; jsdom ships
  // neither. The same four stubs `notifications-bell.test.tsx` puts up.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  for (const name of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"]) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      value: () => (name === "hasPointerCapture" ? false : undefined),
    });
  }
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document
    .querySelectorAll("[data-radix-popper-content-wrapper]")
    .forEach((element) => element.remove());
  resetMailComposeAvailable();
  vi.unstubAllGlobals();
});

async function render(props: Partial<React.ComponentProps<typeof NewMenu>> = {}) {
  await act(async () =>
    root.render(
      <NewMenu
        onPickTemplate={pickTemplate}
        onNewTask={newTask}
        onNewMessage={newMessage}
        {...props}
      >
        <button type="button" aria-label="New" />
      </NewMenu>,
    ),
  );
  for (let round = 0; round < 4; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const trigger = () => host.querySelector<HTMLButtonElement>('[aria-label="New"]')!;

/** The press alone. Radix opens a dropdown on `pointerdown`, and below md the
 *  sheet stands the handler down and waits for the lift. */
const press = async () => {
  await act(async () => {
    trigger().dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 }),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
};

/** The whole gesture: the press, then the click the browser fires when the
 *  reader lets go. The menu is up either way by the end of it. */
const open = async () => {
  await press();
  await act(async () => trigger().click());
  await act(async () => {
    await Promise.resolve();
  });
};

/** TWO MACROTASK HOPS, not one. Radix dispatches its unmount-autofocus event
 *  from a `setTimeout(0)` of its own, and `useDeferredMenuAction` schedules the
 *  action from inside that handler, so the act lands a hop after the hop. */
const released = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

const menu = () => document.querySelector<HTMLElement>(".brain-menu")!;
const rows = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((node) =>
    (node.textContent ?? "").trim(),
  );
const row = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (node) => (node.textContent ?? "").trim() === name,
  );

describe("the New menu", () => {
  it("stands two groups with a rule between them", async () => {
    await render();
    await open();

    const labels = [...menu().querySelectorAll(".brain-menu-label")].map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(["New", "Page"]);
    expect(menu().querySelectorAll(".brain-menu-sep")).toHaveLength(1);

    // Task and Message first, then every page the menu already offered.
    expect(rows()).toEqual([
      "Task",
      "Message",
      ...TEMPLATES.map((template) => `${template.emoji}${template.name}`),
    ]);
  });

  it("leaves the Message row out when there is no account to send from", async () => {
    accounts = [];
    await render();
    await open();

    expect(row("Message")).toBeUndefined();
    // absent, not disabled: a row nobody can press is worse than no row
    expect(menu().querySelector("[data-disabled]")).toBeNull();
    expect(rows()[0]).toBe("Task");
  });

  it("leaves the Message row out when the one account cannot send", async () => {
    accounts = [readOnlyImapAccount()];
    await render();
    await open();

    expect(row("Message")).toBeUndefined();
  });

  it("gives Task and Message the glyphs their surfaces wear", async () => {
    await render();
    await open();

    expect(row("Task")!.querySelector("svg")).not.toBeNull();
    expect(row("Message")!.querySelector("svg")).not.toBeNull();
    expect(row("Task")!.querySelector(".brain-menu-icon")).not.toBeNull();
    expect(row("Message")!.querySelector(".brain-menu-icon")).not.toBeNull();
  });

  it("runs the three creates from their own rows", async () => {
    await render();

    // TASK AND MESSAGE WAIT FOR THE MENU TO GO. Both put a caret somewhere,
    // and a caret moved inside Radix's focus scope is a caret Radix takes back
    // as the layer tears down. The page rows move no caret in this commit and
    // run at the press, as they always have.
    await open();
    await act(async () => row("Task")!.click());
    expect(newTask).not.toHaveBeenCalled();
    await released();
    expect(newTask).toHaveBeenCalledTimes(1);

    await open();
    await act(async () => row("Message")!.click());
    await released();
    expect(newMessage).toHaveBeenCalledTimes(1);

    await open();
    await act(async () => row("Blank page")!.click());
    expect(pickTemplate).toHaveBeenCalledTimes(1);
    expect(pickTemplate.mock.calls[0][0].id).toBe("blank");
  });

  it("draws no sheet and no grip on a pointer", async () => {
    await render();
    await open();
    expect(menu().classList.contains("brain-menu-sheet")).toBe(false);
    expect(document.querySelector(".brain-composer-grip")).toBeNull();
  });

  it("opens on the press, where nothing of it is under the pointer", async () => {
    // A menu that drops BELOW its trigger is off the press's path, so it keeps
    // Radix's own gesture and a mouse gets its rows the moment it goes down.
    await render();
    await press();
    expect(document.querySelector(".brain-menu")).not.toBeNull();
  });
});

describe("the New menu on a phone", () => {
  beforeEach(() => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(max-width: 767px)",
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
  });

  it("rises as a sheet on the menu material, with a grip", async () => {
    await render();
    await open();

    expect(menu().classList.contains("brain-menu")).toBe(true);
    expect(menu().classList.contains("brain-menu-sheet")).toBe(true);
    expect(document.querySelector(".brain-composer-grip")).not.toBeNull();
    // the same rows, in the same order: a sheet is a shape, not a second menu
    expect(rows()).toEqual([
      "Task",
      "Message",
      ...TEMPLATES.map((template) => `${template.emoji}${template.name}`),
    ]);
  });

  /** THE SHEET ARRIVES UNDER THE FINGER THAT OPENED IT.
   *
   *  Radix opens on `pointerdown` and picks a row on the press that follows. A
   *  menu that drops below its trigger is never under the press that asked for
   *  it; the sheet rises over the plus, so the end of that one tap came down on
   *  whichever row had arrived at those coordinates and made a page the reader
   *  never chose. So the press opens nothing and the lift opens the sheet, the
   *  gesture the When picker's popover already takes on this breakpoint. */
  it("opens on the lift and not on the press", async () => {
    await render();
    await press();
    expect(document.querySelector(".brain-menu")).toBeNull();

    await act(async () => trigger().click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(menu().classList.contains("brain-menu-sheet")).toBe(true);
  });
});
