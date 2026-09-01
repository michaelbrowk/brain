"use client";

import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { useEffect, useRef, useState } from "react";
import { Button, IconButton } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Field, SearchCapsule } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { BreadcrumbPill } from "@/components/ui/breadcrumb-pill";
import { Kbd, Skeleton } from "@/components/ui/primitives";
import { ScrollEdge } from "@/components/ui/scroll-edge";
import { ToolbarDivider, ToolbarPill } from "@/components/ui/toolbar-pill";
import { TreeRow } from "@/components/ui/tree-row";
import { SAMPLE_TREE } from "./sample-fixtures";

/** §9 of the stand: every Phase 1 component in its five states — rest,
 *  hover, active (press), focus-visible, disabled — rendered statically
 *  through the `data-hover` / `data-active` / `data-focus` hooks the classes
 *  in globals.css and stand.css honour, next to one live instance. The ring
 *  is keyboard focus only: `data-active` is scale + tint and never carries
 *  it (a field's `focus` is its own :focus-within blue ring), and the live
 *  instances run under the app's <InputModality/> (root layout), so a mouse
 *  click never rings here either. Light and
 *  dark follow the stand toggle; "matte" forces the reduced-transparency
 *  remap. The e2e design audit hovers every control in the REST column and
 *  asserts a computed change; the stand-shots script measures ΔL between
 *  the rest and hover columns from pixels. */

const STATES = ["rest", "hover", "active", "focus", "disabled"] as const;
/** The live tree-row demo needs four names to click between: the workspace
 *  root, then the first three pages of the sample tree. */
const LIVE_TREE = ["Brain", ...SAMPLE_TREE.slice(0, 3).map((page) => page.title)];
/** What the palette shows for the query "sea": one page and its neighbours. */
const PALETTE_RESULTS = [
  "2026 Season Calendar",
  "2025 Season — retro",
  "Season planting plan",
  "Season — north bed split",
];
/** Descenders and accents on one line — what a truncating label must not clip. */
const DESCENDERS = "Repairs g j p y q Ã‰";
type State = (typeof STATES)[number];

function stateProps(state: State) {
  return {
    "data-hover": state === "hover" ? "" : undefined,
    "data-active": state === "active" ? "" : undefined,
    "data-focus": state === "focus" ? "" : undefined,
    disabled: state === "disabled" ? true : undefined,
  };
}
/** For elements that are not form controls (a row div): no `disabled`. */
function stateAttrs(state: State) {
  const attrs: Record<string, string | undefined> = { ...stateProps(state), disabled: undefined };
  delete attrs.disabled;
  return attrs;
}

export function ComponentsSection() {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [selected, setSelected] = useState(1);
  const [chipActive, setChipActive] = useState(false);
  return (
    <div data-stand-components className="flex flex-col gap-10">
      {/* column heads */}
      <div className="text-label grid grid-cols-[180px_repeat(5,1fr)] gap-3 px-1 text-ink-2">
        <span>Component</span>
        {STATES.map((s) => (
          <span key={s}>{s}</span>
        ))}
      </div>

      {/* ── buttons on glass (quiet / ink / destructive live in dialogs) ── */}
      <Panel title="Buttons" note="Control 13/500. glass floats on paper; quiet, ink and destructive belong to dialogs (thick glass); accent is the one filled circle per surface.">
        <Grid label="Button · glass" onPaper>
          {(s) => (
            <Button variant="glass" {...stateProps(s)} data-measure="btn-glass">
              <Icon name="share-linear" size={16} /> Share
            </Button>
          )}
        </Grid>
        <Grid label="Button · quiet">
          {(s) => (
            <Button variant="quiet" {...stateProps(s)} data-measure="btn-quiet">
              Cancel
            </Button>
          )}
        </Grid>
        <Grid label="Button · ink">
          {(s) => (
            <Button variant="ink" {...stateProps(s)} data-measure="btn-ink">
              Save
            </Button>
          )}
        </Grid>
        <Grid label="Button · accent">
          {(s) => (
            <Button variant="accent" aria-label="New page" {...stateProps(s)} data-measure="btn-accent">
              <Icon name="add" size={18} />
            </Button>
          )}
        </Grid>
        <Grid label="Button · destructive">
          {(s) => (
            <Button variant="destructive" {...stateProps(s)} data-measure="btn-destructive">
              Delete
            </Button>
          )}
        </Grid>
        <Grid label="IconButton 28">
          {(s) => (
            <IconButton size={28} aria-label="More" {...stateProps(s)} data-measure="icon-28">
              <Icon name="menu-dots-bold" size={16} />
            </IconButton>
          )}
        </Grid>
        <Grid label="IconButton 36 · in a pill" onPaper>
          {(s) => (
            <ToolbarPill aria-label="Page actions">
              <IconButton size={36} aria-label="Pin" {...stateProps(s)} data-measure="icon-36">
                <Icon name="pin-linear" size={18} />
              </IconButton>
              <ToolbarDivider />
              <IconButton size={36} aria-label="More">
                <Icon name="menu-dots-bold" size={18} />
              </IconButton>
            </ToolbarPill>
          )}
        </Grid>
      </Panel>

      {/* ── fields ── */}
      <Panel title="Field · SearchCapsule · Kbd" note="On paper a hairline ring → blue on focus, red the whole way down when the input carries aria-invalid. On glass an ink fill .055, never a second material; the shortcut is a kbd chip (white .70 + rim on glass, ink .05 on paper).">
        <Grid label="Field · paper" onPaper>
          {(s) => (
            <Field
              icon="document-text"
              placeholder="Page title"
              aria-label="Page title"
              defaultValue={s === "rest" ? "" : "2026 Season Calendar"}
              hover={s === "hover" || s === "active"}
              focus={s === "focus"}
              disabled={s === "disabled"}
            />
          )}
        </Grid>
        {/* the sixth state: aria-invalid on the input, so the ring a form
            rejected is red in every column — full red under the pointer and
            while it holds focus */}
        <Grid label="Field · invalid" onPaper>
          {(s) => (
            <Field
              placeholder="Page title"
              aria-label="Page title, invalid"
              aria-invalid="true"
              defaultValue="untitled/"
              hover={s === "hover" || s === "active"}
              focus={s === "focus"}
              disabled={s === "disabled"}
            />
          )}
        </Grid>
        <Grid label="Field · glass">
          {(s) => (
            <Field
              on="glass"
              placeholder="Category name"
              aria-label="Category name"
              hover={s === "hover" || s === "active"}
              focus={s === "focus"}
              disabled={s === "disabled"}
            />
          )}
        </Grid>
        <Grid label="SearchCapsule">
          {(s) => (
            <SearchCapsule
              placeholder="Search"
              aria-label="Search"
              hover={s === "hover" || s === "active"}
              focus={s === "focus"}
              disabled={s === "disabled"}
            />
          )}
        </Grid>
        <Row label="Kbd" onPaper>
          <div className="flex items-center gap-3">
            <span className="mat-thick text-control flex h-9 items-center gap-2 rounded-pill px-3 text-ink-2">
              on glass <Kbd>⌘K</Kbd> <Kbd>⌘⇧P</Kbd>
            </span>
            <span className="text-control flex h-9 items-center gap-2 rounded-table bg-paper px-3 text-ink-2">
              on paper <Kbd>⌘N</Kbd> <Kbd>Esc</Kbd>
            </span>
          </div>
        </Row>
      </Panel>

      {/* ── chips + tree rows ── */}
      <Panel title="Chip · Tree row" note="Chip: white .50, 600; hover is the ink tint layered over the fill; an active chip carries the bold icon. Row: 28px capsule r14, hover tint + “…”, selected white .78 capsule that flows on SPRING_SELECT; drag lifts, the yellow line marks the drop.">
        <Grid label="Chip">
          {(s) => (
            <Chip emoji="🌿" {...stateProps(s)} hover={s === "hover"} pressed={s === "active"} data-measure="chip">
              Field Guide
            </Chip>
          )}
        </Grid>
        <Grid label="Chip · icon, active">
          {(s) => (
            <Chip icon="star" active {...stateProps(s)} hover={s === "hover"} pressed={s === "active"}>
              Starred
            </Chip>
          )}
        </Grid>
        <Grid label="Tree row">
          {(s) => (
            <TreeRow
              role="button"
              tabIndex={s === "disabled" ? -1 : 0}
              title="Field Guide"
              emoji="🌿"
              hasChildren
              onToggle={() => {}}
              menu={<More />}
              {...stateAttrs(s)}
              hover={s === "hover"}
              aria-disabled={s === "disabled" ? true : undefined}
              style={s === "disabled" ? { opacity: 0.4 } : undefined}
              data-measure="tree-row"
            />
          )}
        </Grid>
        <Grid label="Tree row · selected">
          {(s) => (
            <TreeRow
              role="button"
              tabIndex={0}
              title="2026 Season Calendar"
              emoji="📅"
              selected
              depth={1}
              layoutId={`stand-${s}`}
              menu={<More />}
              {...stateAttrs(s)}
              hover={s === "hover"}
              dragging={s === "active"}
              data-measure="tree-row-selected"
            />
          )}
        </Grid>
        {/* The two things a drop can mean, and the row that is in the air:
            the line on a row's edge (the page lands beside it, at that indent)
            and the ring around a whole row (the page goes inside it). */}
        <Row label="Tree row · drag">
          <div className="flex w-[260px] flex-col">
            <TreeRow role="button" tabIndex={0} title="Household" emoji="🏠" />
            <TreeRow
              role="button"
              tabIndex={0}
              title="Recipes"
              emoji="🍲"
              depth={1}
              dropEdge="before"
              dropDepth={1}
            />
            <TreeRow role="button" tabIndex={0} title="Trip" emoji="✈️" depth={1} dragging />
            <TreeRow role="button" tabIndex={0} title="Daily" emoji="📅" dropInto />
          </div>
        </Row>
        <Row label="Tree row · live">
          <div className="flex w-[260px] flex-col" data-live-tree>
            {LIVE_TREE.map((t, i) => (
              <TreeRow
                key={t}
                role="button"
                tabIndex={0}
                title={t}
                icon="document-text"
                selected={selected === i}
                onClick={() => setSelected(i)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") setSelected(i);
                }}
                menu={<More />}
              />
            ))}
          </div>
        </Row>
        <Row label="Chip · live">
          <Chip emoji="🧠" active={chipActive} onClick={() => setChipActive((v) => !v)}>
            Brain
          </Chip>
          <Chip icon="letter" active={chipActive} onClick={() => setChipActive((v) => !v)}>
            Mail
          </Chip>
        </Row>
        <Row label="Truncation · descenders">
          <div className="flex w-[260px] flex-col gap-1" data-descenders>
            <TreeRow role="button" tabIndex={0} title={DESCENDERS} emoji="🔧" selected layoutId="stand-desc" />
            <TreeRow role="button" tabIndex={0} title={`${DESCENDERS} — a title long enough to truncate`} icon="document-text" menu={<More />} />
            <div className="flex gap-1">
              <Chip emoji="🔧">{DESCENDERS}</Chip>
              <Chip icon="star" active className="max-w-[120px]">
                {DESCENDERS} truncated
              </Chip>
            </div>
            <div className="brain-menu-item" role="menuitem" tabIndex={-1}>
              <Icon name="text-field-linear" size={16} className="brain-menu-icon" />
              <span className="truncate">{DESCENDERS} — menu item that truncates</span>
            </div>
            <Button variant="quiet" className="max-w-[160px]">
              <span className="truncate">{DESCENDERS} quiet</span>
            </Button>
          </div>
          <div className="text-caption max-w-[220px] text-ink-3">
            “{DESCENDERS}”: every truncated label keeps a 1.25 line box inside its control, so
            descenders and accents survive the overflow clip. The breadcrumb below carries the
            same string.
          </div>
        </Row>
      </Panel>

      {/* ── pills ── */}
      <Panel title="Breadcrumb pill · Toolbar pill" note="Regular material 36 on paper. Parents are ink 500 with a chevron and hover with the tint and an underline; current is 600. Meta is not inside the pill. The toolbar pill hosts IconButton 36 with a hairline divider.">
        <Grid label="Breadcrumb" onPaper wide>
          {(s) => (
            <BreadcrumbPill
              data-measure="crumb"
              items={[
                {
                  emoji: "🌿",
                  label: s === "rest" ? DESCENDERS : "Field Guide",
                  href: "#components",
                  hover: s === "hover",
                  pressed: s === "active",
                  focus: s === "focus",
                  disabled: s === "disabled",
                },
                { emoji: "📅", label: "2026 Season Calendar" },
              ]}
            />
          )}
        </Grid>
        <Row label="Toolbar pills · live" onPaper>
          <Button variant="glass">
            <Icon name="share-linear" size={16} /> Share
          </Button>
          <ToolbarPill aria-label="Page actions">
            <IconButton size={36} aria-label="Pin">
              <Icon name="pin-linear" size={18} />
            </IconButton>
            <ToolbarDivider />
            <StandMenu>
              <IconButton size={36} aria-label="More" data-stand-menu-trigger>
                <Icon name="menu-dots-bold" size={18} />
              </IconButton>
            </StandMenu>
          </ToolbarPill>
          <Button variant="accent" aria-label="New page">
            <Icon name="add" size={18} />
          </Button>
        </Row>
      </Panel>

      {/* ── menus, dialogs, palette ── */}
      <Panel title="Menu · Dialog · Palette" note="Regular material r14, item r8 in padding 6, Control 13/500 ink; icons ink-2 → ink on highlight. Materialize on data-state: opacity + scale .96→1 from the trigger, edge-light at 60%, exit 120ms. Dialog: thick r20 over the L4 scrim; palette: thick r22, 560 × ≤60vh.">
        <Row label="Menu · static" onPaper>
          <div className="brain-menu w-[184px]" data-measure-menu>
            <p className="brain-menu-label">Page</p>
            {[
              ["add-linear", "New page inside"],
              ["pin-linear", "Pin"],
              ["text-field-linear", "Rename"],
            ].map(([icon, label], i) => (
              <div key={label} className="brain-menu-item" data-hover={i === 1 ? "" : undefined} data-measure={i === 1 ? undefined : "menu-item"} role="menuitem" tabIndex={-1}>
                <Icon name={icon} size={16} className="brain-menu-icon" />
                {label}
                {i === 2 && <Kbd className="ml-auto">⏎</Kbd>}
              </div>
            ))}
            <div className="brain-menu-sep" />
            <div className="brain-menu-item" data-disabled="" role="menuitem" tabIndex={-1}>
              <Icon name="trash-bin-trash-linear" size={16} className="brain-menu-icon" />
              Move to trash
            </div>
          </div>
          <div className="text-caption max-w-[220px] text-ink-3">
            rest · hover (static) · kbd · disabled. The live one sits in the toolbar pill above (“More”).
          </div>
        </Row>
        <Row label="Dialog · live" onPaper>
          <Button variant="glass" onClick={() => setConfirmOpen(true)}>
            Open confirm dialog
          </Button>
          <ConfirmDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            title="Move “2026 Season Calendar” to trash?"
            description="The page and its 3 subpages go to Trash. You can restore them for 30 days."
            confirmLabel="Move to trash"
            onConfirm={() => setConfirmOpen(false)}
          />
        </Row>
        <Row label="Palette · static" onPaper>
          <PaletteStatic />
          <div className="text-caption max-w-[220px] text-ink-3">
            Results scroll under the fade atom: opens pre-scrolled, so the top edge is on; the
            bottom edge stays while results continue and goes at the end of the list.
          </div>
        </Row>
      </Panel>

      {/* ── content objects ── */}
      <Panel title="Sticker · Toast · Skeleton · Empty-block hint" note="The sticker is content: r14, the warm gradient, Label 11 header with a dot, its own warm shadow. The toast is an opaque ink capsule with the L3 shadow. Skeleton reads ink .05 on paper and white .40 on glass; the pulse stops under reduced motion.">
        <Row label="Sticker" onPaper>
          <div className="brain-sticker relative w-[180px]" style={{ rotate: "-1deg" }}>
            <div className="flex h-7 items-center justify-between pl-3 pr-1.5">
              <span className="brain-sticker-label">Note</span>
              <span className="grid size-5 place-items-center text-[var(--sticker-ink)]">
                <Icon name="close-linear" size={13} />
              </span>
            </div>
            <p className="px-3 pb-3 font-mono text-[12.5px] leading-relaxed text-[var(--sticker-ink)]">
              Ask the co-op for the north bed split before Thursday
            </p>
          </div>
        </Row>
        <Row label="Toast" onPaper>
          <div className="brain-toast flex items-center gap-3 py-2.5 pl-3.5 pr-2.5">
            <span className="grid size-8 place-items-center">
              <Icon name="trash-bin-trash-linear" size={16} className="text-paper" />
            </span>
            <div>
              <div className="text-control font-semibold text-paper">Page moved to trash</div>
              <div className="text-caption mt-0.5 text-paper/60">2026 Season Calendar</div>
            </div>
            <Button variant="pill" className="ml-1">
              Undo
            </Button>
          </div>
        </Row>
        <Row label="Skeleton" onPaper>
          <div className="flex w-[200px] flex-col gap-2 rounded-table bg-paper p-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
          <div className="mat-thick flex w-[200px] flex-col gap-2 rounded-panel p-3">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </Row>
        <Row label="Empty-block hint" onPaper>
          <div className="relative w-[320px] rounded-table bg-paper px-6 py-4">
            <p className="text-body text-ink">Last paragraph of the page.</p>
            <p className="text-body relative mt-3 text-ink-4">
              <span aria-hidden className="absolute -left-[10px] top-[0.2em] h-[1.1em] w-px bg-ink" />
              Press / for a block
            </p>
          </div>
        </Row>
      </Panel>
    </div>
  );
}

/** The palette panel, static: results inside the fade atom, opened scrolled
 *  40px so the top edge is on (the live palette does the same through
 *  `useScrollEdge` on cmdk's list). */
function PaletteStatic() {
  const panel = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    panel.current?.querySelector(".edge-fade")?.scrollTo({ top: 40 });
  }, []);
  return (
    <div ref={panel} className="brain-palette relative flex flex-col overflow-hidden" style={{ top: 0 }} data-palette-static>
      <div className="flex items-center gap-2.5 px-4">
        <Icon name="magnifer-linear" size={18} className="shrink-0 text-ink-2" />
        <span className="text-subheading h-14 flex-1 leading-[56px] text-ink">sea</span>
        <Kbd>Esc</Kbd>
      </div>
      <ScrollEdge variant="fade" className="max-h-[220px] px-3 pb-3 pt-1" scrollerProps={{ "aria-label": "Palette results" }}>
        <p className="brain-menu-label">Pages</p>
        {PALETTE_RESULTS.map((t, i) => (
          <div key={t} className="brain-palette-item flex items-center gap-2.5 px-2.5 py-2 text-[14px]" data-selected={i === 0 ? "true" : undefined} data-measure={i === 1 ? "palette-item" : undefined}>
            <span className="grid size-5 shrink-0 place-items-center text-[15px]">📅</span>
            <span className="min-w-0 flex-1 truncate">{t}</span>
            <span className="text-caption shrink-0 text-ink-2">Field Guide</span>
          </div>
        ))}
        <p className="brain-menu-label">Actions</p>
        {["New page", "Toggle theme", "Open settings", "Trash"].map((t) => (
          <div key={t} className="brain-palette-item flex items-center gap-2.5 px-2.5 py-2 text-[14px]">
            <Icon name="add-linear" size={16} className="text-ink-2" />
            <span className="min-w-0 flex-1 truncate">{t}</span>
          </div>
        ))}
      </ScrollEdge>
    </div>
  );
}

/* ── layout pieces ────────────────────────────────────────────────────────── */

/** A panel is paper; each cell decides whether the component sits on thick
 *  glass (what lives in a sidebar, menu or dialog) or on a cover-like
 *  canvas (what floats as its own material) — so no material ever nests in
 *  another, the way the app composes them. */
function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h3 className="text-h3">{title}</h3>
        <p className="text-caption mt-1 max-w-[760px] text-ink-3">{note}</p>
      </div>
      <div className="stand-light flex flex-col gap-3 rounded-sheet p-4 shadow-[0_0_0_1px_var(--hair)]">
        {children}
      </div>
    </div>
  );
}

const CELL_GLASS = "mat-thick rounded-panel px-3 py-2";
const CELL_COVER = "stand-cover-soft rounded-table px-3 py-2";

/** One component × five states. `onPaper` puts the cells on a cover-like
 *  backdrop instead of thick glass, for what floats on the canvas. */
function Grid({
  label,
  onPaper,
  wide,
  children,
}: {
  label: string;
  onPaper?: boolean;
  wide?: boolean;
  children: (state: State) => React.ReactNode;
}) {
  return (
    <div className={`grid items-center gap-3 ${wide ? "grid-cols-[180px_repeat(5,minmax(320px,1fr))] overflow-x-auto" : "grid-cols-[180px_repeat(5,1fr)]"}`} data-grid>
      <span className="text-control text-ink-2">{label}</span>
      {STATES.map((s) => (
        <div
          key={s}
          data-state-cell={s}
          className={`flex min-h-[44px] items-center ${onPaper ? CELL_COVER : CELL_GLASS}`}
        >
          {children(s)}
        </div>
      ))}
    </div>
  );
}

function Row({ label, onPaper, children }: { label: string; onPaper?: boolean; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[180px_1fr] items-start gap-3" data-grid>
      <span className="text-control pt-2 text-ink-2">{label}</span>
      <div className={`flex flex-wrap items-start gap-3 ${onPaper ? CELL_COVER : CELL_GLASS} py-3`}>{children}</div>
    </div>
  );
}

function More() {
  return (
    <IconButton size={28} aria-label="More actions">
      <Icon name="menu-dots-bold" size={16} />
    </IconButton>
  );
}

/** A live Radix dropdown on the menu classes — the same DOM the app's
 *  row-menu / page-actions-menu / template-menu / mail-nav render. */
function StandMenu({ children }: { children: React.ReactNode }) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>{children}</Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content side="bottom" align="end" sideOffset={6} className="brain-menu z-[var(--z-modal)] w-[200px]" data-stand-menu>
          <p className="brain-menu-label">Page</p>
          {[
            ["link-linear", "Copy link"],
            ["copy-linear", "Duplicate"],
            ["list-arrow-down-linear", "Move to…"],
            ["history-2-linear", "Version history"],
          ].map(([icon, label]) => (
            <Dropdown.Item key={label} className="brain-menu-item">
              <Icon name={icon} size={16} className="brain-menu-icon" />
              {label}
            </Dropdown.Item>
          ))}
          <Dropdown.Separator className="brain-menu-sep" />
          <Dropdown.Item className="brain-menu-item">
            <Icon name="trash-bin-trash-linear" size={16} className="brain-menu-icon" />
            Move to trash
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
