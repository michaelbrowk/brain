# Brain MCP tools

Every tool Brain registers on `/api/mcp`, the scope it is declared against,
what it takes, what it answers and what it turns down. Connecting and
authorizing is `docs/mcp-oauth.md`.

Two rules hold for every row. An answer is JSON in one text block, so a client
parses `content[0].text` and nothing else. A refusal Brain decided on is an
`{ error, reason }` object with `isError` set, not a transport error, so the
agent reads why and stops rather than retrying blind. A transport error from
this endpoint is a bug.

Scope is what the connection must already hold. `brain:read` is the floor every
connection has, so a row with no scope named needs nothing beyond it. A tool
called without its scope answers `insufficient_scope` and names the scope it
wanted, and the gate runs on the tool name before the handler, so nothing is
read or written on the way to that answer. Scope closure is in
`docs/mcp-oauth.md`: send implies mail, mail implies read, import implies
write implies read, and mail never implies write.

## What an agent should know

Four rules no single row states.

- **A refusal is an answer, not an error.** Read it and do not retry a
  permanent one. Every tool but the `notion_*` family answers the same two
  fields: `error` is the sentence and `reason` is what names the cause, which
  is the machine code wherever the refusal has one and otherwise the field,
  the id or the measurement. Branch on `reason`. A refusal with more to hand
  back puts it in a third field beside those two, `currentRev` on a
  `write_page` conflict and `currentWhen` on a task one. The import tools keep
  the `{ error, code }` their own contract has, which `docs/notion-import.md`
  owns.
- **`read_mail_message` may answer `state: "fetching"`.** Call it again. Each
  call re-records the demand that keeps the body in the service's cache, so an
  agent that stops asking loses the body it was waiting for.
- **`send_mail` and `reply_mail` need an `idempotencyKey` of 16 to 128
  characters from `A-Z`, `a-z`, `0-9`, `_` and `-`.** Reusing a key replays the
  same result. Reusing it with different content is refused.
- **`complete_task` and `reopen_task` need `today` as your own local calendar
  date.** A completion writes a day into the Logbook and the server has no
  caller's time zone to fall back on. `list_tasks` and `get_task` are the
  lenient pair: they fall back to the owner's own zone.

## Notes

| Tool | Scope | Inputs | Answers | Refuses |
| --- | --- | --- | --- | --- |
| `connection_check` | | none | `status`, per-check results, `access` with `read`, `write`, `import`, `mail` and `mailSend`, the root page count and the granted scopes | nothing |
| `list_tree` | | none | the whole page tree: ids, titles, icons, nesting | nothing |
| `read_page` | | `id` | the page's meta, its markdown and its `rev` | an id that is not a page surfaces as a transport error today rather than an `{ error }` answer |
| `search` | | `query` | matching pages with snippets | nothing |
| `write_page` | `brain:write` | `id`, `markdown`, `rev?` | the written page's meta and new `rev` | `rev_conflict`, with `currentRev` to re-read from |
| `append_page` | `brain:write` | `id`, `markdown` | the page's meta after the append | nothing of its own |
| `create_page` | `brain:write` | `title`, `parentId?`, `markdown?`, `icon?`, `status?` | the new page's meta, including its id | `parent not found`, and it says the page was not created so the client does not retry at the root |
| `update_meta` | `brain:write` | `id`, `title?`, `icon?`, `category?`, `status?`, `view?`, `public?` | the page's meta after the change | `public: true`, with `share_disclosure_required`: only the owner's own disclosure flow turns sharing on |
| `move_page` | `brain:write` | `id`, `newParentId?`, `beforeId?` | the moved page's meta plus `unlinkedFrom`, the old parent whose body stopped listing it | nothing of its own |
| `delete_page` | `brain:write` | `id` | `{ ok: true }`. The page and its subtree go to Trash and are recoverable | nothing of its own |

## Tasks

A task is a record, not a note. A derived list is read against a day, so
`list_tasks` takes the caller's own calendar date as `today`. Leave it out and
Brain uses the owner's own time zone, the one Settings, Account holds. With no
zone captured and no `today`, the read is refused rather than answered in UTC.
The Inbox is the exception: it is a property of the record alone, so it needs
neither a day nor a zone. The logbook needs a UTC offset as well, because a
completion is one instant and the day it falls on is the caller's.

A completion does not leave its list. A ticked task stays in the list it was
in, struck through, until the day changes, and only then does it reach the
logbook. So a list read that follows a completion carries `offsetMinutes` too.
Without one the day is UTC's, and a completion near midnight moves lists under
the agent that made it.

`time` is `HH:MM`, 24 hour, in the owner's zone. `evening` is `true` or absent,
never `false`. Both are statements about a day, so both need `when` to be a day
rather than `someday`, and a later change that parks the task or sends it back
to the Inbox clears them whether or not the call names them. `remindedAt` is
not a field any tool can set: clearing `time` is how a reminder is stopped, and
the store clears the mark itself.

Every task write records one line in the activity log, carrying the tool, the
record's id, the note's id for a promote, and the outcome. No title enters it.

| Tool | Scope | Inputs | Answers | Refuses |
| --- | --- | --- | --- | --- |
| `list_tasks` | | `list?` as `inbox`, `today`, `upcoming`, `someday` or `logbook`, `page?`, `today?`, `offsetMinutes?`, `category?` | `{ tasks }` for every list but the logbook, which answers `{ entries }`, one per completion, each with its own `key` | `bad_today` for a day that is not `YYYY-MM-DD`, `bad_offset` for a logbook read with no offset and no zone, the no-zone refusal for a derived list with neither a day nor a captured zone, and `missing_list` for a call naming neither a list nor a page |
| `get_task` | | `id` | `{ task }`, including whether its note line was removed and which page it is linked to | `bad_id`, `not_found`, `page_trashed` |
| `create_task` | `brain:write` | `title`, `when?`, `time?`, `evening?`, `deadline?`, `category?`, `repeat?` | `{ task }`, unlinked: it owns its own completion and belongs to no note | whatever the record refuses, as `that task change was refused` with the record's own reason, for instance `time needs a day to be a time on` |
| `promote_task_line` | `brain:write` | `page`, `line` as a zero-based markdown line number or the line's own text with runs of whitespace collapsed, `when?`, `time?`, `evening?`, `deadline?`, `category?` | `{ task }`, linked to that checkbox line, with the anchor the editor's own promote builds. The note's category is inherited unless one is named here | `that line is not a checkbox`, `that line appears more than once, pass its line number`, `that line is empty`, `that line already has a task` naming the record that has it, `bad_page`, and `not_found` for a note that is not there |
| `update_task` | `brain:write` | `id`, `title?`, `when?`, `time?`, `evening?`, `deadline?`, `category?`, `repeat?`. A field left out is left alone and `null` clears it | `{ task }` after the change | `bad_id`, `not_found`, whatever the record refuses. `expectedWhen` and `remindedAt` are refused as unknown arguments |
| `complete_task` | `brain:write` | `id`, `today`, `offsetMinutes?`, `expectedWhen?` | `{ task, list }`, where `list` is the list the record is in for that day, which is the list it was already in | `bad_id`, `not_found`, and `conflict` with `currentWhen` when a repeating task has moved since the caller last read it |
| `reopen_task` | `brain:write` | `id`, `today`, `offsetMinutes?` | `{ task, list }`. Unticking a repeating task restores the instance its newest completion came from | `bad_id`, `not_found`, `conflict` |
| `delete_task` | `brain:write` | `id` | `{ ok: true }`. A linked task's checkbox line stays in its note, and the record that pointed at it is what goes | `bad_id`, `not_found` |

Every code named in the task rows above is the `reason` on the refusal, with
the sentence beside it in `error`.

`list_tasks` with `page` answers a different question, so it takes nothing
else. It hands back `{ tasks }`: every record that note owns, linked and
detached, done and open, whatever their age, because the editor draws a word on
every task line whatever state its record is in. A `list`, a `today`, an
`offsetMinutes` or a `category` beside it is refused as `unexpected_list`,
`unexpected_today`, `unexpected_offset` or `unexpected_category`, and a page id
that is not an id is `bad_page`.

A linked task cannot repeat. The record refuses `repeat` and `page` together,
because a repeating task advances its own `when` on completion and a checkbox
has no second occurrence. That is why `promote_task_line` takes no `repeat`.

## Mail, reading

Every mail tool talks to the mail service in process over its Unix socket.
None of them goes through `/api/mail/*`, which is same-origin gated for the
browser. When the service is down the answer is one refusal,
`the mail service is unavailable` with reason `mail_service_unavailable`, and
nothing of the underlying failure is in it. Every other refusal the service
coined keeps its own code in `reason`, so one code reads the same wherever an
agent meets it.

`mailbox` is one of the six system mailboxes (`inbox`, `all`, `sent`,
`starred`, `spam`, `trash`) and defaults to `inbox`. There are no custom
folders. `view` narrows a mailbox to `unread`, `attachments`, `lists` or
`people`. `limit` runs 1 to 50 and defaults to 25. A page is handed back by
passing its `nextCursor` as the next call's `cursor`.

No tool answers HTML. A message that arrived as HTML alone is answered with
its text: the service's own extraction when that already ran, and Brain's
own reading of the sanitized HTML for the one shape the service's extraction
misses.

`accountId`, `threadId` and `messageId` are checked against the client's own
id shapes before any of them reach it, so a malformed one is refused as
`invalid_account_id`, `invalid_thread_id` or `invalid_message_id`, naming the
field rather than arriving as a service refusal for a service that was never
asked. `search_mail`'s `query` is checked the same way: empty or over the
browser's own cap is `invalid_query`.

Reading mail writes no activity line. The log is what an agent changed, and a
log that recorded every read would bury the sends.

| Tool | Scope | Inputs | Answers | Refuses |
| --- | --- | --- | --- | --- |
| `list_mail_accounts` | `brain:mail` | none | `{ accounts }`, each `accountId`, `address`, `displayName`, `provider`, `canSend`, and `sendBlockedReason` only when it cannot send | nothing of its own |
| `list_mail_threads` | `brain:mail` | `accountId`, `mailbox?`, `view?`, `cursor?`, `limit?` | `{ threads, nextCursor, availability }`, threads newest first with subject, participants, last message time, unread, starred, size, list flag and category. `availability` says whether the mailbox itself answered or why it did not | `invalid_account_id`, `account not found`, and any other code the service coined, as `the mail service refused this request` with that code as the reason |
| `search_mail` | `brain:mail` | `query`, `accountId?`, `mailbox?`, `cursor?`, `limit?` | one account: `{ threads, nextCursor, availability, indexStatus, resultsTruncated }`. Every account: `{ threads, nextCursor, accounts }`, `accounts` holding each queried account's own `availability`, `indexStatus` and `resultsTruncated`, or `error` and `reason` for one that did not answer | `invalid_account_id`, `invalid_query`, `that cursor is not usable any more` (`stale_cursor`), plus the service's own codes |
| `get_mail_thread` | `brain:mail` | `accountId`, `threadId` | `{ thread, messages }`, each message's `messageId`, `from`, `to`, `cc`, `subject`, `sentAt`, `unread`, `snippet`, `hasAttachments` and `bodyCached` | `invalid_account_id`, `invalid_thread_id`, `thread not found`, plus the service's own codes |
| `read_mail_message` | `brain:mail` | `accountId`, `messageId`, `wait?` | `{ state, text?, attachments }`, each attachment's `attachmentId`, `filename`, `mimeType` and `bytes` | `invalid_account_id`, `invalid_message_id`, the service's own codes |

`sendBlockedReason` is Brain's own read of a `canSend: false`, because the
service reports sending as one boolean. `account_reauth_required` is the
account waiting to be reconnected, `smtp_not_configured` is an IMAP account
that was never given an SMTP endpoint, and `smtp_relay_unavailable` is
everything else, which today means an account whose relay this host cannot
reach. That last one is a fallback rather than a finding, so treat it as "the
service will not send from this account" and not as a diagnosis.

`availability`, on both `list_mail_threads` and `search_mail`, is what lets
an agent tell an empty `threads` array apart from a mailbox that has not
answered. `status: "available"` carries `windowTruncated`, and
`status: "unavailable"` carries a `reason` such as `mailbox_reauth_required`.
`search_mail` adds `indexStatus` (`building` or `ready`) and
`resultsTruncated`, the same two signals the browser shows as "Indexing" and
"Retrying later".

`search_mail` with no `accountId` runs the search on every connected account,
merges the results newest first with the thread id breaking a tie, and answers
one opaque cursor holding a cursor per account. `limit` is per account, so a
merged page can hold up to `limit` threads for each of them. An account the
previous page ran to the end is not asked again. A cursor naming an account
that is no longer connected is refused rather than silently narrowed, and a
cursor from a merged search is not a cursor a single-account search accepts.
One account failing does not fail the others: its page is skipped, its entry
in `accounts` carries `error` and `reason` instead of the completeness
signals, and the next call asks it again from the start.

`read_mail_message` records the body demand with the service first, because the
body cache drops a message outside the newest-Inbox cohort unless something is
holding it, and then polls for up to `wait` milliseconds (0 to 20000, 8000 by
default). It answers `state` rather than holding the call open. `not_requested`
and `fetching` both mean the body is not there yet and the caller should call
again, `transient` means the fetch failed and may succeed later, `permanent`
means it will not, and `ready` carries `text` and `attachments`.

## Mail, triage

| Tool | Scope | Inputs | Answers | Refuses |
| --- | --- | --- | --- | --- |
| `update_mail_thread` | `brain:mail` | `accountId`, `threadId`, and exactly one of `read`, `starred`, `archive`, `trash`, `restore`, `spam` | `{ thread }`, the thread's row as it stands after the change | `invalid_account_id` and `invalid_thread_id`. `trash_is_true_only` and `restore_is_true_only` for a `false` that names no second thing either word could mean. `one change per call`, naming either the fields that arrived together or the six to pick from. `mail_thread_mutation_unsupported` when the service withholds them for that account, the same code the wire uses for the folderless case. `thread not found`, plus the service's own codes |

`trash` and `restore` take `true` and nothing else, because there is no second
thing either word could mean. `false` on either is refused rather than
accepted and ignored, naming the field and pointing at `restore: true` for the
agent that reached for `trash: false` to mean "take it out of the trash". The
other four take a boolean, so `read: false` puts a thread back to unread and
`archive: false` brings it back to the Inbox. "Move" is one of these six.
Brain has no custom folders, and this release adds none.

The one-change rule is Brain's own, checked before the mail service is called,
so the refusal names the fields the agent sent. It mirrors the PATCH the
service accepts, which counts its keys and turns down a second action.

`accountId` and `threadId` are checked against the same shapes the read tools
check, before anything else runs. A malformed id is refused here, naming the
field, rather than reaching the mail client or the activity log.

A `read: true` also marks that thread's row read in the notification centre, on
the same condition the Mail surface uses: a letter read is a letter read,
whichever window read it. That mark never blocks the tool and never fails it,
so a bell that is one row stale is not reported as a triage that did not land.

Every call writes one activity line with the account, the thread, which of the
six fields changed and the outcome. A refused call writes one too, so the
owner sees what was attempted.

## Mail, sending

| Tool | Scope | Inputs | Answers | Refuses |
| --- | --- | --- | --- | --- |
| `send_mail` | `brain:mail:send` | `accountId`, `to`, `cc?`, `bcc?`, `subject`, `text`, `idempotencyKey`, `attachments?` as `[{ page, name }]` | `{ operationId, created, status }`. `created: false` means this key had already been sent and the first result is being replayed | `agent sending is off`. `invalid_account_id`. `to is empty`. `that is too many recipients` over 100 across the three fields. `that is not an address` naming the field and index, and `that address is listed twice` the same way. `that message is too long` and `that subject is too long`, each naming its cap. `that subject holds a control character`. `that message holds a null byte`. `account not found`. `cannot send from this account` with the blocked reason. `too many attachments`, `that is not an attachment name`, `page not found`, `that page does not hold that file`, `that file is gone`, `those attachments are too large`, `that file cannot be sent`, `page_changed`, `attachment_read_failed`. Plus the service's own codes. A send that timed out is not refused: see the `state` unknown answer below |
| `reply_mail` | `brain:mail:send` | `accountId`, `threadId`, `messageId`, `replyAll?`, `text`, `idempotencyKey`, `attachments?` as `[{ page, name }]` | `{ operationId, created, status }`, the reply threaded by the service onto the message named | everything `send_mail` refuses, plus `invalid_thread_id`, `invalid_message_id`, `that message is not in that thread`, and `there is no one to reply to` when the message names this account and no one else. A `to`, `cc`, `bcc` or `subject` is an unknown argument and is refused by the schema |
| `get_mail_send_status` | `brain:mail:send` | `operationId`, `accountId?` | `{ operationId, status, threadId }`. `threadId` is the thread the Sent copy landed in, or `null`. With `accountId` given, a send the tool never got an answer for gets its Sent-row mark written here | `invalid_operation_id`, `invalid_account_id`, `no send with that id`, the service's own codes |

The account is a parameter of every send and the agent picks it. There is no
allowlist of accounts an agent may write from: the gate is the scope, the
owner's toggle, and whether the account can send at all.

`idempotencyKey` is required and is the agent's own: 16 to 128 characters of
`A-Z`, `a-z`, `0-9`, `_` and `-`. A key outside that shape is an unknown
argument rather than a refusal, so the agent learns it from the tool
definition. Sending twice with one key replays the first result instead of
sending twice, and reusing a key for a different message is refused with
`mail_send_idempotency_conflict`.

`status` is the send state machine as it stands: `queued`, `sending`, `sent`,
`delivery_unknown` or `failed`. `threadId` on a status read stays `null` until
the provider has a Sent copy, and on an account with no Sent folder it stays
`null` for good.

A send whose answer never comes back is not a refusal. The mail service
enqueues the message durably before it delivers, so a request that timed out
or was cancelled is as likely to have gone out as not, and `send_mail` and
`reply_mail` answer

```json
{ "state": "unknown", "idempotencyKey": "...", "operationId": null, "retry": "same-key" }
```

with a sentence saying what to do. The one safe move is to ask again with the
**same** `idempotencyKey`: the service replays the first send rather than
making a second one, and answers its `operationId`, which
`get_mail_send_status` then reports on. A fresh key sends the message twice.
The activity line for that call reads `unknown`, so the owner's log
distinguishes a send that did not happen from one nobody knows about. The
answer carries no `error` and is not marked as one: only a failure the service
named is a refusal.

A send with no answer wrote no mark either, because the tool never learned an
operation id, so the Sent row has nothing to caption. Passing `accountId` to
`get_mail_send_status` beside the `operationId` closes that: the first status
call that finds the send accepted writes the mark the send could not write for
itself. A mark already there is left alone.

Brain checks what it can before the mail service is called: the three id
shapes, the owner's toggle, an empty `to`, every address, a repeated address,
the recipient count, a control character in a subject, and the two body caps
(998 bytes of subject, 1 MiB of text). Each of those is a rule the mail client
applies a moment later, and checking twice is what lets the refusal name the
field instead of arriving as a request the service could not read. The ids come
first, so no activity line carries a string Brain never issued, and a line for
a malformed id names no target at all. The one round trip a refusal costs is
the account list, which is why it is the last check.

`reply_mail` derives its own recipients and the agent may not override them.
The tool reads the thread, finds the message by id, puts `Reply-To` over
`From`, drops this account's own addresses and the provider's equivalent forms
of them, and never guesses a Bcc. `replyAll: true` keeps the To and Cc roles of
the message being answered. The subject is the target's, prefixed `Re: ` unless
it already answers. An agent that wants different recipients sends a new
message.

Every message an agent sends is marked as one. The send carries
`origin: "mcp"`, which is what earns it the `X-Brain-Agent: mcp` header in the
outbound MIME. One activity line is written with the account, the operation
and the outcome, and one mark is kept in the state directory so the Sent row
can say which app wrote it. The mark holds the operation id, the account, the
app's name and the thread once it is known, and nothing about what was
written. None of this is visible to the recipient.

Two toggles in Settings, Connections govern the pair. "Let agents send mail" is
on by default. With it off, `send_mail` and `reply_mail` answer
`agent sending is off` with `turn it on in Settings, Connections` before the
mail client is built, and reading mail is unaffected. "Tell recipients when an
agent writes" is off by default. With it on, the outgoing message carries one
plain last line, `Sent by an agent through Brain.`. `get_mail_send_status` is a
read and neither toggle gates it: a send already made can always be asked
about.

The kill switch fails closed. A settings file this process cannot read or make
sense of refuses both write tools, naming Settings, Connections, where saving
either toggle rewrites the file. A file nobody has written yet is the first
run, not a fault, and the documented defaults are the answer.

Outgoing attachments come from a page's own files and from nowhere else. Each
is named by the page and by the file's own name in that page's Markdown, the
part after `/_attachments-v2/`, and never by a path. A name holding a slash, a
`..` or a space is refused as a name before anything is read. Brain then reads
the page, and a file the body does not show is refused even when the file
exists, because a page id the agent can read would otherwise be a key to every
file in the notes folder. What an agent can send is what the note it named
already shows, which is what a person could forward by opening that note.

Ten files and 10 MiB of them are the limits for one message. Each file is read
against what is left of that budget and the total is summed as it goes, so a
set over the cap is turned down before a single byte is encoded and a file
above the budget is turned down without being read at all. The bytes reach the
message through the note store, the one module that touches the notes
filesystem, and never through a temporary file. A file's type is the one its
name records, and a type a MIME header cannot carry is refused with that as
the reason.

One message with files goes out at a time. A 10 MiB attachment costs about
60 MiB of memory while it is on its way, counting the file, its base64, the
JSON of the whole request and the buffer of that, and the mail service builds
one message at a time anyway. So a second call carrying files waits for the
first to answer before it reads a byte, rather than holding its own encoded
copy for the length of somebody else's send. It waits, it is never refused,
and a message with no files is not held up at all.

A failure in the notes folder is answered as one. A page that cannot be read
answers `page_changed` and a file that changed while it was being read answers
`attachment_read_failed`, each with the mail service untouched and the same
code in the activity line, so the owner's log never names a subsystem that was
not involved.

The activity line for a send with files names how many there were and the
names the store minted for them. Those names are the store's own, not a
filename a person chose, so the line says which file left the notes folder
without saying anything about what is in it. A line has room for about two or
three names before it is cut, and a cut is marked.

## Mail, an attachment into a note

| Tool | Scope | Inputs | Answers | Refuses |
| --- | --- | --- | --- | --- |
| `save_mail_attachment` | `brain:mail` and `brain:write` | `accountId`, `attachmentId`, `page`, `append?` | `{ url, name, size, type }`, the saved file as the note store named it | `invalid_account_id`, `invalid_attachment_id` and `invalid_page_id`, the codes its sibling mail tools use. `page not found`, before anything is downloaded. `that file is too large for a note`, naming the cap. `that file cannot be saved into a note`, naming the executable extension. Whatever the note store refuses the file for, in its own words with its own code (`blocked_mime`, `mime_mismatch`, `too_large`). Plus the service's own codes |

It is the one mail tool that writes a note, so it asks for `brain:write`
beside `brain:mail`. A grant that reads mail and cannot edit notes is refused
before the mail client is built.

The page is read before the download. A mistyped page id is the common case
and costs one file read to answer, where answering it afterwards costs a whole
file over the socket and leaves one nothing links. The append keeps its own
not-found branch for the page deleted in between, and that one does say the
file is saved and no line was added. With `append` false there is no line to
write, so the page is not read at all.

Two caps apply and the smaller one wins. The mail service hands out no more
than 40 MiB from a mailbox, the notes folder takes no more than 25 MiB, and
the download is bounded to the smaller number as it is read: a file over the
cap is abandoned part-way rather than held whole in memory and then turned
down. The note store checks the rest, the same checks an upload from the
browser meets: the blocked types, and the first bytes against the type the
file claims.

One check is this path's own, and the owner's own uploads do not meet it. A
file whose stored name would end `.exe`, `.dll`, `.com`, `.scr`, `.bat`,
`.cmd`, `.ps1`, `.msi`, `.jar`, `.sh`, `.app`, `.dmg` or `.pkg` is refused,
whatever type the message claimed for it. A person dragging an installer into
their own note chose both the bytes and the name. Here a remote sender chose
both and an agent decided to keep them, and that is the difference the rule is
about. The list lives in `lib/attachments.ts` beside the MIME lists.

The file is named from the message's own `Content-Disposition`, the RFC 5987
form first. The client refuses a malformed or oversized header before this
tool sees it, and the name is bounded again here at 255 bytes. The store keeps
it as display metadata only and mints its own name for the file on disk.

With `append` true, the default, one Markdown line is added to the page: an
image is shown, anything else is linked. The filename is escaped into the
link's label, because it is the sender's prose and an unescaped bracket in it
would close the link early. The page's `updatedBy` becomes `claude`, as with
every MCP write. With `append` false nothing is written to the page, and a
file no page links is collected by the attachment sweep a day later, so an
agent that passes it has to write its own line.

There is no dedupe. Saving one attachment twice writes two files and two
lines, the way a person uploading the same file twice would, so an agent
retrying a call it already made has to check the page rather than call again.

One activity line per call names the account, the attachment and the page,
never the filename.

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

There are no draft tools either, and that one is a gap rather than a decision.
See below.

## Activity

Brain keeps an append-only log of what a connection did, capped at 2000 lines
and at 512 KiB, whichever a line reaches first. A line holds the time, the
app's name the owner approved, the tool, the ids it touched, which field
changed on a triage or a task write and an outcome code. There is no field a
subject, an address, a body or a title can enter through, an outcome is
reduced to letters, digits and the punctuation an id or a hostname needs, and
every other field is bounded on its own: a caller that hands over an id far
past its real shape gets that field back cut and marked rather than the whole
line, so one call cannot spend the log's budget on itself.

The log lives in the MCP state directory (`BRAIN_MCP_STATE_DIR`,
`/var/lib/brain/mcp` in production), beside the owner's agent toggles and the
marks that caption a Sent row an agent wrote. None of it is in the notes
folder, in git or in a portable archive.

Settings, Connections shows the last fifty lines, newest first, with a Clear
action beside the two toggles.

## Known gaps

Five things this release ships without, each of them known.

- **A write is logged and a read is not.** Every triage, send, attachment save
  and task write leaves a line, refusals included. No read of any kind leaves
  one, `get_mail_send_status` included. An owner scanning Connections sees what
  an agent changed, never what it looked at.
- **An agent's reply can make the bell name the correspondent.** The
  notification centre announces a thread when something in it is unread, and a
  reply an agent wrote into a thread that still holds an older unread message
  passes that gate. The row then names the person the agent was answering. The
  exact gate lives in the mail service, so this is a hole the agent path
  widened rather than made.
- **A Sent row from an IMAP account never gets its caption.**
  `MailSendOperation.threadId` fills only on an accepted provider delivery,
  which today means Gmail. First-party SMTP issues no provider ids, so the
  mark has no thread to join on and the row reads as any other. The
  `X-Brain-Agent: mcp` header and the activity line are still there.
- **`sendBlockedReason` has three answers and the service has one boolean.**
  Brain derives the reason from what it can see, so a fourth cause the service
  knows about reads as `smtp_relay_unavailable`. A field on the wire is the
  honest fix.
- **A draft carries no attachments, so there are no draft tools.** The service
  refuses a draft that holds one, in `createDraft` and again in
  `draftMatchesSubmission`. MCP sends directly and never touches a draft, so
  nothing here is blocked by it, and an agent that wanted to leave a message
  for the owner to check cannot.
