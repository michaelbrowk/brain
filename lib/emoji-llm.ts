import { pickEmoji } from "./emoji";
import { DEFAULT_PAGE_ICON } from "./constants";

/** Ask OpenRouter for a single emoji that fits the title. Falls back to the
 *  heuristic on any failure. */
export async function smartEmoji(title: string): Promise<string> {
  const heuristic = pickEmoji(title);
  if (heuristic !== DEFAULT_PAGE_ICON) return heuristic; // fast path — keyword matched
  const key = process.env.OPENROUTER_API_KEY;
  if (!key || !title.trim()) return DEFAULT_PAGE_ICON;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
        max_tokens: 8,
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content:
              "You pick ONE emoji that best represents a note title. Reply with only the single emoji, nothing else.",
          },
          { role: "user", content: title.slice(0, 120) },
        ],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return DEFAULT_PAGE_ICON;
    const data = await res.json();
    const text: string = data?.choices?.[0]?.message?.content ?? "";
    const emoji = [...text.trim()].filter((c) => /\p{Extended_Pictographic}/u.test(c)).join("");
    return emoji || DEFAULT_PAGE_ICON;
  } catch {
    return DEFAULT_PAGE_ICON;
  }
}
