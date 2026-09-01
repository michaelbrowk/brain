"use client";

import * as Popover from "@radix-ui/react-popover";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ShareScopeSnapshot } from "@/lib/store/types";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Icon } from "./ui/icon";

export type ShareEnableResult =
  | { status: "enabled"; snapshot: ShareScopeSnapshot }
  | { status: "conflict"; snapshot: ShareScopeSnapshot };

type Grant = { id: string; title: string };
type ExpiredGrant = Grant & { expiresAt?: string };
type ExpiryChoice = "never" | "1" | "7" | "30";

/** A single flat surface that moves from exact-scope review to management. */
export function SharePopover({
  isPublic,
  pageId,
  hasPassword,
  expiresAt,
  inheritedFrom,
  expiredInheritedFrom,
  scopeRevision,
  onPrepareShare,
  onEnableShare,
  onDisableShare,
  onCopyLink,
  onOpenShareSettings,
  onSetProtection,
  children,
}: {
  isPublic: boolean;
  pageId: string;
  hasPassword: boolean;
  expiresAt?: string;
  inheritedFrom?: Grant;
  expiredInheritedFrom?: ExpiredGrant;
  scopeRevision?: string;
  onPrepareShare: (rootId: string) => Promise<ShareScopeSnapshot>;
  onEnableShare: (input: {
    expectedScopeToken: string;
    password?: string | null;
    expiresAt?: string | null;
  }) => Promise<ShareEnableResult>;
  onDisableShare: () => Promise<ShareScopeSnapshot>;
  onCopyLink: (rootId: string) => void | Promise<void>;
  onOpenShareSettings?: () => void;
  onSetProtection: (input: {
    password?: string | null;
    expiresAt?: string | null;
  }) => void | Promise<void>;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [verified, setVerified] = useState<ShareScopeSnapshot | null>(null);
  const [confirmation, setConfirmation] = useState<ShareScopeSnapshot | null>(null);
  const [checkingScope, setCheckingScope] = useState(false);
  const [busy, setBusy] = useState(false);
  const [revokeConfirming, setRevokeConfirming] = useState(false);
  const [revokePending, setRevokePending] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [enablePasswordOn, setEnablePasswordOn] = useState(false);
  const [enablePassword, setEnablePassword] = useState("");
  const [enablePasswordVisible, setEnablePasswordVisible] = useState(false);
  const [enableExpiry, setEnableExpiry] = useState<ExpiryChoice>("never");
  const [directOverride, setDirectOverride] = useState<{
    value: boolean;
    basePublic: boolean;
  } | null>(null);
  const mobile = useSyncExternalStore(
    subscribeMobileViewport,
    getMobileViewportSnapshot,
    getServerMobileViewportSnapshot,
  );
  const enablePasswordRef = useRef<HTMLInputElement>(null);

  const verifiedDirectPublic = verified?.rootId === pageId ? verified.public : null;
  const effectiveDirectPublic =
    directOverride?.basePublic === isPublic
      ? directOverride.value
      : verifiedDirectPublic ?? isPublic;
  const directExpiry = effectiveExpiryValue(verified, pageId, expiresAt);
  const directExpired = effectiveDirectPublic && isExpired(directExpiry);
  const inheritedOnly = !!inheritedFrom && !effectiveDirectPublic;
  const expiredInheritedOnly =
    !effectiveDirectPublic && !inheritedFrom && !!expiredInheritedFrom;
  const directActive = effectiveDirectPublic && !directExpired;
  const activeRootId = directActive ? pageId : inheritedFrom?.id ?? null;
  const refreshRootId = effectiveDirectPublic
    ? pageId
    : inheritedFrom?.id ?? expiredInheritedFrom?.id ?? pageId;
  const activeSnapshot =
    verified?.rootId === activeRootId && verified.public ? verified : null;
  const effectiveLocked =
    verified?.rootId === pageId && verified.public ? verified.shareLocked : hasPassword;
  const effectiveExpiry =
    verified?.rootId === pageId && verified.public
      ? verified.shareExpiresAt ?? undefined
      : expiresAt;
  const url =
    typeof window !== "undefined" && activeRootId
      ? `${location.origin}/share/${activeRootId}${
          activeRootId !== pageId ? `?page=${encodeURIComponent(pageId)}` : ""
        }`
      : "";

  useEffect(() => {
    if (!enablePasswordOn) return;
    enablePasswordRef.current?.focus();
  }, [enablePasswordOn]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const refresh = async () => {
      setCheckingScope(true);
      setShareError(null);
      try {
        const snapshot = await onPrepareShare(refreshRootId);
        if (cancelled) return;
        setVerified(snapshot);
        if (refreshRootId === pageId) {
          setDirectOverride({ value: snapshot.public, basePublic: isPublic });
        }
        if (
          refreshRootId === pageId &&
          !snapshot.public &&
          !inheritedFrom &&
          !expiredInheritedFrom
        ) {
          setConfirmation(snapshot);
          setEnablePasswordOn(false);
          setEnablePassword("");
          setEnablePasswordVisible(false);
          setEnableExpiry("never");
        } else {
          setConfirmation(null);
        }
      } catch {
        if (cancelled) return;
        setShareError(
          effectiveDirectPublic || inheritedFrom || expiredInheritedFrom
            ? "Couldn't refresh the exact shared scope. The link may still work."
            : "Couldn't check the pages that would be shared. Try again.",
        );
      } finally {
        if (!cancelled) setCheckingScope(false);
      }
    };
    void refresh();
    return () => {
      cancelled = true;
    };
  }, [
    effectiveDirectPublic,
    expiredInheritedFrom,
    inheritedFrom,
    isPublic,
    onPrepareShare,
    open,
    pageId,
    refreshRootId,
    scopeRevision,
  ]);

  const enableShare = async () => {
    if (!confirmation || busy) return;
    const password = enablePassword.trim();
    if (enablePasswordOn && !password) return;
    setBusy(true);
    setShareError(null);
    try {
      const result = await onEnableShare({
        expectedScopeToken: confirmation.scopeToken,
        password: enablePasswordOn ? password : null,
        expiresAt:
          enablePasswordOn && enableExpiry !== "never"
            ? new Date(Date.now() + Number(enableExpiry) * DAY_MS).toISOString()
            : null,
      });
      setVerified(result.snapshot);
      if (result.status === "conflict") {
        setConfirmation(result.snapshot);
        setShareError(
          "The shared scope changed. Review the updated count and confirm again.",
        );
        return;
      }
      if (!result.snapshot.public) throw new Error("share enable was not confirmed");
      setDirectOverride({ value: true, basePublic: isPublic });
      setConfirmation(null);
      setEnablePassword("");
      setEnablePasswordVisible(false);
      setEnableExpiry("never");
    } catch {
      setShareError(
        "Couldn't confirm sharing. The link was not copied; check the current state before retrying.",
      );
    } finally {
      setBusy(false);
    }
  };

  const stopSharing = async () => {
    if (busy || !effectiveDirectPublic) return;
    setBusy(true);
    setRevokePending(true);
    setShareError(null);
    try {
      const snapshot = await onDisableShare();
      if (snapshot.public) throw new Error("share revoke was not confirmed");
      setDirectOverride({ value: false, basePublic: isPublic });
      setVerified(snapshot);
      setConfirmation(null);
      setRevokeConfirming(false);

      const fallbackGrant = inheritedFrom ?? expiredInheritedFrom;
      if (fallbackGrant) {
        try {
          const inheritedSnapshot = await onPrepareShare(fallbackGrant.id);
          if (
            !inheritedSnapshot.public ||
            (inheritedFrom && !isSnapshotActive(inheritedSnapshot))
          ) {
            throw new Error("inherited share is no longer active");
          }
          setVerified(inheritedSnapshot);
        } catch {
          setShareError(
            `This page's own link is off. The parent share through ${fallbackGrant.title} could not be refreshed.`,
          );
        }
      } else {
        setCheckingScope(true);
        try {
          const refreshed = await onPrepareShare(pageId);
          setVerified(refreshed);
          if (!refreshed.public) setConfirmation(refreshed);
        } catch {
          setShareError(
            "Sharing stopped, but the private review could not be refreshed.",
          );
        } finally {
          setCheckingScope(false);
        }
      }
    } catch {
      setRevokeConfirming(false);
      setShareError(
        "Couldn't stop sharing. The link is still shown as active and may still work.",
      );
    } finally {
      setRevokePending(false);
      setBusy(false);
    }
  };

  const copyLink = async () => {
    if (busy || checkingScope || !activeRootId) return;
    setBusy(true);
    setShareError(null);
    try {
      await onCopyLink(activeRootId);
    } catch {
      setShareError(
        "Couldn't verify and copy the public link. Check the current state and try again.",
      );
    } finally {
      setBusy(false);
    }
  };

  const resetEnablePassword = () => {
    setEnablePasswordOn(false);
    setEnablePassword("");
    setEnablePasswordVisible(false);
    setEnableExpiry("never");
  };

  const closeSurface = () => {
    setOpen(false);
    setRevokeConfirming(false);
    resetEnablePassword();
  };

  const surfaceBody = (
    <>
      {revokeConfirming ? (
        <RevokeView
          pending={revokePending}
          inheritedFrom={inheritedFrom}
          overlaps={activeSnapshot?.overlappingRoots ?? []}
          onCancel={() => setRevokeConfirming(false)}
          onConfirm={() => void stopSharing()}
        />
      ) : confirmation && !effectiveDirectPublic ? (
        <PrivateReview
          snapshot={confirmation}
          busy={busy}
          passwordOn={enablePasswordOn}
          password={enablePassword}
          passwordVisible={enablePasswordVisible}
          expiry={enableExpiry}
          passwordRef={enablePasswordRef}
          onPasswordToggle={(nextOn) => {
            if (nextOn) {
              setEnablePasswordOn(true);
              return;
            }
            resetEnablePassword();
          }}
          onPasswordChange={setEnablePassword}
          onPasswordVisibleChange={setEnablePasswordVisible}
          onExpiryChange={setEnableExpiry}
          onShare={() => void enableShare()}
          onOpenShareSettings={onOpenShareSettings}
        />
      ) : checkingScope && !effectiveDirectPublic && !inheritedFrom && !expiredInheritedFrom ? (
        <LoadingView />
      ) : (
        <ManagementView
          activeRootId={activeRootId}
          activeSnapshot={activeSnapshot}
          checkingScope={checkingScope}
          directPublic={effectiveDirectPublic}
          directExpired={directExpired}
          inheritedOnly={inheritedOnly}
          expiredInheritedOnly={expiredInheritedOnly}
          inheritedFrom={inheritedFrom}
          expiredInheritedFrom={expiredInheritedFrom}
          url={url}
          busy={busy}
          revokePending={revokePending}
          hasPassword={effectiveLocked}
          expiresAt={effectiveExpiry}
          onCopy={() => void copyLink()}
          onOpenShareSettings={onOpenShareSettings}
          onSetProtection={onSetProtection}
          onStopSharing={() => setRevokeConfirming(true)}
        />
      )}
      {shareError && (
        <p role="alert" className="mt-3 text-caption font-medium text-red">
          {shareError}
        </p>
      )}
    </>
  );

  if (mobile) {
    return (
      <Dialog.Root
        open={open}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (!nextOpen) closeSurface();
        }}
      >
        <Dialog.Trigger asChild data-share-mobile-trigger>
          {children}
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay
            data-share-mobile-backdrop
            className="brain-dialog-overlay fixed inset-0 z-[var(--z-modal)]"
          />
          {/* thick material bottom sheet: .brain-dialog carries the material,
              .brain-sheet the top radius and the slide keyframes */}
          <Dialog.Content
            aria-label="Share settings"
            aria-describedby={undefined}
            data-share-mobile-surface
            className="brain-dialog brain-sheet font-system fixed inset-x-0 bottom-0 z-[calc(var(--z-modal)+1)] w-screen overflow-y-auto px-4 pt-4 pb-[max(16px,env(safe-area-inset-bottom))] outline-none"
          >
            {surfaceBody}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          closeSurface();
        }
      }}
    >
      <Popover.Trigger asChild>{children}</Popover.Trigger>
      {/* regular material r14 from the Share pill: Radix data-state drives
          the materialize keyframes and keeps the panel mounted for the exit
          retrace (the .brain-menu canon shared with the pickers). */}
      <Popover.Portal>
        <Popover.Content
          aria-label="Share settings"
          aria-describedby={undefined}
          side="bottom"
          align="end"
          sideOffset={6}
          collisionPadding={12}
          data-share-surface
          className="brain-share-popover z-[var(--z-modal)] outline-none max-sm:hidden"
        >
          {surfaceBody}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function LoadingView() {
  return (
    <div aria-busy="true" className="min-h-24">
      <h2 className="text-subheading text-ink">Share page</h2>
      <p className="mt-1.5 text-caption font-medium text-ink-2">
        Checking which pages will be shared…
      </p>
    </div>
  );
}

function PrivateReview({
  snapshot,
  busy,
  passwordOn,
  password,
  passwordVisible,
  expiry,
  passwordRef,
  onPasswordToggle,
  onPasswordChange,
  onPasswordVisibleChange,
  onExpiryChange,
  onShare,
  onOpenShareSettings,
}: {
  snapshot: ShareScopeSnapshot;
  busy: boolean;
  passwordOn: boolean;
  password: string;
  passwordVisible: boolean;
  expiry: ExpiryChoice;
  passwordRef: React.RefObject<HTMLInputElement | null>;
  onPasswordToggle: (nextOn: boolean) => void;
  onPasswordChange: (value: string) => void;
  onPasswordVisibleChange: (visible: boolean) => void;
  onExpiryChange: (value: ExpiryChoice) => void;
  onShare: () => void;
  onOpenShareSettings?: () => void;
}) {
  const total = snapshot.descendantCount + 1;
  const label = total === 1 ? "Share page" : `Share ${total} pages`;
  const overlaps = snapshot.overlappingRoots;
  return (
    <div data-share-state="review">
      <h2 className="text-subheading text-ink">{label}</h2>
      <p className="mt-1.5 text-caption font-medium text-ink-2">
        {snapshot.descendantCount === 0
          ? "Anyone with the link can read this page."
          : "Anyone with the link can read them."}
      </p>

      {overlaps.length > 0 && (
        <div data-share-overlap-blocker className="mt-3">
          <p className="text-caption font-medium text-ink">
            This scope already overlaps {overlaps.length === 1 ? "another shared page" : "other shared pages"}.
          </p>
          <ul className="mt-1 space-y-0.5 text-caption font-medium text-ink-2">
            {overlaps.map((overlap) => (
              <li key={overlap.rootId}>
                {overlap.title} · {overlap.relation === "ancestor" ? "shared parent" : "shared nested page"}
                {isExpired(overlap.shareExpiresAt ?? undefined) ? " · expired" : ""}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-caption font-medium text-ink-2">
            Resolve the existing grant before creating this link.
          </p>
          {onOpenShareSettings && (
            <button
              type="button"
              onClick={onOpenShareSettings}
              className="mt-1 min-h-8 text-caption font-medium text-ink-2 transition-colors hover:text-ink max-sm:min-h-11"
            >
              Review shared links
            </button>
          )}
        </div>
      )}

      {overlaps.length === 0 && <div className="mt-4">
        <SettingToggle
          label="Password protection"
          checked={passwordOn}
          disabled={busy}
          onChange={onPasswordToggle}
        />
        {passwordOn && (
          <div className="brain-share-reveal mt-2">
            <div>
              <PasswordFields
                inputRef={passwordRef}
                password={password}
                visible={passwordVisible}
                expiry={expiry}
                disabled={busy}
                onPasswordChange={onPasswordChange}
                onVisibleChange={onPasswordVisibleChange}
                onExpiryChange={onExpiryChange}
              />
            </div>
          </div>
        )}
      </div>}

      {overlaps.length === 0 && (
        <div className="mt-4 flex justify-end">
          <Button
            variant="ink"
            disabled={busy || (passwordOn && !password.trim())}
            onClick={onShare}
            className="max-sm:min-h-11"
          >
            {busy ? "Sharing…" : "Share"}
          </Button>
        </div>
      )}
    </div>
  );
}

function ManagementView({
  activeRootId,
  activeSnapshot,
  checkingScope,
  directPublic,
  directExpired,
  inheritedOnly,
  expiredInheritedOnly,
  inheritedFrom,
  expiredInheritedFrom,
  url,
  busy,
  revokePending,
  hasPassword,
  expiresAt,
  onCopy,
  onOpenShareSettings,
  onSetProtection,
  onStopSharing,
}: {
  activeRootId: string | null;
  activeSnapshot: ShareScopeSnapshot | null;
  checkingScope: boolean;
  directPublic: boolean;
  directExpired: boolean;
  inheritedOnly: boolean;
  expiredInheritedOnly: boolean;
  inheritedFrom?: Grant;
  expiredInheritedFrom?: ExpiredGrant;
  url: string;
  busy: boolean;
  revokePending: boolean;
  hasPassword: boolean;
  expiresAt?: string;
  onCopy: () => void;
  onOpenShareSettings?: () => void;
  onSetProtection: (input: {
    password?: string | null;
    expiresAt?: string | null;
  }) => void | Promise<void>;
  onStopSharing: () => void;
}) {
  const title = expiredInheritedOnly
    ? "Link expired"
    : inheritedOnly
      ? `Shared through ${inheritedFrom?.title}`
      : directExpired && inheritedFrom
        ? `Shared through ${inheritedFrom.title}`
        : directExpired
          ? "Link expired"
          : "Shared to web";
  return (
    <div data-share-state="manage">
      <div data-share-primary-row="status">
        <h2 className="text-subheading text-ink">{title}</h2>
        <p className="mt-1 text-caption font-medium text-ink-2">
          {checkingScope
            ? "Refreshing shared page count…"
            : activeSnapshot
              ? activeScopeLabel(activeSnapshot.descendantCount, inheritedOnly || !!inheritedFrom)
              : expiredInheritedOnly
                ? `Parent share through ${expiredInheritedFrom?.title} is expired.`
                : directExpired
                  ? "This page's own link is expired."
                  : "Shared; exact count unavailable"}
        </p>
      </div>

      <div
        data-share-primary-row="link"
        data-share-link-row
        className="mt-3 flex items-center gap-1"
      >
        <span className="brain-share-url-well">
          <span
            data-share-url
            title={url || "No active public link"}
            aria-label={url ? `Public link: ${url}` : "No active public link"}
            className="min-w-0 flex-1 truncate font-mono text-[12px] font-medium leading-4 text-ink-2"
          >
            {url ? url.replace(/^https?:\/\//, "") : "No active public link"}
          </span>
        </span>
        <button
          type="button"
          disabled={busy || checkingScope || !activeRootId}
          onClick={onCopy}
          aria-label="Copy link"
          title="Copy link"
          className="brain-share-icon-btn brain-touch-hit focus-inset"
        >
          <Icon name="copy-linear" size={16} />
        </button>
        {activeRootId && !revokePending && (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            aria-label="Open public page"
            title="Open public page"
            className="brain-share-icon-btn brain-touch-hit focus-inset"
          >
            <Icon name="link-linear" size={16} />
          </a>
        )}
      </div>

      {activeSnapshot && activeSnapshot.overlappingRoots.length > 0 && (
        <div data-existing-share-overlaps className="mt-3">
          <p className="text-caption font-medium text-ink">Other recorded public links</p>
          <ul className="mt-1 space-y-0.5 text-caption font-medium text-ink-2">
            {activeSnapshot.overlappingRoots.map((overlap) => (
              <li key={overlap.rootId}>{overlapLabel(overlap)}</li>
            ))}
          </ul>
        </div>
      )}

      {inheritedFrom && directPublic && (
        <div data-multiple-share-grants className="mt-2">
          <p className="text-caption font-medium text-ink-2">
            {directExpired
              ? `Active access comes through ${inheritedFrom.title}.`
              : `Also shared through ${inheritedFrom.title}. Stopping this page's own link will not make it private.`}
          </p>
          {onOpenShareSettings && (
            <button
              type="button"
              onClick={onOpenShareSettings}
              className="mt-1 min-h-8 text-left text-caption font-medium text-ink-2 transition-colors hover:text-ink max-sm:min-h-11"
            >
              Go to shared parent
            </button>
          )}
        </div>
      )}

      {expiredInheritedFrom &&
        (!inheritedFrom || expiredInheritedFrom.id !== inheritedFrom.id) && (
          <p className="mt-2 text-caption font-medium text-ink-2">
            Parent share through {expiredInheritedFrom.title} is expired.
            {inheritedFrom ? ` Active access comes through ${inheritedFrom.title}.` : ""}
          </p>
        )}

      {directPublic && (
        <fieldset disabled={revokePending} className="mt-2 disabled:opacity-60">
          <ManagementSecurity
            key={`${hasPassword}:${expiresAt ?? "never"}`}
            hasPassword={hasPassword}
            expiresAt={expiresAt}
            onSetProtection={onSetProtection}
            onStopSharing={onStopSharing}
            revokePending={revokePending}
          />
        </fieldset>
      )}

      {(inheritedOnly || expiredInheritedOnly) && onOpenShareSettings && (
        <div className="mt-4 flex justify-end">
          <Button
            variant="quiet"
            onClick={onOpenShareSettings}
            className="max-sm:min-h-11"
          >
            Go to shared parent
          </Button>
        </div>
      )}

    </div>
  );
}

function RevokeView({
  pending,
  inheritedFrom,
  overlaps,
  onCancel,
  onConfirm,
}: {
  pending: boolean;
  inheritedFrom?: Grant;
  overlaps: ShareScopeSnapshot["overlappingRoots"];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const activeParents = overlaps.filter(
    (overlap) => overlap.relation === "ancestor" && !isExpired(overlap.shareExpiresAt ?? undefined),
  ).length;
  const activeChildren = overlaps.filter(
    (overlap) => overlap.relation === "descendant" && !isExpired(overlap.shareExpiresAt ?? undefined),
  ).length;
  const expiredParents = overlaps.filter(
    (overlap) => overlap.relation === "ancestor" && isExpired(overlap.shareExpiresAt ?? undefined),
  ).length;
  const expiredChildren = overlaps.filter(
    (overlap) => overlap.relation === "descendant" && isExpired(overlap.shareExpiresAt ?? undefined),
  ).length;
  return (
    <div data-share-state="revoke">
      <h2 className="text-subheading text-ink">
        {pending ? "Stopping sharing…" : "Stop sharing?"}
      </h2>
      <p className="mt-1.5 text-caption font-medium text-ink-2">
        {inheritedFrom
          ? `This page's own link will stop. Access through ${inheritedFrom.title} will remain.`
          : "The public link will stop working after the change is confirmed."}
      </p>
      {(activeParents > 0 || activeChildren > 0 || expiredParents > 0 || expiredChildren > 0) && (
        <div className="mt-2 space-y-1 text-caption font-medium text-ink-2">
          {activeParents > 0 && (
            <p>{`Stopping this root link will leave ${activeParents} parent public ${activeParents === 1 ? "link" : "links"} active.`}</p>
          )}
          {activeChildren > 0 && (
            <p>{`Stopping this root link will leave ${activeChildren} nested public ${activeChildren === 1 ? "link" : "links"} active.`}</p>
          )}
          {expiredParents > 0 && (
            <p>{`The expired parent ${expiredParents === 1 ? "link remains" : "links remain"} recorded but ${expiredParents === 1 ? "does" : "do"} not provide access.`}</p>
          )}
          {expiredChildren > 0 && (
            <p>{`The expired nested ${expiredChildren === 1 ? "link remains" : "links remain"} recorded but ${expiredChildren === 1 ? "does" : "do"} not provide access.`}</p>
          )}
        </div>
      )}
      {pending && (
        <p className="mt-1 text-caption font-medium text-ink-2">
          Waiting for durable confirmation…
        </p>
      )}
      <div className="mt-4 flex justify-end gap-2">
        <Button
          variant="quiet"
          disabled={pending}
          onClick={onCancel}
          className="max-sm:min-h-11"
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          disabled={pending}
          onClick={onConfirm}
          className="max-sm:min-h-11"
        >
          {pending ? "Stopping…" : "Stop sharing"}
        </Button>
      </div>
    </div>
  );
}

/** The v2 switch: blue track when on, an ink-3 track when off (≥3:1 against
 *  paper and the regular glass — WCAG 1.4.11), the knob pinned at 3px and
 *  travelling 16px on transform (compositor), never `left`. */
function SwitchControl({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="brain-touch-hit relative h-6 w-10 shrink-0 rounded-full disabled:opacity-40 max-sm:h-11 max-sm:w-14"
    >
      <span
        aria-hidden
        className={`absolute left-1/2 top-1/2 h-6 w-10 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors motion-reduce:transition-none ${
          checked ? "bg-blue" : "bg-ink-3"
        }`}
      >
        <span
          className={`absolute left-[3px] top-[3px] size-[18px] rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform motion-reduce:transition-none ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

function SettingToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div
      data-share-setting-row
      className="flex min-h-9 items-center justify-between gap-3 max-sm:min-h-11"
    >
      <span className="text-control text-ink">{label}</span>
      <SwitchControl
        label={label}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
    </div>
  );
}

function PasswordFields({
  inputRef,
  password,
  visible,
  expiry,
  disabled,
  onPasswordChange,
  onVisibleChange,
  onExpiryChange,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  password: string;
  visible: boolean;
  expiry: ExpiryChoice;
  disabled?: boolean;
  onPasswordChange: (value: string) => void;
  onVisibleChange: (visible: boolean) => void;
  onExpiryChange: (value: ExpiryChoice) => void;
}) {
  return (
    <div>
      <label htmlFor="share-password" className="block text-label text-ink-2">
        Password
      </label>
      <Field
        ref={inputRef}
        on="glass"
        id="share-password"
        type={visible ? "text" : "password"}
        aria-label="Share password"
        value={password}
        disabled={disabled}
        onChange={(event) => onPasswordChange(event.target.value)}
        className="brain-share-password-field mt-1.5 max-sm:min-h-11"
        trailing={
          <button
            type="button"
            aria-label={visible ? "Hide password" : "Show password"}
            aria-pressed={visible}
            disabled={disabled}
            onClick={() => onVisibleChange(!visible)}
            className="shrink-0 text-caption font-medium text-ink-2 transition-colors hover:text-ink disabled:opacity-40 max-sm:min-h-11"
          >
            {visible ? "Hide" : "Show"}
          </button>
        }
      />
      <ExpiryRadios value={expiry} disabled={disabled} onChange={onExpiryChange} />
    </div>
  );
}

function ExpiryRadios({
  value,
  disabled,
  onChange,
}: {
  value: ExpiryChoice;
  disabled?: boolean;
  onChange: (value: ExpiryChoice) => void;
}) {
  const options: Array<{ value: ExpiryChoice; label: string }> = [
    { value: "1", label: "1 day" },
    { value: "7", label: "7 days" },
    { value: "30", label: "30 days" },
    { value: "never", label: "Never" },
  ];
  return (
    <div className="mt-3">
      <p className="text-label text-ink-2">Expiry</p>
      <fieldset aria-label="Link expiry" className="brain-share-seg mt-1.5">
        {options.map((option) => (
          <label
            key={option.value}
            data-checked={value === option.value ? "" : undefined}
            className={`brain-share-seg-option relative cursor-pointer has-[:focus-visible]:outline-solid has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-blue/55 ${
              disabled ? "cursor-default opacity-40" : ""
            }`}
          >
            <input
              type="radio"
              name="share-expiry"
              value={option.value}
              checked={value === option.value}
              disabled={disabled}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        ))}
      </fieldset>
    </div>
  );
}

function ManagementSecurity({
  hasPassword,
  expiresAt,
  onSetProtection,
  onStopSharing,
  revokePending,
}: {
  hasPassword: boolean;
  expiresAt?: string;
  onSetProtection: (input: {
    password?: string | null;
    expiresAt?: string | null;
  }) => void | Promise<void>;
  onStopSharing: () => void;
  revokePending: boolean;
}) {
  const [passwordOn, setPasswordOn] = useState(hasPassword);
  const [draft, setDraft] = useState("");
  const [visible, setVisible] = useState(false);
  const [expiry, setExpiry] = useState<ExpiryChoice>(expiryPreset(expiresAt));
  const [expiryDirty, setExpiryDirty] = useState(false);
  const [localLegacyExpiry, setLocalLegacyExpiry] = useState(expiresAt);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (passwordOn) inputRef.current?.focus();
  }, [passwordOn]);

  const turnOff = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setDraft("");
    setVisible(false);
    setExpiry("never");
    setExpiryDirty(true);
    try {
      await onSetProtection({ password: null, expiresAt: null });
      setPasswordOn(false);
      setLocalLegacyExpiry(undefined);
    } catch {
      setPasswordOn(hasPassword);
      setExpiry(expiryPreset(expiresAt));
      setExpiryDirty(false);
      setLocalLegacyExpiry(expiresAt);
      setError("Couldn't remove password protection. The previous settings may still apply.");
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (busy || (!hasPassword && !draft.trim())) return;
    setBusy(true);
    setError(null);
    try {
      await onSetProtection({
        password: draft.trim() || undefined,
        expiresAt:
          !expiryDirty
            ? undefined
            : expiry === "never"
              ? null
              : new Date(Date.now() + Number(expiry) * DAY_MS).toISOString(),
      });
      setPasswordOn(true);
      setDraft("");
      setVisible(false);
      setLocalLegacyExpiry(undefined);
      setExpiryDirty(false);
    } catch {
      setError("Couldn't save password protection. The previous settings may still apply.");
    } finally {
      setBusy(false);
    }
  };

  const clearLegacyExpiry = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSetProtection({ password: null, expiresAt: null });
      setLocalLegacyExpiry(undefined);
      setExpiry("never");
    } catch {
      setError("Couldn't remove the legacy expiry.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div
        data-share-primary-row="controls"
        data-share-controls-pair
        className="flex min-h-8 min-w-0 items-center justify-between gap-2 max-sm:min-h-11"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="min-w-0 truncate text-[13px] font-medium leading-[1.25] tracking-[-0.08px] text-ink">
            <span className="max-sm:hidden">Password protection</span>
            <span className="sm:hidden">Password</span>
          </span>
          <SwitchControl
            label="Password protection"
            checked={passwordOn}
            disabled={busy}
            onChange={(nextOn) => {
              if (nextOn) {
                setPasswordOn(true);
                setDraft("");
                setVisible(false);
                setExpiry("never");
                setExpiryDirty(true);
              } else {
                void turnOff();
              }
            }}
          />
        </div>
        <Button
          variant="destructive"
          data-share-stop-row
          disabled={revokePending || busy}
          onClick={onStopSharing}
          className="max-sm:min-h-11"
        >
          Stop sharing
        </Button>
      </div>
      {passwordOn && (
        <div className="brain-share-reveal mt-2">
          <div>
            <PasswordFields
              inputRef={inputRef}
              password={draft}
              visible={visible}
              expiry={expiry}
              disabled={busy}
              onPasswordChange={setDraft}
              onVisibleChange={setVisible}
              onExpiryChange={(value) => {
                setExpiry(value);
                setExpiryDirty(true);
              }}
            />
            {hasPassword && !draft && (
              <p className="mt-1.5 text-caption font-medium text-ink-2">
                Leave blank to keep the current password.
              </p>
            )}
            <div className="mt-3 flex justify-end">
              <Button
                variant="ink"
                disabled={busy || (!hasPassword && !draft.trim())}
                onClick={() => void save()}
                className="max-sm:min-h-11"
              >
                {busy ? "Saving…" : "Save protection"}
              </Button>
            </div>
          </div>
        </div>
      )}
      {!passwordOn && localLegacyExpiry && (
        <div data-legacy-expiry className="mt-2 flex items-center gap-2">
          <p className="min-w-0 flex-1 text-caption font-medium text-ink-2">
            Legacy link expiry: {formatShareExpiry(localLegacyExpiry)}. It still applies without a password.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void clearLegacyExpiry()}
            className="min-h-8 shrink-0 text-caption font-medium text-ink-2 transition-colors hover:text-ink max-sm:min-h-11"
          >
            Remove expiry
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-caption font-medium text-red">
          {error}
        </p>
      )}
    </div>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MOBILE_VIEWPORT_QUERY = "(max-width: 639px)";

function subscribeMobileViewport(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const query = window.matchMedia(MOBILE_VIEWPORT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getMobileViewportSnapshot(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MOBILE_VIEWPORT_QUERY).matches
  );
}

function getServerMobileViewportSnapshot(): boolean {
  return false;
}

function effectiveExpiryValue(
  snapshot: ShareScopeSnapshot | null,
  rootId: string,
  fallback?: string,
): string | undefined {
  return snapshot?.rootId === rootId && snapshot.public
    ? snapshot.shareExpiresAt ?? undefined
    : fallback;
}

function isSnapshotActive(snapshot: ShareScopeSnapshot): boolean {
  return snapshot.public && !isExpired(snapshot.shareExpiresAt ?? undefined);
}

function formatShareExpiry(expiresAt: string): string {
  return expiresAt.slice(0, 10);
}

function activeScopeLabel(descendantCount: number, inherited: boolean): string {
  if (inherited) {
    return descendantCount === 0
      ? "Parent share: root page only"
      : `Parent share: ${descendantCount} ${
          descendantCount === 1 ? "descendant" : "descendants"
        }`;
  }
  return descendantCount === 0
    ? "This page only"
    : `This page + ${descendantCount} ${
        descendantCount === 1 ? "subpage" : "subpages"
      }`;
}

function isExpired(value?: string): boolean {
  if (!value) return false;
  const deadline = Date.parse(value);
  return !Number.isFinite(deadline) || deadline <= Date.now();
}

function overlapLabel(
  overlap: ShareScopeSnapshot["overlappingRoots"][number],
): string {
  const relation = overlap.relation === "ancestor" ? "shared parent" : "shared nested page";
  const status = isExpired(overlap.shareExpiresAt ?? undefined) ? "expired" : "active";
  return `${overlap.title} · ${relation} · ${status}`;
}

function expiryPreset(value?: string): ExpiryChoice {
  if (!value) return "never";
  const remaining = Date.parse(value) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "never";
  if (remaining <= 2 * DAY_MS) return "1";
  if (remaining <= 14 * DAY_MS) return "7";
  return "30";
}
