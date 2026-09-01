"use client";

// The settings surface (DESIGN.md v2, "Settings — V1"): a first-class canvas
// surface inside the shell at /settings/[section]. Desktop shows the active
// section as a 640 paper column under the breadcrumb pill — the section list
// lives in the sidebar slot. Mobile is a System-Settings drill-down: the
// root list at /settings, one section per screen, the header in flow.
// Presentational — navigation (pushState / replaceState / back) lives in
// <Shell>, which hands it down as callbacks.

import type { TreeNode } from "@/lib/store/types";
import { Icon } from "../ui/icon";
import {
  SETTINGS_SECTION_META,
  SETTINGS_SECTION_ORDER,
  settingsSectionLabel,
  type SettingsSection,
} from "./sections";
import { AppearanceSection } from "./appearance-section";
import { MailSection } from "./mail-section";
import { ConnectionsSection } from "./connections-section";
import { SharingSection } from "./sharing-section";
import { DataSection } from "./data-section";
import { AccountSection } from "./account-section";

export interface SettingsSurfaceProps {
  /** The open section; null renders the mobile root list. */
  section: SettingsSection | null;
  tree: TreeNode[];
  /** Deep link /settings/mail?account=<id>: the account whose details open. */
  mailAccountId: string | null;
  onSelectSection: (section: SettingsSection) => void;
  /** Mobile back: a section returns to the root list, the root exits. */
  onBack: () => void;
  onOpenMail: () => void;
  onMailAccountStatusChange?: (configured: boolean) => void;
  onUnshare: (id: string) => void | Promise<void>;
  onCopyShareLink: (id: string) => void | Promise<void>;
  onToast: (title: string) => void;
}

export function SettingsSurface({
  section,
  tree,
  mailAccountId,
  onSelectSection,
  onBack,
  onOpenMail,
  onMailAccountStatusChange,
  onUnshare,
  onCopyShareLink,
  onToast,
}: SettingsSurfaceProps) {
  if (section === null) {
    // The root list is a mobile screen; desktop normalises /settings to
    // /settings/appearance before this ever paints.
    return (
      <div data-testid="mobile-settings-root" className="brain-settings-page md:hidden">
        <MobileSettingsHeader label="Settings" onBack={onBack} />
        <nav aria-label="Settings sections" className="brain-settings">
          <div className="brain-settings-group">
            {SETTINGS_SECTION_ORDER.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => onSelectSection(entry)}
                className="brain-settings-row brain-settings-rootrow brain-touch-min focus-inset"
              >
                <span className="brain-settings-rootrow-glyph" aria-hidden>
                  <Icon name={SETTINGS_SECTION_META[entry].icon} size={18} />
                </span>
                <span className="min-w-0 flex-1 truncate text-table font-medium text-ink">
                  {SETTINGS_SECTION_META[entry].label}
                </span>
                <Icon
                  name="alt-arrow-right-linear"
                  size={16}
                  className="text-ink-4"
                />
              </button>
            ))}
          </div>
        </nav>
      </div>
    );
  }

  return (
    <div data-testid="mobile-settings-detail" className="brain-settings-page">
      <div className="md:hidden">
        <MobileSettingsHeader
          label={settingsSectionLabel(section)}
          onBack={onBack}
        />
      </div>
      <div className="brain-settings">
        {section === "appearance" && <AppearanceSection />}
        {section === "mail" && (
          <MailSection
            onOpenMail={onOpenMail}
            onAccountStatusChange={onMailAccountStatusChange}
            onToast={onToast}
            initialAccountId={mailAccountId}
          />
        )}
        {section === "connections" && <ConnectionsSection onToast={onToast} />}
        {section === "sharing" && (
          <SharingSection
            tree={tree}
            onUnshare={onUnshare}
            onCopyShareLink={onCopyShareLink}
          />
        )}
        {section === "data" && <DataSection onToast={onToast} />}
        {section === "account" && <AccountSection onToast={onToast} />}
      </div>
    </div>
  );
}

/** The mobile header of a settings screen: Back at the left, the screen
 *  name centred. In flow on paper — the surface has no floating chrome of
 *  its own on mobile. */
function MobileSettingsHeader({
  label,
  onBack,
}: {
  label: string;
  onBack: () => void;
}) {
  return (
    <header className="brain-settings-mobile-head">
      <button
        type="button"
        aria-label="Back"
        onClick={onBack}
        className="brain-settings-mobile-back brain-touch-hit focus-inset"
      >
        <Icon name="alt-arrow-left" size={16} />
        <span>Back</span>
      </button>
      <span className="text-h3 text-ink">{label}</span>
      <span aria-hidden="true" />
    </header>
  );
}
