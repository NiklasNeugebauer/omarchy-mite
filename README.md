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

Add the widget to your bar and configure it in `~/.config/omarchy/shell.json`
(the shell hot-reloads on save):

```json
{
  "id": "niklasneugebauer.mite",
  "account": "your-account",
  "apiKey": "your-mite-api-key",
  "defaultProject": "Meetings"
}
```

- **account** — the subdomain of `https://<account>.mite.de`.
- **apiKey** — mite → Account → "mite API key". Stays in shell.json; treat that
  file accordingly.
- **defaultProject** — the project the form snaps back to after each entry
  (matched case-insensitively by name). Optional.

For keyboard-only access, bind the panel toggle in
`~/.config/hypr/bindings.lua`:

```lua
o.bind("SUPER + CTRL + M", "mite", "omarchy-shell shell toggle niklasneugebauer.mite")
```

## Use

The form is built for speed: it opens focused on the **time field**, `Tab`
walks time → project → service → note, `Enter` books from anywhere.

- Time field, bare digits, no colons:
  - `930 1215` — completed entry 9:30–12:15 (also `930-1215`)
  - `930` — entry from 9:30 until now
  - *empty* — start the mite tracker now (stop it later with `Ctrl+Enter`;
    the stop writes the `(start bis end)` prefix into the note)
- Project and service pickers filter fuzzily while you type (`wr` finds
  "Website Relaunch"); the top match is preselected, `Down`/`Up` pick,
  `Tab` accepts and moves on. The placeholder shows the current selection.
- After booking, the project snaps back to `defaultProject`, the service
  stays, time and note clear.

Below the form, the day timeline (8–18 h, growing with the entries):
overlapping entries stand side by side in red; entries whose duration does
not match their prefix are flagged; entries without a time prefix hang below
the last timed entry, dimmed. Chords work from any field:

| Chord | Action |
|---|---|
| `Ctrl+Left` / `Ctrl+Right` | previous / next day (chevrons do the same) |
| `Ctrl+T` | back to today |
| `Ctrl+Down` / `Ctrl+Up` | select an entry in the timeline |
| `Ctrl+D` | delete the selected entry (twice to confirm) |
| `Ctrl+Enter` | stop the running tracker |
| `Ctrl+R` | reload day, projects, and services |
| `Esc` | clear selection, then close |

The bar widget polls mite once a minute. Red glyph: no tracker running and no
entry prefix covering now. While the tracker runs, the label shows the
running entry's elapsed time alongside today's total.

## Develop

```bash
node --test   # model layer: time parsing, note prefix, fuzzy match, day layout
```

Saved changes hot-reload into the running shell
(`omarchy-shell shell rescanPlugins` forces it).
