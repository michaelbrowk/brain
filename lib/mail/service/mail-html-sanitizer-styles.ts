import { parse, type ChildNode, type Rule } from "postcss";

const MAX_CSS_CHARACTERS = 65_536;
const MAX_RULES = 256;
const MAX_SELECTORS = 8;
const SIMPLE_SELECTOR = /^([a-z][a-z0-9-]*)?(?:\.([A-Za-z_][\w-]{0,63}))?$/;

export const TRACKED_CSS_PROPERTY = /^(?:display|visibility|content-visibility|opacity|width|height|max-width|max-height)$/;

export interface TrackingValue {
  readonly value: string;
  readonly important: boolean;
}
type TrackingStyle = Map<string, TrackingValue>;
type Viewport = { edge: "min" | "max"; width: number };
interface VisibilityRule {
  readonly declarations: TrackingStyle;
  readonly viewport: Viewport | null;
  readonly specificity: number;
  readonly order: number;
}

export interface MailPresentationSheet {
  css: string;
  readonly classes: Set<string>;
  readonly tracking: Map<string, VisibilityRule[]>;
  usesBody: boolean;
}

export function mailClassNames(raw: string | undefined): string[] {
  return raw && raw.length <= 1_024 ? raw.trim().split(/\s+/).slice(0, 32) : [];
}

/** Only matching class names are emitted, under a namespace owned by the frame. */
export function mailPresentationSheet(
  sources: readonly string[],
  allowedTags: ReadonlySet<string>,
  sanitizeValue: (property: string, value: string) => string | null,
): MailPresentationSheet {
  const sheet: MailPresentationSheet = {
    css: "", classes: new Set(), tracking: new Map(), usesBody: false,
  };
  let count = 0;
  let characters = 0;
  const viewportEdges = new Set<number>();
  function ruleCss(rule: Rule, viewport: Viewport | null): string {
    if (++count > MAX_RULES || rule.selector.length > 512) return "";
    const declarations: string[] = [];
    const tracking: TrackingStyle = new Map();
    for (const item of rule.nodes.slice(0, 64)) {
      if (item.type !== "decl") continue;
      const property = item.prop.toLowerCase();
      const value = sanitizeValue(property, item.value);
      if (value === null) continue;
      declarations.push(property + ":" + value + (item.important ? "!important" : ""));
      if (TRACKED_CSS_PROPERTY.test(property)) {
        applyTrackingValue(tracking, property, { value, important: !!item.important });
      }
    }
    if (!declarations.length) return "";
    const style = declarations.join(";");
    const selectors: string[] = [];
    for (const selector of rule.selector.split(",").slice(0, MAX_SELECTORS)) {
      // Each compound is a type, a class or type.class. A short chain covers
      // newsletter columns, sibling cells and nested links without selectors
      // that observe attributes, browser state, or anything outside the letter.
      const parts = selector.trim().split(/\s*([>+])\s*|\s+/).filter(Boolean);
      if (!parts.length || parts.length > 7) continue;
      const names: string[] = [];
      const output: string[] = [];
      let key = "";
      let usesBody = false;
      for (const part of parts) {
        if (part === ">" || part === "+") {
          if (!key) break;
          output.push(part);
          key = "";
          continue;
        }
        const match = SIMPLE_SELECTOR.exec(part);
        if (!match || (!match[1] && !match[2])) { key = ""; break; }
        const [, tag, name] = match;
        if (tag && tag !== "body" && !allowedTags.has(tag)) { key = ""; break; }
        if (name) names.push(name);
        if (tag === "body") usesBody = true;
        key = (tag ?? "") + (name ? "." + name : "");
        output.push((tag === "body" ? ".bm-body" : tag ?? "") + (name ? ".bm-c-" + name : ""));
      }
      if (!key) continue;
      names.forEach(name => sheet.classes.add(name));
      if (usesBody) sheet.usesBody = true;
      selectors.push("#brain-mail-content " + output.join(" "));
      // Only an exact match may override a local visibility declaration. A
      // descendant or sibling selector cannot be matched by its last class.
      if (parts.length === 1 && tracking.size) {
        const entries = sheet.tracking.get(key) ?? [];
        entries.push({
          viewport, declarations: tracking, order: count,
          specificity: (names.length ? 2 : 0) + (key.startsWith(".") ? 0 : 1),
        });
        sheet.tracking.set(key, entries);
      }
    }
    return selectors.length ? selectors.join(",") + "{" + style + "}" : "";
  }

  function rules(nodes: readonly ChildNode[], viewport: Viewport | null): string {
    let css = "";
    for (const node of nodes) {
      if (count >= MAX_RULES) break;
      if (node.type === "rule") {
        css += ruleCss(node, viewport);
      } else if (!viewport && node.type === "atrule" && node.name.toLowerCase() === "media" && node.nodes) {
        const media = /^(?:(?:only\s+)?screen\s+and\s*)?\(\s*(min|max)-width\s*:\s*(\d{1,4})px\s*\)$/i.exec(node.params);
        if (media) {
          const width = Number(media[2]);
          // Bound the distinct layouts whose visibility the image manifest evaluates.
          if (!viewportEdges.has(width) && viewportEdges.size >= 16) continue;
          viewportEdges.add(width);
          const edge = media[1]!.toLowerCase() === "min" ? "min" : "max";
          const inner = rules(node.nodes, { edge, width });
          if (inner) css += `@media(${edge}-width:${width}px){${inner}}`;
        }
      }
    }
    return css;
  }

  for (const source of sources) {
    characters += source.length;
    if (characters > MAX_CSS_CHARACTERS || count >= MAX_RULES) break;
    try {
      sheet.css += rules(parse(source).nodes, null);
    } catch {
      // A malformed stylesheet must not make the rest of the letter unreadable.
    }
  }
  return sheet;
}

/** Styles arrive in specificity/source order. Within an origin, important
 * declarations still win over subsequent normal declarations. */
export function applyTrackingValue(target: TrackingStyle, property: string, declaration: TrackingValue) {
  if (declaration.important || !target.get(property)?.important) target.set(property, declaration);
}

export function visibilityVariants(
  sheet: MailPresentationSheet,
  tag: string,
  classes: string | undefined,
): TrackingStyle[] {
  const keys = new Set([tag]);
  for (const name of mailClassNames(classes)) {
    keys.add("." + name);
    keys.add(tag + "." + name);
  }
  const rules = [...keys].flatMap(key => sheet.tracking.get(key) ?? []);
  if (!rules.length) return [];
  rules.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  // Integer pixel thresholds are inclusive. At the threshold, just above
  // it, and at zero we cover every combination of accepted media conditions.
  const widths = new Set([0]);
  for (const { viewport } of rules) {
    if (viewport) {
      widths.add(viewport.width);
      widths.add(viewport.width + 0.5);
    }
  }
  return [...widths].map(width => {
    const style: TrackingStyle = new Map();
    for (const { viewport, declarations } of rules) {
      if (viewport && (viewport.edge === "min" ? width < viewport.width : width > viewport.width)) continue;
      for (const [property, declaration] of declarations) applyTrackingValue(style, property, declaration);
    }
    return style;
  });
}
