// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAIL_RESOURCE_LIMITS } from "@/lib/mail/security";
import { MAX_MAIL_ACCOUNTS, MailAccountSettings } from "./mail-account-settings";

function imapAccount(
  accountId = "account-a0123456789abcdef0123456789abcdef",
  emailAddress = "person@example.test",
) {
  return {
    accountId,
    emailAddress,
    displayName: "Personal",
    status: "connected",
    connectedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    providerKind: "imap",
    imap: {
      hostname: "imap.example.test",
      port: 993,
      tls: "implicit",
      username: emailAddress,
    },
  };
}

function imapAccountWithSmtp(
  accountId = "account-a0123456789abcdef0123456789abcdef",
  emailAddress = "person@example.test",
) {
  return {
    ...imapAccount(accountId, emailAddress),
    smtp: {
      hostname: "smtp.example.test",
      port: 465,
      tls: "implicit",
      username: emailAddress,
    },
  };
}

function gmailAccount() {
  return {
    accountId: "account-affffffffffffffffffffffffffffffff",
    emailAddress: "person@gmail.test",
    displayName: null,
    status: "reauth_required",
    connectedAt: 1_700_000_000_000,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    providerKind: "gmail",
  };
}

const accounts = (...items: unknown[]) => ({ apiVersion: 2, accounts: items });
const result = (account: unknown) => ({ apiVersion: 2, account });

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function inputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
  const match = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`);
  return match;
}

/** One option of a Segmented control — a radiogroup of role=radio buttons,
 *  not native radio inputs — found by the group's label and the option's
 *  own text. */
function segmentedOption(group: string, label: string): HTMLButtonElement {
  const radiogroup = document.querySelector(
    `[role="radiogroup"][aria-label="${group}"]`,
  );
  const match = [...(radiogroup?.querySelectorAll('[role="radio"]') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing ${group} option: ${label}`);
  }
  return match;
}

/** Security of the incoming server; the outgoing server has its own group. */
function securityOption(value: "implicit" | "starttls"): HTMLButtonElement {
  return segmentedOption("Security", value === "implicit" ? "TLS" : "STARTTLS");
}

function outgoingSecurityOption(value: "implicit" | "starttls"): HTMLButtonElement {
  return segmentedOption(
    "Outgoing security",
    value === "implicit" ? "TLS" : "STARTTLS",
  );
}

const SEND_SWITCH = "Send from this account";

function sendSwitch(value: "on" | "off"): HTMLButtonElement {
  return segmentedOption(SEND_SWITCH, value === "on" ? "On" : "Off");
}

function sendSwitchIs(value: "on" | "off"): boolean {
  return sendSwitch(value).getAttribute("aria-checked") === "true";
}

function submitForm(host: HTMLElement) {
  (host.querySelector('form[autocomplete="off"]') as HTMLFormElement).dispatchEvent(
    new Event("submit", { bubbles: true, cancelable: true }),
  );
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openOtherEmail() {
  await act(async () => button("Connect account").click());
  await act(async () => button("Other emailConnect with IMAP").click());
}

describe("MailAccountSettings", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onOpenMail = vi.fn();
  const onToast = vi.fn();

  beforeEach(() => {
    (
      globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT: boolean;
      }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    onOpenMail.mockReset();
    onToast.mockReset();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("shows multiple providers and starts Google OAuth with browser navigation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(accounts())));
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    expect(
      [...document.body.querySelectorAll("button")].filter(
        (candidate) => candidate.textContent?.trim() === "Connect account",
      ),
    ).toHaveLength(1);
    expect(document.body.textContent).not.toContain("Add account");
    await act(async () => button("Connect account").click());

    const google = button("GoogleGmail and Google Workspace");
    const googleForm = google.closest("form") as HTMLFormElement;
    expect(googleForm.getAttribute("method")).toBe("post");
    expect(googleForm.getAttribute("action")).toBe("/api/mail/oauth/google/start");
    expect(button("Other emailConnect with IMAP")).not.toBeNull();
  });

  it("mirrors the account cap the mail service enforces", () => {
    expect(MAX_MAIL_ACCOUNTS).toBe(MAIL_RESOURCE_LIMITS.maxAccounts);
  });

  it("replaces the add action with a clear account-limit state", async () => {
    const full = Array.from({ length: MAX_MAIL_ACCOUNTS }, (_, index) =>
      imapAccount(
        `account-a${String(index + 1).repeat(32)}`,
        `person-${index + 1}@example.test`,
      ),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(accounts(...full))),
    );
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();

    expect(document.body.textContent).toContain(
      `${MAX_MAIL_ACCOUNTS} account limit`,
    );
    expect(document.body.textContent).toContain(
      `Brain supports up to ${MAX_MAIL_ACCOUNTS} mail accounts.`,
    );
    expect(document.body.textContent).not.toContain("Add account");
  });

  it("autofills IMAP details and isolates credentials from the Brain login", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(accounts())));
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await openOtherEmail();

    const form = host.querySelector('form[autocomplete="off"]') as HTMLFormElement;
    const email = document.getElementById("mail-email") as HTMLInputElement;
    const hostname = document.getElementById("mail-hostname") as HTMLInputElement;
    const username = document.getElementById("mail-username") as HTMLInputElement;
    const password = document.getElementById("mail-password") as HTMLInputElement;
    const port = document.getElementById("mail-port") as HTMLInputElement;
    await act(async () => inputValue(email, "misha@studio.example"));
    expect(hostname.value).toBe("imap.studio.example");
    expect(username.value).toBe("misha@studio.example");
    expect(form.getAttribute("autocomplete")).toBe("off");
    expect(username.getAttribute("autocomplete")).toBe("section-brain-mail username");
    expect(password.getAttribute("autocomplete")).toBe("section-brain-mail new-password");
    // every input is a Field atom, never a bare input styled inline
    for (const input of form.querySelectorAll("input")) {
      expect(input.closest("label.field")).not.toBeNull();
    }

    await act(async () => securityOption("starttls").click());
    expect(port.value).toBe("143");
  });

  it("creates an exact IMAP account with a custom port and opens Mail", async () => {
    const created = imapAccount();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accounts()))
      .mockResolvedValueOnce(response(result(created)));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await openOtherEmail();

    await act(async () => {
      inputValue(document.getElementById("mail-display-name") as HTMLInputElement, "Personal");
      inputValue(document.getElementById("mail-email") as HTMLInputElement, created.emailAddress);
      inputValue(document.getElementById("mail-password") as HTMLInputElement, "SECRET password");
      inputValue(document.getElementById("mail-port") as HTMLInputElement, "7993");
    });
    await act(async () => {
      (host.querySelector('form[autocomplete="off"]') as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(fetchMock.mock.calls[1][0]).toBe("/api/mail/accounts");
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(request.method).toBe("POST");
    const body = JSON.parse(String(request.body)) as { smtp: Record<string, unknown> };
    expect(body).toEqual({
      providerKind: "imap",
      emailAddress: created.emailAddress,
      displayName: "Personal",
      imap: {
        hostname: "imap.example.test",
        port: 7993,
        tls: "implicit",
        username: created.emailAddress,
        password: "SECRET password",
      },
      // a complete address turns the outgoing server on with the derived
      // guess; the password travels once, inside imap, never beside smtp
      smtp: {
        hostname: "smtp.example.test",
        port: 465,
        tls: "implicit",
        username: created.emailAddress,
      },
    });
    expect(Object.prototype.hasOwnProperty.call(body.smtp, "password")).toBe(false);
    expect(document.body.textContent).not.toContain("SECRET password");
    expect(onToast).toHaveBeenCalledWith("Mail account connected");
    expect(onOpenMail).toHaveBeenCalledTimes(1);
  });

  it("aborts a pending connection when settings closes and ignores its late result", async () => {
    const pending = deferred<Response>();
    const created = imapAccount();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accounts()))
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce(response(accounts()));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await openOtherEmail();
    await act(async () => {
      inputValue(document.getElementById("mail-email") as HTMLInputElement, created.emailAddress);
      inputValue(document.getElementById("mail-password") as HTMLInputElement, "SECRET password");
      (host.querySelector('form[autocomplete="off"]') as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(request.signal?.aborted).toBe(false);
    await act(async () => root.render(<div>Settings closed</div>));
    expect(request.signal?.aborted).toBe(true);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();

    pending.resolve(response(result(created)));
    await settle();

    expect(document.body.textContent).toContain("Connect account");
    expect(onToast).not.toHaveBeenCalled();
    expect(onOpenMail).not.toHaveBeenCalled();
  });

  it("renders the last loaded accounts at once on a revisit and revalidates silently", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(accounts(imapAccount()))));
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    expect(document.body.textContent).toContain("person@example.test");
    await act(async () => root.render(<div>Settings closed</div>));

    const pending = deferred<Response>();
    const fetchMock = vi.fn().mockImplementation(() => pending.promise);
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(document.body.textContent).toContain("person@example.test");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    pending.resolve(response(accounts(imapAccount(), gmailAccount())));
    await settle();
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    expect(document.body.textContent).toContain("person@gmail.test");
  });

  it("renders all accounts and marks Google reauthorization", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(accounts(imapAccount(), gmailAccount()))),
    );
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();

    expect(document.body.textContent).toContain("Personal");
    expect(document.body.textContent).toContain("person@gmail.test");
    expect(document.body.textContent).toContain("Reconnect needed");
    await act(async () => button("person@gmail.testGoogleReconnect needed").click());
    const reconnect = button("Reconnect Google");
    const reconnectForm = reconnect.closest("form") as HTMLFormElement;
    expect(reconnectForm.getAttribute("action")).toBe(
      "/api/mail/oauth/google/start",
    );
    expect(
      (reconnectForm.elements.namedItem("accountId") as HTMLInputElement).value,
    ).toBe(gmailAccount().accountId);
  });

  it("edits only the selected account and keeps its saved credential", async () => {
    const original = imapAccount();
    const updated = { ...original, displayName: "Work", updatedAt: original.updatedAt + 1 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accounts(original, gmailAccount())))
      .mockResolvedValueOnce(response(result(updated)));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await act(async () => button("Personalperson@example.test · IMAP").click());
    await act(async () => button("Edit").click());
    await act(async () =>
      inputValue(document.getElementById("mail-display-name") as HTMLInputElement, "Work"),
    );
    await act(async () => {
      (host.querySelector('form[autocomplete="off"]') as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(fetchMock.mock.calls[1][0]).toBe(
      `/api/mail/accounts/${original.accountId}`,
    );
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(request.method).toBe("PATCH");
    expect(JSON.parse(String(request.body)).imap.password).toBeNull();
    expect(document.body.textContent).toContain("Work");
    expect(onToast).toHaveBeenCalledWith("Mail settings saved");
    expect(onOpenMail).not.toHaveBeenCalled();
  });

  it("requires the password again after connection identity changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(accounts(imapAccount())));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await act(async () => button("Personalperson@example.test · IMAP").click());
    await act(async () => button("Edit").click());
    await act(async () =>
      inputValue(
        document.getElementById("mail-hostname") as HTMLInputElement,
        "imap.changed.example.test",
      ),
    );
    await act(async () => {
      (host.querySelector('form[autocomplete="off"]') as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });

    expect(document.getElementById("mail-password-error")?.textContent).toBe(
      "Re-enter the password after changing the server, security, port, or username.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("removes only the selected account after explicit confirmation", async () => {
    const removed = imapAccount();
    const remaining = gmailAccount();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accounts(removed, remaining)))
      .mockResolvedValueOnce(response(result(removed)));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await act(async () => button("Personalperson@example.test · IMAP").click());
    await act(async () => button("Remove").click());

    expect(document.body.textContent).toContain("cached mail, local drafts, search index, and sync state");
    expect(document.body.textContent).toContain("Nothing will be deleted from your mail provider.");
    await act(async () => button("Remove from Brain").click());
    await settle();

    expect(fetchMock.mock.calls[1][0]).toBe(
      `/api/mail/accounts/${removed.accountId}`,
    );
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({ method: "DELETE", signal: expect.any(AbortSignal) }),
    );
    expect(document.body.textContent).not.toContain("person@example.test");
    expect(document.body.textContent).toContain("person@gmail.test");
    expect(onToast).toHaveBeenCalledWith("Mail account removed");
  });

  it("maps duplicate and account-limit errors without leaving the form", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accounts()))
      .mockResolvedValueOnce(
        response({ apiVersion: 2, error: { code: "account_already_exists" } }, 409),
      );
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await openOtherEmail();
    await act(async () => {
      inputValue(document.getElementById("mail-email") as HTMLInputElement, "person@example.test");
      inputValue(document.getElementById("mail-password") as HTMLInputElement, "password");
    });
    await act(async () => {
      (host.querySelector('form[autocomplete="off"]') as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(document.body.textContent).toContain("This mail account is already connected.");
    expect(document.getElementById("mail-email")).not.toBeNull();
    expect(onOpenMail).not.toHaveBeenCalled();
  });

  it("explains an unreachable company IMAP host without blaming the settings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accounts()))
      .mockResolvedValueOnce(
        response({ apiVersion: 2, error: { code: "imap_connection_failed" } }, 422),
      );
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await openOtherEmail();
    await act(async () => {
      inputValue(
        document.getElementById("mail-email") as HTMLInputElement,
        "person@example.test",
      );
      inputValue(document.getElementById("mail-password") as HTMLInputElement, "password");
    });
    await act(async () => {
      (host.querySelector('form[autocomplete="off"]') as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(document.body.textContent).toContain(
      "only accepts connections from your work network",
    );
    expect(document.getElementById("mail-email")).not.toBeNull();
    expect(onOpenMail).not.toHaveBeenCalled();
  });

  /*
    The five `smtp_*` codes had no line of copy at all, so a wrong outgoing
    password fell through to "Mail setup is unavailable right now. Try again."
    — the sentence for an outage, under a refusal the owner has to act on.
  */
  it.each([
    [
      "smtp_authentication_failed",
      "The outgoing server rejected the username or password. Providers with two-step sign-in need an app password.",
    ],
    ["smtp_dns_failed", "We couldn't find this outgoing (SMTP) server."],
    ["smtp_tls_failed", "The secure connection to the outgoing server failed."],
    ["smtp_connection_failed", "We couldn't reach the outgoing (SMTP) server."],
    ["smtp_connection_timeout", "The outgoing (SMTP) server didn't respond."],
    // the service has no direct SMTP: the owner either connects receive-only
    // or enables it on the host, and the sentence names both ways out
    [
      "smtp_submission_unavailable",
      'Outgoing mail isn\'t enabled on this Brain server. Turn off "Send from this account" to connect receive-only, or enable direct SMTP in the server settings.',
    ],
  ])("explains %s as the server's answer, not an outage", async (code, sentence) => {
    const status = code.endsWith("timeout") ? 408 : code.endsWith("unavailable") ? 503 : 422;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accounts()))
      .mockResolvedValueOnce(response({ apiVersion: 2, error: { code } }, status));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await openOtherEmail();
    await act(async () => {
      inputValue(document.getElementById("mail-email") as HTMLInputElement, "person@example.test");
      inputValue(document.getElementById("mail-password") as HTMLInputElement, "password");
    });
    await act(async () => {
      (host.querySelector('form[autocomplete="off"]') as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(document.body.textContent).toContain(sentence);
    expect(document.body.textContent).not.toContain("Mail setup is unavailable");
    expect(document.getElementById("mail-email")).not.toBeNull();
    expect(onOpenMail).not.toHaveBeenCalled();
  });

  async function openFormWithAccounts() {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(accounts())));
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await openOtherEmail();
  }

  const field = (id: string) => document.getElementById(id) as HTMLInputElement;
  const securityChecked = (value: "implicit" | "starttls") =>
    securityOption(value).getAttribute("aria-checked") === "true";

  it("uses the provider autoconfig endpoint for the exact provider domain", async () => {
    await openFormWithAccounts();
    await act(async () => inputValue(field("mail-email"), "person@icloud.com"));

    expect(field("mail-hostname").value).toBe("imap.mail.me.com");
    expect(field("mail-port").value).toBe("993");
    expect(field("mail-username").value).toBe("person@icloud.com");
    expect(securityChecked("implicit")).toBe(true);
  });

  it("matches the provider domain regardless of address case", async () => {
    await openFormWithAccounts();
    await act(async () => inputValue(field("mail-email"), "Person@ICLOUD.COM"));

    expect(field("mail-hostname").value).toBe("imap.mail.me.com");
    expect(field("mail-port").value).toBe("993");
  });

  it("matches the provider domain exactly and not a lookalike or subdomain", async () => {
    await openFormWithAccounts();
    await act(async () => inputValue(field("mail-email"), "person@noticloud.test"));
    expect(field("mail-hostname").value).toBe("imap.noticloud.test");

    await act(async () => inputValue(field("mail-email"), "person@corp.icloud.com"));
    expect(field("mail-hostname").value).toBe("imap.corp.icloud.com");
  });

  it("returns to the derived host after switching away from the provider domain", async () => {
    await openFormWithAccounts();
    await act(async () => inputValue(field("mail-email"), "person@icloud.com"));
    expect(field("mail-hostname").value).toBe("imap.mail.me.com");

    await act(async () => inputValue(field("mail-email"), "misha@studio.example"));

    expect(field("mail-hostname").value).toBe("imap.studio.example");
    expect(field("mail-username").value).toBe("misha@studio.example");
    expect(field("mail-port").value).toBe("993");
  });

  it("keeps an explicitly entered server, port, and security for the provider domain", async () => {
    await openFormWithAccounts();
    await act(async () => {
      inputValue(field("mail-hostname"), "imap.internal.example");
      inputValue(field("mail-port"), "1993");
    });
    await act(async () => securityOption("starttls").click());
    await act(async () => inputValue(field("mail-email"), "person@icloud.com"));

    expect(field("mail-hostname").value).toBe("imap.internal.example");
    expect(field("mail-port").value).toBe("1993");
    expect(securityChecked("starttls")).toBe(true);
  });

  it("keeps a security-only override when the provider address is entered after it", async () => {
    // Security must survive on its own. Selecting STARTTLS sets no port flag,
    // so the provider pair would otherwise silently restore implicit TLS.
    await openFormWithAccounts();
    await act(async () => securityOption("starttls").click());
    expect(field("mail-port").value).toBe("143");

    await act(async () => inputValue(field("mail-email"), "person@icloud.com"));

    expect(securityChecked("starttls")).toBe(true);
    expect(field("mail-port").value).toBe("143");
    expect(field("mail-hostname").value).toBe("imap.mail.me.com");
  });

  it("keeps a port-only override while still applying the provider security", async () => {
    await openFormWithAccounts();
    await act(async () => inputValue(field("mail-port"), "1993"));
    await act(async () => inputValue(field("mail-email"), "person@icloud.com"));

    expect(field("mail-port").value).toBe("1993");
    expect(securityChecked("implicit")).toBe(true);
    expect(field("mail-hostname").value).toBe("imap.mail.me.com");
  });

  it("submits the explicitly entered host unchanged for the provider domain", async () => {
    const created = imapAccount();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accounts()))
      .mockResolvedValueOnce(response(result(created)));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await openOtherEmail();

    await act(async () => inputValue(field("mail-hostname"), "imap.internal.example"));
    await act(async () => {
      inputValue(field("mail-email"), "person@icloud.com");
      inputValue(field("mail-password"), "password");
    });
    await act(async () => {
      (host.querySelector('form[autocomplete="off"]') as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    const body: unknown = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(body).toMatchObject({
      emailAddress: "person@icloud.com",
      imap: { hostname: "imap.internal.example", port: 993 },
      // the outgoing server is the provider's own; an incoming override
      // says nothing about it
      smtp: { hostname: "smtp.mail.me.com", port: 587, tls: "starttls" },
    });
  });

  it("starts receive-only until the address is complete, then offers the provider's outgoing server", async () => {
    await openFormWithAccounts();
    expect(document.body.textContent).toContain("Outgoing (SMTP)");
    expect(document.body.textContent).toContain(
      "Needed to reply and send. Uses the same password as incoming.",
    );
    expect(sendSwitchIs("off")).toBe(true);
    expect(document.body.textContent).toContain("Turn on to reply and send from Brain");
    expect(document.getElementById("mail-smtp-hostname")).toBeNull();

    await act(async () => inputValue(field("mail-email"), "person@icloud.com"));

    expect(sendSwitchIs("on")).toBe(true);
    expect(document.body.textContent).not.toContain("Turn on to reply and send from Brain");
    expect(field("mail-smtp-hostname").value).toBe("smtp.mail.me.com");
    expect(field("mail-smtp-username").value).toBe("person@icloud.com");
    expect(field("mail-smtp-port").value).toBe("587");
    expect(outgoingSecurityOption("starttls").getAttribute("aria-checked")).toBe("true");
    // every outgoing input is a Field atom too
    for (const id of ["mail-smtp-hostname", "mail-smtp-username", "mail-smtp-port"]) {
      expect(field(id).closest("label.field")).not.toBeNull();
    }
  });

  it.each([
    ["person@gmail.com", "imap.gmail.com", "smtp.gmail.com", "465", "implicit"],
    ["person@fastmail.com", "imap.fastmail.com", "smtp.fastmail.com", "465", "implicit"],
    ["misha@studio.example", "imap.studio.example", "smtp.studio.example", "465", "implicit"],
  ] as const)(
    "fills both servers for %s",
    async (address, imapHost, smtpHost, smtpPort, smtpTls) => {
      await openFormWithAccounts();
      await act(async () => inputValue(field("mail-email"), address));

      expect(field("mail-hostname").value).toBe(imapHost);
      expect(field("mail-smtp-hostname").value).toBe(smtpHost);
      expect(field("mail-smtp-port").value).toBe(smtpPort);
      expect(field("mail-smtp-username").value).toBe(address);
      expect(outgoingSecurityOption(smtpTls).getAttribute("aria-checked")).toBe("true");
    },
  );

  it("returns the outgoing server to the derived pair after leaving the provider domain", async () => {
    await openFormWithAccounts();
    await act(async () => inputValue(field("mail-email"), "person@icloud.com"));
    expect(field("mail-smtp-port").value).toBe("587");

    await act(async () => inputValue(field("mail-email"), "misha@studio.example"));

    expect(field("mail-smtp-hostname").value).toBe("smtp.studio.example");
    expect(field("mail-smtp-port").value).toBe("465");
    expect(outgoingSecurityOption("implicit").getAttribute("aria-checked")).toBe("true");
  });

  it("pairs outgoing security with its port unless the port was entered by hand", async () => {
    await openFormWithAccounts();
    await act(async () => inputValue(field("mail-email"), "misha@studio.example"));
    await act(async () => outgoingSecurityOption("starttls").click());
    expect(field("mail-smtp-port").value).toBe("587");
    await act(async () => outgoingSecurityOption("implicit").click());
    expect(field("mail-smtp-port").value).toBe("465");
    // the incoming pair is untouched by the outgoing choice
    expect(field("mail-port").value).toBe("993");
    expect(securityChecked("implicit")).toBe(true);

    await act(async () => inputValue(field("mail-smtp-port"), "2525"));
    await act(async () => outgoingSecurityOption("starttls").click());
    expect(field("mail-smtp-port").value).toBe("2525");
  });

  it("follows the incoming username until the outgoing one is edited by hand", async () => {
    await openFormWithAccounts();
    await act(async () => inputValue(field("mail-email"), "misha@studio.example"));
    await act(async () => inputValue(field("mail-username"), "misha"));
    expect(field("mail-smtp-username").value).toBe("misha");

    await act(async () => inputValue(field("mail-smtp-username"), "misha-out"));
    await act(async () => inputValue(field("mail-username"), "misha-in"));
    expect(field("mail-smtp-username").value).toBe("misha-out");
  });

  it("connects receive-only when the switch is turned off", async () => {
    const created = imapAccount();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accounts()))
      .mockResolvedValueOnce(response(result(created)));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await openOtherEmail();
    await act(async () => {
      inputValue(field("mail-email"), created.emailAddress);
      inputValue(field("mail-password"), "password");
    });
    await act(async () => sendSwitch("off").click());
    expect(document.body.textContent).toContain("Turn on to reply and send from Brain");
    expect(document.getElementById("mail-smtp-hostname")).toBeNull();
    await act(async () => submitForm(host));
    await settle();

    const body: unknown = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(Object.prototype.hasOwnProperty.call(body, "smtp")).toBe(false);
    expect(onToast).toHaveBeenCalledWith("Mail account connected");
  });

  it("refuses an empty outgoing server while the switch is on", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(accounts()));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await openOtherEmail();
    await act(async () => {
      inputValue(field("mail-email"), "misha@studio.example");
      inputValue(field("mail-password"), "password");
      inputValue(field("mail-smtp-hostname"), "");
    });
    await act(async () => submitForm(host));

    expect(document.getElementById("mail-smtp-hostname-error")?.textContent).toBe(
      "Enter the outgoing (SMTP) server name.",
    );
    expect(document.activeElement).toBe(field("mail-smtp-hostname"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("edits an account with an outgoing server and keeps it without asking for the password", async () => {
    const original = imapAccountWithSmtp();
    const updated = { ...original, displayName: "Work", updatedAt: original.updatedAt + 1 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accounts(original)))
      .mockResolvedValueOnce(response(result(updated)));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await act(async () => button("Personalperson@example.test · IMAP").click());
    await act(async () => button("Edit").click());

    expect(sendSwitchIs("on")).toBe(true);
    expect(field("mail-smtp-hostname").value).toBe("smtp.example.test");
    expect(field("mail-smtp-username").value).toBe("person@example.test");
    expect(field("mail-smtp-port").value).toBe("465");
    await act(async () => inputValue(field("mail-display-name"), "Work"));
    await act(async () => submitForm(host));
    await settle();

    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(request.method).toBe("PATCH");
    expect(JSON.parse(String(request.body))).toEqual({
      emailAddress: "person@example.test",
      displayName: "Work",
      imap: {
        hostname: "imap.example.test",
        port: 993,
        tls: "implicit",
        username: "person@example.test",
        password: null,
      },
      smtp: {
        hostname: "smtp.example.test",
        port: 465,
        tls: "implicit",
        username: "person@example.test",
      },
    });
    expect(onToast).toHaveBeenCalledWith("Mail settings saved");
  });

  it("turns the outgoing server off on edit as smtp: null, with no password", async () => {
    const original = imapAccountWithSmtp();
    const updated = { ...imapAccount(), updatedAt: original.updatedAt + 1 };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accounts(original)))
      .mockResolvedValueOnce(response(result(updated)));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await act(async () => button("Personalperson@example.test · IMAP").click());
    await act(async () => button("Edit").click());
    await act(async () => sendSwitch("off").click());
    expect(document.getElementById("mail-smtp-hostname")).toBeNull();
    await act(async () => submitForm(host));
    await settle();

    const body = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(body.smtp).toBeNull();
    expect(body.imap.password).toBeNull();
    expect(onToast).toHaveBeenCalledWith("Mail settings saved");
  });

  it("requires the password again to add an outgoing server to an account", async () => {
    const original = imapAccount();
    const updated = imapAccountWithSmtp();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accounts(original)))
      .mockResolvedValueOnce(response(result(updated)));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await act(async () => button("Personalperson@example.test · IMAP").click());
    await act(async () => button("Edit").click());
    expect(sendSwitchIs("off")).toBe(true);

    await act(async () => sendSwitch("on").click());
    // the guess for the account's own domain, ready to be reviewed
    expect(field("mail-smtp-hostname").value).toBe("smtp.example.test");
    expect(field("mail-smtp-username").value).toBe("person@example.test");
    expect(document.getElementById("mail-password-hint")?.textContent).toBe(
      "Re-enter the password to add or change the outgoing server.",
    );
    await act(async () => submitForm(host));
    expect(document.getElementById("mail-password-error")?.textContent).toBe(
      "Re-enter the password to add or change the outgoing server.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => inputValue(field("mail-password"), "app password"));
    await act(async () => submitForm(host));
    await settle();

    const body = JSON.parse(String(fetchMock.mock.calls[1][1].body));
    expect(body.imap.password).toBe("app password");
    expect(body.smtp).toEqual({
      hostname: "smtp.example.test",
      port: 465,
      tls: "implicit",
      username: "person@example.test",
    });
    expect(onToast).toHaveBeenCalledWith("Mail settings saved");
  });

  it("requires the password again after the outgoing server changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(accounts(imapAccountWithSmtp())));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await act(async () => button("Personalperson@example.test · IMAP").click());
    await act(async () => button("Edit").click());
    await act(async () => inputValue(field("mail-smtp-hostname"), "smtp.changed.example.test"));
    await act(async () => submitForm(host));

    expect(document.getElementById("mail-password-error")?.textContent).toBe(
      "Re-enter the password to add or change the outgoing server.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("submits the provider autoconfig endpoint when defaults are unchanged", async () => {
    const created = imapAccount();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accounts()))
      .mockResolvedValueOnce(response(result(created)));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await openOtherEmail();

    await act(async () => {
      inputValue(field("mail-email"), "person@icloud.com");
      inputValue(field("mail-password"), "password");
    });
    await act(async () => {
      (host.querySelector('form[autocomplete="off"]') as HTMLFormElement).dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    await settle();

    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toMatchObject({
      imap: {
        hostname: "imap.mail.me.com",
        port: 993,
        tls: "implicit",
        username: "person@icloud.com",
      },
    });
  });

  it("renders an account carrying an outgoing server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(accounts(imapAccountWithSmtp()))),
    );
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();

    expect(document.body.textContent).not.toContain("Mail setup is unavailable");
    expect(document.body.textContent).toContain("person@example.test");
  });

  it.each([
    ["a port outside the range", { hostname: "smtp.example.test", port: 0, tls: "implicit", username: "a@b.test" }],
    ["an unknown security mode", { hostname: "smtp.example.test", port: 465, tls: "ssl", username: "a@b.test" }],
    ["an empty server name", { hostname: "", port: 465, tls: "implicit", username: "a@b.test" }],
    ["an extra field", { hostname: "smtp.example.test", port: 465, tls: "implicit", username: "a@b.test", password: "x" }],
  ])("fails closed on an outgoing server with %s", async (_label, smtp) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(accounts({ ...imapAccount(), smtp }))),
    );
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();

    expect(document.body.textContent).toContain("Mail setup is unavailable right now.");
    expect(document.body.textContent).not.toContain("person@example.test");
  });

  const SEND_UNAVAILABLE =
    "Outgoing server is saved, but sending is unavailable on this Brain right now.";
  const capabilities = (send: boolean) => ({
    mailboxes: ["inbox"],
    listThreads: true,
    sync: true,
    headerPreview: true,
    messageBodies: true,
    threadMutations: true,
    compose: send,
    send,
    reply: send,
  });
  const accountsWithCapabilities = (...items: Array<Record<string, unknown> & { providerKind: string }>) => ({
    apiVersion: 3,
    accounts: items.map((item) => ({
      ...item,
      capabilities: capabilities(item.providerKind === "gmail" || "smtp" in item),
    })),
  });

  it("reads the account list from the capabilities route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(accountsWithCapabilities(imapAccount())));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();

    expect(fetchMock.mock.calls[0][0]).toBe("/api/mail/accounts/capabilities");
    expect(document.body.textContent).toContain("person@example.test");
  });

  it("shows the outgoing server on the card and removes it as smtp: null after confirmation", async () => {
    const withSmtp = imapAccountWithSmtp();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accountsWithCapabilities(withSmtp)))
      .mockResolvedValueOnce(response(result(imapAccount())));
    vi.stubGlobal("fetch", fetchMock);
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await act(async () => button("Personalperson@example.test · IMAP").click());

    expect(document.body.textContent).toContain("imap.example.test:993 · TLS");
    expect(document.body.textContent).toContain("smtp.example.test:465 · TLS");
    expect(document.body.textContent).not.toContain("Receive only");
    expect(document.body.textContent).not.toContain("Add outgoing server");
    expect(document.body.querySelector('[role="status"]')).toBeNull();
    await act(async () => button("Remove outgoing server").click());
    expect(document.body.textContent).toContain(
      "Brain will stop sending from this account. Incoming mail keeps syncing.",
    );
    await act(async () => button("Stop sending").click());
    await settle();

    expect(fetchMock.mock.calls[1][0]).toBe(`/api/mail/accounts/${withSmtp.accountId}`);
    const request = fetchMock.mock.calls[1][1] as RequestInit;
    expect(request.method).toBe("PATCH");
    expect(JSON.parse(String(request.body))).toEqual({ smtp: null });
    expect(document.body.textContent).toContain("Receive only");
    expect(document.body.textContent).toContain("Add outgoing server");
    expect(document.body.textContent).not.toContain("Remove outgoing server");
    expect(onToast).toHaveBeenCalledWith("Outgoing server removed");
  });

  it("opens the form on the outgoing server from a receive-only card", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(accountsWithCapabilities(imapAccount()))));
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await act(async () => button("Personalperson@example.test · IMAP").click());

    expect(document.body.textContent).toContain("Receive only");
    expect(document.body.textContent).not.toContain("Remove outgoing server");
    await act(async () => button("Add outgoing server").click());

    expect(sendSwitchIs("on")).toBe(true);
    expect(field("mail-smtp-hostname").value).toBe("smtp.example.test");
    expect(document.activeElement).toBe(field("mail-smtp-hostname"));
    // the account is being edited, so the same password rule applies
    expect(document.getElementById("mail-password-hint")?.textContent).toBe(
      "Re-enter the password to add or change the outgoing server.",
    );
  });

  it("says when a saved outgoing server cannot send on this Brain", async () => {
    const withSmtp = imapAccountWithSmtp();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          apiVersion: 3,
          accounts: [{ ...withSmtp, capabilities: capabilities(false) }],
        }),
      ),
    );
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await act(async () => button("Personalperson@example.test · IMAP").click());

    const status = document.body.querySelector('[role="status"]');
    expect(status?.textContent).toBe(SEND_UNAVAILABLE);
    expect(document.body.textContent).toContain("smtp.example.test:465 · TLS");
    expect(button("Remove outgoing server")).not.toBeNull();
  });

  it("keeps the Google card free of the outgoing line", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(accountsWithCapabilities(gmailAccount()))),
    );
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();
    await act(async () => button("person@gmail.testGoogleReconnect needed").click());

    expect(document.body.textContent).not.toContain("Receive only");
    expect(document.body.textContent).not.toContain("outgoing server");
    expect(document.body.textContent).not.toContain(SEND_UNAVAILABLE);
  });

  it("still derives imap.<domain> for a domain with no provider entry", async () => {
    await openFormWithAccounts();
    await act(async () => inputValue(field("mail-email"), "misha@studio.example"));

    expect(field("mail-hostname").value).toBe("imap.studio.example");
  });
});
