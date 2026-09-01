// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailAccountSettings } from "./mail-account-settings";

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

/** Security is the shared Segmented control — a radiogroup of role=radio
 *  buttons, not native radio inputs. */
function securityOption(value: "implicit" | "starttls"): HTMLButtonElement {
  const group = document.querySelector(
    '[role="radiogroup"][aria-label="Security"]',
  );
  const label = value === "implicit" ? "TLS" : "STARTTLS";
  const match = [...(group?.querySelectorAll('[role="radio"]') ?? [])].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!(match instanceof HTMLButtonElement)) {
    throw new Error(`Missing security option: ${label}`);
  }
  return match;
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

  it("replaces the add action with a clear account-limit state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response(
          accounts(
            imapAccount(
              "account-a11111111111111111111111111111111",
              "one@example.test",
            ),
            imapAccount(
              "account-a22222222222222222222222222222222",
              "two@example.test",
            ),
            imapAccount(
              "account-a33333333333333333333333333333333",
              "three@example.test",
            ),
          ),
        ),
      ),
    );
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();

    expect(document.body.textContent).toContain("3 account limit");
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
    expect(JSON.parse(String(request.body))).toEqual({
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
    });
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
    ["smtp_authentication_failed", "The outgoing server rejected the username or password."],
    ["smtp_dns_failed", "We couldn't find this outgoing (SMTP) server."],
    ["smtp_tls_failed", "The secure connection to the outgoing server failed."],
    ["smtp_connection_failed", "We couldn't reach the outgoing (SMTP) server."],
    ["smtp_connection_timeout", "The outgoing (SMTP) server didn't respond."],
  ])("explains %s as the server's answer, not an outage", async (code, sentence) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(accounts()))
      .mockResolvedValueOnce(
        response({ apiVersion: 2, error: { code } }, code.endsWith("timeout") ? 408 : 422),
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
    });
    // The form has no SMTP field, so connect must not post an endpoint the
    // operator could never review or override.
    expect(Object.prototype.hasOwnProperty.call(body, "smtp")).toBe(false);
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

  it("fails closed on an account carrying SMTP, pinning the unbuilt send surface", async () => {
    // Known gap, not desired behaviour. parsePublicAccount accepts an exact
    // field set with no "smtp", so the moment any account stores an SMTP
    // endpoint the whole list stops rendering. Whoever adds the SMTP review
    // field must widen the parser and delete this test.
    const withSmtp = {
      ...imapAccount(),
      smtp: { hostname: "smtp.example.test", port: 465, tls: "implicit", username: "a@b.test" },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(accounts(withSmtp))));
    await act(async () =>
      root.render(<MailAccountSettings onOpenMail={onOpenMail} onToast={onToast} />),
    );
    await settle();

    expect(document.body.textContent).toContain("Mail setup is unavailable right now.");
    expect(document.body.textContent).not.toContain("imap.example.test");
  });

  it("still derives imap.<domain> for a domain with no provider entry", async () => {
    await openFormWithAccounts();
    await act(async () => inputValue(field("mail-email"), "misha@studio.example"));

    expect(field("mail-hostname").value).toBe("imap.studio.example");
  });
});
