# Sharing

A share is owned by one page. `public` on that page's frontmatter is the grant,
and every request for a shared page is resolved from that root on each load
(`lib/share-access.ts`): the root's `public`, `sharePass`, `shareExpiresAt` and
`shareVersion` are the whole of the authority, and sharing metadata on a
descendant is deliberately ignored, so moving a page cannot silently widen or
narrow what a link reaches. `shareEdit` is root-only for the same reason, and
every change to any of them rotates `shareVersion`, which ends every cookie
already issued against the old one.

## One authority per subtree

Two grants over the same pages mean two answers to the same question, so a new
grant is refused where one already overlaps it — an ancestor's or a
descendant's (`Store.configureShare`, which checks the overlap against the exact
disclosure token the owner was shown). The owner's card states the overlap
rather than creating a second root.

## Sharing a parent folds the nested grants into it

Refusing was a dead end: the only way forward was to revoke a link somebody was
already holding. Where every overlap is a grant nested **inside** the page being
shared, `Store.absorbNestedShares` takes them in one mutation — the parent
becomes the root, each nested page stops being one, and a page whose grant was
still alive records `sharedUnder: <parentId>`, which is how its old address goes
on working: `/share/<formerRoot>` is answered with a 308 to
`/share/<parentId>?page=<formerRoot>` (`resolveFoldedShareRoot`), so the media,
the edit cookie and the subpages the page then asks for are all addressed to the
root that actually holds the grant.

`shareEdit` is the one setting inherited, and the safe way round for a reader
who already holds a link: on if any absorbed grant had it. An expired nested
grant is cleared like the rest, so one authority is left, but it records no
pointer and its dead link stays dead. Two folds are refused, because both would
give a reader something the grant they hold never promised: one that would
answer for an **ancestor's** grant (that root is already the authority, and the
page is already inside its link), and one that would drop a nested **password**
under a parent that asks for none. Both come back as the enable path's scope
conflict, carrying the fresh disclosure.

Revoking the parent's share gives every pointer back, so the folded links stop
resolving with the one that absorbed them. There is no other undo: revoking the
parent does not resurrect the grants it took.

`sharedUnder` is not hierarchy (invariant 3). The folder tree stays the only
source of containment, and the pointer is read only through the live tree: the
page it names has to exist, to still contain this page, to be undeleted and to
be an active public root, or the old address is a 404 like any revoked share.
A fold that was itself folded is followed up the chain.

## Attachments

A visitor's writes bring the attachment index into it (`lib/store/attachment-scope.ts`).
A page becoming a share root while a scoped root already sits inside it takes
its baseline before the flag lands, and the fold is that same case arriving by
another route, so it takes the baseline too: after it, the parent grants every
attachment the subtree shows.
