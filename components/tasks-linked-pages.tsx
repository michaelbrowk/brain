"use client";

import * as Popover from "@radix-ui/react-popover";
import { useRef, useState } from "react";
import { Button, IconButton } from "./ui/button";
import { Field } from "./ui/field";
import { Icon } from "./ui/icon";
import { ScrollEdge } from "./ui/scroll-edge";
import { useLayerSignal } from "./use-layer-signal";
import { TaskCategoryGlyph } from "./tasks-category-picker";

export interface TaskPageOption { id: string; title: string; icon?: string; path?: string; kind?: "app" }

export function TasksLinkedPages({ value, pages, onChange, onOpenChange }: {
  value: readonly string[];
  pages: readonly TaskPageOption[];
  onChange: (ids: string[]) => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useLayerSignal(open, onOpenChange);
  const filtered = pages.filter((page) => `${page.title} ${page.path || ""}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = value.map((id) => pages.find((page) => page.id === id) || { id, title: "Page unavailable", path: "This page may have been removed" });
  function close() { setOpen(false); setQuery(""); }
  function toggle(id: string) { if (!value.includes(id) && value.length >= 64) return; onChange(value.includes(id) ? value.filter((entry) => entry !== id) : [...new Set([...value, id])]); }
  return <section className="tasks-linked-pages" aria-label="Linked pages">
    <div className="tasks-linked-heading"><span className="tasks-detail-label text-table">Linked pages</span>
      <Popover.Root modal open={open} onOpenChange={(next) => { if (next) setOpen(true); else close(); }}>
        <Popover.Trigger asChild><Button type="button" variant="quiet" className="tasks-add-page"><Icon name="add" size={16} />Add page</Button></Popover.Trigger>
        <Popover.Portal><Popover.Content side="bottom" align="start" sideOffset={6} collisionPadding={16} className="brain-menu tasks-picker tasks-page-picker z-[var(--z-modal)]" aria-label="Link pages" onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); }} onEscapeKeyDown={(event) => { event.preventDefault(); event.stopPropagation(); close(); }}>
          <div className="tasks-picker-panel">
            <div className="tasks-picker-heading"><span className="text-label">Pages</span><IconButton type="button" size={28} aria-label="Close page picker" onClick={close}><Icon name="close" size={16} /></IconButton></div>
            <Field ref={input} on="glass" icon="magnifer" className="tasks-picker-field" aria-label="Search pages" placeholder="Search pages" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); if (filtered.length === 1) toggle(filtered[0].id); } }} />
            <ScrollEdge variant="fade" className="tasks-picker-list" scrollerProps={{ role: "group", "aria-label": "Pages" }}>
              {filtered.map((page) => <button type="button" key={page.id} role="checkbox" aria-checked={value.includes(page.id)} disabled={!value.includes(page.id) && value.length >= 64} className="brain-menu-item tasks-page-option focus-inset" onClick={() => toggle(page.id)}><TaskCategoryGlyph icon={page.icon} /><span className="tasks-page-copy"><span className="text-control">{page.title}</span>{page.path && <span className="text-caption">{page.path}</span>}</span>{value.includes(page.id) && <Icon name="check" size={14} className="shrink-0" />}</button>)}
              {!filtered.length && <p className="tasks-picker-empty text-table">No pages found</p>}
            </ScrollEdge>
            <div className="tasks-picker-footer"><span className="text-caption">{value.length >= 64 ? "Up to 64 linked pages" : ""}</span><Button type="button" variant="quiet" onClick={close}>Done</Button></div>
          </div>
        </Popover.Content></Popover.Portal>
      </Popover.Root>
    </div>
    {selected.length > 0 && <ul className="tasks-linked-list">{selected.map((page) => <li key={page.id}><TaskCategoryGlyph icon={page.icon} /><span className="tasks-page-copy"><span className="text-control">{page.title}</span>{page.path && <span className="text-caption">{page.path}</span>}</span><IconButton type="button" size={28} aria-label={`Remove linked page: ${page.title}`} onClick={() => onChange(value.filter((id) => id !== page.id))}><Icon name="close" size={16} /></IconButton></li>)}</ul>}
  </section>;
}
