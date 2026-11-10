import { fromMarkdown, type Handle } from "mdast-util-from-markdown";
import { directiveFromMarkdown } from "mdast-util-directive";
import { directive } from "micromark-extension-directive";

/** Rewrite destinations, never matching text that merely looks like a URL.
 * Parser offsets let every other byte (labels, prose, code and whitespace)
 * survive export/import unchanged. The destination handlers retain mdast's
 * ordinary buffer/resume behaviour while recording the source span. */
export function rewriteMarkdownDestinations(
  markdown: string,
  replacements: ReadonlyMap<string, string>,
): string {
  if (replacements.size === 0) return markdown;
  const edits: Array<{ start: number; end: number; value: string }> = [];
  let rawSuffixStart: number | undefined;
  let originalExitHandlers: Array<[string, Handle]> = [];
  const enterDestination: Handle = function () {
    this.buffer();
    rawSuffixStart = undefined;
    let decodedLength = 0;
    // Keep the parser's normal decoding, and record where a decoded query/hash
    // begins in the source. Its spelling may be `?`, `\?` or `&quest;`.
    originalExitHandlers = ["data", "characterEscapeValue", "characterReference"]
      .map((type) => [type, this.config.exit[type]]);
    for (const [type, original] of originalExitHandlers) {
      this.config.exit[type] = function (token) {
        original.call(this, token);
        const fragment = this.stack[this.stack.length - 1];
        const text = fragment.type === "fragment" ? fragment.children.at(-1) : undefined;
        if (text?.type !== "text") return;
        const suffixAt = text.value.slice(decodedLength).search(/[?#]/);
        decodedLength = text.value.length;
        if (rawSuffixStart !== undefined || suffixAt < 0) return;
        rawSuffixStart = token.start.offset
          + (type === "data" ? suffixAt : type === "characterEscapeValue" ? -1 : 0);
      };
    }
  };
  const destination: Handle = function (token) {
    for (const [type, original] of originalExitHandlers) this.config.exit[type] = original;
    const url = this.resume();
    const node = this.stack[this.stack.length - 1];
    if (node.type === "link" || node.type === "image" || node.type === "definition") {
      node.url = url;
    }
    const start = token.start.offset;
    const end = token.end.offset;
    // Match the semantic path, including escaped/entity-encoded characters,
    // while retaining the original query/hash spelling and all unrelated bytes.
    const suffixAt = url.search(/[?#]/);
    const pathname = suffixAt < 0 ? url : url.slice(0, suffixAt);
    const target = replacements.get(pathname);
    if (target !== undefined) {
      edits.push({ start, end, value: target + (rawSuffixStart === undefined ? "" : markdown.slice(rawSuffixStart, end)) });
    }
  };
  fromMarkdown(markdown, {
    extensions: [directive()],
    mdastExtensions: [
      directiveFromMarkdown(),
      {
        enter: { resourceDestinationString: enterDestination, definitionDestinationString: enterDestination },
        exit: { resourceDestinationString: destination, definitionDestinationString: destination },
      },
    ],
  });
  let result = markdown;
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end);
  }
  return result;
}
