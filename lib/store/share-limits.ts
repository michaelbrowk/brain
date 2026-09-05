// Four numbers three layers agree on. They live in a module with no imports so
// the Store, the request guard and the routes can all reach them without a
// cycle, and so changing one changes it everywhere at once.

/** A visitor PUT body. Generous for prose, far under nginx's 101 MB. */
export const MAX_SHARE_WRITE_BYTES = 256 * 1024;

/** Live descendants a shared root may hold before it stops accepting new
 *  subpages. Bounds the blast radius of an unattended editable link. */
export const MAX_SHARE_SUBTREE_PAGES = 200;

/** Per-root upload total. Every uploaded byte is permanent git history on a
 *  droplet with 8.7 GB shared between three sites; nginx caps one body and not
 *  a sum, so the sum is capped here. */
export const SHARE_ROOT_UPLOAD_BYTES = 200 * 1024 * 1024;

/** Visitor writes queued on Store.mutate() starve resolveShareAccess for every
 *  other share on the box. Four at once is the ceiling across all roots. */
export const SHARE_WRITE_CONCURRENCY = 4;
