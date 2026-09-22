/** THE DESIGN SYSTEM, AS THE FRAME CAN RECEIVE IT.
 *
 *  The frame shares no origin and no stylesheet with Brain, so it cannot read
 *  `app/globals.css`. The host resolves these properties off the live document
 *  and hands their computed values over at `hello` and again on every theme
 *  change, and the kit's bootstrap writes them onto the frame's own
 *  `:root`. That is what makes a theme change repaint an app without a reload.
 *
 *  The list is the subset spec §6 names: paper, the ink set, the blue, the
 *  fills, the radii, the font stack. Not every token in the file: an app is a
 *  small surface, and a hundred properties over `postMessage` on every theme
 *  flip is a cost with nothing on the other side of it. */
export const APP_TOKEN_NAMES = [
  "--paper",
  "--surface",
  "--ink",
  "--ink-2",
  "--ink-3",
  "--ink-4",
  "--line",
  "--hair",
  "--hair-strong",
  "--blue",
  "--blue-tint",
  "--red",
  "--yellow",
  "--fill-tint",
  "--fill-hover",
  "--fill-active",
  "--r-xs",
  "--r-sm",
  "--r-md",
  "--r-lg",
  "--r-xl",
  "--font-sf",
  "--ease-out",
] as const;

export function readAppTokens(root: HTMLElement): Record<string, string> {
  const computed = getComputedStyle(root);
  const tokens: Record<string, string> = {};
  for (const name of APP_TOKEN_NAMES) {
    const value = computed.getPropertyValue(name).trim();
    if (value) tokens[name] = value;
  }
  return tokens;
}
