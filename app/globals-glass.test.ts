import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** DESIGN.md v2, ban #1 and #6: no backdrop-filter inside a backdrop-filter,
 *  none on rows. Static checks cannot see the rendered tree, so this guards
 *  the two places it can: which CSS rules own a backdrop-filter, and which
 *  components reach for a raw backdrop class instead of a material. */

const root = path.resolve(__dirname, "..");
const css = readFileSync(path.join(root, "app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function rulesWith(property: string) {
  // selector { ... property ... } — good enough for our hand-written CSS
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    if (m[2].includes(property)) out.push(m[1].trim().replace(/\s+/g, " "));
  }
  return out;
}

describe("liquid glass foundations", () => {
  it("backdrop-filter lives only in the material utilities and the scroll-edge layers", () => {
    const owners = rulesWith("backdrop-filter:").filter((s) => !s.startsWith("@supports"));
    // Phase 1 components that ARE a material (each is a regular or thick
    // surface of its own, never placed inside another): the glass button,
    // the breadcrumb and toolbar pills, menus, the share popover (P3-c),
    // dialogs, the palette, the table handle's action group, and (P5) the
    // mail search pill and the composer sheet. Plus the cover's two edges,
    // the only always-on bands (DESIGN.md §7).
    const allowed = [
      /^@utility mat-(thin|reg|thick)$/,
      /^\.edge(\[[^\]]+\])* > i(:nth-child\(\d\))?$/,
      // The cover dissolves at its foot and on its way under the sidebar: the
      // scroll edge's construction held always-on. Two layers at the foot, one
      // on the longer left ramp. The alpha is a mask on the image itself and
      // carries no blur.
      /^\.brain-cover-foot > i:nth-child\([12]\)$/,
      /^\.brain-cover-left > i$/,
      /^\.(btn-glass|crumb|toolbar-pill|brain-menu|brain-share-popover|brain-dialog|brain-palette|brain-mail-search|brain-composer-sheet)$/,
      /^\.milkdown \.milkdown-table-block \.cell-handle \.button-group$/,
    ];
    for (const owner of owners) {
      expect(allowed.some((a) => a.test(owner)), `unexpected backdrop-filter owner: ${owner}`).toBe(true);
    }
    expect(owners.length).toBeGreaterThan(0);
  });

  it("fills on glass never declare a backdrop-filter", () => {
    const fills = rulesWith("backdrop-filter:").filter((s) => s.includes("mat-fill"));
    expect(fills).toEqual([]);
  });

  it("scroll-edge uses at most two backdrop layers", () => {
    const layers = rulesWith("backdrop-filter:").filter((s) => s.startsWith(".edge"));
    const steps = new Set(layers.map((s) => s.match(/nth-child\((\d)\)/)?.[1] ?? "1"));
    expect([...steps].every((n) => Number(n) <= 2)).toBe(true);
  });

  it("components do not add raw backdrop classes beyond the known legacy spots", () => {
    const legacy = new Set(["components/mobile-tab-bar.tsx", "components/shell.tsx"]);
    const atoms = new Set(["components/ui/scroll-edge.tsx"]);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === "node_modules" || entry.startsWith(".")) continue;
          walk(full);
        } else if (/\.(tsx|css)$/.test(entry) && !/\.test\.tsx$/.test(entry)) {
          const rel = path.relative(root, full);
          if (rel === "app/globals.css") continue;
          const text = readFileSync(full, "utf8");
          if (/backdrop-blur|backdrop-filter/.test(text) && !legacy.has(rel) && !atoms.has(rel))
            hits.push(rel);
        }
      }
    };
    walk(path.join(root, "components"));
    walk(path.join(root, "app"));
    expect(hits, "use mat-thin / mat-reg / mat-thick or <ScrollEdge>, never a raw backdrop").toEqual([]);
  });

  it("matte fallback remaps every material and edge token in each condition", () => {
    const blocks = [
      /@media \(prefers-reduced-transparency: reduce\) \{\s*:root \{([^}]*)\}/,
      /@supports not \(backdrop-filter: blur\(1px\)\) \{\s*:root \{([^}]*)\}/,
      /html\[data-glass-fallback="matte"\] \{([^}]*)\}/,
    ];
    const must = ["--glass-thin", "--glass-reg", "--glass-thick", "--blur-thin", "--blur-reg", "--blur-thick", "--rim", "--edge-light", "--glass-sheen", "--edge-backdrop-1", "--edge-backdrop-2", "--edge-fill", "--fill-glass-selected", "--fill-chip", "--fill-kbd-glass", "--fill-skeleton-glass"];
    for (const re of blocks) {
      const body = css.match(re)?.[1];
      expect(body, `missing fallback block ${re}`).toBeTruthy();
      for (const token of must) expect(body, `${token} not remapped in ${re}`).toContain(`${token}:`);
    }
  });
});
