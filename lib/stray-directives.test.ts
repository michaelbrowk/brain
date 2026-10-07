import { directiveFromMarkdown } from "mdast-util-directive";
import { fromMarkdown } from "mdast-util-from-markdown";
import { directive } from "micromark-extension-directive";
import { describe, expect, it } from "vitest";
import { removeOneStandalonePageRef, standalonePageRefOccurrences } from "./page-ref-nesting";
import { stripStrayDirectiveNodes, type StrayDirectiveNode } from "./stray-directives";

function outline(markdown: string): string {
  const root = fromMarkdown(markdown, {
    extensions: [directive()],
    mdastExtensions: [directiveFromMarkdown()],
  }) as StrayDirectiveNode;
  stripStrayDirectiveNodes(root, markdown);
  const show = (node: StrayDirectiveNode): string => {
    if (node.type === "text" || node.type === "inlineCode") return JSON.stringify(node.value);
    const inner = (node.children ?? []).map(show).join(" ");
    return `${node.name ?? node.type}(${inner})`;
  };
  return (root.children ?? []).map(show).join(" ");
}

describe("container fences of one length, nested", () => {
  it("close the innermost container, as the writer meant", () => {
    expect(outline(':::toggle{summary="O"}\n:::callout{icon="💡"}\nIn\n:::\n:::')).toBe(
      'toggle(callout(paragraph("In")))',
    );
  });

  it("put what stands between two fences back in the outer container", () => {
    expect(
      outline(':::toggle{summary="O"}\n:::callout\nIn\n:::\nafter\n:::\n\nnext'),
    ).toBe('toggle(callout(paragraph("In")) paragraph("after")) paragraph("next")');
    expect(outline(":::toggle\n:::callout\n:::toggle\nx\n:::\ny\n:::\nz\n:::")).toBe(
      'toggle(callout(toggle(paragraph("x")) paragraph("y")) paragraph("z"))',
    );
  });

  it("leave a body whose fences already nest alone", () => {
    expect(outline('::::toggle{summary="O"}\n:::callout\nIn\n:::\n::::\n\n:::')).toBe(
      'toggle(callout(paragraph("In"))) paragraph(":::")',
    );
  });

  it("leave an escaped fence as the prose it is", () => {
    expect(outline(':::toggle{summary="O"}\n:::callout\nIn\n:::\n\n\\:::')).toBe(
      'toggle(callout(paragraph("In"))) paragraph(":::")',
    );
  });

  it("move nothing when no fence follows", () => {
    expect(outline(':::toggle{summary="O"}\n:::callout\nIn\n:::\n\nafter')).toBe(
      'toggle(callout(paragraph("In"))) paragraph("after")',
    );
  });

  it("keep the server's page rows where the editor sees them", () => {
    // One-length fences closed `cols` at the first column's fence, so the
    // second column stood outside the row and its card was no row at all.
    const markdown = ":::cols\n:::col\nL\n:::\n:::col\n[Card](/p/abc)\n:::\n:::";
    expect(outline(markdown)).toBe('cols(col(paragraph("L")) col(paragraph(link("Card"))))');
    expect(standalonePageRefOccurrences(markdown, "abc")).toHaveLength(1);
    expect(removeOneStandalonePageRef(markdown, "abc")).toEqual({
      markdown: ":::cols\n:::col\nL\n:::\n:::col\n:::\n:::",
      removed: true,
    });
  });
});
