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
};

type PublicMailAccount =
  | (PublicMailAccountBase & {
      readonly providerKind: "imap";
      readonly imap: {
        readonly hostname: string;
        readonly port: number;
        readonly tls: MailTlsMode;
        readonly username: string;
      };
    })
  | (PublicMailAccountBase & { readonly providerKind: "gmail" });

type LoadState = "loading" | "ready" | "error";
type View = "list" | "providers" | "details" | "imap-form";
type FormField = "email" | "hostname" | "username" | "password" | "port";
type FieldErrors = Partial<Record<FormField, string>>;

const MAX_ACCOUNTS = 3;
const NAVROW_CLASS =
  "brain-settings-row brain-settings-rootrow brain-settings-navrow brain-touch-min focus-inset";
const FORM_FIELD_ORDER: FormField[] = [
  "email",
  "hostname",
  "username",
  "password",
  "port",
];
const REENTER_PASSWORD_COPY =
  "Re-enter the password after changing the server, security, port, or username.";
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
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [requestError, setRequestError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const manuallyEdited = useRef({
    hostname: false,
    username: false,
    port: false,
    tls: false,
  });
  const advancedRef = useRef<HTMLDetailsElement | null>(null);
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
  const connectionIdentityChanged =
    editingAccount !== null &&
    (hostname.trim() !== editingAccount.imap.hostname ||
      Number(port) !== editingAccount.imap.port ||
      tls !== editingAccount.imap.tls ||
      username !== editingAccount.imap.username);

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
      manuallyEdited.current = {
        hostname: true,
        username: true,
        port: true,
        tls: true,
      };
      return;
    }
    setDisplayName("");
    setEmail("");
    setHostname("");
    setUsername("");
    setTls("implicit");
    setPort("993");
    manuallyEdited.current = {
      hostname: false,
      username: false,
      port: false,
      tls: false,
    };
  }, []);

  useEffect(() => {
    if (loadState === "ready") lastLoadedAccounts = accounts;
  }, [accounts, loadState]);

  const load = useCallback(async (signal?: AbortSignal, silent = false) => {
    if (!silent) setLoadState("loading");
    setRequestError(null);
    try {
      const response = await fetch("/api/mail/accounts", {
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
    if (!manuallyEdited.current.username) {
      setUsername(suggestedHostname ? value.trim() : "");
      clearFieldError("username");
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
      setTls(provider.tls);
      if (!manuallyEdited.current.port) {
        setPort(String(provider.imapPort));
        clearFieldError("port");
      }
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
      else if (connectionIdentityChanged) next.password = REENTER_PASSWORD_COPY;
    }
    if (
      !Number.isInteger(normalizedPort) ||
      normalizedPort < 1 ||
      normalizedPort > 65_535
    ) {
      next.port = "Enter a port from 1 to 65535.";
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
      window.requestAnimationFrame(() => {
        document.getElementById(`mail-${firstError}`)?.focus();
      });
      return;
    }

    setSubmitting(true);
    setRequestError(null);
    const editing = editingAccount !== null;
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
        : `${selectedAccount.imap.hostname}:${selectedAccount.imap.port} · ${securityLabel(selectedAccount.imap.tls)}`;
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
            </div>
          </div>
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
              onChange={(event) => {
                manuallyEdited.current.username = true;
                setUsername(event.target.value);
                clearFieldError("username");
              }}
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
                  ? REENTER_PASSWORD_COPY
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
          accounts.length > 0 && accounts.length < MAX_ACCOUNTS ? (
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
          ) : accounts.length >= MAX_ACCOUNTS ? (
            <span className="pt-1 text-caption text-ink-3">3 account limit</span>
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

      {accounts.length >= MAX_ACCOUNTS && (
        <p className="text-caption text-ink-3">
          Brain supports up to three mail accounts.
        </p>
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
  readonly tls: MailTlsMode;
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
 * Receive only. Connect deliberately posts no `smtp` endpoint, because three
 * things fail closed today: this form has no SMTP field to review or override,
 * `parsePublicAccount` rejects an account payload that carries `smtp`, and with
 * `BRAIN_MAIL_SMTP_EGRESS_ENABLED` unset the service has no SMTP verifier and
 * answers `account_state_unavailable`. Adding the endpoint here would break
 * connect and the account list rather than configure send.
 */
const MAIL_PROVIDER_DEFAULTS: ReadonlyMap<string, MailProviderDefaults> = new Map([
  ["icloud.com", { imapHostname: "imap.mail.me.com", imapPort: 993, tls: "implicit" }],
  ["gmail.com", { imapHostname: "imap.gmail.com", imapPort: 993, tls: "implicit" }],
  ["fastmail.com", { imapHostname: "imap.fastmail.com", imapPort: 993, tls: "implicit" }],
]);

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

function parseAccounts(value: unknown): PublicMailAccount[] {
  if (
    !isExactRecord(value, ["apiVersion", "accounts"]) ||
    value.apiVersion !== 2 ||
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
  const base: PublicMailAccountBase = {
    accountId: value.accountId,
    emailAddress: value.emailAddress,
    displayName: value.displayName,
    status: value.status,
    connectedAt: value.connectedAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
  if (value.providerKind === "gmail") {
    return { ...base, providerKind: "gmail" };
  }
  if (
    !isExactRecord(value.imap, ["hostname", "port", "tls", "username"]) ||
    typeof value.imap.hostname !== "string" ||
    !value.imap.hostname ||
    !Number.isSafeInteger(value.imap.port) ||
    (value.imap.port as number) < 1 ||
    (value.imap.port as number) > 65_535 ||
    (value.imap.tls !== "implicit" && value.imap.tls !== "starttls") ||
    typeof value.imap.username !== "string" ||
    !value.imap.username
  ) {
    throw new Error("mail_service_invalid_response");
  }
  const imapPort = value.imap.port as number;
  return {
    ...base,
    providerKind: "imap",
    imap: {
      hostname: value.imap.hostname,
      port: imapPort,
      tls: value.imap.tls,
      username: value.imap.username,
    },
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
      return "Brain supports up to three mail accounts.";
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
