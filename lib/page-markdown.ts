/** Markdown shape visible after one serialize → parse cycle. Keep this shared:
 * conversion hashes must commit to exactly what Store will persist/read. */
export function canonicalPageMarkdown(markdown: string): string {
  return markdown.trimEnd().replace(/^\n+/, "");
}
