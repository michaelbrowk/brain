# Notifications

Brain has one notification centre and one background timer behind it. The timer
looks for task reminders every thirty seconds and for new mail every minute.
What it finds becomes a row in the centre, and a push on every device you have
turned push on for.

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

One scan appends at most fifty rows and leaves the rest for the next one, so a
week of downtime fills the centre in stages rather than in one flood.

`BRAIN_REMINDERS=0` stops the scan, reminders and new mail together.

## The centre

A row is `{ id, kind, at, title, body?, href, readAt? }`, and the kind is one of
`task-reminder`, `task-missed`, `mail-new` and `agent-action`
(`lib/notifications/model.ts`). Nothing in the shape is about a task, a letter
or a tool call, so another kind can join later without a second store.

- **Five hundred rows.** The oldest goes when the five hundred and first
  arrives. The file is read whole on every request, and the cap is what keeps
  that cheap.
- **Read state is on the server**, so a row read on a phone is read on the
  laptop. `GET /api/notifications` answers the rows and the unread count at one
  instant, which is what keeps the count and the list from disagreeing.
  `POST /api/notifications/read` takes `{ ids }`, and
  `POST /api/notifications/read-all` clears the centre.
- **The bell keeps itself current.** A new row is announced over the SSE stream
  Brain already runs, as `type: "notification"`, and the shell forwards it the
  way it forwards a task event. A tab that slept through its own events reloads
  the centre when it comes back.

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
Tasks with that task selected. A mail row opens Mail with that thread selected,
and marks the thread read. "Mark all read" clears the centre alone and moves no
mailbox: one press would otherwise fire an unbounded number of thread writes at
a service that can stop answering halfway, with no undo.

## New mail

A new thread in an account's Inbox, from a person, produces a `mail-new` row:
the sender's name as the title, the subject as the body
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
on fifty rows about mail you have already seen. The first poll writes the mark
and stays quiet.

The poll asks each account for one page of twenty five threads on every second
tick, so once a minute. The mail service runs its own sync once a minute, and
asking twice as often would ask the same question twice for one answer.

**Read state runs both ways.** Marking the thread read in Mail marks the row
read, batched so that emptying an inbox is one request rather than one per
letter. Opening the row in the centre marks the thread read.

One case still rings when it should not. A reply you write into a thread that
still holds an older unread message passes the unread gate. The exact answer
needs a "the newest message is the owner's" fact from the mail service, which
is a change over there.

## What an agent did

A mutation an agent makes through MCP produces an `agent-action` row. The
title is the app's own name and a verb, "Claude completed a task", and the
body after it is the thing's own name where the call already knew one, "Water
the plants". A row whose call knew no name is the title alone, "Claude
archived a thread".

- **Successful mutations, and nothing else.** A refusal leaves no row, a read
  of any kind leaves none, and the `notion_*` import family and
  `connection_check` are out by name. The row comes off the one activity line
  the mutation already writes (`lib/mcp/activity-log.ts`), so a tool that logs
  cannot forget to announce, and a tool that does not log stays silent: page
  writes leave no line today, so they leave no row either.
- **Nothing the agent wrote reaches a row.** The title is Brain's own words
  after the app's name, and the body is a title read out of your own notes or
  tasks at the moment of the call. The activity line holds ids and no prose by
  design, and the centre is downstream of it: no subject, no address, no body,
  no recipient.
- **A press opens what the row is about.** The task, selected in Tasks. The
  note the file landed in. The thread, opened in Mail without being marked
  read, because the row is a record of what an agent did and not a new letter.
  A row about something deleted opens the surface it was on.
- **No push.** Push stays the phone's signal for reminders. An agent working
  through a list at two in the morning is not a reason to buzz a pocket.

Settings → Connections still holds the full log, refusals and reads included,
and is unchanged by any of this.

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

Three controls, and each one does a different thing.

- **`BRAIN_REMINDERS=0`** stops the background scan for the whole instance. No
  reminder is computed and no inbox is polled, so nothing reaches the centre and
  nothing is pushed. `off` and `false` do the same. Rows already in the centre
  stay where they are.
- **A kind switched off in Settings → Notifications** stops the push for that
  kind alone. The row still lands in the centre and the bell still counts it.
- **Removing a device** stops that device being rung. Other devices are
  unaffected and so is the centre. The browser keeps the permission it granted,
  so turning it on there again asks nothing.

Under `NODE_ENV=test` the scan never starts at all.
