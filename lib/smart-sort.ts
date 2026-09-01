import { orderPageIdsByTitleDate } from "./dated-sections";
import { getStore } from "./store";
import type { TreeNode } from "./store/types";

const OTHER = "Other";

export interface SmartSortResult {
  sections: string[]; // ordered labels
  assignments: Record<string, string>; // pageId -> label (every child covered)
  /** Every child id, sections in label order, pages in reading order within a
   *  section. A section whose titles carry dates reads newest first — see
   *  `lib/dated-sections.ts`. */
  order: string[];
  count: number;
}

interface Child {
  id: string;
  title: string;
  icon?: string;
  category?: string;
  created?: string;
}

/** Ask the LLM to group child pages into thematic sections, then RECONCILE
 *  against the real child set so no page can be lost (unplaced → "Other",
 *  invented ids dropped). Titles only — never page bodies. */
export async function smartSort(parentId: string): Promise<SmartSortResult> {
  const store = await getStore();
  const tree = store.getTree();
  const node = findNode(tree, parentId);
  const kids: Child[] = (node?.children ?? []).map((c: TreeNode) => ({
    id: c.id,
    title: c.title,
    icon: c.icon,
    category: c.category,
    created: c.created,
  }));
  if (kids.length === 0) {
    return { sections: [], assignments: {}, order: [], count: 0 };
  }

  const proposed = await askLLM(kids);
  if (!proposed || proposed.sections.length === 0) {
    throw new Error("smart sort unavailable");
  }

  // ── reconcile: guarantee 100% coverage, drop hallucinated ids ──
  const validLabels = new Set(proposed.sections.filter(Boolean));
  const hasRealThemedAssignment = kids.some((child) => {
    const label = proposed.assignments[child.id];
    return Boolean(label && label !== OTHER && validLabels.has(label));
  });
  // A syntactically valid 200 with no usable grouping is still an AI failure.
  // Do not present a fake success that silently puts every page into Other.
  if (validLabels.size === 0 || !hasRealThemedAssignment) {
    throw new Error("smart sort unavailable");
  }
  const assignments: Record<string, string> = {};
  let usedOther = false;
  for (const k of kids) {
    const label = proposed.assignments[k.id];
    if (label && validLabels.has(label)) assignments[k.id] = label;
    else {
      assignments[k.id] = OTHER;
      usedOther = true;
    }
  }
  // final sections = AI order (only ones that got a page) + any assigned label
  // the AI forgot to list + Other last. Guarantees every status has a section.
  const assigned = new Set(Object.values(assignments));
  const finalSections = [
    ...proposed.sections.filter((s) => s && s !== OTHER && assigned.has(s)),
    ...[...assigned].filter(
      (s) => s !== OTHER && !proposed.sections.includes(s),
    ),
  ];
  if (usedOther || assigned.has(OTHER)) finalSections.push(OTHER);

  // The LLM chooses the sections, never the order inside one. Titles that hold
  // a date decide that for themselves, so a lesson log stops reading 12 May,
  // 13 April, 16 June — the alphabet's idea of a calendar.
  const order = finalSections.flatMap((section) =>
    orderPageIdsByTitleDate(kids.filter((k) => assignments[k.id] === section)),
  );

  return { sections: finalSections, assignments, order, count: kids.length };
}

async function askLLM(kids: Child[]): Promise<{
  sections: string[];
  assignments: Record<string, string>;
} | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;

  const list = kids
    .map((k) => `- id:${k.id} | ${k.title}${k.category ? ` [${k.category}]` : ""}`)
    .join("\n");
  const maxSections = Math.min(6, Math.max(1, Math.floor(kids.length / 2)));
  const minSections = Math.min(maxSections, kids.length >= 6 ? 3 : kids.length >= 4 ? 2 : 1);
  const sectionRange =
    minSections === maxSections ? String(minSections) : `${minSections}-${maxSections}`;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 25000);
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              `You organize a flat list of note pages into ${sectionRange} BALANCED thematic sections. ` +
              "EVERY page must go into a themed section — group by topic so most sections hold " +
              "several pages. Do NOT create one-page sections. Use the bracketed category as a strong hint. " +
              'Only use "Other" for a page that genuinely relates to nothing else — avoid it. ' +
              "Every id in the input MUST appear exactly once in assignments, and every label used in " +
              "assignments MUST be listed in sections. " +
              "Section labels: short (1-3 words), in the language the titles are mostly written in. " +
              'Reply ONLY as JSON: {"sections":["Label",...],"assignments":{"<id>":"<Label>",...}}',
          },
          { role: "user", content: list },
        ],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = JSON.parse(data?.choices?.[0]?.message?.content ?? "{}");
    return {
      sections: Array.isArray(parsed.sections) ? parsed.sections.map(String) : [],
      assignments:
        parsed.assignments && typeof parsed.assignments === "object"
          ? parsed.assignments
          : {},
    };
  } catch {
    return null;
  }
}

// minimal tree find (avoids importing TreeNode type gymnastics)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findNode(nodes: any[], id: string): any {
  for (const n of nodes) {
    if (n.id === id) return n;
    const f = findNode(n.children, id);
    if (f) return f;
  }
  return null;
}
