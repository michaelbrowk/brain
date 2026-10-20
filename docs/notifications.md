# Notifications

Brain has one notification centre and one background timer behind it. The timer
looks for task reminders every thirty seconds and for new mail every minute, and
new mail is also looked for two seconds after the mail service reports a sync
that changed an Inbox. What it finds becomes a row in the centre, and a push on
every device you have turned push on for.

## What fires

A task with `when` a day and a `time` rings at that wall clock in the owner's
zone. The zone is one setting for the notebook, at **Settings → Account**, and
`docs/tasks.md` describes how it is captured. A reader in another country sees
the same clock on the row, and the reminder still fires on the owner's hour.

The scan runs fifteen seconds after boot and every thirty seconds after that
(`lib/reminders/scheduler.ts`). A reminder set for 13:00 therefore rings
between 13:00:00 and 13:00:30, which is inside the minute a person can see on
their own clock.

**A reminder missed by less than a day still rings.** A server that was off
over lunch catches up when it starts. Anything older than twenty four hours is
history: it lands in the centre as a missed row and is not pushed, because a
buzz about yesterday afternoon is noise.

**One ring per instance.** The record carries `remindedAt` once it has fired,
and the scan refuses a record that has one. Editing the day or the clock clears
that mark, so the task rings again at the new time. A repeating task's next
instance carries the rule's clock and no mark of its own.

**No zone means nothing fires.** Brain has no clock to read a "13:00" against,
so the scan does nothing rather than guessing UTC, and says so once in the log.
Settings → Notifications says the same thing where a person can act on it: "No
time zone is set, so no reminder will fire. Set one in Account."

**A task on a page in the trash is deferred, not lost.** It does not ring while
the page is in the trash. Restore the page inside the day and the reminder
still fires.

One reminder scan appends at most fifty rows and leaves the rest for the next
one, so a week of downtime fills the centre in stages rather than in one flood.
The mail poll beside it writes one row however many letters it found.

`BRAIN_REMINDERS=0` stops the scan, reminders and new mail together.

## The centre

A row is `{ id, kind, at, title, body?, href, readAt?, digest? }`, and the kind is one of
`task-reminder`, `task-missed`, `mail-new` and `agent-action`
(`lib/notifications/model.ts`). Agent rows carry the structured digest described below; other kinds keep their existing shape.

- **Two hundred rows of each kind**, eight hundred in all. A kind's oldest goes
  when its two hundred and first arrives, and a kind can only ever push out its
  own: mail opens a new row every time the last one was read, so against one
  shared bound a few busy days of letters evicted the reminders under them. The
  file is read whole on every request, and the four shares are what keep that
  cheap.
- **Read state is on the server**, so a row read on a phone is read on the
  laptop. `GET /api/notifications` answers the rows and the unread count at one
  instant, which is what keeps the count and the list from disagreeing.
  `POST /api/notifications/read` takes `{ ids }`, and
  `POST /api/notifications/read-all` clears the centre.
- **The bell keeps itself current.** A new row is announced over the SSE stream
  Brain already runs, as `type: "notification"`, and the shell forwards it the
  way it forwards a task event. A tab that slept through its own events reloads
  the centre when it comes back.
- **The badge counts rows, not letters.** It is how many things want you, and
  new mail is one of them however many letters are behind it: the row itself
  says how many.

**On a desktop the bell is in the sidebar head**, inboard of the accent circle,
and it is drawn on Settings too. It carries a count while something is unread
and nothing when nothing is, so the head's resting shape is unchanged. Past 99
it reads `99+`. The list opens on the menu material every other menu in Brain
uses: the kind's glyph, the title, the body in quiet ink after it, and how long
ago. "Mark all read" sits at the foot while anything is unread.

**On a phone there is no bell and no rows.** The tab slots are full and stay
full, so the centre is a desktop object: push is what tells a phone something
arrived, and Mail's own block on Home names the new letters. Nothing stands
above Home's capture field at any width. Home carried up to three unread rows
for one release, which put the centre's list where the page's opening line
belongs.

**Opening a row marks it read and goes where it points.** A task row opens
Tasks with that task selected. The mail row opens Mail on its main screen and
names no thread. "Mark all read" clears the centre alone and moves no mailbox:
a row there is a thing that wants you, not a letter, and pressing one word
should not write to a mail service that can stop answering halfway.

## New mail

**One row, and it counts.** New mail is a single `mail-new` row that says "10
new messages" — no sender, no subject, no account — and it opens Mail
(`lib/notifications/mail-rows.ts`). It held one row per thread until 0.12.2,
which made a morning's mail thirty rows to press one at a time: the bell had
become a second inbox. What a letter looks like is the phone's push and Mail
itself.

A new thread in an account's Inbox, from a person, is a letter the row counts
(`lib/notifications/mail-producer.ts`). Three things have to be true.

- **The mail classifier calls it people, and not a list message.** A
  newsletter and a service notification are out by that rule, and the
  classifier's own answer is the one that decides.
- **The thread is unread.** That is what keeps your own sent mail quiet. On
  Gmail a whole conversation is one thread, so a reply you write on a phone
  moves the thread's timestamp and the thread keeps its Inbox label. A thread
  whose newest message is yours has nothing unread left in it. The same gate
  keeps a re-sync quiet: a label applied to an old thread moves the timestamp
  and makes a known thread look new, and if it was read it stays read.
- **It is newer than the mark this account was last reported at.** One
  high-water mark per account, kept beside the centre's own file.

**The first pass after an upgrade says nothing.** With no mark to compare
against, every unread thread in the inbox would be new, and the bell would open
counting mail you have already seen. The first poll writes the mark and stays
quiet.

The poll asks each account for one page of twenty five threads. It runs two
seconds after the last `mail` event that says a sync changed an Inbox, or that
events were lost (`lib/mail/change-feed.ts`), so a burst of sync passes is one
poll, and a poll that such an event lands during runs once more when it
finishes. Every second tick, once a minute, runs it too, as the fallback for a
change feed that is down or an event that went missing. The marks make the two
one poll: a letter is reported once, by whichever reaches it first.

**The count grows while the row is unread.** Every account's letters go into
one count — the row is not about a mailbox — and each poll that finds more adds
to the open row and moves it to the head of the bell under the newest letter's
time. The row's id is the instant it opened, so it is one row for its whole
life.

**Reading it resets.** The row is read when you press it, when Mail is opened
any other way, and by "Mark all read". A read row is never counted into again:
the next letters open a new row with a fresh count. Nothing else clears it —
not reading one letter in Mail, and not an agent marking a thread read through
MCP.

**While Mail is open it stays read.** A poll that lands during an hour in Mail
opens a row about letters already in the list in front of you, so the surface
holds the seam for as long as it stands and every answer the centre gives reads
the mail row. It ends when you leave Mail: a row that opens after that is
yours to see, including one that opens while a failed first load is being
retried.

**A centre from before 0.12.2** holds one row per thread. They are folded into
one counted row the first time the file is read, dated by the newest of them
and unread if any of them was, and dropped if all of them were read.

**The push is unchanged**: one per letter, with the sender and the subject on
it, tagged with the account and thread so two letters are two notifications.
The phone's signal is push; the centre is the tally.

One case still counts when it should not. A reply you write into a thread that
still holds an older unread message passes the unread gate. The exact answer
needs a "the newest message is the owner's" fact from the mail service, which
is a change over there.

## What an agent did

**One row per agent per local calendar day**, across tools and targets:
"ChatGPT · 23 pages, 2 tasks, 4 threads, 1 message sent". The agent is the OAuth
client name or token name already recorded by MCP. Days use the owner's IANA
time zone from Settings → Account, the same setting reminders use, including
DST. Before a zone is set, digests use UTC; they never use the server's zone.
A zone change affects future actions; existing digest days stay recorded.

- **Distinct targets, not actions.** Seven writes and a move of one page count
  as one page. Tasks count distinct task ids. Mail triage counts distinct
  `(account, thread)` pairs; sends and replies count distinct outbound operation
  ids per account (message id if no operation id is available), labelled
  "messages sent". Saving a mail attachment counts the destination page. An
  older caller with no target id falls back to a hash of its activity line.
- **The header only expands or collapses.** A bare Solar chevron discloses the
  day and the 50 most recently touched targets, newest first. Links show page
  titles, task titles or mail subjects; a caller without a title uses "Page",
  "Task", "Mail thread" or "Sent message". Labels come from the completed
  operation beside the log line; the activity log itself still stores ids and
  tokens only, never subjects, recipients or message bodies. A target opens
  its page, selected task or mail thread. Deleted targets open their surface.
  Opening an agent's mail target does not mark the thread read.
- **Bounded detail and counts.** Version 2 of `notifications.json` persists
  `digest: { agent, day, ids, saturated, targets }`. Each of the four `ids` sets
  holds at most 200 hashed identities; counts beyond that explicitly say
  "200+" rather than claiming precision. Target details retain the latest 50
  independently of those sets, with "+N more" (a lower bound after saturation).
  The existing 200 rows per kind and 800 rows total caps still apply.
- **A quiet history.** Agent rows never contribute to the bell badge and
  always use read styling. A later action updates the same day's row even
  after it was read, preserves `readAt`, and announces the update over SSE.
  Only unread mail and task reminder/missed rows count toward the badge.
  "Mark all read" continues to clear those rows as before. Digests send no push.
- **Successful mutations only.** Refusals, reads, the `notion_*` import family,
  `connection_check` and mail read marks stay silent. App-page writes join
  the same daily rule under the app's logged name. Settings → Connections
  retains the full activity log, including refusals.

**Upgrade from version 1:** known singular agent sentences with recoverable
page/task/thread destinations fold by agent and owner-local date. Repeated
references to one target count once. Aggregated bursts with lost target ids,
ambiguous app sentences and unknown formats remain verbatim, also quiet and
excluded from the badge. No distinct count is invented for them. Migration is
serialized and persisted atomically on the first read, so restarts preserve
both the fold and its calendar day. Other notification kinds retain their
existing behavior, including the older mail-row migration.

## Push

Push is per device. Turning it on is one press in **Settings → Notifications**,
on each device you want rung.

**On an iPhone or an iPad, Brain has to be on the Home Screen first.** Apple
gives web push to an installed web app and to nothing else, so an open Safari
tab never rings, whatever it is allowed to do. Settings detects that and says so
before it asks for permission. iOS 16.4 is the floor. A Mac, an Android phone
and a desktop browser need no install step. The permission prompt is reached
from the press itself with nothing awaited in front of it, because iOS grants it
only from inside the gesture.

- **The worker does push and nothing else** (`public/sw.js`). No caching, no
  offline, no fetch handler. Your notes live in a folder of Markdown files, and
  a cached copy of them would be a second answer.
- **It always shows a notification.** iOS revokes an origin's permission when a
  push arrives and nothing appears, so no branch in the handler ends without
  one. A payload it cannot read still shows Brain's own name and a sentence
  that is true of all of them.
- **The payload is the title, the body, the path to open and the row's own id.**
  The id is the notification's tag, so two reminders due in one scan stand side
  by side rather than one replacing the other. Nothing about your notes is in
  it, and what is in it is encrypted to the device.
- **A tap opens the task or the thread.** The worker honours a path on this
  origin and nothing else, so a payload naming another host lands on Home.
- **The TTL is an hour.** `web-push` defaults to four weeks, which for a 13:00
  reminder means a phone that was off all week ringing about Tuesday on Friday.
- **A 404 or a 410 removes the device.** Both mean the endpoint is gone. A 400,
  a 413 or a 429 is this server's problem, and the device stays.
- **A subscription the browser replaces re-registers itself.** The worker hears
  `pushsubscriptionchange`, fetches the public key and posts the new
  subscription. Without that the device goes quiet and neither side says why.

Settings → Notifications sits between Connections and Sharing. It holds the one
press, the devices with a Remove beside each, "Send a test", a switch each for
**Task reminders** and **New mail**, and the zone line with a way to Account.
**A kind switched off stops the buzz and nothing else**, so the centre still
lists it. Twenty devices is the ceiling.

A push endpoint is a capability: anyone holding it can deliver a notification to
that device. It never reaches a log line, a URL or the browser. A device is
named in Settings by a label like "iPhone" and identified by a hash of its
endpoint.

## Where state lives

Two directories under `/var/lib/brain`, both outside the notes folder and
outside a portable archive. A notification is state about your notes, not a
note, and somebody restoring an archive on a new machine wants their tasks back
rather than last month's alarms.

| Path | Holds |
| --- | --- |
| `/var/lib/brain/notifications/notifications.json` | the centre's rows |
| `/var/lib/brain/notifications/mail-watermarks.json` | the newest letter reported, per account |
| `/var/lib/brain/push/vapid.json` | the VAPID key pair |
| `/var/lib/brain/push/subscriptions.json` | the registered devices |
| `/var/lib/brain/push/preferences.json` | the two per-kind switches |

`BRAIN_NOTIFICATIONS_STATE_DIR` and `BRAIN_PUSH_STATE_DIR` move each directory.
Outside production both default to a per-user temp folder. Directories are 0700
and files are 0600.

**The VAPID private key is generated on first use and exists nowhere else.**
There is no secret to paste into a compose file and none in the repository.
Deleting it means every device has to be added again, because a browser bakes
the public half into the subscription it made. A `vapid.json` that is there and
cannot be read has the same effect, and that case says so in the log.
`docs/operations.md` carries the backup consequences.

Deleting the centre's file costs you the rows and nothing else. The watermarks
go with it, so the next poll is a first pass and stays quiet.

## Turning it off

Four controls, and each one does a different thing.

- **`BRAIN_REMINDERS=0`** stops the background scan for the whole instance. No
  reminder is computed and no inbox is polled, so nothing reaches the centre and
  nothing is pushed. `off` and `false` do the same. Rows already in the centre
  stay where they are.
- **A module switched off in Settings → Modules** stops that module's half of
  the scan. With Tasks off no reminder is computed at all, and a reminder that
  would have fired while it was off is gone rather than queued, exactly as it
  would be under `BRAIN_REMINDERS=0`. With Mail off the inbox is not polled and
  no `mail-new` row is produced. Rows already in the centre stay where they are
  and read normally, and the kind's own push preference is untouched.
- **A kind switched off in Settings → Notifications** stops the push for that
  kind alone. The row still lands in the centre and the bell still counts it.
- **Removing a device** stops that device being rung. Other devices are
  unaffected and so is the centre. The browser keeps the permission it granted,
  so turning it on there again asks nothing.

Under `NODE_ENV=test` the scan never starts at all.
