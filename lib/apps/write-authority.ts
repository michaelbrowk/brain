/** HOW AN APP SIGNS ITS OWN WRITES.
 *
 *  Spec §4: every write through the bridge is logged with `client: <app page
 *  title> (app)`. The word in the brackets is what stops an app called
 *  "Claude" reading in the log like the grant that built it. Written here
 *  rather than at the call sites so the two routes and their tests spell it
 *  one way.
 *
 *  Bounded and collapsed to one line for the same reason the log bounds every
 *  other field: the title is the owner's own, but it reaches a file a person
 *  scrolls, and a title with a newline in it makes that file unreadable. */
const MAX_TITLE_CHARS = 100;
const FALLBACK = "An app";

export function appWriteClient(title: string): string {
  const tidy = title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
  return `${tidy.length > 0 ? tidy : FALLBACK} (app)`;
}
