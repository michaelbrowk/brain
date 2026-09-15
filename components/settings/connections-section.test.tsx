// @vitest-environment jsdom

// The section a person opens after handing an agent their mail: what each
// grant can actually do, the two switches that narrow it without revoking
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
let agent: { tellRecipients: boolean; allowSending: boolean };
let agentWrites: string[];
let activityMethods: string[];
let agentWriteFails: boolean;
let activityLoadFails: boolean;

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
        agent = JSON.parse(String(init!.body)) as typeof agent;
        return response(agent);
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
    expect(JSON.parse(agentWrites[0]!)).toEqual({
      tellRecipients: false,
      allowSending: false,
    });
    expect(toasts).toContain("Agents can no longer send mail");
    expect(radio("Let agents send mail", "Off").getAttribute("aria-checked")).toBe("true");
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
});
