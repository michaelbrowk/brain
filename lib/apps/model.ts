import { z } from "zod";

/** WHAT AN APP IS, AS A HANDFUL OF NUMBERS AND ONE SHAPE.
 *
 *  A page is an app when its frontmatter says so. Everything about that here
 *  and nowhere else: the schema the serializer round-trips, the three caps a
 *  write is measured against, and the two rules that decide what an asset may
 *  be called and what it may be. No React, no Next, no filesystem, so the
 *  store, the route, the MCP tools and the tests all read the same module. */

/** The one path an app's entry is served from. It is fixed rather than free
 *  so a page cannot name a file outside its own `app/` folder, and so the
 *  route has one name to match rather than a value from a file to trust. */
export const APP_ENTRY_PATH = "app/index.html";
export const APP_ASSETS_DIR = "app/assets";
export const APP_STATE_PATH = "app/state.json";

/** Where a rewrite assembles the new set before it replaces the old one. The
 *  leading dot is load-bearing: `isReservedDir` already skips a dot-prefixed
 *  folder, so a `Store.init()` that runs while a rewrite is half-done cannot
 *  walk the staging directory and find an app's files sitting where a page's
 *  would be. */
export const APP_STAGING_DIR = ".app-next";

/** How many pages one app may own. A number rather than a taste: the write
 *  check walks the list on every bridge write, and an app that has minted
 *  sixty-four pages under itself is a loop, not a feature. The schema below
 *  reads this, so the cap and the validation cannot disagree. */
export const APP_MAX_OWNED = 64;

/** Spec §2. The entry is one file and the agent inlines its libraries, so two
 *  megabytes is a generous document rather than a budget to fill. */
export const APP_ENTRY_MAX_BYTES = 2 * 1024 * 1024;
export const APP_ASSETS_MAX_BYTES = 10 * 1024 * 1024;
export const APP_STATE_MAX_BYTES = 256 * 1024;

/** One line, because the owner reads it under the title in the page head. A
 *  paragraph there would push the app itself below the fold. */
const MAX_REASON_CHARS = 280;

const PAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A path segment of an asset: letters, digits and the three punctuation
 *  marks a filename needs, never leading with a dot. A leading dot is out
 *  because `.` and `..` are how a traversal is spelled and a dotfile is not
 *  something an agent means to ship. */
const ASSET_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

/** MARKDOWN IS NOT AN ASSET, AT ANY NAME.
 *
 *  `Store.walk()` recurses into a folder that has no `index.md` and reads one
 *  as a page the moment it finds it, and `isReservedDir` skips an app's `app/`
 *  folder only from this release on: an archive restored into an older Brain,
 *  or a notes folder opened by another clone, still walks it. An
 *  `app/assets/index.md` would then appear as a phantom child page, and one
 *  carrying an id that already exists throws "duplicate page id" out of
 *  `rebuild()` and takes the whole notebook down at boot.
 *
 *  So the rule is the name, not the folder: no `.md`, ever, whatever it is
 *  called and however deep it sits. An app that wants to ship text ships
 *  `.txt`, which the walk has never read. */
const MARKDOWN_NAME = /\.md$/i;

/** A NAME WINDOWS WOULD NOT STORE AS WRITTEN.
 *
 *  A notes folder syncs, and a name one host accepts and another rewrites
 *  makes two notebooks that disagree about what is on disk: the asset an app
 *  asks for stops being the file that is there. Windows strips a trailing dot
 *  or space silently, and reserves the old device names whatever extension
 *  follows them, so `CON.png` is not a file it will keep.
 *
 *  Refused here rather than repaired, because an agent that meant `card.png`
 *  can be told to write `card.png`, while a rename behind its back leaves it
 *  addressing a name that no longer exists. */
const WINDOWS_RESERVED_BASENAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

function windowsWouldRewrite(segment: string): boolean {
  return (
    segment.endsWith(".") ||
    segment.endsWith(" ") ||
    WINDOWS_RESERVED_BASENAME.test(segment)
  );
}

export const appMetaSchema = z.object({
  entry: z.literal(APP_ENTRY_PATH),
  /** The app's own version, the agent's to set. Brain reads it only to show
   *  the owner that a rebuild happened. */
  version: z.number().int().min(1).max(1_000_000),
  /** The client name out of the grant, never a string the app chose. */
  builtBy: z.string().min(1).max(120),
  builtAt: z.string().datetime(),
  /** The child pages this app may write, resolved to ids on save. Bounded
   *  because the write check walks it on every bridge write. */
  owns: z.array(z.string().regex(PAGE_ID)).max(APP_MAX_OWNED).default([]),
  state: z.boolean().default(false),
  /** Why the app exists, in the owner's own words as the agent heard them.
   *  Collapsed to one line and cut, because the head draws it. */
  reason: z
    .string()
    .transform((value) => value.replace(/\s+/g, " ").trim().slice(0, MAX_REASON_CHARS))
    .refine((value) => value.length > 0)
    .optional(),
});

/** Inferred, never annotated. `owns` and `state` carry `.default()`, so the
 *  schema's input type and its output type differ and a `z.ZodType<AppMeta>`
 *  annotation on the schema will not typecheck. */
export type AppMeta = z.infer<typeof appMetaSchema>;

/** THE ONE VALIDATED READ OF AN `app` MAP.
 *
 *  Frontmatter is a file on somebody's disk and `parsePage` is a cast, so a
 *  map that says `owns: "notalist"` arrives typed as `AppMeta` while being a
 *  string where every caller expects an array. `appMayWrite` would then run
 *  `String.prototype.includes` on it and authorise any page id that happened
 *  to be a substring of it.
 *
 *  So nothing reads `meta.app` directly. A map that does not validate answers
 *  null here, and the page is a page with `kind: app` and no usable app:
 *  readable, renameable, movable, exportable, and unable to authorise
 *  anything. The map itself is never rewritten on that basis. A shape this
 *  release cannot read is more likely an older Brain's or a hand edit than
 *  junk, and deleting somebody's data to tidy a type is not a repair. */
export function validAppMeta(value: unknown): AppMeta | null {
  if (value === undefined || value === null) return null;
  const parsed = appMetaSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** The store path one asset name addresses, or null when the name is not one
 *  an app may hold. Answered before any path is joined, so a traversal never
 *  reaches the filesystem and `assertInRoot` is the second lock rather than
 *  the only one. */
export function appAssetPath(name: string): string | null {
  if (name.length === 0 || name.length > 512) return null;
  if (MARKDOWN_NAME.test(name)) return null;
  const segments = name.split("/");
  if (!segments.every((segment) => ASSET_SEGMENT.test(segment))) return null;
  if (segments.some(windowsWouldRewrite)) return null;
  return `${APP_ASSETS_DIR}/${segments.join("/")}`;
}

/** WHAT AN ASSET IS SERVED AS, READ OFF ITS NAME.
 *
 *  The extension is the only record of an asset's type once it is on disk,
 *  the same way it is for an attachment. A name outside this table is not
 *  served at all rather than served as octet-stream: the frame has
 *  `script-src 'unsafe-inline'` and nothing else, so a file it cannot use is
 *  a file it should not be able to fetch. */
const APP_ASSET_MIME: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  woff: "font/woff",
  woff2: "font/woff2",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  json: "application/json",
  csv: "text/csv",
  txt: "text/plain",
};

export function appAssetMimeType(name: string): string | null {
  // `.md` is refused here as well as in `appAssetPath`, so a caller that
  // reaches only one of the two still cannot land a file the page walk reads.
  if (MARKDOWN_NAME.test(name)) return null;
  const extension = name.split(".").pop()?.toLowerCase();
  if (extension === undefined || extension === name.toLowerCase()) return null;
  return APP_ASSET_MIME[extension] ?? null;
}
