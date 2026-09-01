"use client";

// Appearance: theme, the reading typeface (System / Literata — the mono
// option was retired with the settings surface), and the background under
// glass (Still / Live, the phase-0 `setBackgroundMode`).

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import {
  getBackgroundMode,
  getHeadingFont,
  setBackgroundMode,
  setHeadingFont,
  type BackgroundMode,
  type HeadingFont,
} from "@/lib/appearance";
import { SettingsGroup, SettingsRow, Segmented } from "./shared";

export function AppearanceSection() {
  const { theme, setTheme } = useTheme();
  const [headings, setHeadings] = useState<HeadingFont>("sans");
  const [background, setBackground] = useState<BackgroundMode>("still");

  // Both settings live on <html> (written before first paint by the layout
  // inline script) — read them after mount, deferred a tick so hydration
  // stays clean and the effect never renders in cascade.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setHeadings(getHeadingFont());
      setBackground(getBackgroundMode());
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const applyHeadings = (font: HeadingFont) => {
    setHeadings(font);
    setHeadingFont(font);
  };

  const applyBackground = (mode: BackgroundMode) => {
    setBackground(mode);
    setBackgroundMode(mode);
  };

  return (
    <div className="space-y-7">
      <SettingsGroup>
        <SettingsRow label="Theme" hint="Auto matches your system">
          <Segmented
            label="Theme"
            value={theme ?? "system"}
            options={[
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
              { value: "system", label: "Auto" },
            ]}
            onChange={setTheme}
          />
        </SettingsRow>
        <SettingsRow
          label="Reading typeface"
          hint="Titles and headings across all pages"
        >
          <Segmented
            label="Reading typeface"
            value={headings}
            options={[
              { value: "sans", label: "System" },
              { value: "serif", label: "Literata" },
            ]}
            onChange={(v) => applyHeadings(v as HeadingFont)}
          />
        </SettingsRow>
        <SettingsRow
          label="Background"
          hint="Live drifts the tints behind the glass"
        >
          <Segmented
            label="Background"
            value={background}
            options={[
              { value: "still", label: "Still" },
              { value: "live", label: "Live" },
            ]}
            onChange={(v) => applyBackground(v as BackgroundMode)}
          />
        </SettingsRow>
      </SettingsGroup>
      <p
        aria-hidden="true"
        className="px-1 text-[17px] font-semibold text-ink"
        style={{ fontFamily: "var(--font-headings)" }}
      >
        The quick brown fox
      </p>
    </div>
  );
}
