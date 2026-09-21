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

**The new root's settings come off the grants being absorbed and from nowhere
else.** `shareEdit` is inherited the safe way round for a reader who already
holds a link: on if any absorbed grant had it. The password and the deadline are
cleared, not preserved — `configureShare` keeps both on a revoked page so an
owner can re-enable their own link, and the popover passes explicit values there,
but the fold passes none, so preserving them would turn a credential revoked long
ago back on under links that have never seen it, or publish a grant born expired
while the card says the links inside still work. An expired nested grant is
cleared like the rest, so one authority is left, but it records no pointer and
its dead link stays dead.

Two folds are refused, because each would give a reader something the grant they
hold never promised, or leave two grants over the same pages. One would answer
for an **ancestor's** grant — that root is already the authority, and the page
is already inside its link; the same refusal covers a page that overlaps a
parent's grant *and* a nested one. The other would take a gate away from a live
nested link: its **password** or its **deadline**, both of which the fold
otherwise clears, so a link the owner set to die next Friday would live for
good. The owner lifts that gate where it stands, on the link that carries it,
and the card's overlap list names which gate that is. Both refusals come back as
the enable path's scope conflict, carrying the fresh disclosure.

Revoking the parent's share gives every pointer back, so the folded links stop
resolving with the one that absorbed them — through the card's own revoke and
through the legacy `PATCH /api/page/<id> {"public": false}` alike, so no later
re-share of that page can revive an address the owner has already turned off.
There is no other undo: revoking the parent does not resurrect the grants it
took.

`sharedUnder` is not hierarchy (invariant 3). The folder tree stays the only
source of containment, and the pointer is read only through the live tree: the
page it names has to exist, to still contain this page, to be undeleted and to
be an active public root, or the old address is a 404 like any revoked share.
A fold that was itself folded is followed up the chain.

`mutate()` is a queue and not a transaction, and nothing here rolls back. A
failed write inside the fold leaves some nested roots cleared and the parent not
yet public — which fails closed, since the children go private before the parent
goes public and no window has two roots over one subtree — but it does not heal
itself, and the attachment baseline it took first makes a later share of that
parent skip taking a fresh one. `configureShare` has the same shape.

## Attachments

A visitor's writes bring the attachment index into it (`lib/store/attachment-scope.ts`).
A page becoming a share root while a scoped root already sits inside it takes
its baseline before the flag lands, and the fold is that same case arriving by
another route, so it takes the baseline too: after it, the parent grants every
attachment the subtree shows.
