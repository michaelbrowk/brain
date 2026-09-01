"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Icon } from "@/components/ui/icon";
import { ScrollEdge } from "@/components/ui/scroll-edge";
import { Background } from "@/components/ui/background";
import { getBackgroundMode, setBackgroundMode, type BackgroundMode } from "@/lib/appearance";
import { ComponentsSection } from "./components-section";
import { flattenStandTree, type StandPage } from "./sample-fixtures";

type Fallback = "none" | "matte" | "contrast";

const MATERIALS = [
  { key: "thin", cls: "mat-thin", label: "thin", where: "chip · handle · tooltip · kbd" },
  { key: "reg", cls: "mat-reg", label: "regular", where: "pills · menus · popovers" },
  { key: "thick", cls: "mat-thick", label: "thick", where: "sidebar · palette · sheets" },
] as const;

const REGISTERS = [
  { cls: "text-title", name: "Title", spec: "30 / 700 / 1.15 / −0.02em", where: "page title" },
  { cls: "text-heading", name: "Heading", spec: "22 / 700 / 1.2 / −0.015em", where: "H1 in a document" },
  { cls: "text-subheading", name: "Subheading", spec: "17 / 600 / 1.3 / −0.02em", where: "H2, lead, dialog title" },
  { cls: "text-h3", name: "H3", spec: "15 / 600 / 1.35 / −0.01em", where: "H3, settings groups" },
  { cls: "text-body", name: "Body", spec: "16 / 400 / 1.5 / −0.2px", where: "editor, hub, settings copy" },
  { cls: "text-table", name: "Table", spec: "14 / 400 / 1.35 / −0.15px · tabular", where: "tables, mail list" },
  { cls: "text-control", name: "Control", spec: "13 / 500 / 1 / −0.08px", where: "sidebar, pills, menus, buttons" },
  { cls: "text-label", name: "Label", spec: "11 / 600 / 18px / +0.06px", where: "Pinned, Pages, menu sections" },
  { cls: "text-caption", name: "Caption", spec: "12 / 400 / 1.35 / 0", where: "timestamps, captions" },
  { cls: "text-kbd", name: "Kbd", spec: "11 / 500 / 1 / +0.06px", where: "shortcuts" },
] as const;

const TABLE_ROWS = [
  ["Broad beans", "wk 09", "wk 11", "wk 10", "wk 12", "wk 07"],
  ["Radish", "wk 12", "wk 12", "wk 14", "wk 13", "wk 09"],
  ["Carrots", "wk 13", "wk 15", "wk 14", "wk 16", "wk 10"],
  ["Chard", "wk 15", "wk 14", "wk 16", "wk 15", "wk 11"],
  ["Beetroot", "wk 14", "wk 13", "wk 15", "wk 14", "wk 12"],
  ["Leeks", "wk 16", "wk 18", "wk 17", "wk 19", "wk 13"],
  ["Pumpkin", "wk 19", "wk 20", "wk 18", "wk 21", "wk 15"],
  ["Kale", "wk 21", "wk 22", "wk 20", "wk 23", "wk 17"],
];

const LOREM =
  "The order below is the one the beds go in, not a promise about the weather. Weeks count from the first Monday in January, and anything raised under glass runs two or three weeks ahead of the same crop outdoors. Dates move by hand once the nights stop freezing, which in most years is somewhere in the middle of April.";
const LOREM_RU =
  "Съешь же ещё этих мягких французских булок, да выпей чаю. Лейку держим у калитки, чтобы её не искали по всему участку.";

/** <html> attributes are the source of truth (set before paint by layout.tsx
 *  and flipped by the helpers); subscribe to them instead of mirroring state. */
const subscribeHtml = (cb: () => void) => {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-bg", "data-glass-fallback", "class"],
  });
  return () => mo.disconnect();
};
const readFallback = (): Fallback => {
  const f = document.documentElement.dataset.glassFallback;
  return f === "matte" || f === "contrast" ? f : "none";
};

export function GlassStand({ tree }: { tree: StandPage[] }) {
  const { resolvedTheme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const bg = useSyncExternalStore(subscribeHtml, getBackgroundMode, () => "still" as BackgroundMode);
  const fallback = useSyncExternalStore(subscribeHtml, readFallback, () => "none" as Fallback);
  const [rows, setRows] = useState<ContrastRow[]>([]);

  const applyFallback = (f: Fallback) => {
    if (f === "none") delete document.documentElement.dataset.glassFallback;
    else document.documentElement.dataset.glassFallback = f;
  };
  const applyBg = (m: BackgroundMode) => setBackgroundMode(m);

  const recompute = useCallback(() => {
    const table = computeContrast();
    setRows(table);
    (window as unknown as { __glassContrast?: ContrastRow[] }).__glassContrast = table;
  }, []);
  useEffect(() => {
    if (!mounted) return;
    // after the theme class / fallback attribute has been applied
    const id = requestAnimationFrame(() => requestAnimationFrame(recompute));
    // OS-level toggles (reduced transparency, increased contrast) remap the
    // material tokens without touching the DOM — recompute on those too.
    const queries = ["(prefers-reduced-transparency: reduce)", "(prefers-contrast: more)"].map((q) =>
      window.matchMedia(q),
    );
    const onChange = () => requestAnimationFrame(recompute);
    queries.forEach((q) => q.addEventListener("change", onChange));
    return () => {
      cancelAnimationFrame(id);
      queries.forEach((q) => q.removeEventListener("change", onChange));
    };
  }, [mounted, resolvedTheme, fallback, recompute]);

  const isDark = mounted && resolvedTheme === "dark";

  return (
    <div
      data-glass-stand
      // the server HTML paints the stand long before React attaches its
      // handlers; `mounted` flips on the first post-hydration commit, so
      // this attribute is the "interactive now" signal the audit and the
      // shot scripts wait for before clicking anything live
      data-hydrated={mounted ? "" : undefined}
      className="relative isolate min-h-screen"
      style={{ "--stand-dark": "oklch(0.2 0.012 280)" } as React.CSSProperties}
    >
      <Background fixed />

      {/* stand toolbar — the stand's own chrome, also a live use of the pills */}
      <header className="sticky top-0 z-[var(--z-toolbar)] flex items-center gap-2 px-inset pt-inset">
        <div className="mat-reg text-control flex h-9 items-center gap-2 px-3.5">
          <span className="font-semibold">Glass · Phase 1</span>
          <span>stand</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Segment
            label="Theme"
            value={isDark ? "dark" : "light"}
            options={["light", "dark"]}
            onChange={(v) => setTheme(v)}
          />
          <Segment label="Background" value={bg} options={["still", "live"]} onChange={applyBg} />
          <Segment
            label="Fallback"
            value={fallback}
            options={["none", "matte", "contrast"]}
            onChange={applyFallback}
          />
        </div>
      </header>

      <main className="mx-auto flex max-w-[1400px] flex-col gap-14 px-inset pb-24 pt-10">
        {/* 1 — composition: the concept's chrome over a real canvas */}
        <Section n="1" title="Composition — chrome floats over the paper">
          <p className="text-body max-w-[700px] text-ink-2">
            Sidebar (thick), toolbar pills (regular), a block handle (thin) over a scrolling
            canvas with a photo cover, body text and a dense table. The cover passes under the
            pills only — the sidebar sits over paper. The canvas has no edge band: scroll the
            frame and the pills blur what passes beneath them on their own, while the tree
            fades inside the panel once it scrolls.
          </p>
          <Composition tree={tree} />
        </Section>

        {/* 2 — every material over every dirty backdrop */}
        <Section n="2" title="Materials × backdrops">
          <p className="text-body max-w-[700px] text-ink-2">
            Each material over the four stand backdrops. Text on glass is ink and ink-2 only,
            weight ≥ 500. The contrast table at the end of the page is computed from these
            swatches.
          </p>
          <div className="grid grid-cols-4 gap-3">
            <Backdrop kind="light" label="paper + sky tint (lightest)" />
            <Backdrop kind="cover" label="photo cover" />
            <Backdrop kind="table" label="dense table" />
            <Backdrop kind="mail" label="dark mail (darkest)" />
          </div>
        </Section>

        {/* 3 — fills on glass */}
        <Section n="3" title="Fills, not materials">
          <p className="text-body max-w-[700px] text-ink-2">
            What sits on glass never gets its own backdrop. Hover is an ink tint (ΔL ≥ 0.03) plus a
            second signal — the “…” button appears. Selected is a white capsule, 600, with a
            hairline shadow.
          </p>
          <div className="mat-thick w-[280px] p-3">
            <div className="stand-field text-control mb-2 flex h-8 items-center gap-2 rounded-field px-2.5 text-ink-2">
              <Icon name="magnifer" size={16} />
              <span className="flex-1">Search</span>
              <kbd className="stand-kbd-glass text-kbd rounded-sm px-1.5 py-0.5 text-ink-2">⌘K</kbd>
            </div>
            <Row icon="home" label="Rest" />
            <Row icon="inbox" label="Hover (static)" hover />
            <Row icon="letter" label="Selected" selected />
            <Row icon="star" label="Selected, hover" selected hover />
            <div className="text-label mt-2 px-2.5 text-ink-2">Pinned</div>
            <div className="grid grid-cols-2 gap-1 px-0.5">
              <Chip emoji="🧠" label="Brain" />
              <Chip emoji="🌿" label="Field Guide" active />
            </div>
            <div className="text-label mt-2 px-2.5 text-ink-2">Icon pairs</div>
            <div className="flex flex-wrap gap-2 px-2.5 py-1 text-ink-2">
              {["home", "inbox", "letter", "settings", "trash-bin-trash", "magnifer", "pen-new-square", "star", "folder", "document-text"].map(
                (n) => (
                  <span key={n} className="flex items-center gap-1" title={n}>
                    <Icon name={n} size={16} />
                    <Icon name={n} size={16} variant="bold" className="text-ink" />
                  </span>
                ),
              )}
            </div>
          </div>
        </Section>

        {/* 4 — type registers */}
        <Section n="4" title="Type registers">
          <div className="grid grid-cols-[160px_1fr_200px] gap-x-6 gap-y-4 rounded-table bg-paper p-6 shadow-[0_0_0_1px_var(--hair)]">
            {REGISTERS.map((r) => (
              <RegisterRow key={r.cls} {...r} />
            ))}
          </div>
        </Section>

        {/* 5 — scroll-edge */}
        <Section n="5" title="Scroll-edge — lists and panels only, invisible at rest">
          <p className="text-body max-w-[700px] text-ink-2">
            A mail-style list under its pill toolbar (edge-blur, two steps above, one under the
            chip) and palette results inside thick glass (edge-fade). Both start scrolled so the
            edges show. Scroll either back to the top: the edge fades out over 160ms and nothing
            is left at rest. The page canvas never gets one.
          </p>
          <div className="grid grid-cols-[1fr_300px] gap-6">
            <EdgeBlurDemo />
            <EdgeFadeDemo />
          </div>
        </Section>

        {/* 6 — focus rings + controls */}
        <Section n="6" title="Focus ring v2 and controls">
          <p className="text-body max-w-[700px] text-ink-2">
            Press Tab. The ring is 3px blue at .55, offset 2; inside capsules it sits 3px in
            (.focus-inset). The ink-filled circle is the one primary action per surface — rest,
            then hover (static, lightness ±.08); press is scale .97. Dark inverts it.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button className="mat-reg tint-hover stand-press text-control flex h-9 items-center gap-2 px-3.5">
              <Icon name="share-linear" size={16} /> Share
            </button>
            <div className="mat-reg flex h-9 items-center" role="group" aria-label="Page actions">
              <button className="stand-pill-ib focus-inset grid size-9 place-items-center rounded-pill" aria-label="Pin">
                <Icon name="pin-linear" size={16} />
              </button>
              <span className="h-[18px] w-px bg-hair" />
              <button className="stand-pill-ib focus-inset grid size-9 place-items-center rounded-pill" aria-label="More">
                <Icon name="menu-dots-bold" size={16} />
              </button>
            </div>
            <button data-accent className="stand-accent stand-press grid size-[34px] place-items-center rounded-full" aria-label="New page">
              <Icon name="add" size={18} />
            </button>
            <button data-accent data-hover className="stand-accent stand-press grid size-[34px] place-items-center rounded-full" aria-label="New page (hover)">
              <Icon name="add" size={18} />
            </button>
            <button className="stand-accent stand-press text-control h-8 rounded-md px-3">Ink primary (dialogs)</button>
            <button className="text-control stand-press h-8 rounded-md px-3 text-ink-2 hover:bg-fill-hover hover:text-ink">Quiet</button>
            <button className="text-control stand-press h-8 rounded-md px-3 text-red hover:bg-fill-hover">Delete</button>
            <a href="#contrast" className="text-body text-blue underline-offset-[3px] hover:underline">
              A link in blue
            </a>
            <kbd className="stand-kbd-paper text-kbd rounded-sm px-1.5 py-0.5 text-ink-2">⌘N</kbd>
          </div>
        </Section>

        {/* 7 — background modes */}
        <Section n="7" title="Background under glass">
          <p className="text-body max-w-[700px] text-ink-2">
            The stand itself follows the toggle in the header (html[data-bg]). Below, both modes
            forced side by side; “live” drifts on 48–64s cycles and stops under reduced motion.
          </p>
          <div className="grid grid-cols-2 gap-3">
            {(["still", "live"] as const).map((m) => (
              <div key={m} className="relative isolate h-[220px] overflow-hidden rounded-sheet shadow-[0_0_0_1px_var(--hair)]">
                <Background mode={m} />
                <div className="mat-reg text-control absolute left-3 top-3 flex h-9 items-center px-3.5">
                  {m}
                </div>
              </div>
            ))}
          </div>
        </Section>

        {/* 9 — components, five states each */}
        <Section n="9" title="Components — rest · hover · active · focus · disabled" id="components">
          <p className="text-body max-w-[700px] text-ink-2">
            Every Phase 1 component statically in its five states next to a live instance.
            Hover is one mechanism everywhere: the ink tint layered over the element&apos;s
            own fill plus a second signal. Press is scale .97 (icons .90), never the ring; the
            blue ring is keyboard focus only (Tab); disabled is opacity .4. Flip the theme and
            the fallback in the header.
          </p>
          <ComponentsSection />
        </Section>

        {/* 10 — contrast table */}
        <Section n="10" title="Contrast — computed at runtime" id="contrast">
          <p className="text-body max-w-[700px] text-ink-2">
            Material fill composited over the lightest and darkest stand backdrops (blur is
            mean-preserving; saturate is ignored), then WCAG ratio against ink, ink-2 and blue
            (the link colour, measured although links stay on paper), then the primary
            button&apos;s glyph on its fill at rest and on hover, then the Phase 1 fills on
            thick glass — chip, selected capsule, menu item hover — against ink. The gate asks
            for ≥ 4.5 everywhere. Theme: {isDark ? "dark" : "light"}, fallback: {fallback}.
          </p>
          <ContrastTable rows={rows} />
        </Section>
      </main>
    </div>
  );
}

/* ── pieces ─────────────────────────────────────────────────────────────── */

function Section({
  n,
  title,
  id,
  children,
}: {
  n: string;
  title: string;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="flex flex-col gap-5">
      <h2 className="text-heading">
        <span className="text-ink-4">{n} — </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Segment<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="mat-reg flex h-9 items-center gap-0.5 p-1" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={o === value}
          onClick={() => onChange(o)}
          className={`text-control focus-inset h-7 rounded-pill px-3 capitalize ${
            o === value ? "mat-fill-selected" : "hover:bg-[var(--fill-glass-hover)]"
          }`}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function Row({
  icon,
  label,
  hover,
  selected,
}: {
  icon: string;
  label: string;
  hover?: boolean;
  selected?: boolean;
}) {
  return (
    <button
      type="button"
      data-hover={hover ? "" : undefined}
      className={`stand-row focus-inset text-control flex h-7 w-full items-center gap-[7px] rounded-row pl-2.5 pr-1.5 text-left ${
        selected ? "mat-fill-selected" : "text-ink"
      }`}
    >
      <Icon name={icon} size={16} variant={selected ? "bold" : "linear"} className={selected ? "text-ink" : "text-ink-2"} />
      <span className="flex-1 truncate">{label}</span>
      <span className="stand-row-more grid size-5 place-items-center text-ink-2">
        <Icon name="menu-dots-bold" size={14} />
      </span>
    </button>
  );
}

function Chip({ emoji, label, active }: { emoji: string; label: string; active?: boolean }) {
  return (
    <button
      type="button"
      className={`mat-fill-chip focus-inset text-control flex h-7 items-center gap-1.5 rounded-row pl-2 pr-2.5 ${
        active ? "text-ink" : ""
      }`}
    >
      <span className="w-[18px] text-center text-[14px] leading-none">{emoji}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}

function RegisterRow({ cls, name, spec, where }: (typeof REGISTERS)[number]) {
  return (
    <>
      <div className="text-caption pt-1 text-ink-3">
        <div className="text-control text-ink">{name}</div>
        <div className="mt-1">{spec}</div>
      </div>
      <div className={cls}>
        {cls === "text-kbd" ? (
          <kbd className="stand-kbd-paper rounded-sm px-1.5 py-0.5 text-ink-2">⌘⇧K</kbd>
        ) : cls === "text-table" ? (
          <span>Radish — wk 12 · 1,440 seeds · 05.05.2027</span>
        ) : (
          <span>2026 Season Calendar — Съешь же ещё этих мягких французских булок</span>
        )}
      </div>
      <div className="text-caption pt-1 text-ink-3">{where}</div>
    </>
  );
}

function DenseTable({ compact }: { compact?: boolean }) {
  return (
    <table className="stand-table text-table w-full border-separate border-spacing-0 rounded-table shadow-[0_0_0_1px_var(--hair)]">
      <thead>
        <tr>
          {["Crop", "North", "South", "River", "Terrace", "Greenhouse"].map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(compact ? TABLE_ROWS.slice(0, 5) : TABLE_ROWS).map((r) => (
          <tr key={r[0]}>
            {r.map((c, i) => (
              <td key={i}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function MaterialSwatch({ m, sample }: { m: (typeof MATERIALS)[number]; sample: string }) {
  return (
    <div
      data-swatch={m.key}
      data-sample={sample}
      className={`${m.cls} text-control flex h-9 items-center gap-2 px-3.5 ${m.key === "thick" ? "rounded-pill" : ""}`}
    >
      <span data-ink className="text-ink">
        {m.label}
      </span>
      <span data-ink-2 className="text-ink-2">
        Edited 2h ago
      </span>
    </div>
  );
}

function Backdrop({ kind, label }: { kind: "light" | "cover" | "table" | "mail"; label: string }) {
  const bgCls =
    kind === "light" ? "stand-light" : kind === "cover" ? "stand-cover" : kind === "mail" ? "stand-mail" : "bg-paper";
  return (
    <div className="flex flex-col gap-2">
      <div className="text-caption text-ink-3">{label}</div>
      <div
        data-backdrop={kind}
        className={`relative h-[260px] overflow-hidden rounded-table shadow-[0_0_0_1px_var(--hair)] ${bgCls}`}
      >
        {kind === "table" && (
          <div className="p-2">
            <DenseTable compact />
          </div>
        )}
        {kind === "mail" && (
          <div className="text-table p-4">
            <div className="font-semibold">Your statement is ready</div>
            <div className="mt-1 opacity-70">Acme Bank · to me</div>
            <p className="mt-3 opacity-90">{LOREM}</p>
          </div>
        )}
        {kind === "light" && <p className="text-body p-4 text-ink-2">{LOREM_RU}</p>}
        <div className="absolute inset-x-3 top-3 flex flex-col items-start gap-2">
          {MATERIALS.map((m) => (
            <MaterialSwatch key={m.key} m={m} sample={kind} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Composition({ tree }: { tree: StandPage[] }) {
  const rows = flattenStandTree(tree);
  // The one selected row: the first child there is, so the indent and the
  // selected capsule are both on screen whichever tree is loaded.
  const selected = rows.findIndex((row) => row.child);
  return (
    <div className="relative h-[620px] overflow-hidden rounded-sheet shadow-[0_0_0_1px_var(--hair)]">
      <div className="absolute inset-0 overflow-y-auto bg-paper" data-composition-scroll>
        <div className="sticky top-inset z-[var(--z-toolbar)] flex items-center justify-between px-inset" style={{ paddingLeft: "calc(280px + 24px)" }}>
          <nav className="mat-reg text-control flex h-9 items-center gap-2 px-3.5" aria-label="Breadcrumb">
            <span className="text-[14px] leading-none">🌿</span>
            <a href="#" className="text-ink">
              Field Guide
            </a>
            <span className="text-ink-4">›</span>
            <span className="text-[14px] leading-none">📅</span>
            <span className="font-semibold">2026 Season Calendar</span>
          </nav>
          <div className="flex items-center gap-2">
            <button className="mat-reg tint-hover stand-press text-control flex h-9 items-center gap-2 px-3.5">
              <Icon name="share-linear" size={16} /> Share
            </button>
            <div className="mat-reg flex h-9 items-center" role="group" aria-label="Page actions">
              <button className="stand-pill-ib focus-inset grid size-9 place-items-center rounded-pill" aria-label="Pin">
                <Icon name="pin-linear" size={16} />
              </button>
              <span className="h-[18px] w-px bg-hair" />
              <button className="stand-pill-ib focus-inset grid size-9 place-items-center rounded-pill" aria-label="More">
                <Icon name="menu-dots-bold" size={16} />
              </button>
            </div>
          </div>
        </div>
        <div className="stand-cover -mt-12 h-[260px]" style={{ marginLeft: "calc(280px + 24px)" }} />
        <article className="mx-auto w-[700px] pb-16 pt-10" style={{ marginLeft: "calc(280px + 24px + (100% - 280px - 24px - 700px) / 2)" }}>
          <div className="text-[44px] leading-none">📅</div>
          <h1 className="text-title mt-3.5">2026 Season Calendar</h1>
          <p className="text-subheading mt-4">North bed | South bed | River plot | Terrace | Greenhouse</p>
          <p className="text-body mt-2.5">Sowing weeks for the five beds, kept on one page</p>
          <p className="text-caption mt-3 text-ink-3">Edited 2h ago</p>
          <div className="relative mt-5 rounded-block bg-[oklch(0.232_0.004_286_/_0.035)] shadow-[0_0_0_8px_oklch(0.232_0.004_286_/_0.035)]">
            <span className="mat-thin stand-handle absolute -left-[38px] top-1/2 grid -translate-y-1/2 place-items-center text-ink-2" aria-hidden>
              <Icon name="menu-dots-bold" size={12} />
            </span>
            <p className="text-body">{LOREM}</p>
          </div>
          <h2 className="text-heading mt-8">2. What goes in each bed</h2>
          <p className="text-body mt-3">{LOREM_RU}</p>
          <div className="mt-4">
            <DenseTable />
          </div>
          <p className="text-body mt-4">{LOREM}</p>
          <p className="text-body mt-3">{LOREM_RU}</p>
          <div className="mt-4">
            <DenseTable />
          </div>
          <p className="text-body mt-4">{LOREM}</p>
          <p className="text-body mt-3">{LOREM}</p>
          <p className="text-body mt-3 text-ink-4">Press / for a block</p>
        </article>
      </div>

      <aside className="mat-thick absolute bottom-inset left-inset top-inset z-[var(--z-sidebar)] flex w-[280px] flex-col p-3 pb-2.5">
        <div className="flex h-9 items-center justify-between pl-2.5 pr-1">
          <span className="text-h3">Brain</span>
          <button className="stand-accent stand-press grid size-[34px] place-items-center rounded-full" aria-label="New page">
            <Icon name="add" size={17} />
          </button>
        </div>
        <div className="stand-field text-control my-2 flex h-8 items-center gap-2 rounded-field px-2.5 text-ink-2">
          <Icon name="magnifer" size={16} />
          <span className="flex-1">Search</span>
          <kbd className="stand-kbd-glass text-kbd rounded-sm px-1.5 py-0.5 text-ink-2">⌘K</kbd>
        </div>
        <Row icon="sun" label="Today thoughts" />
        <Row icon="letter" label="Mail" />
        <ScrollEdge variant="fade" className="-mx-1 mt-1 flex-1 px-1" scrollerProps={{ "aria-label": "Page tree" }}>
          <div className="text-label px-2.5 pt-1 text-ink-2">Pinned</div>
          <div className="grid grid-cols-2 gap-1 px-0.5 pb-1">
            <Chip emoji="🧠" label="Brain" />
            <Chip emoji="🏠" label="Household" />
            <Chip emoji="🌿" label="Field Guide" />
            <Chip emoji="📚" label="Reading" />
          </div>
          <div className="text-label px-2.5 pt-2 text-ink-2">Pages</div>
          {rows.map((t, i) => (
            <button
              key={`${t.title}-${i}`}
              type="button"
              className={`stand-row focus-inset text-control flex h-7 w-full items-center gap-[7px] rounded-row pl-2.5 pr-2 text-left ${
                i === selected ? "mat-fill-selected" : ""
              } ${t.child ? "pl-[30px]" : ""}`}
            >
              <span className="w-[18px] text-center text-[14px] leading-none">{t.emoji}</span>
              <span className="flex-1 truncate">{t.title}</span>
            </button>
          ))}
        </ScrollEdge>
        <div className="mt-1 flex gap-1 pt-1.5">
          <Row icon="settings" label="Settings" />
          <Row icon="trash-bin-trash" label="Trash" />
        </div>
      </aside>
    </div>
  );
}

/** The §5 demos open scrolled so the edges are on screen; scrolling back up
 *  shows rest. Attach to the scroller, or to a container and name the
 *  scroller inside it. */
function useStartScrolled<T extends HTMLElement>(top: number, selector?: string) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = selector ? ref.current?.querySelector(selector) : ref.current;
    el?.scrollTo({ top });
  }, [top, selector]);
  return ref;
}

function EdgeBlurDemo() {
  const scroller = useStartScrolled<HTMLDivElement>(300);
  return (
    <div className="relative h-[420px] overflow-hidden rounded-table shadow-[0_0_0_1px_var(--hair)]">
      <div ref={scroller} className="absolute inset-0 overflow-y-auto bg-paper" data-edge-blur-scroll>
        <ScrollEdge variant="blur" position="top" steps={2} />
        <div className="sticky top-inset z-[var(--z-toolbar)] flex items-center gap-2 px-inset">
          <div className="mat-reg text-control flex h-9 items-center gap-2 px-3.5">
            <Icon name="magnifer" size={16} className="text-ink-2" /> Search mail
          </div>
          <div className="mat-reg text-control flex h-9 items-center px-3.5">Unread</div>
        </div>
        <div className="-mt-12 px-6 pb-14 pt-16">
          {Array.from({ length: 14 }, (_, i) => (
            <div key={i} className="text-table flex gap-3 border-b border-hair-soft py-2.5">
              <span className="w-[140px] shrink-0 font-semibold">Sender {i + 1}</span>
              <span className="flex-1 truncate">{LOREM}</span>
              <span className="shrink-0 text-ink-3">12:0{i % 10}</span>
            </div>
          ))}
          <div className="stand-cover my-3 h-[140px] rounded-table" />
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="text-table flex gap-3 border-b border-hair-soft py-2.5">
              <span className="w-[140px] shrink-0 font-semibold">Sender {i + 15}</span>
              <span className="flex-1 truncate">{LOREM_RU}</span>
              <span className="shrink-0 text-ink-3">11:3{i}</span>
            </div>
          ))}
        </div>
        {/* thin chip floating over the list bottom — the one-step edge exists
            only because this chrome overlaps the content (28 + 12 + 28 = 68) */}
        <div className="pointer-events-none sticky bottom-inset z-[var(--z-toolbar)] -mt-7 flex h-7 justify-center">
          <button className="mat-thin stand-press text-control pointer-events-auto flex h-7 items-center gap-1.5 pl-2.5 pr-3">
            <Icon name="inbox" size={16} className="text-ink-2" /> 2 new messages
          </button>
        </div>
        <ScrollEdge variant="blur" position="bottom" steps={1} size={68} />
      </div>
    </div>
  );
}

function EdgeFadeDemo() {
  const panel = useStartScrolled<HTMLDivElement>(120, ".edge-fade");
  return (
    <div ref={panel} className="mat-thick flex h-[420px] flex-col p-3">
      <div className="text-label px-2.5 text-ink-2">Results (edge-fade)</div>
      <ScrollEdge variant="fade" className="-mx-1 mt-1 flex-1 px-1" scrollerProps={{ "aria-label": "Results" }}>
        {Array.from({ length: 40 }, (_, i) => (
          <button
            key={i}
            type="button"
            className={`stand-row focus-inset text-control flex h-7 w-full items-center gap-[7px] rounded-row pl-2.5 pr-2 text-left ${
              i === 2 ? "mat-fill-selected" : ""
            }`}
          >
            <Icon name="document-text" size={16} variant={i === 2 ? "bold" : "linear"} className={i === 2 ? "text-ink" : "text-ink-2"} />
            <span className="flex-1 truncate">Result {i + 1} — page title that is long enough to truncate</span>
          </button>
        ))}
      </ScrollEdge>
    </div>
  );
}

/* ── contrast ───────────────────────────────────────────────────────────── */

export type ContrastRow = {
  material: string;
  backdrop: "lightest" | "darkest" | "fill";
  text: "ink" | "ink-2" | "blue" | "glyph";
  fill: string;
  backdropColor: string;
  composite: string;
  textColor: string;
  ratio: number;
  pass: boolean;
};

type RGBA = [number, number, number, number];

function parseColor(css: string): RGBA | null {
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = "#000";
  ctx.fillStyle = css;
  if (ctx.fillStyle === "#000000" && !/black|#000|rgb\(0, 0, 0\)|oklch\(0 /.test(css)) {
    // canvas could not parse the string
    return null;
  }
  ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data;
  return [d[0] / 255, d[1] / 255, d[2] / 255, d[3] / 255];
}

function over(fg: RGBA, bg: RGBA): RGBA {
  const a = fg[3];
  return [fg[0] * a + bg[0] * (1 - a), fg[1] * a + bg[1] * (1 - a), fg[2] * a + bg[2] * (1 - a), 1];
}

function luminance([r, g, b]: RGBA) {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function ratio(a: RGBA, b: RGBA) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function hex([r, g, b]: RGBA) {
  return (
    "#" +
    [r, g, b]
      .map((c) =>
        Math.round(c * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("")
      .toUpperCase()
  );
}

function computeContrast(): ContrastRow[] {
  const out: ContrastRow[] = [];
  const root = document.querySelector<HTMLElement>("[data-glass-stand]");
  if (!root) return out;
  const cs = getComputedStyle(root);
  const paper = parseColor(cs.getPropertyValue("--paper").trim());
  const sky = parseColor(cs.getPropertyValue("--tint-sky").trim());
  const mail = parseColor(getComputedStyle(root.querySelector("[data-backdrop='mail']")!).backgroundColor);
  // blue is measured from the token, not a swatch: the adopted rule keeps
  // links off glass, so no pill on the stand renders it (see DESIGN.md v2 →
  // Text on glass). The row shows what a link would cost if it did.
  const blueStr = cs.getPropertyValue("--blue").trim();
  const blue = parseColor(blueStr);
  if (!paper || !sky || !mail || !blue) return out;
  const backdrops = {
    lightest: over(sky, paper),
    darkest: mail,
  } as const;
  for (const m of MATERIALS) {
    const swatch = root.querySelector<HTMLElement>(`[data-swatch='${m.key}'][data-sample='light']`);
    if (!swatch) continue;
    const scs = getComputedStyle(swatch);
    const fillStr = scs.backgroundColor;
    const fill = parseColor(fillStr);
    const inkStr = getComputedStyle(swatch.querySelector("[data-ink]")!).color;
    const ink2Str = getComputedStyle(swatch.querySelector("[data-ink-2]")!).color;
    const ink = parseColor(inkStr);
    const ink2 = parseColor(ink2Str);
    if (!fill || !ink || !ink2) continue;
    // thick carries a sheen on ::before: white .55 → 0 over the top 38%.
    // Average it in as ~.10 extra white so the table is not optimistic.
    const sheen = m.key === "thick" && !/none/.test(cs.getPropertyValue("--glass-sheen")) ? 0.1 : 0;
    for (const [bk, bg] of Object.entries(backdrops) as [keyof typeof backdrops, RGBA][]) {
      let comp = over(fill, bg);
      if (sheen) comp = over([1, 1, 1, sheen], comp);
      for (const [t, tc, ts] of [
        ["ink", ink, inkStr],
        ["ink-2", ink2, ink2Str],
        ["blue", blue, blueStr],
      ] as const) {
        const r = ratio(tc, comp);
        out.push({
          material: m.label,
          backdrop: bk,
          text: t,
          fill: fillStr,
          backdropColor: hex(bg),
          composite: hex(comp),
          textColor: ts,
          ratio: Math.round(r * 100) / 100,
          pass: r >= 4.5,
        });
      }
    }
  }
  // the primary: paper glyph on the ink fill (dark: the inverse pair, same
  // arithmetic). Opaque, so the backdrop is the fill itself. Rest and hover.
  for (const [label, sel] of [
    ["accent", "[data-accent]:not([data-hover])"],
    ["accent hover", "[data-accent][data-hover]"],
  ] as const) {
    const el = root.querySelector<HTMLElement>(sel);
    if (!el) continue;
    const ecs = getComputedStyle(el);
    const fill = parseColor(ecs.backgroundColor);
    const glyph = parseColor(ecs.color);
    if (!fill || !glyph) continue;
    const r = ratio(glyph, fill);
    out.push({
      material: label,
      backdrop: "fill",
      text: "glyph",
      fill: ecs.backgroundColor,
      backdropColor: hex(fill),
      composite: hex(fill),
      textColor: ecs.color,
      ratio: Math.round(r * 100) / 100,
      pass: r >= 4.5,
    });
  }
  // Phase 1 fills on the thick material (the sidebar): chip white .50, the
  // selected capsule white .78, the ink-tint hover .07 — each composited on
  // the thick glass over both backdrops, ink text on top (text on a fill is
  // 600 and full ink). The hover tint is also measured over the selected
  // capsule, the layered form every fill uses.
  const thick = root.querySelector<HTMLElement>("[data-swatch='thick'][data-sample='light']");
  const thickFill = thick ? parseColor(getComputedStyle(thick).backgroundColor) : null;
  const thickInk = thick ? parseColor(getComputedStyle(thick.querySelector("[data-ink]")!).color) : null;
  const chip = parseColor(cs.getPropertyValue("--fill-chip").trim());
  const selected = parseColor(cs.getPropertyValue("--fill-glass-selected").trim());
  const hover = parseColor(cs.getPropertyValue("--fill-glass-hover").trim());
  // the tint over the selected capsule is its own token (dark darkens); the
  // first colour of the gradient, in whatever space the bundler serialised
  const selectedTintStr = cs
    .getPropertyValue("--hover-tint-selected")
    .trim()
    .match(/(?:oklch|oklab|lab|lch|rgba?|color)\([^)]*\)/)?.[0];
  const selectedHover = selectedTintStr ? parseColor(selectedTintStr) : hover;
  if (thickFill && thickInk && chip && selected && hover && selectedHover) {
    const sheen = !/none/.test(cs.getPropertyValue("--glass-sheen")) ? 0.1 : 0;
    for (const [bk, bg] of Object.entries(backdrops) as [keyof typeof backdrops, RGBA][]) {
      let glass = over(thickFill, bg);
      if (sheen) glass = over([1, 1, 1, sheen], glass);
      for (const [label, layers] of [
        ["chip", [chip]],
        ["chip hover", [chip, hover]],
        ["selected", [selected]],
        ["selected hover", [selected, selectedHover]],
        ["item hover", [hover]],
      ] as const) {
        const comp = layers.reduce((acc, layer) => over(layer, acc), glass);
        const r = ratio(thickInk, comp);
        out.push({
          material: label,
          backdrop: bk,
          text: "ink",
          fill: `${layers.length} layer${layers.length > 1 ? "s" : ""} on thick`,
          backdropColor: hex(bg),
          composite: hex(comp),
          textColor: getComputedStyle(thick!.querySelector("[data-ink]")!).color,
          ratio: Math.round(r * 100) / 100,
          pass: r >= 4.5,
        });
      }
    }
  }
  return out;
}

function ContrastTable({ rows }: { rows: ContrastRow[] }) {
  return (
    <div className="rounded-table bg-paper shadow-[0_0_0_1px_var(--hair)]">
      <table className="stand-table text-table w-full border-separate border-spacing-0" data-contrast-table>
        <thead>
          <tr>
            <th>Material</th>
            <th>Backdrop</th>
            <th>Text</th>
            <th>Composite</th>
            <th>Ratio</th>
            <th>AA</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>{r.material}</td>
              <td>
                {r.backdrop} <span className="text-ink-3">{r.backdropColor}</span>
              </td>
              <td>{r.text}</td>
              <td className="font-mono">{r.composite}</td>
              <td className="tabular-nums">{r.ratio.toFixed(2)}</td>
              <td className={r.pass ? "text-ink" : "font-semibold text-red"}>{r.pass ? "pass" : "FAIL"}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="text-ink-3">
                computing…
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
