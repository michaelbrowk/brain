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

The mail tools, the task write tools and the Settings view of the activity log
land later on this branch. Their rows are added here as each one is
registered, so this table and the server stay one description.
