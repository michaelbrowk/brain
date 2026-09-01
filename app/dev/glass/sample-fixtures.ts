export type StandPage = { title: string; emoji?: string; children?: StandPage[] };

/** A workspace shaped like a real one — nested projects, a language shelf, a
 *  daily log — so the stand exercises depth, long titles, Cyrillic and emoji,
 *  without naming anybody. The row count is deliberate: the sidebar in §8 has
 *  to overflow for the fade edge to be on screen at rest. */
export const SAMPLE_TREE: StandPage[] = [
  { title: "Notes", emoji: "🧠" },
  {
    title: "Household",
    emoji: "🏠",
    children: [
      { title: "Recipes", emoji: "🍲" },
      { title: "Repairs", emoji: "🔧" },
      { title: "Moving Checklist", emoji: "📦" },
    ],
  },
  {
    title: "Field Guide",
    emoji: "🌿",
    children: [
      { title: "2026 Season Calendar & Planting Schedule", emoji: "📅" },
      { title: "Soil — Notes from the north bed", emoji: "🪴" },
      { title: "Seed Orders", emoji: "🌱" },
      { title: "Greenhouse — Winter build log", emoji: "🏗️" },
      { title: "Pests & Remedies", emoji: "🐌" },
      { title: "Harvest Log — Урожай по грядкам", emoji: "🧺" },
    ],
  },
  { title: "Archive", emoji: "🗄️" },
  {
    title: "Reading",
    emoji: "📚",
    children: [
      { title: "Long-form queue", emoji: "📰" },
      { title: "Finished in 2026", emoji: "✅" },
    ],
  },
  {
    title: "Languages",
    emoji: "🗣️",
    children: [
      { title: "Spanish", emoji: "🇪🇸" },
      { title: "English", emoji: "🇬🇧" },
    ],
  },
  { title: "Daily", emoji: "📅" },
];

/** The sidebar draws one flat list with a one-step indent, the way the real
 *  tree renders an expanded parent. Depth stops at one because that is all the
 *  §8 composition shows. */
export function flattenStandTree(pages: StandPage[]) {
  return pages.flatMap((page) => [
    { title: page.title, emoji: page.emoji, child: false },
    ...(page.children ?? []).map((child) => ({ title: child.title, emoji: child.emoji, child: true })),
  ]);
}
