"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import { fade } from "@/lib/motion";
import { MailSettingsSkeleton } from "./mail-settings-skeleton";
import { SettingsGroup, SettingsRow, Segmented } from "./settings/shared";
import { Button } from "./ui/button";
import { ConfirmDialog } from "./ui/confirm-dialog";
import { Field } from "./ui/field";
import { Icon } from "./ui/icon";

type MailTlsMode = "implicit" | "starttls";
type MailAccountStatus = "connected" | "reauth_required";

type PublicMailAccountBase = {
  readonly accountId: string;
  readonly emailAddress: string;
  readonly displayName: string | null;
  readonly status: MailAccountStatus;
  readonly connectedAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** What the service will do for this account right now, from the
   *  capabilities list. Only `send` is read here: an outgoing server can be
   *  saved while the worker behind it is down, and the card has to say so.
   *  Null after a mutation, whose answer carries no capabilities; the next
   *  load of the list fills it in again. */
  readonly capabilities: { readonly send: boolean } | null;
};

/** One server of an IMAP account, incoming or outgoing. The outgoing one
 *  carries no password of its own: the service signs in to both with the
 *  mailbox password, which is why the form never asks for a second one. */
type MailEndpoint = {
  readonly hostname: string;
  readonly port: number;
  readonly tls: MailTlsMode;
  readonly username: string;
};

type PublicMailAccount =
  | (PublicMailAccountBase & {
      readonly providerKind: "imap";
      readonly imap: MailEndpoint;
      /** Missing means receive only, the shape every account had before
       *  the form could configure an outgoing server. */
      readonly smtp?: MailEndpoint;
    })
  | (PublicMailAccountBase & { readonly providerKind: "gmail" });

type LoadState = "loading" | "ready" | "error";
type View = "list" | "providers" | "details" | "imap-form";
type FormField =
  | "email"
  | "hostname"
  | "username"
  | "password"
  | "port"
  | "smtpHostname"
  | "smtpUsername"
  | "smtpPort";
type FieldErrors = Partial<Record<FormField, string>>;
/** How the "Send from this account" switch was decided. A new connect starts
 *  in `auto`: on as soon as the address names a domain (every domain has an
 *  outgoing guess), off with a hint before that. A press makes it explicit,
 *  and an edit starts explicit at whatever the account has saved. */
type SmtpChoice = "auto" | "on" | "off";

/**
 * Mirror of `MAIL_RESOURCE_LIMITS.maxAccounts`. That module reaches node:crypto
 * and node:net, which cannot enter a browser bundle, and this manager is loaded
 * on its own chunk with no dependency on the mail API client, so the number is
 * repeated here. `mirrors the account cap the mail service enforces` fails the
 * build if the two ever differ. Every count the reader sees is written from it,
 * so the copy stays true at whatever the cap becomes.
 */
export const MAX_MAIL_ACCOUNTS = 7;

const ACCOUNT_LIMIT_BADGE = `${MAX_MAIL_ACCOUNTS} account limit`;
const ACCOUNT_LIMIT_COPY = `Brain supports up to ${MAX_MAIL_ACCOUNTS} mail accounts.`;
const NAVROW_CLASS =
  "brain-settings-row brain-settings-rootrow brain-settings-navrow brain-touch-min focus-inset";
const FORM_FIELD_ORDER: FormField[] = [
  "email",
  "hostname",
  "username",
  "password",
  "port",
  "smtpHostname",
  "smtpUsername",
  "smtpPort",
];
const FIELD_IDS: Record<FormField, string> = {
  email: "mail-email",
  hostname: "mail-hostname",
  username: "mail-username",
  password: "mail-password",
  port: "mail-port",
  smtpHostname: "mail-smtp-hostname",
  smtpUsername: "mail-smtp-username",
  smtpPort: "mail-smtp-port",
};
const REENTER_PASSWORD_COPY =
  "Re-enter the password after changing the server, security, port, or username.";
/** Adding or redirecting the outgoing server re-verifies the one credential
 *  the account has, so the service asks for it again, the way it does for
 *  the incoming server (mirrors `sameConnectionIdentity` in the service). */
const REENTER_PASSWORD_SMTP_COPY =
  "Re-enter the password to add or change the outgoing server.";
const SEND_SWITCH_LABEL = "Send from this account";
const SEND_SWITCH_OFF_HINT = "Turn on to reply and send from Brain";
// Last parsed account list. A revisit of the Mail tab renders it at once and
// revalidates in the background instead of flashing the skeleton again.
let lastLoadedAccounts: PublicMailAccount[] | null = null;

export function MailAccountSettings({
  onOpenMail,
  onAccountStatusChange,
  onToast,
  initialAccountId,
}: {
  onOpenMail: () => void;
  onAccountStatusChange?: (configured: boolean) => void;
  onToast: (title: string) => void;
  /** Deep link (/settings/mail?account=<id>): open this account's details
   *  once the account list resolves. */
  initialAccountId?: string | null;
}) {
  const [seededFromCache] = useState(() => lastLoadedAccounts !== null);
  const [loadState, setLoadState] = useState<LoadState>(
    seededFromCache ? "ready" : "loading",
  );
  const [accounts, setAccounts] = useState<PublicMailAccount[]>(
    () => lastLoadedAccounts ?? [],
  );
  const reduce = useReducedMotion();
  const readyMotion = reduce ? {} : fade;
  const [view, setView] = useState<View>("list");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [hostname, setHostname] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [tls, setTls] = useState<MailTlsMode>("implicit");
  const [port, setPort] = useState("993");
  const [smtpChoice, setSmtpChoice] = useState<SmtpChoice>("auto");
  const [smtpHostname, setSmtpHostname] = useState("");
  const [smtpUsername, setSmtpUsername] = useState("");
  const [smtpTls, setSmtpTls] = useState<MailTlsMode>("implicit");
  const [smtpPort, setSmtpPort] = useState("465");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [requestError, setRequestError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removingSmtp, setRemovingSmtp] = useState(false);
  const [confirmRemoveSmtp, setConfirmRemoveSmtp] = useState(false);
  // "Add outgoing server" opens the form on the SMTP server field. The field
  // exists only once the form has rendered with the switch on, so the focus
  // waits for that commit instead of racing it.
  const pendingSmtpFocusRef = useRef(false);
  const manuallyEdited = useRef({
    hostname: false,
    username: false,
    port: false,
    tls: false,
    smtpHostname: false,
    smtpUsername: false,
    smtpPort: false,
    smtpTls: false,
  });
  const advancedRef = useRef<HTMLDetailsElement | null>(null);
  const smtpAdvancedRef = useRef<HTMLDetailsElement | null>(null);
  const pendingInitialAccountRef = useRef<string | null>(
    initialAccountId ?? null,
  );
  const mountedRef = useRef(false);
  const mutationControllerRef = useRef<AbortController | null>(null);
  const mutationSequenceRef = useRef(0);

  const selectedAccount =
    selectedId === null
      ? null
      : (accounts.find((account) => account.accountId === selectedId) ?? null);
  const editingAccount =
    view === "imap-form" && selectedAccount?.providerKind === "imap"
      ? selectedAccount
      : null;
  const smtpEnabled =
    smtpChoice === "auto" ? smtpDefaultsForEmail(email) !== null : smtpChoice === "on";
  const imapIdentityChanged =
    editingAccount !== null &&
    (hostname.trim() !== editingAccount.imap.hostname ||
      Number(port) !== editingAccount.imap.port ||
      tls !== editingAccount.imap.tls ||
      username !== editingAccount.imap.username);
  // Turning the outgoing server off never needs the password: removal
  // discloses nothing. Adding one, or pointing it elsewhere, does.
  const smtpIdentityChanged =
    editingAccount !== null &&
    smtpEnabled &&
    (editingAccount.smtp === undefined ||
      smtpHostname.trim() !== editingAccount.smtp.hostname ||
      Number(smtpPort) !== editingAccount.smtp.port ||
      smtpTls !== editingAccount.smtp.tls ||
      smtpUsername !== editingAccount.smtp.username);
  const connectionIdentityChanged = imapIdentityChanged || smtpIdentityChanged;
  const reenterPasswordCopy = imapIdentityChanged
    ? REENTER_PASSWORD_COPY
    : REENTER_PASSWORD_SMTP_COPY;

  const resetForm = useCallback((account: PublicMailAccount | null) => {
    setFieldErrors({});
    setRequestError(null);
    setPassword("");
    if (account?.providerKind === "imap") {
      setDisplayName(account.displayName ?? "");
      setEmail(account.emailAddress);
      setHostname(account.imap.hostname);
      setUsername(account.imap.username);
      setTls(account.imap.tls);
      setPort(String(account.imap.port));
      // A receive-only account still gets the guess for its own domain, so
      // turning the switch on offers a filled group to review, not a blank.
      const smtp = account.smtp ?? {
        ...(smtpDefaultsForEmail(account.emailAddress) ?? {
          hostname: "",
          port: 465,
          tls: "implicit" as const,
        }),
        username: account.imap.username,
      };
      setSmtpChoice(account.smtp ? "on" : "off");
      setSmtpHostname(smtp.hostname);
      setSmtpUsername(smtp.username);
      setSmtpTls(smtp.tls);
      setSmtpPort(String(smtp.port));
      manuallyEdited.current = {
        hostname: true,
        username: true,
        port: true,
        tls: true,
        smtpHostname: account.smtp !== undefined,
        smtpUsername: account.smtp !== undefined,
        smtpPort: account.smtp !== undefined,
        smtpTls: account.smtp !== undefined,
      };
      return;
    }
    setDisplayName("");
    setEmail("");
    setHostname("");
    setUsername("");
    setTls("implicit");
    setPort("993");
    setSmtpChoice("auto");
    setSmtpHostname("");
    setSmtpUsername("");
    setSmtpTls("implicit");
    setSmtpPort("465");
    manuallyEdited.current = {
      hostname: false,
      username: false,
      port: false,
      tls: false,
      smtpHostname: false,
      smtpUsername: false,
      smtpPort: false,
      smtpTls: false,
    };
  }, []);

  useEffect(() => {
    if (loadState === "ready") lastLoadedAccounts = accounts;
  }, [accounts, loadState]);

  useEffect(() => {
    if (view !== "imap-form" || !pendingSmtpFocusRef.current) return;
    pendingSmtpFocusRef.current = false;
    document.getElementById(FIELD_IDS.smtpHostname)?.focus();
  }, [view]);

  const load = useCallback(async (signal?: AbortSignal, silent = false) => {
    if (!silent) setLoadState("loading");
    setRequestError(null);
    try {
      // The capabilities list, not the plain one: it is the same accounts
      // with what the service can do for each, and the card needs `send`.
      const response = await fetch("/api/mail/accounts/capabilities", {
        cache: "no-store",
        signal,
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readErrorCode(payload));
      const nextAccounts = parseAccounts(payload);
      if (signal?.aborted || !mountedRef.current) return;
      setAccounts(nextAccounts);
      onAccountStatusChange?.(nextAccounts.length > 0);
      // a deep-linked account opens its details once; anything else lands
      // on the list as before
      const pending = pendingInitialAccountRef.current;
      pendingInitialAccountRef.current = null;
      const target = pending
        ? nextAccounts.find((account) => account.accountId === pending)
        : undefined;
      if (target) {
        setSelectedId(target.accountId);
        setView("details");
      } else {
        setView("list");
        setSelectedId(null);
      }
      setLoadState("ready");
    } catch (error) {
      if (signal?.aborted) return;
      setRequestError(messageForError(error));
      setLoadState("error");
    }
  }, [onAccountStatusChange]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      mutationSequenceRef.current += 1;
      mutationControllerRef.current?.abort();
      mutationControllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted)
        void load(controller.signal, seededFromCache);
    });
    return () => controller.abort();
  }, [load, seededFromCache]);

  const changeEmail = (value: string) => {
    setEmail(value);
    clearFieldError("email");
    const suggestedHostname = imapHostForEmail(value);
    // The outgoing username follows the incoming one, which follows the
    // address; each link holds until its own field is edited by hand.
    const suggestedUsername = manuallyEdited.current.username
      ? username
      : suggestedHostname
        ? value.trim()
        : "";
    if (!manuallyEdited.current.username) {
      setUsername(suggestedUsername);
      clearFieldError("username");
    }
    if (!manuallyEdited.current.smtpUsername) {
      setSmtpUsername(suggestedUsername);
      clearFieldError("smtpUsername");
    }
    if (!manuallyEdited.current.hostname) {
      setHostname(suggestedHostname);
      clearFieldError("hostname");
    }
    // A provider pins security and port as one pair, so an explicit security
    // choice opts out of both and keeps the port changeTls already matched to
    // it. An explicit port alone still survives the provider's security.
    const provider = mailProviderDefaultsForEmail(value);
    if (provider && !manuallyEdited.current.tls) {
      setTls(provider.imapTls);
      if (!manuallyEdited.current.port) {
        setPort(String(provider.imapPort));
        clearFieldError("port");
      }
    }
    // The outgoing pair is derived for every domain, not only a provider's,
    // so leaving iCloud's 587/STARTTLS for an unknown domain lands back on
    // the 465/TLS the derived guess stands for.
    const smtpDefaults = smtpDefaultsForEmail(value);
    if (!manuallyEdited.current.smtpHostname) {
      setSmtpHostname(smtpDefaults?.hostname ?? "");
      clearFieldError("smtpHostname");
    }
    if (smtpDefaults && !manuallyEdited.current.smtpTls) {
      setSmtpTls(smtpDefaults.tls);
      if (!manuallyEdited.current.smtpPort) {
        setSmtpPort(String(smtpDefaults.port));
        clearFieldError("smtpPort");
      }
    }
  };

  const changeUsername = (value: string) => {
    manuallyEdited.current.username = true;
    setUsername(value);
    clearFieldError("username");
    if (!manuallyEdited.current.smtpUsername) {
      setSmtpUsername(value);
      clearFieldError("smtpUsername");
    }
  };

  const changeTls = (value: MailTlsMode) => {
    manuallyEdited.current.tls = true;
    setTls(value);
    if (!manuallyEdited.current.port) {
      setPort(value === "implicit" ? "993" : "143");
      clearFieldError("port");
    }
  };

  const changeSmtpTls = (value: MailTlsMode) => {
    manuallyEdited.current.smtpTls = true;
    setSmtpTls(value);
    if (!manuallyEdited.current.smtpPort) {
      setSmtpPort(value === "implicit" ? "465" : "587");
      clearFieldError("smtpPort");
    }
  };

  const clearFieldError = (field: FormField) => {
    setFieldErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const validate = (): FieldErrors => {
    const next: FieldErrors = {};
    const normalizedEmail = email.trim();
    const normalizedHostname = hostname.trim();
    const normalizedPort = Number(port);
    if (!/^[^@\s]+@[^@\s.]+(?:\.[^@\s.]+)+$/.test(normalizedEmail)) {
      next.email = "Enter a complete email address.";
    }
    if (!normalizedHostname || /[\s/]/.test(normalizedHostname)) {
      next.hostname = "Enter the IMAP server name.";
    }
    if (!username || /[\r\n\u0000]/.test(username)) {
      next.username = "Enter the username for this mailbox.";
    }
    if (!password) {
      if (!editingAccount) next.password = "Enter the password or app password.";
      else if (connectionIdentityChanged) next.password = reenterPasswordCopy;
    }
    if (!isValidPort(normalizedPort)) {
      next.port = "Enter a port from 1 to 65535.";
    }
    if (smtpEnabled) {
      const normalizedSmtpHostname = smtpHostname.trim();
      if (!normalizedSmtpHostname || /[\s/]/.test(normalizedSmtpHostname)) {
        next.smtpHostname = "Enter the outgoing (SMTP) server name.";
      }
      if (!smtpUsername || /[\r\n ]/.test(smtpUsername)) {
        next.smtpUsername = "Enter the username for the outgoing server.";
      }
      if (!isValidPort(Number(smtpPort))) {
        next.smtpPort = "Enter a port from 1 to 65535.";
      }
    }
    return next;
  };

  const validateOne = (field: FormField) => {
    const next = validate();
    setFieldErrors((current) => {
      const copy = { ...current };
      if (next[field]) copy[field] = next[field];
      else delete copy[field];
      return copy;
    });
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const nextErrors = validate();
    setFieldErrors(nextErrors);
    const firstError = FORM_FIELD_ORDER.find((field) => nextErrors[field]);
    if (firstError) {
      if (firstError === "port" && advancedRef.current) {
        advancedRef.current.open = true;
      }
      if (firstError === "smtpPort" && smtpAdvancedRef.current) {
        smtpAdvancedRef.current.open = true;
      }
      window.requestAnimationFrame(() => {
        document.getElementById(FIELD_IDS[firstError])?.focus();
      });
      return;
    }

    setSubmitting(true);
    setRequestError(null);
    const editing = editingAccount !== null;
    // The outgoing server carries no password of its own: the service signs
    // in to it with the mailbox password it already holds inside `imap`.
    const smtp = smtpEnabled
      ? {
          hostname: smtpHostname.trim(),
          port: Number(smtpPort),
          tls: smtpTls,
          username: smtpUsername,
        }
      : null;
    mutationControllerRef.current?.abort();
    const controller = new AbortController();
    const requestSequence = mutationSequenceRef.current + 1;
    mutationSequenceRef.current = requestSequence;
    mutationControllerRef.current = controller;
    const isCurrentRequest = () =>
      mountedRef.current &&
      !controller.signal.aborted &&
      mutationSequenceRef.current === requestSequence;
    try {
      const response = await fetch(
        editing
          ? `/api/mail/accounts/${encodeURIComponent(editingAccount.accountId)}`
          : "/api/mail/accounts",
        {
          method: editing ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify(
            editing
              ? {
                  emailAddress: email.trim(),
                  displayName: displayName.trim() || null,
                  imap: {
                    hostname: hostname.trim(),
                    port: Number(port),
                    tls,
                    username,
                    password: password || null,
                  },
                  // `smtp: null` is the removal; an account that never had
                  // an outgoing server has nothing to remove and says nothing
                  ...(smtp
                    ? { smtp }
                    : editingAccount.smtp
                      ? { smtp: null }
                      : {}),
                }
              : {
                  providerKind: "imap",
                  emailAddress: email.trim(),
                  displayName: displayName.trim() || null,
                  imap: {
                    hostname: hostname.trim(),
                    port: Number(port),
                    tls,
                    username,
                    password,
                  },
                  ...(smtp ? { smtp } : {}),
                },
          ),
        },
      );
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readErrorCode(payload));
      const nextAccount = parseAccountResult(payload);
      if (!isCurrentRequest()) return;
      setAccounts((current) =>
        editing
          ? current.map((account) =>
              account.accountId === nextAccount.accountId ? nextAccount : account,
            )
          : [...current, nextAccount],
      );
      onAccountStatusChange?.(true);
      resetForm(nextAccount);
      if (editing) {
        setSelectedId(nextAccount.accountId);
        setView("details");
        onToast("Mail settings saved");
      } else {
        onToast("Mail account connected");
        onOpenMail();
      }
    } catch (error) {
      if (!isCurrentRequest()) return;
      setRequestError(messageForError(error));
    } finally {
      if (isCurrentRequest()) {
        mutationControllerRef.current = null;
        setSubmitting(false);
      }
    }
  };

  const removeSelected = async () => {
    if (!selectedAccount || removing) return;
    setRemoving(true);
    setRequestError(null);
    const accountToRemove = selectedAccount;
    mutationControllerRef.current?.abort();
    const controller = new AbortController();
    const requestSequence = mutationSequenceRef.current + 1;
    mutationSequenceRef.current = requestSequence;
    mutationControllerRef.current = controller;
    const isCurrentRequest = () =>
      mountedRef.current &&
      !controller.signal.aborted &&
      mutationSequenceRef.current === requestSequence;
    try {
      const response = await fetch(
        `/api/mail/accounts/${encodeURIComponent(accountToRemove.accountId)}`,
        { method: "DELETE", signal: controller.signal },
      );
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readErrorCode(payload));
      const removed = parseAccountResult(payload);
      if (removed.accountId !== accountToRemove.accountId) {
        throw new Error("mail_service_invalid_response");
      }
      if (!isCurrentRequest()) return;
      const nextAccounts = accounts.filter(
        (account) => account.accountId !== accountToRemove.accountId,
      );
      setAccounts(nextAccounts);
      onAccountStatusChange?.(nextAccounts.length > 0);
      setSelectedId(null);
      setView("list");
      setConfirmRemove(false);
      onToast("Mail account removed");
    } catch (error) {
      if (!isCurrentRequest()) return;
      setRequestError(messageForError(error));
    } finally {
      if (isCurrentRequest()) {
        mutationControllerRef.current = null;
        setRemoving(false);
      }
    }
  };

  const removeOutgoingServer = async () => {
    if (selectedAccount?.providerKind !== "imap" || !selectedAccount.smtp || removingSmtp) {
      return;
    }
    setRemovingSmtp(true);
    setRequestError(null);
    const accountId = selectedAccount.accountId;
    mutationControllerRef.current?.abort();
    const controller = new AbortController();
    const requestSequence = mutationSequenceRef.current + 1;
    mutationSequenceRef.current = requestSequence;
    mutationControllerRef.current = controller;
    const isCurrentRequest = () =>
      mountedRef.current &&
      !controller.signal.aborted &&
      mutationSequenceRef.current === requestSequence;
    try {
      // Removal never needs the password (the service rule: taking the
      // outgoing server away discloses nothing), so the patch is the one key.
      const response = await fetch(`/api/mail/accounts/${encodeURIComponent(accountId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ smtp: null }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(readErrorCode(payload));
      const nextAccount = parseAccountResult(payload);
      if (nextAccount.accountId !== accountId) {
        throw new Error("mail_service_invalid_response");
      }
      if (!isCurrentRequest()) return;
      setAccounts((current) =>
        current.map((account) => (account.accountId === accountId ? nextAccount : account)),
      );
      setConfirmRemoveSmtp(false);
      onToast("Outgoing server removed");
    } catch (error) {
      if (!isCurrentRequest()) return;
      setRequestError(messageForError(error));
    } finally {
      if (isCurrentRequest()) {
        mutationControllerRef.current = null;
        setRemovingSmtp(false);
      }
    }
  };

  if (loadState === "loading") return <MailSettingsSkeleton />;

  if (loadState === "error") {
    return (
      <div role="alert" className="space-y-7">
        <SettingsGroup
          title="Mail accounts"
          description="Gmail, Google Workspace, or any IMAP mailbox."
        >
          {/* the same error row the Connections and Backups groups use */}
          <div className="brain-settings-row">
            <p className="min-w-0 flex-1 text-table text-ink-2">{requestError}</p>
            <Button type="button" variant="quiet" onClick={() => void load()}>
              Try again
            </Button>
          </div>
        </SettingsGroup>
      </div>
    );
  }

  if (view === "providers") {
    return (
      <div className="space-y-7">
        <SectionBack label="Mail accounts" onBack={() => setView("list")} />
        <SettingsGroup title="Add account" description="Choose your mail provider.">
          <form method="post" action="/api/mail/oauth/google/start">
            <ProviderButton
              type="submit"
              icon="letter-linear"
              label="Google"
              description="Gmail and Google Workspace"
            />
          </form>
          <ProviderButton
            type="button"
            icon="inbox-linear"
            label="Other email"
            description="Connect with IMAP"
            onClick={() => {
              setSelectedId(null);
              resetForm(null);
              setView("imap-form");
            }}
          />
        </SettingsGroup>
      </div>
    );
  }

  if (view === "details" && selectedAccount) {
    const accountLabel = selectedAccount.displayName || selectedAccount.emailAddress;
    const connectionLabel =
      selectedAccount.providerKind === "gmail"
        ? "Google"
        : endpointLabel(selectedAccount.imap);
    // The outgoing half of an IMAP account, on its own caption line: the
    // server it sends through, or the plain fact that it does not send.
    // Google sends through Google and has no such line.
    const outgoing = selectedAccount.providerKind === "imap" ? selectedAccount.smtp : undefined;
    const outgoingLabel =
      selectedAccount.providerKind === "imap"
        ? outgoing
          ? endpointLabel(outgoing)
          : "Receive only"
        : null;
    const sendUnavailable =
      outgoing !== undefined && selectedAccount.capabilities?.send === false;
    return (
      <div className="space-y-7">
        <SectionBack label="Mail accounts" onBack={() => setView("list")} />
        <SettingsGroup>
          <div className="brain-settings-row" data-lead="">
            <span className="brain-settings-tile" aria-hidden="true">
              <Icon name="letter-linear" size={16} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-table font-semibold text-ink">{accountLabel}</p>
              <p className="truncate text-caption text-ink-3">
                {selectedAccount.displayName
                  ? `${selectedAccount.emailAddress} · ${connectionLabel}`
                  : connectionLabel}
              </p>
              {outgoingLabel && (
                <p className="truncate text-caption text-ink-3">{outgoingLabel}</p>
              )}
            </div>
          </div>
          {sendUnavailable && (
            <div className="brain-settings-row">
              {/* the server is saved and verified; what is missing is the
                  worker on this Brain, which the owner repairs on the host,
                  not in this form, so the row offers no control */}
              <p role="status" className="min-w-0 flex-1 text-table text-ink-2">
                Outgoing server is saved, but sending is unavailable on this Brain right now.
              </p>
            </div>
          )}
          {selectedAccount.status === "reauth_required" && (
            <div className="brain-settings-row">
              {/* only a Google account is repaired through OAuth; an IMAP
                  one is repaired by editing it, so it must not be told to
                  ask Google for anything */}
              <p role="status" className="min-w-0 flex-1 text-table text-ink-2">
                {selectedAccount.providerKind === "gmail"
                  ? "Google needs permission again before this account can sync."
                  : "This mailbox needs its password again before Brain can sync."}
              </p>
              {/* only Google can be reconnected through OAuth; an IMAP
                  account is repaired in its own form, so the row carries the
                  way there instead of leaving the reader to find "Edit"
                  in the group below */}
              {selectedAccount.providerKind === "gmail" ? (
                <form
                  method="post"
                  action="/api/mail/oauth/google/start"
                  className="shrink-0"
                >
                  <input
                    type="hidden"
                    name="accountId"
                    value={selectedAccount.accountId}
                  />
                  <Button type="submit" variant="quiet">
                    Reconnect Google
                  </Button>
                </form>
              ) : (
                <Button
                  type="button"
                  variant="quiet"
                  className="shrink-0"
                  onClick={() => {
                    resetForm(selectedAccount);
                    setView("imap-form");
                  }}
                >
                  {/* The Google branch beside this one names its own repair
                      ("Reconnect Google"), so the IMAP branch names its own
                      too. "Edit" would also collide with the group's nav row,
                      leaving two controls with the same accessible name. */}
                  Update password
                </Button>
              )}
            </div>
          )}
        </SettingsGroup>

        {requestError && (
          <p role="alert" className="text-caption leading-relaxed text-red">
            {requestError}
          </p>
        )}

        <SettingsGroup>
          <button type="button" onClick={onOpenMail} className={NAVROW_CLASS}>
            <span className="min-w-0 flex-1 truncate text-table font-medium text-ink">
              Open Mail
            </span>
            <Icon
              name="arrow-right-linear"
              size={16}
              className="shrink-0 text-ink-3"
            />
          </button>
          {selectedAccount.providerKind === "imap" && (
            <button
              type="button"
              onClick={() => {
                resetForm(selectedAccount);
                setView("imap-form");
              }}
              className={NAVROW_CLASS}
            >
              <span className="min-w-0 flex-1 truncate text-table font-medium text-ink">
                Edit
              </span>
              <Icon
                name="alt-arrow-right-linear"
                size={16}
                className="shrink-0 text-ink-3"
              />
            </button>
          )}
          {selectedAccount.providerKind === "imap" && !outgoing && (
            <button
              type="button"
              onClick={() => {
                resetForm(selectedAccount);
                setSmtpChoice("on");
                pendingSmtpFocusRef.current = true;
                setView("imap-form");
              }}
              className={NAVROW_CLASS}
            >
              <span className="min-w-0 flex-1 truncate text-table font-medium text-ink">
                Add outgoing server
              </span>
              <Icon
                name="alt-arrow-right-linear"
                size={16}
                className="shrink-0 text-ink-3"
              />
            </button>
          )}
          {outgoing && (
            <SettingsRow
              label="Outgoing server"
              hint="Reply and send from Brain go through it"
            >
              <Button
                type="button"
                variant="quiet"
                className="shrink-0"
                disabled={removingSmtp}
                onClick={() => setConfirmRemoveSmtp(true)}
              >
                {removingSmtp ? "Removing…" : "Remove outgoing server"}
              </Button>
            </SettingsRow>
          )}
        </SettingsGroup>

        <SettingsGroup>
          <SettingsRow
            label="Remove account"
            hint="Deletes the credentials and cached mail from Brain, not from your provider"
          >
            <Button
              type="button"
              variant="destructive"
              disabled={removing}
              onClick={() => setConfirmRemove(true)}
            >
              {removing ? "Removing…" : "Remove"}
            </Button>
          </SettingsRow>
        </SettingsGroup>

        <ConfirmDialog
          open={confirmRemove}
          onOpenChange={setConfirmRemove}
          title={`Remove ${selectedAccount.emailAddress} from Brain?`}
          description="Brain will delete this account, its credentials, settings, cached mail, local drafts, search index, and sync state. Nothing will be deleted from your mail provider."
          confirmLabel="Remove from Brain"
          onConfirm={() => void removeSelected()}
        />
        <ConfirmDialog
          open={confirmRemoveSmtp}
          onOpenChange={setConfirmRemoveSmtp}
          title="Remove the outgoing server?"
          description="Brain will stop sending from this account. Incoming mail keeps syncing."
          confirmLabel="Stop sending"
          onConfirm={() => void removeOutgoingServer()}
        />
      </div>
    );
  }

  if (view === "imap-form") {
    return (
      <form
        onSubmit={submit}
        noValidate
        autoComplete="off"
        aria-busy={submitting}
        className="space-y-7"
      >
        <SectionBack
          label={editingAccount ? "Account" : "Providers"}
          onBack={() => {
            setRequestError(null);
            setView(editingAccount ? "details" : "providers");
          }}
        />
        <SettingsGroup
          title={editingAccount ? "Edit account" : "Other email"}
          description="Use the IMAP details from your mail provider."
        >
          <FormRow id="mail-display-name" label="Name">
            <Field
              id="mail-display-name"
              value={displayName}
              placeholder="Optional"
              autoComplete="section-brain-mail name"
              disabled={submitting}
              onChange={(event) => setDisplayName(event.target.value)}
              className="w-full"
            />
          </FormRow>

          <FormRow id="mail-email" label="Email" error={fieldErrors.email}>
            <Field
              id="mail-email"
              type="email"
              value={email}
              autoComplete="section-brain-mail email"
              autoCapitalize="none"
              spellCheck={false}
              disabled={submitting}
              aria-invalid={!!fieldErrors.email}
              aria-describedby={fieldErrors.email ? "mail-email-error" : undefined}
              onChange={(event) => changeEmail(event.target.value)}
              onBlur={() => validateOne("email")}
              className="w-full"
            />
          </FormRow>

          <FormRow
            id="mail-hostname"
            label="IMAP server"
            error={fieldErrors.hostname}
          >
            <Field
              id="mail-hostname"
              value={hostname}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={submitting}
              aria-invalid={!!fieldErrors.hostname}
              aria-describedby={
                fieldErrors.hostname ? "mail-hostname-error" : undefined
              }
              onChange={(event) => {
                manuallyEdited.current.hostname = true;
                setHostname(event.target.value);
                clearFieldError("hostname");
              }}
              onBlur={() => validateOne("hostname")}
              className="w-full"
            />
          </FormRow>

          <FormRow
            id="mail-username"
            label="Username"
            error={fieldErrors.username}
          >
            <Field
              id="mail-username"
              value={username}
              autoComplete="section-brain-mail username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={submitting}
              aria-invalid={!!fieldErrors.username}
              aria-describedby={
                fieldErrors.username ? "mail-username-error" : undefined
              }
              onChange={(event) => changeUsername(event.target.value)}
              onBlur={() => validateOne("username")}
              className="w-full"
            />
          </FormRow>

          <FormRow
            id="mail-password"
            label="Password or app password"
            hint={
              editingAccount
                ? connectionIdentityChanged
                  ? reenterPasswordCopy
                  : "Leave blank to keep the saved password."
                : undefined
            }
            error={fieldErrors.password}
          >
            <Field
              id="mail-password"
              type="password"
              value={password}
              autoComplete="section-brain-mail new-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={submitting}
              aria-invalid={!!fieldErrors.password}
              aria-describedby={
                fieldErrors.password
                  ? "mail-password-error"
                  : editingAccount
                    ? "mail-password-hint"
                    : undefined
              }
              onChange={(event) => {
                setPassword(event.target.value);
                clearFieldError("password");
              }}
              onBlur={() => validateOne("password")}
              className="w-full"
            />
          </FormRow>

          <details ref={advancedRef} className="group">
            <summary className="brain-settings-row brain-settings-rootrow brain-touch-min focus-inset cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <Icon
                name="alt-arrow-right-linear"
                size={16}
                className="shrink-0 text-ink-3 transition-transform group-open:rotate-90"
              />
              <span className="min-w-0 flex-1 truncate text-table font-medium text-ink">
                Advanced
              </span>
            </summary>
            <SettingsRow label="Security">
              <Segmented
                label="Security"
                value={tls}
                disabled={submitting}
                options={[
                  { value: "implicit", label: securityLabel("implicit") },
                  { value: "starttls", label: securityLabel("starttls") },
                ]}
                onChange={(value) => changeTls(value as MailTlsMode)}
              />
            </SettingsRow>
            <FormRow id="mail-port" label="Port" error={fieldErrors.port}>
              <Field
                id="mail-port"
                type="number"
                inputMode="numeric"
                min={1}
                max={65_535}
                value={port}
                disabled={submitting}
                aria-invalid={!!fieldErrors.port}
                aria-describedby={fieldErrors.port ? "mail-port-error" : undefined}
                onChange={(event) => {
                  manuallyEdited.current.port = true;
                  setPort(event.target.value);
                  clearFieldError("port");
                }}
                onBlur={() => validateOne("port")}
                className="w-24"
              />
            </FormRow>
          </details>
        </SettingsGroup>

        <SettingsGroup
          title="Outgoing (SMTP)"
          description="Needed to reply and send. Uses the same password as incoming."
        >
          <SettingsRow
            label={SEND_SWITCH_LABEL}
            hint={smtpEnabled ? undefined : SEND_SWITCH_OFF_HINT}
          >
            <Segmented
              label={SEND_SWITCH_LABEL}
              value={smtpEnabled ? "on" : "off"}
              disabled={submitting}
              options={[
                { value: "off", label: "Off" },
                { value: "on", label: "On" },
              ]}
              onChange={(value) => setSmtpChoice(value === "on" ? "on" : "off")}
            />
          </SettingsRow>
          {smtpEnabled && (
            <>
              <FormRow
                id="mail-smtp-hostname"
                label="SMTP server"
                error={fieldErrors.smtpHostname}
              >
                <Field
                  id="mail-smtp-hostname"
                  value={smtpHostname}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={submitting}
                  aria-invalid={!!fieldErrors.smtpHostname}
                  aria-describedby={
                    fieldErrors.smtpHostname ? "mail-smtp-hostname-error" : undefined
                  }
                  onChange={(event) => {
                    manuallyEdited.current.smtpHostname = true;
                    setSmtpHostname(event.target.value);
                    clearFieldError("smtpHostname");
                  }}
                  onBlur={() => validateOne("smtpHostname")}
                  className="w-full"
                />
              </FormRow>

              <FormRow
                id="mail-smtp-username"
                label="Username"
                error={fieldErrors.smtpUsername}
              >
                <Field
                  id="mail-smtp-username"
                  value={smtpUsername}
                  autoComplete="section-brain-mail-smtp username"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  disabled={submitting}
                  aria-invalid={!!fieldErrors.smtpUsername}
                  aria-describedby={
                    fieldErrors.smtpUsername ? "mail-smtp-username-error" : undefined
                  }
                  onChange={(event) => {
                    manuallyEdited.current.smtpUsername = true;
                    setSmtpUsername(event.target.value);
                    clearFieldError("smtpUsername");
                  }}
                  onBlur={() => validateOne("smtpUsername")}
                  className="w-full"
                />
              </FormRow>

              <details ref={smtpAdvancedRef} className="group">
                <summary className="brain-settings-row brain-settings-rootrow brain-touch-min focus-inset cursor-pointer list-none [&::-webkit-details-marker]:hidden">
                  <Icon
                    name="alt-arrow-right-linear"
                    size={16}
                    className="shrink-0 text-ink-3 transition-transform group-open:rotate-90"
                  />
                  <span className="min-w-0 flex-1 truncate text-table font-medium text-ink">
                    Advanced
                  </span>
                </summary>
                <SettingsRow label="Security">
                  {/* the visible row says "Security" like the incoming one;
                      the control's own name tells the two groups apart */}
                  <Segmented
                    label="Outgoing security"
                    value={smtpTls}
                    disabled={submitting}
                    options={[
                      { value: "implicit", label: securityLabel("implicit") },
                      { value: "starttls", label: securityLabel("starttls") },
                    ]}
                    onChange={(value) => changeSmtpTls(value as MailTlsMode)}
                  />
                </SettingsRow>
                <FormRow id="mail-smtp-port" label="Port" error={fieldErrors.smtpPort}>
                  <Field
                    id="mail-smtp-port"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={65_535}
                    value={smtpPort}
                    disabled={submitting}
                    aria-invalid={!!fieldErrors.smtpPort}
                    aria-describedby={
                      fieldErrors.smtpPort ? "mail-smtp-port-error" : undefined
                    }
                    onChange={(event) => {
                      manuallyEdited.current.smtpPort = true;
                      setSmtpPort(event.target.value);
                      clearFieldError("smtpPort");
                    }}
                    onBlur={() => validateOne("smtpPort")}
                    className="w-24"
                  />
                </FormRow>
              </details>
            </>
          )}
        </SettingsGroup>

        {requestError && (
          <p role="alert" className="text-caption leading-relaxed text-red">
            {requestError}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="submit" variant="ink" disabled={submitting}>
            {submitting
              ? editingAccount
                ? "Saving…"
                : "Connecting…"
              : editingAccount
                ? "Save changes"
                : "Connect"}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <motion.div {...readyMotion} className="space-y-7">
      <SettingsGroup
        title="Mail accounts"
        description="Gmail, Google Workspace, or any IMAP mailbox."
        action={
          accounts.length > 0 && accounts.length < MAX_MAIL_ACCOUNTS ? (
            <Button
              type="button"
              variant="quiet"
              onClick={() => {
                setRequestError(null);
                setView("providers");
              }}
            >
              <Icon name="add-linear" size={16} />
              Add account
            </Button>
          ) : accounts.length >= MAX_MAIL_ACCOUNTS ? (
            <span className="pt-1 text-caption text-ink-3">
              {ACCOUNT_LIMIT_BADGE}
            </span>
          ) : null
        }
      >
        {accounts.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <p className="text-table text-ink-2">No mail accounts yet</p>
            <Button
              type="button"
              variant="glass"
              className="mt-3"
              onClick={() => setView("providers")}
            >
              Connect account
            </Button>
          </div>
        ) : (
          <>
            {accounts.map((account) => (
              <button
                key={account.accountId}
                type="button"
                data-lead=""
                onClick={() => {
                  setSelectedId(account.accountId);
                  setRequestError(null);
                  setView("details");
                }}
                className={NAVROW_CLASS}
              >
                <span className="brain-settings-tile" aria-hidden="true">
                  <Icon name="letter-linear" size={16} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-table font-semibold text-ink">
                    {account.displayName || account.emailAddress}
                  </span>
                  <span className="block truncate text-caption text-ink-3">
                    {account.displayName ? `${account.emailAddress} · ` : ""}
                    {account.providerKind === "gmail" ? "Google" : "IMAP"}
                  </span>
                </span>
                {/* a state, not an action — the row opens the account, and
                    the Reconnect button lives inside it */}
                {account.status === "reauth_required" && (
                  <span className="brain-settings-badge text-table text-ink-2">
                    Reconnect needed
                  </span>
                )}
                <Icon
                  name="alt-arrow-right-linear"
                  size={16}
                  className="shrink-0 text-ink-3"
                />
              </button>
            ))}
            <button type="button" onClick={onOpenMail} className={NAVROW_CLASS}>
              <span className="min-w-0 flex-1 truncate text-table font-medium text-ink">
                Open Mail
              </span>
              <Icon
                name="arrow-right-linear"
                size={16}
                className="shrink-0 text-ink-3"
              />
            </button>
          </>
        )}
      </SettingsGroup>

      {accounts.length >= MAX_MAIL_ACCOUNTS && (
        <p className="text-caption text-ink-3">{ACCOUNT_LIMIT_COPY}</p>
      )}
    </motion.div>
  );
}

function SectionBack({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <Button type="button" variant="quiet" className="-ml-3" onClick={onBack}>
      <Icon name="arrow-left-linear" size={16} />
      {label}
    </Button>
  );
}

function ProviderButton({
  type,
  icon,
  label,
  description,
  onClick,
}: {
  type: "button" | "submit";
  icon: string;
  label: string;
  description: string;
  onClick?: () => void;
}) {
  return (
    <button type={type} onClick={onClick} data-lead="" className={NAVROW_CLASS}>
      <span className="brain-settings-tile" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-table font-semibold text-ink">
          {label}
        </span>
        <span className="block truncate text-caption text-ink-3">
          {description}
        </span>
      </span>
      <Icon
        name="alt-arrow-right-linear"
        size={16}
        className="shrink-0 text-ink-3"
      />
    </button>
  );
}

/** One row of the IMAP form in the surface's own grammar: a real <label> on
 *  the left in the row-label register, the Field on the right, and the
 *  Caption line under the label carrying either the hint or — when the field
 *  is invalid — the error in red. The row states one thing at a time, so it
 *  keeps a stable height while a form is being repaired. The `${id}-hint` /
 *  `${id}-error` ids aria-describedby points at are unchanged. */
function FormRow({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="brain-settings-row" data-lead={hint || error ? "" : undefined}>
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="text-table font-medium text-ink">
          {label}
        </label>
        {error ? (
          <p id={`${id}-error`} role="alert" className="mt-0.5 text-caption text-red">
            {error}
          </p>
        ) : (
          hint && (
            <p id={`${id}-hint`} className="mt-0.5 text-caption text-ink-3">
              {hint}
            </p>
          )
        )}
      </div>
      {/* the control gets the room the value needs: the labels here top out
          at 172px, while an address like p.hartington@company-name.example.com
          measures 290 and is read more often than typed (the Edit form
          arrives pre-filled). 56% of the row is 335px at the 640 settings
          width — the old `min(56%, 240px)` never let the percentage win, so
          every value over ~26 characters lost its tail. The percentage keeps
          the row honest on a narrow surface; the 340 ceiling stops the
          control from running away on a wide one. */}
      <div className="flex w-[min(56%,340px)] shrink-0 justify-end">{children}</div>
    </div>
  );
}

interface MailProviderDefaults {
  readonly imapHostname: string;
  readonly imapPort: number;
  readonly imapTls: MailTlsMode;
  readonly smtpHostname: string;
  readonly smtpPort: number;
  readonly smtpTls: MailTlsMode;
}

/**
 * Provider-authoritative defaults, keyed on the exact mail domain. A domain
 * earns an entry when the provider's own autoconfig names a server the derived
 * `imap.<domain>` guess would miss — iCloud designates `imap.mail.me.com:993`
 * with SSL and the full address as username, and a guess at `imap.icloud.com`
 * would send credentials to a host Apple does not run mail on. Where the guess
 * is already right (Gmail, Fastmail) the entry states the port and security so
 * the form fills in completely rather than half. The operator can overwrite
 * the server, port, and security before saving.
 *
 * The outgoing half follows the same rule. An entry names the submission
 * server with its own security and port pair (iCloud submits over STARTTLS on
 * 587, the others over implicit TLS on 465); a domain without an entry gets
 * `smtp.<domain>:465`, the guess the operator reviews in the form. Connect
 * posts `smtp` only while "Send from this account" is on, and the endpoint
 * carries no password: the service signs in to it with the mailbox password.
 */
const MAIL_PROVIDER_DEFAULTS: ReadonlyMap<string, MailProviderDefaults> = new Map([
  [
    "icloud.com",
    {
      imapHostname: "imap.mail.me.com",
      imapPort: 993,
      imapTls: "implicit",
      smtpHostname: "smtp.mail.me.com",
      smtpPort: 587,
      smtpTls: "starttls",
    },
  ],
  [
    "gmail.com",
    {
      imapHostname: "imap.gmail.com",
      imapPort: 993,
      imapTls: "implicit",
      smtpHostname: "smtp.gmail.com",
      smtpPort: 465,
      smtpTls: "implicit",
    },
  ],
  [
    "fastmail.com",
    {
      imapHostname: "imap.fastmail.com",
      imapPort: 993,
      imapTls: "implicit",
      smtpHostname: "smtp.fastmail.com",
      smtpPort: 465,
      smtpTls: "implicit",
    },
  ],
]);

interface SmtpDefaults {
  readonly hostname: string;
  readonly port: number;
  readonly tls: MailTlsMode;
}

/** The outgoing guess for a complete address, provider entry or derived
 *  `smtp.<domain>:465`, or null while the address names no domain yet. */
function smtpDefaultsForEmail(value: string): SmtpDefaults | null {
  const domain = emailDomain(value);
  if (!domain) return null;
  const provider = MAIL_PROVIDER_DEFAULTS.get(domain);
  return provider
    ? { hostname: provider.smtpHostname, port: provider.smtpPort, tls: provider.smtpTls }
    : { hostname: `smtp.${domain}`, port: 465, tls: "implicit" };
}

function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65_535;
}

/** Lowercased domain of a complete address, or "" when it is not one yet. */
function emailDomain(value: string): string {
  const match = /^[^@\s]+@([^@\s.]+(?:\.[^@\s.]+)+)$/.exec(value.trim());
  return match ? match[1].toLowerCase() : "";
}

/** Exact-domain provider entry for this address, or null to derive it. */
function mailProviderDefaultsForEmail(value: string): MailProviderDefaults | null {
  const domain = emailDomain(value);
  return domain ? MAIL_PROVIDER_DEFAULTS.get(domain) ?? null : null;
}

function imapHostForEmail(value: string): string {
  const domain = emailDomain(value);
  if (!domain) return "";
  return MAIL_PROVIDER_DEFAULTS.get(domain)?.imapHostname ?? `imap.${domain}`;
}

function securityLabel(value: MailTlsMode): string {
  return value === "implicit" ? "TLS" : "STARTTLS";
}

function endpointLabel(endpoint: MailEndpoint): string {
  return `${endpoint.hostname}:${endpoint.port} · ${securityLabel(endpoint.tls)}`;
}

/** The capabilities route answers apiVersion 3, each account carrying its
 *  capabilities. A service from before that route answers the plain list as
 *  apiVersion 2, the same accounts without them, and the Brain client passes
 *  that through; both shapes are the account list. */
function parseAccounts(value: unknown): PublicMailAccount[] {
  if (
    !isExactRecord(value, ["apiVersion", "accounts"]) ||
    (value.apiVersion !== 2 && value.apiVersion !== 3) ||
    !Array.isArray(value.accounts)
  ) {
    throw new Error("mail_service_invalid_response");
  }
  return value.accounts.map(parsePublicAccount);
}

function parseAccountResult(value: unknown): PublicMailAccount {
  if (
    !isExactRecord(value, ["apiVersion", "account"]) ||
    value.apiVersion !== 2
  ) {
    throw new Error("mail_service_invalid_response");
  }
  return parsePublicAccount(value.account);
}

function parsePublicAccount(value: unknown): PublicMailAccount {
  if (!isRecord(value) || (value.providerKind !== "imap" && value.providerKind !== "gmail")) {
    throw new Error("mail_service_invalid_response");
  }
  const fields = [
    "accountId",
    "emailAddress",
    "displayName",
    "status",
    "connectedAt",
    "createdAt",
    "updatedAt",
    "providerKind",
    ...(value.providerKind === "imap" ? ["imap"] : []),
    // the outgoing server is optional on the wire, so its key is admitted
    // only when the account carries one; an exact record stays exact
    ...(value.providerKind === "imap" && Object.prototype.hasOwnProperty.call(value, "smtp")
      ? ["smtp"]
      : []),
    // present on the capabilities list, absent from a mutation's answer
    ...(Object.prototype.hasOwnProperty.call(value, "capabilities") ? ["capabilities"] : []),
  ];
  if (
    !isExactRecord(value, fields) ||
    typeof value.accountId !== "string" ||
    !value.accountId ||
    typeof value.emailAddress !== "string" ||
    !value.emailAddress ||
    (value.displayName !== null && typeof value.displayName !== "string") ||
    (value.status !== "connected" && value.status !== "reauth_required") ||
    !isSafeTimestamp(value.connectedAt) ||
    !isSafeTimestamp(value.createdAt) ||
    !isSafeTimestamp(value.updatedAt)
  ) {
    throw new Error("mail_service_invalid_response");
  }
  // Only `send` is read, so only `send` is checked: the full capability set
  // belongs to the mail surface and its client, and a capability added there
  // must not make this card fail closed.
  const capabilities = "capabilities" in value ? value.capabilities : undefined;
  if (
    capabilities !== undefined &&
    (!isRecord(capabilities) || typeof capabilities.send !== "boolean")
  ) {
    throw new Error("mail_service_invalid_response");
  }
  const base: PublicMailAccountBase = {
    accountId: value.accountId,
    emailAddress: value.emailAddress,
    displayName: value.displayName,
    status: value.status,
    connectedAt: value.connectedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    capabilities:
      capabilities !== undefined ? { send: capabilities.send as boolean } : null,
  };
  if (value.providerKind === "gmail") {
    return { ...base, providerKind: "gmail" };
  }
  const imap = parseEndpoint(value.imap);
  const smtp = "smtp" in value ? parseEndpoint(value.smtp) : undefined;
  return {
    ...base,
    providerKind: "imap",
    imap,
    ...(smtp ? { smtp } : {}),
  };
}

/** The same checks for both servers of an account: an exact record, a real
 *  port, one of the two security modes, a non-empty name on each side. */
function parseEndpoint(value: unknown): MailEndpoint {
  if (
    !isExactRecord(value, ["hostname", "port", "tls", "username"]) ||
    typeof value.hostname !== "string" ||
    !value.hostname ||
    !Number.isSafeInteger(value.port) ||
    (value.port as number) < 1 ||
    (value.port as number) > 65_535 ||
    (value.tls !== "implicit" && value.tls !== "starttls") ||
    typeof value.username !== "string" ||
    !value.username
  ) {
    throw new Error("mail_service_invalid_response");
  }
  return {
    hostname: value.hostname,
    port: value.port as number,
    tls: value.tls,
    username: value.username,
  };
}

function readErrorCode(value: unknown): string {
  if (
    isRecord(value) &&
    value.apiVersion === 2 &&
    isRecord(value.error) &&
    typeof value.error.code === "string"
  ) {
    return value.error.code;
  }
  return "mail_service_invalid_response";
}

function messageForError(error: unknown): string {
  const code = error instanceof Error ? error.message : "mail_service_unavailable";
  switch (code) {
    case "account_request_invalid":
      return "Check the email, server, port, username, and password.";
    case "account_already_exists":
      return "This mail account is already connected.";
    case "account_limit_reached":
      return ACCOUNT_LIMIT_COPY;
    case "account_not_found":
      return "This account no longer exists. Reload Mail settings.";
    case "imap_dns_failed":
      return "We couldn't find this IMAP server. Check the server name.";
    case "imap_tls_failed":
      return "The secure connection failed. Check the server and security setting.";
    case "imap_authentication_failed":
      return "The server rejected the username or password.";
    // Brain connects from its own server, not from this device. A company-only
    // mail host can therefore fail here while the identical settings work in a
    // desktop mail app on the work network, so never imply the settings are wrong.
    case "imap_connection_timeout":
      return "The IMAP server didn't respond. Check the port, or whether this server only accepts connections from your work network.";
    case "imap_connection_failed":
      return "We couldn't reach the IMAP server. Check the server and port, or whether this server only accepts connections from your work network.";
    // The outgoing half of the account. Same shape as the IMAP answers above,
    // and the same rule: a company-only host can refuse Brain's server while
    // the identical settings work from the work network.
    case "smtp_dns_failed":
      return "We couldn't find this outgoing (SMTP) server. Check the server name.";
    case "smtp_tls_failed":
      return "The secure connection to the outgoing server failed. Check the server and security setting.";
    case "smtp_authentication_failed":
      return "The outgoing server rejected the username or password.";
    case "smtp_connection_timeout":
      return "The outgoing (SMTP) server didn't respond. Check the port, or whether this server only accepts connections from your work network.";
    case "smtp_connection_failed":
      return "We couldn't reach the outgoing (SMTP) server. Check the server and port, or whether this server only accepts connections from your work network.";
    case "mail_service_timeout":
      return "Mail setup took too long to respond. Try again.";
    default:
      return "Mail setup is unavailable right now. Try again.";
  }
}

function isSafeTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExactRecord(
  value: unknown,
  fields: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (
    keys.length === fields.length &&
    keys.every((key) => typeof key === "string" && fields.includes(key)) &&
    fields.every((field) => {
      const descriptor = descriptors[field];
      return descriptor !== undefined && "value" in descriptor;
    })
  );
}
