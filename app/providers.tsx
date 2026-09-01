"use client";

import { ThemeProvider as NextThemes } from "next-themes";
import { MotionConfig } from "framer-motion";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemes
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
    >
      {/* framer-motion ignores the CSS reduced-motion block — this makes it comply */}
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </NextThemes>
  );
}
