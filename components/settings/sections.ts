// The settings surface's section registry: the six sections in their fixed
// order, the URL slug of each (it IS the id), and the sidebar row metadata.
// Server routes validate against SETTINGS_SECTION_ORDER; the shell reducer
// stores a SettingsSection (or null for the mobile root list).

export type SettingsSection =
  | "appearance"
  | "mail"
  | "connections"
  | "sharing"
  | "data"
  | "account";

export const SETTINGS_SECTION_ORDER: SettingsSection[] = [
  "appearance",
  "mail",
  "connections",
  "sharing",
  "data",
  "account",
];

export const SETTINGS_SECTION_META: Record<
  SettingsSection,
  { label: string; icon: string }
> = {
  appearance: { label: "Appearance", icon: "palette" },
  mail: { label: "Mail", icon: "letter" },
  connections: { label: "Connections", icon: "plug-circle" },
  sharing: { label: "Sharing", icon: "earth" },
  data: { label: "Data", icon: "document-text" },
  account: { label: "Account", icon: "user-circle" },
};

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
