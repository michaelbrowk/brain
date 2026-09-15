# Brain MCP tools

Every tool Brain registers on `/api/mcp`, the scope it is declared against,
what it takes, what it answers and what it turns down. Connecting and
authorizing is `docs/mcp-oauth.md`.

Two rules hold for every row. An answer is JSON in one text block, so a client
parses `content[0].text` and nothing else. A refusal Brain decided on is a
`{ error, reason? }` object with `isError` set, not a transport error, so the
agent reads why and stops rather than retrying blind. A transport error from
this endpoint is a bug.

Scope is what the connection must already hold. `brain:read` is the floor every
connection has, so a row with no scope named needs nothing beyond it. A tool
called without its scope answers `insufficient_scope` and names the scope it
wanted, and the gate runs on the tool name before the handler, so nothing is
read or written on the way to that answer. Scope closure is in
`docs/mcp-oauth.md`: send implies mail, mail implies read, import implies
write implies read, and mail never implies write.

## Notes

| Tool | Scope | Inputs | Answers | Refuses |
| --- | --- | --- | --- | --- |
| `connection_check` | | none | `status`, per-check results, which of write and import are authorized, the root page count, the granted scopes | nothing |
| `list_tree` | | none | the whole page tree: ids, titles, icons, nesting | nothing |
| `read_page` | | `id` | the page's meta, its markdown and its `rev` | an id that is not a page surfaces as a transport error today rather than an `{ error }` answer |
| `search` | | `query` | matching pages with snippets | nothing |
| `write_page` | `brain:write` | `id`, `markdown`, `rev?` | the written page's meta and new `rev` | `rev conflict`, with `currentRev` to re-read from |
| `append_page` | `brain:write` | `id`, `markdown` | the page's meta after the append | nothing of its own |
| `create_page` | `brain:write` | `title`, `parentId?`, `markdown?`, `icon?`, `status?` | the new page's meta, including its id | `parent not found`, and it says the page was not created so the client does not retry at the root |
| `update_meta` | `brain:write` | `id`, `title?`, `icon?`, `category?`, `status?`, `view?`, `public?` | the page's meta after the change | `public: true`, with `share_disclosure_required`: only the owner's own disclosure flow turns sharing on |
| `move_page` | `brain:write` | `id`, `newParentId?`, `beforeId?` | the moved page's meta plus `unlinkedFrom`, the old parent whose body stopped listing it | nothing of its own |
| `delete_page` | `brain:write` | `id` | `{ ok: true }`. The page and its subtree go to Trash and are recoverable | nothing of its own |

## Tasks

A task is a record, not a note. `list_tasks` needs the caller's own calendar
date because the server has no timezone to fall back on, and the logbook needs
the caller's UTC offset as well, because a completion is one instant and the
day it falls on is the caller's.

| Tool | Scope | Inputs | Answers | Refuses |
| --- | --- | --- | --- | --- |
| `list_tasks` | | `list`, `today?`, `offsetMinutes?`, `category?` | `{ tasks }` for every list but the logbook, which answers `{ entries }`, one per completion, each with its own `key` | a missing `today` on any list but the inbox, a `today` that is not `YYYY-MM-DD` (`bad_today`), a logbook read with no `offsetMinutes` (`bad_offset`) |
| `get_task` | | `id` | `{ task }`, including whether its note line was removed and which page it is linked to | `bad_id`, `not_found`, `page_trashed` |

## Mail, reading

Every mail tool talks to the mail service in process over its Unix socket.
None of them goes through `/api/mail/*`, which is same-origin gated for the
browser. When the service is down the answer is one refusal,
`the mail service is unavailable` with reason `mail_service_unavailable`, and
nothing of the underlying failure is in it.

`mailbox` is one of the six system mailboxes (`inbox`, `all`, `sent`,
`starred`, `spam`, `trash`) and defaults to `inbox`. There are no custom
folders. `view` narrows a mailbox to `unread`, `attachments`, `lists` or
`people`. `limit` runs 1 to 50 and defaults to 25. A page is handed back by
passing its `nextCursor` as the next call's `cursor`.

No tool answers HTML. A message that arrived as HTML alone is answered with
the text the service extracted from it.

| Tool | Scope | Inputs | Answers | Refuses |
| --- | --- | --- | --- | --- |
| `list_mail_accounts` | `brain:mail` | none | `{ accounts }`, each `accountId`, `address`, `displayName`, `provider`, `canSend`, and `sendBlockedReason` only when it cannot send | nothing of its own |
| `list_mail_threads` | `brain:mail` | `accountId`, `mailbox?`, `view?`, `cursor?`, `limit?` | `{ threads, nextCursor }`, newest first, each thread's subject, participants, last message time, unread, starred, size, list flag and category | `account not found`, and any other code the service coined, as `the mail service refused this request` with that code as the reason |
| `search_mail` | `brain:mail` | `query`, `accountId?`, `mailbox?`, `cursor?`, `limit?` | `{ threads, nextCursor }` over cached headers and previews only | `that cursor is not usable any more` (`stale_cursor`), plus the service's own codes |
| `get_mail_thread` | `brain:mail` | `accountId`, `threadId` | `{ thread, messages }`, each message's `messageId`, `from`, `to`, `cc`, `subject`, `sentAt`, `unread`, `snippet`, `hasAttachments` and `bodyCached` | `thread not found`, plus the service's own codes |
| `read_mail_message` | `brain:mail` | `accountId`, `messageId`, `wait?` | `{ state, text?, attachments }`, each attachment's `attachmentId`, `filename`, `mimeType` and `bytes` | the service's own codes |

`sendBlockedReason` is Brain's own read of a `canSend: false`, because the
service reports sending as one boolean. `account_reauth_required` is the
account waiting to be reconnected, `smtp_not_configured` is an IMAP account
that was never given an SMTP endpoint, and `smtp_relay_unavailable` is an
account that has one this host cannot reach.

`search_mail` with no `accountId` runs the search on every connected account,
merges the results newest first with the thread id breaking a tie, and answers
one opaque cursor holding a cursor per account. `limit` is per account, so a
merged page can hold up to `limit` threads for each of them. An account the
previous page ran to the end is not asked again. A cursor naming an account
that is no longer connected is refused rather than silently narrowed, and a
cursor from a merged search is not a cursor a single-account search accepts.

`read_mail_message` records the body demand with the service first, because the
body cache drops a message outside the newest-Inbox cohort unless something is
holding it, and then polls for up to `wait` milliseconds (0 to 20000, 8000 by
default). It answers `state` rather than holding the call open: `fetching`
means call again, `transient` means the fetch failed and may succeed later,
`permanent` means it will not, and `ready` carries `text` and `attachments`.

## Mail, triage

| Tool | Scope | Inputs | Answers | Refuses |
| --- | --- | --- | --- | --- |
| `update_mail_thread` | `brain:mail` | `accountId`, `threadId`, and exactly one of `read`, `starred`, `archive`, `trash`, `restore`, `spam` | `{ thread }`, the thread's row as it stands after the change | `one change per call`, naming either the fields that arrived together or the six to pick from; `thread_mutations_unavailable` when the service withholds them for that account; `thread not found`, plus the service's own codes |

`trash` and `restore` take `true` and nothing else, because there is no second
thing either word could mean. The other four take a boolean, so `read: false`
puts a thread back to unread and `archive: false` brings it back to the Inbox.
"Move" is one of these six: Brain has no custom folders, and this release adds
none.

The one-change rule is Brain's own, checked before the mail service is called,
so the refusal names the fields the agent sent. It mirrors the PATCH the
service accepts, which counts its keys and turns down a second action.

A `read: true` also marks that thread's row read in the notification centre, on
the same condition the Mail surface uses: a letter read is a letter read,
whichever window read it. That mark never blocks the tool and never fails it,
so a bell that is one row stale is not reported as a triage that did not land.

Every call writes one activity line with the account, the thread and the
outcome. A refused call writes one too, so the owner sees what was attempted.

## Notion import

The nine `notion_*` tools are one guarded protocol, not nine independent
calls. They are declared against `brain:import` and are described in
`lib/notion/mcp.ts` and `docs/notion-import.md`. Every one of them refuses a
stale reservation token or a concurrent edit with a `code` the importer
branches on, and none of them retries at the root.

| Tool | Scope | Inputs | Answers | Refuses |
| --- | --- | --- | --- | --- |
| `notion_find_page` | `brain:import` | `notionId`, `reservationToken?` | the Brain page for that Notion id, its import baseline, its lease, and whether the supplied token owns it | the import conflict codes |
| `notion_inspect_candidate` | `brain:import` | `pageId` | one candidate's rev, placement and redacted Notion binding state | the import conflict codes |
| `notion_adopt_page` | `brain:import` | `pageId`, `notionId`, `sourceHash`, `conversionHash`, `expectedRev`, `expectedParentId`, `expectedBeforeId` | the bound page, its content and hierarchy unchanged | `rev conflict`, `Brain page not found`, the import conflict codes |
| `notion_reserve_page` | `brain:import` | `notionId`, `sourceHash`, `parentId`, `beforeId`, `title`, `reservationToken`, and the optional `conversionHash`, `icon`, `cover`, `acknowledgedAbort` | the reservation | `parent not found` and `next sibling not found`, both saying the page was not reserved, plus the import conflict codes |
| `notion_upload_attachment` | `brain:import` | `notionId`, `sourceHash`, `expectedSha256`, `reservationToken`, `originalName`, `mimeType`, `dataBase64` | the stored attachment's url and hash | a payload whose base64 does not decode exactly, and the import conflict codes |
| `notion_verify_attachment` | `brain:import` | `notionId`, `sourceHash`, `reservationToken`, `url` | the staged attachment's hash | the import conflict codes |
| `notion_verify_finalized_attachment` | `brain:import` | `notionId`, `sourceHash`, `conversionHash`, `url` | the permanent attachment's hash | the import conflict codes |
| `notion_finalize_page` | `brain:import` | `notionId`, `sourceHash`, `conversionHash`, `reservationToken`, `markdown`, and the optional `title`, `icon`, `cover`, `collection`, `collectionRow` | the finalized page | a stale token, a concurrent edit, and the import conflict codes |
| `notion_abort_page` | `brain:import` | `notionId`, `sourceHash`, `reservationToken` | the released reservation, the current page body untouched | the import conflict codes |

## Not offered

Four things an agent will look for and will not find. Each is a decision, not
a gap.

- **No account creation, editing or removal.** Adding a mail account means
  handling a password or an OAuth flow, and that is the owner's own screen.
- **No purge and no empty trash.** A page or a thread in the trash stays there
  until the person empties it. Deletion through MCP is always recoverable.
- **No turning sharing on.** `update_meta` accepts `public: false` and refuses
  `public: true` with `share_disclosure_required`. Publishing a page is the
  owner's decision, taken after seeing what it discloses.
- **No HTML.** Text bodies only, in and out. HTML never crosses an MCP
  boundary in either direction.

## Activity

Brain keeps an append-only log of what a connection did, capped at 2000 lines.
A line holds the time, the app's name the owner approved, the tool, the ids it
touched and an outcome code. There is no field a subject, an address, a body
or a title can enter through, and an outcome is reduced to letters, digits and
the punctuation an id or a hostname needs, so a refusal reason that quoted an
address cannot carry the address into the log.

The log lives in the MCP state directory (`BRAIN_MCP_STATE_DIR`,
`/var/lib/brain/mcp` in production), beside the owner's agent toggles and the
marks that caption a Sent row an agent wrote. None of it is in the notes
folder, in git or in a portable archive.

## Still to come in this release

Mail sending and attachments, the task write tools and the Settings view of the
activity log land later on this branch. Their rows are added here as each one
is registered, so this table and the server stay one description.
