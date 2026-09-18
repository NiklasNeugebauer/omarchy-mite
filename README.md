# omarchy-mite

[mite](https://mite.de) time tracking on the [Omarchy](https://omarchy.org) bar.
A bar widget shows today's booked hours and turns **red while no entry covers
the current time**; its popup panel books entries with a few keystrokes and
lays the day out on a timeline.

mite stores only a date and a duration per entry — clock times live in the
note, in the same `(9:30 bis 12:05)` prefix mite's own web timer writes. This
plugin reads and writes exactly that format, so entries stay interchangeable
with entries booked in mite itself.

## Install

```bash
git clone https://github.com/NiklasNeugebauer/omarchy-mite \
  ~/.config/omarchy/plugins/niklasneugebauer.mite
```

Add the widget to your bar (`omarchy plugin enable niklasneugebauer.mite`) and
open the panel — while unconfigured it opens straight into its settings:
account (the subdomain of `https://<account>.mite.de`) and API key (mite →
Account → "mite API key"). Settings are stored on the widget's entry in
`~/.config/omarchy/shell.json`, which is equally fine to edit by hand (the
shell hot-reloads on save):

```json
{
  "id": "niklasneugebauer.mite",
  "account": "your-account",
  "apiKey": "your-mite-api-key"
}
```

The API key stays in shell.json; treat that file accordingly.

For keyboard-only access, bind the panel toggle in
`~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + CTRL + M", "mite", "omarchy-shell shell toggle niklasneugebauer.mite")
```

## Use

The form is built for speed: it opens focused on the **time field**, `Tab`
walks time → project → service → note, `Enter` books from anywhere.

- Time field, bare digits, no colons: `930 1215` books 9:30–12:15 (also
  `930-1215`), `930` books from 9:30 until now.
- `Ctrl+Enter` toggles the mite tracker: it starts on the form's current
  project/service/note, and stopping writes the `(start bis end)` prefix
  into the note. Enter never starts a timer.
- Project and service are autocomplete comboboxes: the field shows the
  current selection, focusing drops the list, typing fuzzy-filters it (`wr`
  finds "Website Relaunch"), the top match is preselected, `Down`/`Up` pick,
  `Tab` accepts and moves on. Projects also match on their customer, and
  query words are matched separately, in any order: `nord`, `nordwnd` and
  `nord bild` all find "Bildanalyse" under customer "Nordwind 4711".
  With a choice pending, `Enter` only selects —
  another `Enter` books. Free text that matches nothing never books.
- `Ctrl+R` is the shell's reverse search, on bookings: it turns the note
  field into a query over the descriptions of the last 90 days (`historyDays`
  in shell.json), and taking a
  hit fills in description, project **and** service — only the time is left
  to type. `Ctrl+R` again steps to the next match, `Esc` puts the note back.
  Repeats are collapsed, most recently used first, so an empty query simply
  lists what you did last.
- Every booking needs a project, picked deliberately: after booking, the
  project clears. The service stays — also across restarts — time and note
  clear.
- Click an entry in the timeline (or `Ctrl+E` on a selected one) to load it
  into the form; `Enter` saves the changes, `Esc` cancels. An empty time
  field keeps the entry's original timing.

Below the form, the day timeline (8–18 h, growing with the entries):
overlapping entries stand side by side in red; entries whose duration does
not match their prefix are flagged; entries without a time prefix hang below
the last timed entry, dimmed. Chords work from any field:

| Chord | Action |
|---|---|
| `Ctrl+Left` / `Ctrl+Right` | previous / next day (chevrons do the same) |
| `Ctrl+T` | back to today |
| `Ctrl+Down` / `Ctrl+Up` | select an entry in the timeline |
| `Ctrl+J` / `Ctrl+K` | the same, and walks an open picker or history list |
| `Ctrl+E` | edit the selected entry |
| `Ctrl+D` | delete the selected entry (twice to confirm) |
| `Ctrl+Enter` | start/stop the tracker |
| `Ctrl+R` | search past descriptions; again for the next match |
| `Ctrl+Shift+R` | reload day, projects, services, and history |
| `Ctrl+,` | settings (also the ⚙ bottom right) |
| `Ctrl+/` | the shortcut list (also the ⌨ bottom left) |
| `Esc` | clear query / edit / selection, then close |

The bar widget polls mite once a minute (`refreshMinutes` in shell.json).
Today's total includes a running tracker, counted locally from its start
time, so it ticks up on the minute without waiting for the next poll. Red
glyph: no tracker running and no entry prefix covering now.

## Develop

```bash
node --test   # model layer: time parsing, note prefix, fuzzy match, day layout
```

Saved changes hot-reload into the running shell
(`omarchy-shell shell rescanPlugins` forces it). Edits to `Panel.qml` can be
missed by both, since the panel component is already instantiated — reach for
`omarchy restart shell` when a change does not show up.
