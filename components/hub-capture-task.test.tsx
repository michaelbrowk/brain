// @vitest-environment jsdom

// THE SECOND CONTROL ON THE CAPTURE FIELD.
//
// One field, two explicit destinations: Enter still makes a page, and `Task`
// (⌘⏎ from the keyboard) writes a task into today. Never one control with two
// meanings. The reader says where the words are going before they go.
//
// And the words travel. The flight is one element with one `layoutId` in two
// places, so what a reader watches is the sentence they typed moving into the
// row it becomes, on `SPRING_PANEL`. Reduced motion has no flight at all.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MotionRender } from "@/test/framer-motion-mock";
import { SPRING_PANEL } from "@/lib/motion";
import { HUB_CAPTURE_FLIGHT_ID } from "./hub-today";
import { resetTasksStore } from "./tasks-client";
import { Hub } from "./hub";

const harness = { reduce: false };
const renders: MotionRender[] = [];

vi.mock("framer-motion", async () => {
  const { createFramerMotionMock } = await import("@/test/framer-motion-mock");
  return createFramerMotionMock({
    reducedMotion: () => harness.reduce,
    onRender: (render) => {
      renders.push(render);
    },
  });
});

const NOON = new Date("2026-09-13T12:00:00.000Z");

interface Call {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

let host: HTMLDivElement;
let root: Root;
let calls: Call[];
let created: Record<string, unknown> | null;
let createStatus: number;
let createBody: Record<string, unknown>;
const toasts: { title: string; urgent?: boolean }[] = [];

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function field(): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="New thought"]');
  if (!input) throw new Error("the capture field is not rendered");
  return input;
}

function taskControl(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>("[data-hub-capture-task]");
  if (!button) throw new Error("the Task control is not rendered");
  return button;
}

async function type(text: string) {
  const input = field();
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function render() {
  await act(async () => {
    root.render(
      <Hub
        tree={[]}
        onSelect={() => {}}
        onCreate={async () => null}
        onOpenTasks={() => {}}
        onToast={(title, options) => toasts.push({ title, urgent: options?.urgent })}
      />,
    );
  });
  await settle();
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers({ now: NOON });
  harness.reduce = false;
  renders.length = 0;
  toasts.length = 0;
  calls = [];
  created = null;
  createStatus = 201;
  createBody = {};
  resetTasksStore();
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({ matches: query === "(hover: hover)" })),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body =
        typeof init?.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null;
      calls.push({ url, method, body });
      if (url === "/api/tasks" && method === "POST") {
        if (createStatus !== 201) {
          return { ok: false, status: createStatus, json: async () => createBody } as Response;
        }
        created = {
          id: "task-new",
          title: body?.title,
          when: body?.when,
          done: false,
          created: NOON.toISOString(),
          updated: NOON.toISOString(),
        };
        return { ok: true, status: 201, json: async () => ({ task: created }) } as Response;
      }
      if (url.includes("/api/mail/")) {
        return { ok: true, status: 200, json: async () => ({ accounts: [] }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ tasks: created ? [created] : [] }),
      } as Response;
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  resetTasksStore();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the capture field's Task control", () => {
  it("is disabled until there are words to send", async () => {
    await render();
    expect(taskControl().textContent).toBe("Task");
    expect(taskControl().disabled).toBe(true);

    await type("water the plants");
    expect(taskControl().disabled).toBe(false);
  });

  it("writes a task into today and clears the field", async () => {
    await render();
    await type("water the plants");

    await act(async () => taskControl().click());
    await settle();

    const post = calls.find((call) => call.url === "/api/tasks" && call.method === "POST");
    expect(post?.body).toEqual({ title: "water the plants", when: "2026-09-13" });
    expect(field().value).toBe("");
    // and the row is in the block below, as a task and not as a page
    expect(host.querySelector(".brain-task-title")?.textContent).toBe(
      "water the plants",
    );
  });

  it("keeps plain Enter on the page path and puts ⌘⏎ on the task one", async () => {
    const pages: string[] = [];
    await act(async () => {
      root.render(
        <Hub
          tree={[]}
          onSelect={() => {}}
          onCreate={async (title) => {
            pages.push(title);
            return "page-1";
          }}
          onOpenTasks={() => {}}
        />,
      );
    });
    await settle();

    await type("a thought");
    await act(async () => {
      field().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    await settle();
    expect(pages).toEqual(["a thought"]);
    expect(calls.some((call) => call.method === "POST")).toBe(false);

    await type("a task");
    await act(async () => {
      field().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }),
      );
    });
    await settle();
    expect(pages).toEqual(["a thought"]);
    expect(
      calls.find((call) => call.url === "/api/tasks" && call.method === "POST")?.body,
    ).toEqual({ title: "a task", when: "2026-09-13" });
  });

  it("flies the words from the field into the block on one layoutId", async () => {
    await render();
    await type("water the plants");
    renders.length = 0;

    await act(async () => taskControl().click());

    // The words leave the field and land in the block's first row slot. One
    // element, one id, two positions: framer carries it rather than one
    // vanishing and another appearing.
    const flights = renders.filter(
      (render) => render.motion.layoutId === HUB_CAPTURE_FLIGHT_ID,
    );
    expect(flights.length).toBeGreaterThan(0);
    expect(flights.at(-1)?.motion.transition).toEqual(SPRING_PANEL);
    expect(host.querySelector(".brain-hub-flight-text")?.textContent).toBe(
      "water the plants",
    );

    await settle();
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    // and it is gone once the spring has had its 300ms
    expect(host.querySelector(".brain-hub-flight-text")).toBeNull();
  });

  it("has no flight at all under reduced motion", async () => {
    harness.reduce = true;
    await render();
    await type("water the plants");
    renders.length = 0;

    await act(async () => taskControl().click());

    expect(host.querySelector(".brain-hub-flight-text")).toBeNull();
    expect(
      renders.some((render) => render.motion.layoutId === HUB_CAPTURE_FLIGHT_ID),
    ).toBe(false);
    await settle();
    expect(field().value).toBe("");
    expect(host.querySelector(".brain-task-title")?.textContent).toBe(
      "water the plants",
    );
  });

  it("gives the words back to the field when the route refuses them", async () => {
    createStatus = 400;
    createBody = { error: "bad_title", reason: "That title is too long" };
    await render();
    await type("water the plants");

    await act(async () => taskControl().click());
    await settle();

    expect(toasts.at(-1)).toEqual({
      title: "That title is too long",
      urgent: true,
    });
    expect(field().value).toBe("water the plants");
  });
});
