// @vitest-environment jsdom

// The section a person opens after handing an agent their mail: what each
// grant can reach, the two switches that narrow it without revoking
// anything, and the log of what agents changed.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsSection } from "./connections-section";

vi.mock("framer-motion", () => import("@/test/framer-motion-mock"));

const ACCOUNT = "account-a00000000000000000000000000000";

let host: HTMLDivElement;
let root: Root;
let connectedApps: unknown[];
let entries: unknown[];
let agent: { tellRecipients: boolean; allowSending: boolean; unreadable?: boolean };
let agentWrites: string[];
let activityMethods: string[];
let agentWriteFails: boolean;
let activityLoadFails: boolean;
/** Set by a test that wants the write to answer something other than what it
 *  was sent, so an "adopts the echo" test can tell that apart from an
 *  "adopts what it optimistically set" one, which look identical when the
 *  route always echoes the request body back unchanged. */
let agentEchoOverride: Partial<{ tellRecipients: boolean; allowSending: boolean }> | null;

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  connectedApps = [];
  entries = [];
  agent = { tellRecipients: false, allowSending: true };
  agentWrites = [];
  activityMethods = [];
  agentWriteFails = false;
  activityLoadFails = false;
  agentEchoOverride = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings/mcp" && method === "GET") {
        return response({
          endpoint: "https://brain.example.com/api/mcp",
          token: "",
          oauth: {
            issuer: "https://brain.example.com",
            authorizationEndpoint: "https://brain.example.com/oauth/authorize",
          },
          connectedApps,
        });
      }
      if (url === "/api/settings/mcp-activity") {
        activityMethods.push(method);
        if (method === "DELETE") {
          entries = [];
          return response({ ok: true });
        }
        return activityLoadFails ? response(null, 500) : response({ entries });
      }
      if (url === "/api/settings/mcp-agent") {
        if (method === "GET") return response(agent);
        if (agentWriteFails) return response(null, 500);
        agentWrites.push(String(init!.body));
        // The route merges one named field onto what it holds, so the fake
        // does too: a body naming one switch must not blank the other.
        agent = {
          ...agent,
          ...(JSON.parse(String(init!.body)) as Partial<typeof agent>),
          unreadable: false,
        };
        return response(agentEchoOverride ? { ...agent, ...agentEchoOverride } : agent);
      }
      throw new Error(`unexpected request: ${url}`);
    }),
  );
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function render(onToast: (title: string) => void = () => {}) {
  await act(async () => root.render(<ConnectionsSection onToast={onToast} />));
  // The section defers both loads to a timer, so the settle has to cross a
  // macrotask, not only the microtasks the fetch chain then takes.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const text = () => host.textContent ?? "";

const activityRows = () => [
  ...host.querySelectorAll<HTMLElement>('[data-testid="mcp-activity-row"]'),
];

function settingsGroup(title: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>("section")].find(
    (section) => section.querySelector("h3")?.textContent === title,
  );
  if (!found) throw new Error(`No settings group titled ${title}`);
  return found;
}

function group(label: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>('[role="radiogroup"]')].find(
    (node) => node.getAttribute("aria-label") === label,
  );
  if (!found) throw new Error(`No radiogroup named ${label}`);
  return found;
}

function radio(label: string, option: string): HTMLButtonElement {
  const found = [
    ...group(label).querySelectorAll<HTMLButtonElement>('[role="radio"]'),
  ].find((node) => (node.textContent ?? "").trim() === option);
  if (!found) throw new Error(`No ${option} in ${label}`);
  return found;
}

const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (node) => node.getAttribute("aria-label") === name,
  );

describe("Settings → Connections, the agent rows", () => {
  it("names every scope a grant can reach, not only the words stored on it", async () => {
    connectedApps = [
      {
        grantId: "grant_alpha",
        clientId: "client_alpha",
        clientName: "Claude",
        scopes: [
          "brain:read",
          "brain:write",
          "brain:import",
          "brain:mail",
          "brain:mail:send",
        ],
        connectedAt: 1_700_000_000_000,
      },
    ];
    await render();
    expect(text()).toContain("Read · Write · Import · Mail · Send mail");
  });

  it("shows the activity lines newest first, with the change, the account and the outcome", async () => {
    entries = [
      {
        at: "2026-09-14T09:00:01.000Z",
        client: "Claude",
        tool: "send_mail",
        accountId: ACCOUNT,
        operationId: "send-alpha",
        outcome: "ok",
      },
      {
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        tool: "update_mail_thread",
        accountId: ACCOUNT,
        threadId: "thread-alpha",
        change: "archive",
        outcome: "mail_thread_stale",
      },
    ];
    await render();
    const rows = activityRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("Claude");
    expect(rows[0]!.textContent).toContain("send_mail");
    expect(rows[1]!.textContent).toContain("archive");
    expect(rows[1]!.textContent).toContain("account-a000");
    expect(rows[1]!.textContent).toContain("mail_thread_stale");
  });

  it("carries no subject, address or title into the log rows", async () => {
    entries = [
      {
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        tool: "send_mail",
        accountId: ACCOUNT,
        outcome: "ok",
      },
    ];
    await render();
    expect(text()).not.toContain("@");
  });

  it("says so plainly when nothing has happened", async () => {
    await render();
    expect(text()).toContain("No agent activity yet");
  });

  it("clears the log and empties the list", async () => {
    entries = [
      {
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        tool: "send_mail",
        accountId: ACCOUNT,
        outcome: "ok",
      },
    ];
    const toasts: string[] = [];
    await render((title) => toasts.push(title));
    expect(activityRows()).toHaveLength(1);
    await act(async () => button("Clear agent activity")!.click());
    expect(activityMethods).toContain("DELETE");
    expect(activityRows()).toHaveLength(0);
    expect(text()).toContain("No agent activity yet");
    expect(toasts).toContain("Agent activity cleared");
  });

  it("shows the two switches with their defaults", async () => {
    await render();
    expect(radio("Tell recipients when an agent writes", "Off").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(radio("Let agents send mail", "On").getAttribute("aria-checked")).toBe("true");
  });

  it("writes a switch and says what it now means", async () => {
    const toasts: string[] = [];
    await render((title) => toasts.push(title));
    await act(async () => radio("Let agents send mail", "Off").click());
    expect(JSON.parse(agentWrites[0]!)).toEqual({ allowSending: false });
    expect(toasts).toContain("Agents can no longer send mail");
    expect(radio("Let agents send mail", "Off").getAttribute("aria-checked")).toBe("true");
  });

  /** ONE SWITCH WRITES ONE FIELD.
   *
   *  The request used to carry both, spread off the state on screen, so a
   *  value the screen was only standing in for was written back as though the
   *  owner had set it. */
  it("names only the switch that was thrown", async () => {
    await render();
    await act(async () => radio("Tell recipients when an agent writes", "On").click());
    expect(JSON.parse(agentWrites[0]!)).toEqual({ tellRecipients: true });
    expect(agentWrites.every((body) => !body.includes("allowSending"))).toBe(true);
  });

  it("puts a switch back where it was when the write fails", async () => {
    agentWriteFails = true;
    const toasts: string[] = [];
    await render((title) => toasts.push(title));
    await act(async () => radio("Let agents send mail", "Off").click());
    expect(toasts).toContain("Couldn't save that. Try again.");
    expect(radio("Let agents send mail", "On").getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the group standing when the log cannot be read", async () => {
    activityLoadFails = true;
    await render();
    expect(text()).toContain("No agent activity yet");
    expect(radio("Let agents send mail", "On")).toBeTruthy();
  });

  it("gives 'no apps connected' the same empty-state shape 'no activity' already has", async () => {
    await render();
    // Scoped to the empty block itself. The group's own refresh button is an
    // icon inside the same section, so asking the section for any `svg` at
    // all was true whether or not the empty row had one.
    const appsGroup = settingsGroup("Connected apps");
    const empty = [...appsGroup.querySelectorAll<HTMLElement>("div")].find((node) =>
      [...node.children].some(
        (child) =>
          child.tagName === "P" &&
          child.textContent === "No apps connected with OAuth yet",
      ),
    );
    expect(empty).toBeTruthy();
    expect(empty!.querySelector("svg")).not.toBeNull();
  });

  it("says sending is off when the file holding the switches cannot be read", async () => {
    // The tools fail closed on an unreadable settings file. The screen they
    // name in that refusal used to draw the on-by-default beside it.
    agent = { tellRecipients: false, allowSending: true, unreadable: true };
    await render();

    expect(radio("Let agents send mail", "Off").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(text()).toContain("every agent send is refused");
  });

  /** NEITHER SWITCH WRITES OVER A FILE NOBODY COULD READ.
   *
   *  The values on screen are the documented defaults standing in for a file
   *  that did not answer, so writing any of them back is writing a guess. The
   *  kill switch is the one that matters: flipping the other row used to send
   *  `allowSending: true` off that guess and turn sending back on with no
   *  toast and no row saying so. */
  it("sends nothing while the file holding the switches cannot be read", async () => {
    agent = { tellRecipients: false, allowSending: true, unreadable: true };
    await render();

    expect(radio("Tell recipients when an agent writes", "On").disabled).toBe(true);
    expect(radio("Let agents send mail", "On").disabled).toBe(true);
    await act(async () => radio("Tell recipients when an agent writes", "On").click());
    expect(agentWrites).toEqual([]);
    expect(radio("Let agents send mail", "Off").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("does not warn React about a duplicate key when two lines land in the same millisecond", async () => {
    entries = [
      {
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        tool: "update_mail_thread",
        accountId: ACCOUNT,
        threadId: "thread-alpha",
        change: "archive",
        outcome: "ok",
      },
      {
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        tool: "update_mail_thread",
        accountId: ACCOUNT,
        threadId: "thread-beta",
        change: "archive",
        outcome: "ok",
      },
    ];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    await render();
    expect(activityRows()).toHaveLength(2);
    expect(
      consoleError.mock.calls.some((call) =>
        call.some((value) => String(value).toLowerCase().includes("same key")),
      ),
    ).toBe(false);
    consoleError.mockRestore();
  });

  it("names the thread a mail triage line touched, and the task a task line touched", async () => {
    entries = [
      {
        at: "2026-09-14T09:00:01.000Z",
        client: "Claude",
        tool: "update_mail_thread",
        accountId: ACCOUNT,
        threadId: "thread-a0123456789abc",
        change: "archive",
        outcome: "ok",
      },
      {
        at: "2026-09-14T09:00:00.000Z",
        client: "Claude",
        tool: "update_task",
        task: "task-a0123456789abc",
        outcome: "ok",
      },
    ];
    await render();
    const rows = activityRows();
    expect(rows[0]!.textContent).toContain("thread-a01");
    expect(rows[1]!.textContent).toContain("task-a01");
  });

  it("adopts the settings the write echoes back, not only what it optimistically set", async () => {
    agentEchoOverride = { tellRecipients: true };
    await render();
    await act(async () => radio("Let agents send mail", "Off").click());
    expect(radio("Let agents send mail", "Off").getAttribute("aria-checked")).toBe("true");
    expect(
      radio("Tell recipients when an agent writes", "On").getAttribute("aria-checked"),
    ).toBe("true");
  });
});
