/** THE TWO LETTERS THAT SAY AN AGENT BUILT THIS PAGE.
 *
 *  Drawn wherever a page is named, which is the tree, a page ref, a search
 *  result, the palette, Home, the breadcrumb, the share popover's overlap
 *  list and the public page, and drawn from `kind` alone. A title that
 *  happens to say "AI" earns nothing; a page whose frontmatter says
 *  `kind: app` earns it everywhere, including on a phone, where it is the
 *  only thing distinguishing a page somebody wrote from a page something
 *  built.
 *
 *  It is a span rather than a badge component with variants: there is one
 *  chip, it says one thing, and a second caller wanting a different colour
 *  would be a second signal rather than a prop. */
export function AiChip() {
  return (
    <span className="ai-chip" title="Built by an agent" aria-label="Built by an agent">
      AI
    </span>
  );
}
