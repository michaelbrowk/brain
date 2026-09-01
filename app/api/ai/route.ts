import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type AiMode = "continue" | "summarize" | "improve" | "fix";

const OPENROUTER_TIMEOUT_MS = 25000;
const MAX_TEXT_CHARS = 12000;

const PROMPTS: Record<AiMode, string> = {
  continue: "Write the next paragraph continuing the text.",
  summarize: "Write a concise summary of the text.",
  improve: "Rewrite the text to be clearer and tighter while keeping its meaning and voice.",
  fix: "Fix grammar and spelling only. Do not otherwise rewrite the text.",
};

function isAiMode(value: unknown): value is AiMode {
  return value === "continue" || value === "summarize" || value === "improve" || value === "fix";
}

function cleanResult(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const mode = body && typeof body === "object" ? (body as { mode?: unknown }).mode : undefined;
  const rawText = body && typeof body === "object" ? (body as { text?: unknown }).text : undefined;
  const text = typeof rawText === "string" ? rawText.trim().slice(0, MAX_TEXT_CHARS) : "";

  if (!isAiMode(mode)) {
    return NextResponse.json({ result: "", error: "Invalid mode" }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json({ result: "", error: "Text required" }, { status: 400 });
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return NextResponse.json({ result: "", error: "AI not configured" });

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), OPENROUTER_TIMEOUT_MS);

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini",
        temperature: mode === "continue" ? 0.7 : 0.2,
        max_tokens: mode === "continue" ? 700 : 900,
        messages: [
          {
            role: "system",
            content:
              "You are an inline writing assistant inside a markdown notes editor. " +
              "Return only the requested text as plain markdown. " +
              "Do not explain, preface, quote, or wrap the result in code fences.",
          },
          { role: "user", content: `${PROMPTS[mode]}\n\nTEXT:\n${text}` },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return NextResponse.json({ result: "", error: "AI request failed" }, { status: 502 });

    const data = await res.json().catch(() => ({}));
    const result = cleanResult(data?.choices?.[0]?.message?.content);
    return NextResponse.json(result ? { result } : { result: "", error: "AI returned no text" });
  } catch {
    return NextResponse.json({ result: "", error: "AI request failed" }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
