/** Fast keyword→emoji heuristic. Ambiguous cases can be upgraded to an
 *  OpenRouter LLM call later (see backlog) — this covers the common ones. */
import { DEFAULT_PAGE_ICON } from "./constants";

const MAP: [RegExp, string][] = [
  [/\b(project|projects|building|build)\b/i, "🛠️"],
  [/\b(idea|ideas|brainstorm|thought)\b/i, "💡"],
  [/\b(people|team|contact|crm)\b/i, "👥"],
  [/\b(meeting|1:1|sync|standup|call)\b/i, "🗣️"],
  [/\b(tennis|racket|sport|match)\b/i, "🎾"],
  [/\b(spanish|español|language|vocab)\b/i, "🇪🇸"],
  [/\b(money|budget|finance|invoice|cost|pricing)\b/i, "💰"],
  [/\b(travel|trip|flight|vacation)\b/i, "✈️"],
  [/\b(book|books|reading|read)\b/i, "📚"],
  [/\b(music|song|playlist|album)\b/i, "🎵"],
  [/\b(food|recipe|cook|meal)\b/i, "🍳"],
  [/\b(health|gym|workout|fitness|run)\b/i, "💪"],
  [/\b(design|ui|ux|figma|brand)\b/i, "🎨"],
  [/\b(code|dev|engineering|api|bug)\b/i, "💻"],
  [/\b(todo|task|tasks|checklist)\b/i, "✅"],
  [/\b(calendar|schedule|plan|roadmap|timeline)\b/i, "🗓️"],
  [/\b(doc|docs|documentation|spec|wiki)\b/i, DEFAULT_PAGE_ICON],
  [/\b(home|house|apartment)\b/i, "🏠"],
  [/\b(work|job|career|resume|cv)\b/i, "💼"],
  [/\b(research|study|analysis|data)\b/i, "🔬"],
  [/\b(marketing|growth|ads|campaign)\b/i, "📣"],
  [/\b(welcome|start|intro|getting started)\b/i, "👋"],
  [/\b(archive|old|done)\b/i, "🗄️"],
  [/\b(question|faq|ask)\b/i, "❓"],
  [/\b(goal|goals|okr)\b/i, "🎯"],
  [/\b(shop|store|product|shopping)\b/i, "🛍️"],
  [/\b(movie|film|watch|tv|series)\b/i, "🎬"],
  [/\b(game|gaming|games)\b/i, "🎮"],
  [/\b(love|relationship|family)\b/i, "❤️"],
  [/\b(car|drive|auto)\b/i, "🚗"],
];

/** Pick a fitting emoji for a page title. Returns a neutral default when
 *  nothing matches (an LLM pass can refine it later). */
export function pickEmoji(title: string): string {
  for (const [re, e] of MAP) if (re.test(title)) return e;
  return DEFAULT_PAGE_ICON;
}
