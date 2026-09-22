// The settings surface's section registry: the nine sections in their fixed
// order, the URL slug of each (it IS the id), and the sidebar row metadata.
// Server routes validate against SETTINGS_SECTION_ORDER; the shell reducer
// stores a SettingsSection (or null for the mobile root list).
//
// The order runs from what an owner changes to what an owner only reads.
// Notifications sits after Connections because both are about what reaches
// this instance from outside it, and before Sharing because Sharing is about
// what leaves. Donate sits last, past Account: it configures nothing about
// this instance, and it belongs beside the About group that already names the
// project.

export type SettingsSection =
  | "appearance"
  | "modules"
  | "mail"
  | "connections"
  | "notifications"
  | "sharing"
  | "data"
  | "account"
  | "donate";

export const SETTINGS_SECTION_ORDER: SettingsSection[] = [
  "appearance",
  "modules",
  "mail",
  "connections",
  "notifications",
  "sharing",
  "data",
  "account",
  "donate",
];

export const SETTINGS_SECTION_META: Record<
  SettingsSection,
  { label: string; icon: string }
> = {
  appearance: { label: "Appearance", icon: "palette" },
  // The one section that is about what this installation IS rather than how
  // it looks or what it connects to, so it sits second: an owner reaches it
  // once, on the day they decide, and then never again.
  modules: { label: "Modules", icon: "widget-2" },
  mail: { label: "Mail", icon: "letter" },
  connections: { label: "Connections", icon: "plug-circle" },
  notifications: { label: "Notifications", icon: "bell" },
  sharing: { label: "Sharing", icon: "earth" },
  data: { label: "Data", icon: "document-text" },
  account: { label: "Account", icon: "user-circle" },
  donate: { label: "Donate", icon: "heart" },
};

/** The sections this installation draws. Mail is the only one a switch takes
 *  away: Tasks has no section of its own, and Modules is how a module comes
 *  back, so it is never hidden. A hidden section stays a legal slug and
 *  `isSettingsSection` still accepts it, because the deep link normalises
 *  (app/settings/[section]/page.tsx) rather than answering 404 at a stale
 *  bookmark. */
export function visibleSettingsSections(modules: {
  mail: boolean;
  tasks: boolean;
}): SettingsSection[] {
  return SETTINGS_SECTION_ORDER.filter(
    (section) => section !== "mail" || modules.mail,
  );
}

export function isSettingsSection(value: unknown): value is SettingsSection {
  return SETTINGS_SECTION_ORDER.includes(value as SettingsSection);
}

export function settingsSectionLabel(section: SettingsSection): string {
  return SETTINGS_SECTION_META[section].label;
}

/** The canonical path of a section (the mobile root list lives at /settings). */
export function settingsPath(section: SettingsSection | null): string {
  return section ? `/settings/${section}` : "/settings";
}

/** Parse a location pathname into a settings section, `null` for the root
 *  list, or `undefined` when the path is not a settings URL at all. */
export function parseSettingsPath(
  pathname: string,
): SettingsSection | null | undefined {
  const match = /^\/settings(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return undefined;
  if (!match[1]) return null;
  return isSettingsSection(match[1]) ? match[1] : undefined;
}
