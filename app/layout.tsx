import type { Metadata, Viewport } from "next";
import { ThemeProvider } from "./providers";
import { InputModality } from "@/components/input-modality";
import { StaleChunkRecovery } from "@/components/stale-chunk-recovery";
import "./globals.css";

export const metadata: Metadata = {
  title: "Brain",
  description: "A quiet place to think",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Brain" },
  icons: {
    icon: "/icon.png",
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover", // draw under the notch/home-indicator, we pad via safe-area
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#faf9f6" },
    { media: "(prefers-color-scheme: dark)", color: "#1e1d1b" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className="h-full"
      data-bg="still"
    >
      <head>
        {/* Apply the heading-font and background-mode settings before paint (no
            FOUC), and stamp the platform, which decides whether a shortcut chip
            reads ⌘K or Ctrl+K (globals.css, .kbd-pc). The stamp goes first: the
            localStorage reads below throw in a browser set to block site data,
            and the keyboard hints are not theirs to lose. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var d=document.documentElement,p=(navigator.userAgentData&&navigator.userAgentData.platform)||navigator.platform||"";d.dataset.platform=/mac|iphone|ipad|ipod/i.test(p)?"mac":"pc";var h=localStorage.getItem("brain-headings");if(h==="serif")d.dataset.headings=h;if(localStorage.getItem("brain-bg")==="live")d.dataset.bg="live"}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full bg-paper text-ink">
        <ThemeProvider>
          <InputModality />
          <StaleChunkRecovery />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
