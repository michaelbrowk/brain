# Product

## Register

product

## Users

Brain is a personal knowledge workspace you host yourself. You write and retrieve notes on a Mac and an iPhone, while Claude and other LLM clients reach the same Markdown files through MCP. The primary workflow is focused writing, followed by fast retrieval and dependable machine-assisted updates.

## Product Purpose

Brain is a self-hosted minimalist editor whose plain Markdown files remain useful without the application. It should feel fast and quiet next to the all-in-one workspaces, preserve every edit without semantic loss, and give LLMs a controlled door into the same durable note tree.

A page can also be an app: an HTML application an agent builds for the owner, kept beside its `index.md` like everything else and run in a sandboxed frame with no network, reaching the notebook only through a bridge whose writes are authorised on the server against a list the app does not control. It is the last resort and not a shortcut. An agent builds one when the owner asks for one, or when what they asked for cannot be done with the notebook's own means, and says which it was before building. The page stays a page: it has a title, a parent and a body the owner reads, and a client that cannot run the app reads that body instead. `docs/apps.md` is the whole of it.

## Brand Personality

Quiet, exact, personal. The interface should feel alive through precise motion and immediate feedback, while disappearing behind the text during focused writing.

## Anti-references

- Workspace-suite feature sprawl: databases, properties, collaboration chrome, and nested configuration.
- Generic shadcn or SaaS surfaces, decorative card grids, and decorative colour or material. Glass, tint and hue exist in Brain only where they do a job, bounded by `DESIGN.md`.
- An in-product AI chat that competes with the editor.
- An app page built around a missing Brain feature rather than naming the gap. The right answer then is a page and a note to the owner saying what is not there.
- Any interaction or custom block that cannot round-trip to clean Markdown.

## Design Principles

1. Text is the main interface. Chrome recedes while the user writes.
2. Files outlive the application. Markdown and folders remain the source of truth.
3. Zero data loss is a release gate. Writes are atomic, mutations are serialized, and custom blocks round-trip.
4. Response should feel faster than thought through optimistic UI and exact micro-interactions.
5. Fewer features, finished completely, beat broader scope with reliability gaps.
6. AI enters through MCP and operates on the same files under narrowly scoped authorization.

## Accessibility & Inclusion

Target WCAG 2.2 AA for the web interface. Core workflows must work with keyboard and screen readers, and visible controls need descriptive names. Isolated touch controls target 44 by 44 CSS pixels. Dense rows and adjacent controls must remain non-overlapping and meet the WCAG 2.5.8 minimum of 24 by 24 CSS pixels. Respect reduced-motion preferences, preserve zoom and text scaling, and never communicate state by colour alone.
