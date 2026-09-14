# Tasks

Tasks are files. One Markdown file per task under `_tasks/` inside your notes
folder, the record in the file's frontmatter, and the filename is the record's
own id. Git sees them, a backup carries them, and a text editor opens them.

No list is stored. Which list a task is in is derived from `when`, `deadline`
and `done` every time it is read, so a hand edit cannot file a task somewhere
impossible. Moving a task between lists is only ever a change to one of those
three fields.

## The record

| Field | Shape | Rule |
| --- | --- | --- |
| `id` | letters, digits, `_` and `-`, up to 128 characters | Matches the filename. A file whose frontmatter id is not its own name is skipped. |
| `title` | text, up to 2000 characters | Owned by the note line while the task is linked to a checkbox. |
| `when` | a calendar day (`2026-09-14`) or the word `someday` | Absent means the Inbox. |
| `time` | `HH:MM`, 24 hour | Needs `when` to be a day. A wall clock in the owner's zone, not in the reader's. |
| `evening` | `true` | Needs `when` to be a day. A section of that day, not a clock. |
| `deadline` | a calendar day | The day the task is owed, whatever `when` says. |
| `category` | text, up to 200 characters | |
| `page` | a page id | The note that holds this task's checkbox. Requires `anchor`, unless the task has detached. |
| `anchor` | `text`, `hash`, `ordinal`, `line` | Where on that page the checkbox stood when the anchor was written. |
| `detachedAt` | a UTC instant | Written when the reconcile could no longer find the line. Requires `page`. |
| `repeat` | `{ freq: daily }`, `{ freq: weekly, byWeekday: [...] }` or `{ freq: monthly, byMonthDay: n }` | No interval, no end date, no count. |
| `done` | `true` or `false` | Not written while the task is linked. The checkbox in the note answers it. |
| `doneAt` | a UTC instant | The instant of the completion. The day it falls on is the reader's own. |
| `remindedAt` | a UTC instant | When this instance's reminder fired. |
| `log` | entries of `scheduled`, `time` and `completedAt` | One completed occurrence of a repeating task each. Brain keeps the 30 most recent, which covers the Logbook's window. A file is read with up to 100, so a hand-edited one is not skipped for holding a few more. |
| `created`, `updated` | UTC instants | |

Three rules no single field can carry, and a hand editor meets all three.

- **`time` and `evening` both need a day.** `someday` is the explicit absence of
  one and so is no `when` at all, so neither can hold a clock or an evening.
  A task may carry both fields at once: an evening task with a 20:00 reminder
  is an ordinary record.
- **`repeat` and `page` cannot both be set.** A repeating task advances its own
  `when` on completion, and a linked one takes its completion from a checkbox
  that has no second occurrence.
- **A detached record owns its `done`.** While the task is linked the note's
  checkbox is the one answer, and `done` is not written to the file at all.
  Once `detachedAt` is set there is no checkbox left to ask, so the record
  answers for itself and `done` has to be there.

A record Brain cannot read is skipped with a warning on the console and left
alone. Nothing rewrites your file to make it parse.

### One file

```markdown
---
id: t4k9m2
title: Water the plants
when: '2026-09-14'
time: '13:00'
category: Home
created: '2026-09-01T08:10:00.000Z'
updated: '2026-09-14T06:02:11.000Z'
---
The big one by the window needs less than the rest.
```

The key order above is the order Brain writes, so a git diff shows the field
that changed and nothing else. Text under the closing fence is yours and is
kept byte for byte through every write.

Days, instants and clocks are written quoted. **A clock you type unquoted is
still read.** YAML resolves an unquoted `time: 13:00` to the number 780 and
`time: 9:05` to 545, and Brain reads a number inside the day back as the clock
it came from rather than skipping your file over its quoting. A quoted
`'9:05'` is padded to `09:05` for the same reason. One shape stays ambiguous:
a bare `time: 905`, typed by somebody leaving the colon out of 9:05, is the
same 905 that `15:05` resolves to and comes back as 15:05. Quote it and there
is nothing to resolve.

## The lists

A task is in exactly one list. Read these top to bottom and the first that
matches wins.

1. A completion whose day is not today goes to the **Logbook**.
2. `when` is a day at or before today: **Today**.
3. `deadline` is a day at or before today: **Today**. The day it is owed
   outranks the day it was filed under, `someday` included.
4. `when` is a day after today: **Upcoming**.
5. `when` is `someday`: **Someday**.
6. `deadline` is a day after today: **Upcoming**.
7. Nothing above: the **Inbox**.

**A completion stays where it was until the day changes.** Finishing a task is
not the task leaving. The row stays in the list it was in, struck through and
at the foot of its group, and it reaches the Logbook on the day change. So
today's completions are in two places at once, their own list and the
Logbook's Today group. A category view keeps the day's work for the same
reason.

**This Evening** is the last group of Today. It holds the open rows whose
`when` is today and whose `evening` is set. An evening on a day still ahead is
grouped by that day, and an evening already past is an ordinary overdue row
with no moon in its tail.

**Inside a group**: open rows before done ones, then the timed rows by the
clock and the untimed after them, then newest first. The Logbook takes neither
of the last two and reads by completion instead, newest first, over a 30 day
window.

**One clock per row.** An open row shows its own `time` verbatim, because that
clock is a wall clock in the owner's zone and means the same thing on every
device. A finished row shows the time it was finished at instead, in the
reader's own clock, and the hour it was due at is what the strike is drawn
over. A reminder that has already fired on a row still open draws its clock at
the caption's quiet ink, a note rather than an alarm.

**Home draws five open rows** and up to three of the day's completions under
them, flat and ungrouped. Whatever runs over either count is named on the
`All today` row below the block.

A `time` makes the task a reminder. What fires it, and where it lands, is in
Reminders below.

## The time zone

One zone for the notebook, at **Settings → Account**, whichever device you are
on. It is an IANA name (`Europe/Lisbon`). A fixed offset like `+03:00` is
refused: it carries no summer time rule, so a 13:00 alarm set in March would
fire at 14:00 in July.

**Captured once and never overwritten.** The first browser to open Tasks after
the upgrade offers the zone it reports, and the server keeps it while nothing
is set. A device in another zone does not change it, because the reminder time
is the owner's home clock and not the clock of whichever machine asked last.
You can set it by hand at any time, and a **Use this device** button beside the
picker takes the zone this browser reports.

The setting lives under `BRAIN_SETTINGS_STATE_DIR` (`/var/lib/brain/settings`
by default) as `owner.json`, in a 0700 directory at 0600. It is never under
your notes folder: a zone is a property of this instance, not of the notes, so
it stays out of a portable archive and out of the git history of your writing.

**Only a reminder reads it.** Every list request carries the reader's own
`today` and offset from UTC, so what you see is your device's day wherever you
are. The zone answers one question, and it is the question a server timer has
no request to ask.

## The picker

One control draws every date and every time in Tasks: the When chip on a row,
the deadline chip beside it, the capture row at the head of a list, and the
`+ Task` popover in a note, which is the picker with an Inbox row.

It offers **Today**, **This Evening** while the picked day is today, a
Monday-first **month grid**, **Someday** under the grid, and a **Reminder** row
that opens two spinners at 09:00. Then **Clear** and **Done**. Today is ringed
in the grid and the picked day is an ink capsule. Days before today are quiet
and still pickable, because a deadline in the past is a real thing to record.
The Reminder row waits for a day to be picked before it will open, since a
clock with no day names no instant. Someday takes the clock and the evening
with it, for the same reason.

A quick row (Today, This Evening, Someday, Clear) writes at once and closes the picker: one tap, one save. A day in the grid or a step of the clock edits the picker without saving, so a reminder can follow its day. **Done**, a press outside, and a drag on the sheet's grip each save that value once and close. Escape closes and throws it away, unless a quick row or Done has already answered, since that write is on its way and the key is inert. A value that ends where it began saves nothing, and neither does a word the record already carries after a save this panel made.

**One write leaves at a time, and nothing waits in line.** From the press until the route answers the panel is waiting, and says so: `aria-busy`, the rows and the grid quiet and out of reach, Done and the clock disabled. A press made in that window does nothing and is not remembered, because a word held back would be filed a moment later, out of sight of the reader who named it. Escape still closes the panel and cancels nothing: the value is with the route, and the line says what the route made of it whether or not the panel is still on screen. An acceptance is the panel's last act. A refusal gives it back, with the route's own reason on the panel's one refusal line, and the same press writes again.

The keyboard walks the grid: left and right a day, up and down a week, Home
and End the ends of the week, PageUp and PageDown a month, Enter picks the
focused day. The spinners take their own up and down, an hour and five
minutes.

**The deadline form is the same control** with This Evening, Someday and the
Reminder hidden, and "No deadline" in place of Clear. Today stays, because a
deadline of today is a deadline.

Below 768px the picker is full width under the row it belongs to, riding a
sheet a grip drags away. There is no `input[type=date]` and no
`input[type=time]` anywhere under `components/`, on a pointer or on touch, and
`ops/design-guardrails.test.ts` refuses one.

The repeat menu reads the record's clock back into its own wording ("Every day
at 13:00") and offers no second editor for it. The clock is set in the
picker's Reminder row and nowhere else.

## Reminders

A `time` on a task is a reminder. Every thirty seconds Brain works out the
instant that clock names in the owner's zone, and a task whose instant has
arrived rings: a row in the notification centre, and a push on every device you
have turned push on for. The record's `remindedAt` is written in the same pass,
which is what keeps one instance from ringing twice.

Editing the day or the clock clears `remindedAt`, so the task rings again at the
new time. A repeating task's next instance carries the rule's clock and no mark
of its own.

A reminder missed by less than a day still rings when the server comes back. An
older one lands in the centre as a missed reminder and is not pushed.

`docs/notifications.md` has the rest: the centre and the bell, new mail from
people, push on an installed app, and how to turn any of it off.
