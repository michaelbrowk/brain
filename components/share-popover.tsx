"use client";

import * as Popover from "@radix-ui/react-popover";
import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ShareScopeSnapshot } from "@/lib/store/types";
import { Segmented } from "./settings/shared";
import { Button } from "./ui/button";
import { Field } from "./ui/field";
import { Icon } from "./ui/icon";

export type ShareEnableResult =
  | { status: "enabled"; snapshot: ShareScopeSnapshot }
  | { status: "conflict"; snapshot: ShareScopeSnapshot };

type Grant = { id: string; title: string };
type ExpiredGrant = Grant & { expiresAt?: string };
type ExpiryChoice = "never" | "1" | "7" | "30";
type Overlap = ShareScopeSnapshot["overlappingRoots"][number];

/* The ledger's registers come from the utilities, so the guardrails keep
   them on the ladder: the head is the Subheading (the dialog title's
   register), a label and a value share Table at 500 and differ by colour,
   a note is Caption in ink-3, which is legal on paper. */
const HEAD = "brain-share-head text-subheading text-ink";
const LABEL = "brain-share-row-label text-table font-medium text-ink-2";
const VALUE = "brain-share-row-value text-table font-medium text-ink";
const NOTE = "brain-share-row-note text-caption text-ink-3";
const COPIED = "brain-share-copied text-table font-medium text-ink";

const EXPIRY_OPTIONS: Array<{ value: ExpiryChoice; label: string }> = [
  { value: "never", label: "Never" },
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
];

/** The share card is a ledger on paper: one status sentence at the head,
 *  then a row per fact or setting with a hairline between them, and the
 *  action as the last row. One surface moves from the private review to
 *  management, and the revoke confirmation takes the last row's place. */
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
  const [copied, setCopied] = useState(false);
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
  const copiedTimer = useRef<number | null>(null);

  const verifiedDirectPublic = verified?.rootId === pageId ? verified.public : null;
  const effectiveDirectPublic =
    directOverride?.basePublic === isPublic
      ? directOverride.value
      : verifiedDirectPublic ?? isPublic;
  const directExpiry = effectiveExpiryValue(verified, pageId, expiresAt);
  const directExpired = effectiveDirectPublic && isExpired(directExpiry);
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

  useEffect(
    () => () => {
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
    },
    [],
  );

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

  const clearCopied = () => {
    if (copiedTimer.current !== null) {
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = null;
    }
    setCopied(false);
  };

  const copyLink = async () => {
    if (busy || checkingScope || !activeRootId) return;
    setBusy(true);
    setShareError(null);
    try {
      await onCopyLink(activeRootId);
      // the Link row says "Copied" with a bare check for two seconds, then
      // shows the address again; the shell's toast is unchanged
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current);
      setCopied(true);
      copiedTimer.current = window.setTimeout(() => {
        copiedTimer.current = null;
        setCopied(false);
      }, COPIED_MS);
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
    clearCopied();
    resetEnablePassword();
  };

  const view =
    confirmation && !effectiveDirectPublic ? (
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
        expiredInheritedOnly={expiredInheritedOnly}
        inheritedFrom={inheritedFrom}
        expiredInheritedFrom={expiredInheritedFrom}
        url={url}
        busy={busy}
        copied={copied}
        revokeConfirming={revokeConfirming}
        revokePending={revokePending}
        hasPassword={effectiveLocked}
        expiresAt={effectiveExpiry}
        onCopy={() => void copyLink()}
        onOpenShareSettings={onOpenShareSettings}
        onSetProtection={onSetProtection}
        onStopSharing={() => setRevokeConfirming(true)}
        onCancelRevoke={() => setRevokeConfirming(false)}
        onConfirmRevoke={() => void stopSharing()}
      />
    );

  // the paper plate: everything readable stands on it, never on the glass
  const surfaceBody = (
    <div className="brain-share-plate">
      {view}
      {shareError && <AlertRow>{shareError}</AlertRow>}
    </div>
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
              .brain-sheet the top radius and the slide keyframes. The sheet's
              20 is the plate's 10 plus this 10 of padding. */}
          <Dialog.Content
            aria-label="Share settings"
            aria-describedby={undefined}
            data-share-mobile-surface
            className="brain-dialog brain-sheet font-system fixed inset-x-0 bottom-0 z-[calc(var(--z-modal)+1)] w-screen overflow-y-auto p-2.5 pb-[max(10px,env(safe-area-inset-bottom))] outline-none"
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
          className="brain-share-popover z-[var(--z-popover)] outline-none max-sm:hidden"
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
      <h2 className={HEAD}>Checking which pages will be shared…</h2>
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
  const overlaps = snapshot.overlappingRoots;
  const blocked = overlaps.length > 0;
  return (
    <div data-share-state="review">
      <h2 className={HEAD}>
        {readerClause(passwordOn)} will be able to read {pagesClause(total)}.
      </h2>

      {blocked ? (
        <div
          data-share-overlap-blocker
          data-share-row="overlap"
          className="brain-share-row brain-share-row-stack"
        >
          <span className={`${VALUE} brain-share-row-wrap`}>
            This scope already overlaps{" "}
            {overlaps.length === 1 ? "another shared page" : "other shared pages"}.
          </span>
          <ul className="brain-share-row-list">
            {overlaps.map((overlap) => (
              <li key={overlap.rootId} className={NOTE}>
                {overlap.title} · {relationLabel(overlap)}
                {isExpired(overlap.shareExpiresAt ?? undefined) ? " · expired" : ""}
              </li>
            ))}
          </ul>
          <span className={NOTE}>
            Resolve the existing grant before creating this link.
          </span>
        </div>
      ) : (
        <>
          <Row id="read" label="Who can read">
            <span className={VALUE}>{readerValue(passwordOn)}</span>
          </Row>
          {/* The "Who can edit" row lands with the editable-shares feature. */}
          <SwitchRow
            id="password"
            label="Password"
            switchLabel="Password protection"
            checked={passwordOn}
            disabled={busy}
            onChange={onPasswordToggle}
          />
          {passwordOn && (
            <Reveal>
              <PasswordField
                inputRef={passwordRef}
                password={password}
                visible={passwordVisible}
                disabled={busy}
                onPasswordChange={onPasswordChange}
                onVisibleChange={onPasswordVisibleChange}
              />
              <ExpiryRow value={expiry} disabled={busy} onChange={onExpiryChange} />
            </Reveal>
          )}
        </>
      )}

      {blocked
        ? onOpenShareSettings && (
            <ActionRow>
              <Button
                variant="quiet"
                onClick={onOpenShareSettings}
                className="max-sm:min-h-11"
              >
                Review shared links
              </Button>
            </ActionRow>
          )
        : (
            <ActionRow>
              <Button
                variant="ink"
                disabled={busy || (passwordOn && !password.trim())}
                onClick={onShare}
                className="max-sm:min-h-11"
              >
                {busy ? "Sharing…" : `Share ${pagesClause(total)}`}
              </Button>
            </ActionRow>
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
  expiredInheritedOnly,
  inheritedFrom,
  expiredInheritedFrom,
  url,
  busy,
  copied,
  revokeConfirming,
  revokePending,
  hasPassword,
  expiresAt,
  onCopy,
  onOpenShareSettings,
  onSetProtection,
  onStopSharing,
  onCancelRevoke,
  onConfirmRevoke,
}: {
  activeRootId: string | null;
  activeSnapshot: ShareScopeSnapshot | null;
  checkingScope: boolean;
  directPublic: boolean;
  directExpired: boolean;
  expiredInheritedOnly: boolean;
  inheritedFrom?: Grant;
  expiredInheritedFrom?: ExpiredGrant;
  url: string;
  busy: boolean;
  copied: boolean;
  revokeConfirming: boolean;
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
  onCancelRevoke: () => void;
  onConfirmRevoke: () => void;
}) {
  // the head states what the active link does; the active link is the
  // page's own while it works, and the parent's where the page is reached
  // through one
  const activeLocked = activeSnapshot?.shareLocked ?? hasPassword;
  const head = expiredInheritedOnly
    ? `Parent share through ${expiredInheritedFrom?.title} is expired.`
    : directExpired && !inheritedFrom
      ? "This page's own link is expired."
      : activeSnapshot
        ? `${readerClause(activeLocked)} can read ${pagesClause(activeSnapshot.descendantCount + 1)}.`
        : checkingScope
          ? "Refreshing shared page count…"
          : directExpired
            ? "This page's own link is expired."
            : "Shared. The exact page count is unavailable.";
  const readValue = expiredInheritedOnly
    ? "Link expired"
    : directPublic && directExpired && !inheritedFrom
      ? "Link expired"
      : readerValue(activeLocked);
  const throughNote =
    inheritedFrom && directPublic
      ? directExpired
        ? `This page's own link is expired. Active access comes through ${inheritedFrom.title}.`
        : "Stopping this page's own link will not make it private."
      : undefined;
  const locked = revokeConfirming || revokePending;

  const action = (securityBusy: boolean) =>
    revokeConfirming ? (
      <RevokeRow
        pending={revokePending}
        inheritedFrom={inheritedFrom}
        overlaps={activeSnapshot?.overlappingRoots ?? []}
        onCancel={onCancelRevoke}
        onConfirm={onConfirmRevoke}
      />
    ) : (
      <ActionRow>
        <Button
          variant="destructive"
          data-share-stop-row
          disabled={revokePending || securityBusy}
          onClick={onStopSharing}
          className="max-sm:min-h-11"
        >
          Stop sharing
        </Button>
      </ActionRow>
    );

  return (
    <div data-share-state={revokeConfirming ? "revoke" : "manage"}>
      <h2 className={HEAD}>{head}</h2>

      <LinkRow
        url={url}
        copied={copied}
        disabled={busy || checkingScope || !activeRootId || locked}
        linked={!!activeRootId && !revokePending}
        onCopy={onCopy}
      />

      <Row id="read" label="Who can read">
        <span className={VALUE}>{readValue}</span>
      </Row>
      {/* The "Who can edit" row lands with the editable-shares feature. */}

      {(inheritedFrom || expiredInheritedOnly) && (
        <ParentRow
          grant={inheritedFrom ?? expiredInheritedFrom}
          note={throughNote}
          multiple={!!inheritedFrom && directPublic}
          onOpen={onOpenShareSettings}
        />
      )}

      {expiredInheritedFrom &&
        !expiredInheritedOnly &&
        (!inheritedFrom || expiredInheritedFrom.id !== inheritedFrom.id) && (
          <NoteRow id="expired-parent">
            Parent share through {expiredInheritedFrom.title} is expired.
            {inheritedFrom ? ` Active access comes through ${inheritedFrom.title}.` : ""}
          </NoteRow>
        )}

      {activeSnapshot && activeSnapshot.overlappingRoots.length > 0 && (
        <div
          data-existing-share-overlaps
          data-share-row="overlaps"
          className="brain-share-row brain-share-row-stack"
        >
          <span className={LABEL}>Other public links</span>
          <ul className="brain-share-row-list">
            {activeSnapshot.overlappingRoots.map((overlap) => (
              <li key={overlap.rootId} className={NOTE}>
                {overlapLabel(overlap)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {directPublic && (
        <ManagementSecurity
          key={`${hasPassword}:${expiresAt ?? "never"}`}
          hasPassword={hasPassword}
          expiresAt={expiresAt}
          locked={locked}
          onSetProtection={onSetProtection}
          renderAction={action}
        />
      )}

    </div>
  );
}

/** The last row while a stop is being confirmed: the question, what stays
 *  reachable after it, and the two answers. */
function RevokeRow({
  pending,
  inheritedFrom,
  overlaps,
  onCancel,
  onConfirm,
}: {
  pending: boolean;
  inheritedFrom?: Grant;
  overlaps: Overlap[];
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const active = (relation: Overlap["relation"]) =>
    overlaps.filter(
      (overlap) =>
        overlap.relation === relation && !isExpired(overlap.shareExpiresAt ?? undefined),
    ).length;
  const expired = (relation: Overlap["relation"]) =>
    overlaps.filter(
      (overlap) =>
        overlap.relation === relation && isExpired(overlap.shareExpiresAt ?? undefined),
    ).length;
  const activeParents = active("ancestor");
  const activeChildren = active("descendant");
  const expiredParents = expired("ancestor");
  const expiredChildren = expired("descendant");
  return (
    <div
      data-share-row="action"
      data-share-revoke-row
      className="brain-share-row brain-share-row-act brain-share-row-confirm"
    >
      <div className="brain-share-row-stack">
        <span className={`${VALUE} brain-share-row-wrap`}>
          {pending
            ? "Stopping sharing…"
            : inheritedFrom
              ? "This page's own link stops working."
              : "Everyone with the link loses access."}
        </span>
        <span className={NOTE}>
          {inheritedFrom
            ? `Access through ${inheritedFrom.title} will remain.`
            : "The link will stop working."}
        </span>
        {activeParents > 0 && (
          <span className={NOTE}>{`Stopping this root link will leave ${activeParents} parent public ${activeParents === 1 ? "link" : "links"} active.`}</span>
        )}
        {activeChildren > 0 && (
          <span className={NOTE}>{`Stopping this root link will leave ${activeChildren} nested public ${activeChildren === 1 ? "link" : "links"} active.`}</span>
        )}
        {expiredParents > 0 && (
          <span className={NOTE}>{`The expired parent ${expiredParents === 1 ? "link remains" : "links remain"} recorded but ${expiredParents === 1 ? "does" : "do"} not provide access.`}</span>
        )}
        {expiredChildren > 0 && (
          <span className={NOTE}>{`The expired nested ${expiredChildren === 1 ? "link remains" : "links remain"} recorded but ${expiredChildren === 1 ? "does" : "do"} not provide access.`}</span>
        )}
        {pending && (
          <span className={NOTE}>Waiting for durable confirmation…</span>
        )}
      </div>
      <div className="brain-share-row-actions">
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

/* The ledger's parts. Rows are plain divs on a hairline; the head is the one
   sentence above them; the action row closes the plate. */

function Row({
  id,
  label,
  note,
  className = "",
  children,
}: {
  id: string;
  label: string;
  note?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div data-share-row={id} className={`brain-share-row ${className}`}>
      <span className={LABEL}>
        {label}
        {note && <span className={NOTE}>{note}</span>}
      </span>
      {children}
    </div>
  );
}

function NoteRow({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <div data-share-row={id} className="brain-share-row brain-share-row-stack">
      <span className={`${NOTE} brain-share-row-note-lone`}>{children}</span>
    </div>
  );
}

function AlertRow({ children }: { children: React.ReactNode }) {
  return (
    <p
      role="alert"
      data-share-row="alert"
      className="brain-share-row brain-share-row-stack text-caption font-medium text-red"
    >
      {children}
    </p>
  );
}

function ActionRow({ children }: { children: React.ReactNode }) {
  return (
    <div data-share-row="action" className="brain-share-row brain-share-row-act">
      {children}
    </div>
  );
}

function Reveal({ children }: { children: React.ReactNode }) {
  return (
    <div className="brain-share-reveal">
      <div>{children}</div>
    </div>
  );
}

function LinkRow({
  url,
  copied,
  disabled,
  linked,
  onCopy,
}: {
  url: string;
  copied: boolean;
  disabled: boolean;
  linked: boolean;
  onCopy: () => void;
}) {
  const shown = url ? url.replace(/^https?:\/\//, "") : "No active public link";
  return (
    <div
      data-share-row="link"
      data-share-link-row
      className="brain-share-row brain-share-row-link"
    >
      <span className={LABEL}>Link</span>
      {copied ? (
        <span role="status" className={COPIED}>
          Copied
        </span>
      ) : linked ? (
        // the address is the way to the public page, so it keeps the width
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          data-share-url
          aria-label="Open public page"
          title="Open public page"
          className="brain-share-url brain-touch-hit"
        >
          {shown}
        </a>
      ) : (
        <span
          data-share-url
          title={url || "No active public link"}
          aria-label={url ? `Public link: ${url}` : "No active public link"}
          className="brain-share-url"
        >
          {shown}
        </span>
      )}
      <button
        type="button"
        data-size="28"
        data-state={copied ? "done" : undefined}
        disabled={disabled}
        onClick={onCopy}
        aria-label={copied ? "Link copied" : "Copy link"}
        title="Copy link"
        className="icon-btn focus-inset brain-touch-hit brain-share-row-btn"
      >
        <Icon name={copied ? "check-linear" : "copy-linear"} size={16} />
      </button>
    </div>
  );
}

/** The parent a page is reached through. Its title is the way there. */
function ParentRow({
  grant,
  note,
  multiple,
  onOpen,
}: {
  grant?: Grant;
  note?: string;
  multiple: boolean;
  onOpen?: () => void;
}) {
  if (!grant) return null;
  return (
    <Row
      id="through"
      label={multiple ? "Also shared through" : "Shared through"}
      note={note}
      className={multiple ? "brain-share-row-multiple" : ""}
    >
      {onOpen ? (
        <Button
          variant="quiet"
          aria-label="Go to shared parent"
          title="Go to shared parent"
          onClick={onOpen}
          className="brain-share-row-parent max-sm:min-h-11"
        >
          <span className="truncate">{grant.title}</span>
        </Button>
      ) : (
        <span className={`${VALUE} truncate`}>{grant.title}</span>
      )}
    </Row>
  );
}

/** The v2 switch: blue track when on, an ink-3 track when off (at least
 *  3:1 against paper and the regular glass, WCAG 1.4.11), the knob pinned at
 *  3px and travelling 16px on transform (compositor), never `left`. */
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

function SwitchRow({
  id,
  label,
  switchLabel,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  switchLabel: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div data-share-row={id} data-share-setting-row className="brain-share-row">
      <span className={LABEL}>{label}</span>
      <SwitchControl
        label={switchLabel}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
    </div>
  );
}

function PasswordField({
  inputRef,
  password,
  visible,
  disabled,
  hint,
  onPasswordChange,
  onVisibleChange,
}: {
  inputRef?: React.RefObject<HTMLInputElement | null>;
  password: string;
  visible: boolean;
  disabled?: boolean;
  hint?: string;
  onPasswordChange: (value: string) => void;
  onVisibleChange: (visible: boolean) => void;
}) {
  return (
    <div className="brain-share-reveal-field">
      <Field
        ref={inputRef}
        id="share-password"
        type={visible ? "text" : "password"}
        aria-label="Share password"
        value={password}
        disabled={disabled}
        onChange={(event) => onPasswordChange(event.target.value)}
        className="brain-share-password-field max-sm:min-h-11"
        trailing={
          <button
            type="button"
            aria-label={visible ? "Hide password" : "Show password"}
            aria-pressed={visible}
            disabled={disabled}
            onClick={() => onVisibleChange(!visible)}
            className="brain-share-eye brain-touch-hit"
          >
            <Icon name={visible ? "eye-closed-linear" : "eye-linear"} size={16} />
          </button>
        }
      />
      {hint && <p className={NOTE}>{hint}</p>}
    </div>
  );
}

function ExpiryRow({
  value,
  disabled,
  onChange,
}: {
  value: ExpiryChoice;
  disabled?: boolean;
  onChange: (value: ExpiryChoice) => void;
}) {
  return (
    <div data-share-row="expires" className="brain-share-row brain-share-row-expires">
      <span className={LABEL}>Expires</span>
      <Segmented
        label="Link expiry"
        value={value}
        options={EXPIRY_OPTIONS}
        disabled={disabled}
        onChange={(next) => onChange(next as ExpiryChoice)}
      />
    </div>
  );
}

function ManagementSecurity({
  hasPassword,
  expiresAt,
  locked,
  onSetProtection,
  renderAction,
}: {
  hasPassword: boolean;
  expiresAt?: string;
  locked: boolean;
  onSetProtection: (input: {
    password?: string | null;
    expiresAt?: string | null;
  }) => void | Promise<void>;
  renderAction: (busy: boolean) => React.ReactNode;
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
  const disabled = busy || locked;

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
    <>
      <SwitchRow
        id="password"
        label="Password"
        switchLabel="Password protection"
        checked={passwordOn}
        disabled={disabled}
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
      {passwordOn && (
        <Reveal>
          <PasswordField
            inputRef={inputRef}
            password={draft}
            visible={visible}
            disabled={disabled}
            hint={hasPassword && !draft ? "Leave blank to keep the current password." : undefined}
            onPasswordChange={setDraft}
            onVisibleChange={setVisible}
          />
          <ExpiryRow
            value={expiry}
            disabled={disabled}
            onChange={(value) => {
              setExpiry(value);
              setExpiryDirty(true);
            }}
          />
          <div className="brain-share-reveal-foot">
            <Button
              variant="ink"
              disabled={disabled || (!hasPassword && !draft.trim())}
              onClick={() => void save()}
              className="max-sm:min-h-11"
            >
              {busy ? "Saving…" : "Save protection"}
            </Button>
          </div>
        </Reveal>
      )}
      {!passwordOn && localLegacyExpiry && (
        <div data-legacy-expiry data-share-row="expires" className="brain-share-row">
          <span className={LABEL}>
            Expires
            <span className={NOTE}>
              Legacy expiry. It still applies without a password.
            </span>
          </span>
          <span className={VALUE}>
            {formatShareExpiry(localLegacyExpiry)}
          </span>
          <Button
            variant="quiet"
            disabled={disabled}
            onClick={() => void clearLegacyExpiry()}
            className="max-sm:min-h-11"
          >
            Remove expiry
          </Button>
        </div>
      )}
      {error && <AlertRow>{error}</AlertRow>}
      {renderAction(busy)}
    </>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;
const COPIED_MS = 2000;
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

/** Who the link admits, as the head sentence's subject. */
function readerClause(locked: boolean): string {
  return locked ? "Anyone with the link and the password" : "Anyone with the link";
}

/** The same fact as the "Who can read" row's value. */
function readerValue(locked: boolean): string {
  return locked ? "Link and password" : "Anyone with the link";
}

/** "this page" or "15 pages", the count held to its noun. */
function pagesClause(total: number): string {
  return total === 1 ? "this page" : `${total} pages`;
}

function isExpired(value?: string): boolean {
  if (!value) return false;
  const deadline = Date.parse(value);
  return !Number.isFinite(deadline) || deadline <= Date.now();
}

function relationLabel(overlap: Overlap): string {
  return overlap.relation === "ancestor" ? "shared parent" : "shared nested page";
}

function overlapLabel(overlap: Overlap): string {
  const status = isExpired(overlap.shareExpiresAt ?? undefined) ? "expired" : "active";
  return `${overlap.title} · ${relationLabel(overlap)} · ${status}`;
}

function expiryPreset(value?: string): ExpiryChoice {
  if (!value) return "never";
  const remaining = Date.parse(value) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "never";
  if (remaining <= 2 * DAY_MS) return "1";
  if (remaining <= 14 * DAY_MS) return "7";
  return "30";
}
