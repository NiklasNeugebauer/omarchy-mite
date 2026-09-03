// Pure model layer: time parsing, the mite note time-prefix convention,
// fuzzy matching, and the day-timeline layout. No QML, no network, no DOM —
// everything here is testable with `node --test`.
//
// mite stores only a date and a duration per time entry. Clock times live in
// the note: mite's own web UI prepends "(10:15 bis 12:05)" when its timer is
// stopped. This plugin reads and writes exactly that format so entries stay
// interchangeable with entries booked through mite itself.

// ---- Clock-time parsing. Power-user input: bare digits, no colon.
//      "930" → 9:30, "1215" → 12:15, "9" → 9:00, "0930" → 9:30.

/** @returns {?number} minutes from midnight, or null if not a time. */
function parseTimeToken(token) {
  var s = String(token || "").trim()
  if (!/^\d{1,4}$/.test(s)) return null
  var h, m
  if (s.length <= 2) { h = Number(s); m = 0 }
  else { h = Number(s.slice(0, -2)); m = Number(s.slice(-2)) }
  if (h > 23 || m > 59) return null
  return h * 60 + m
}

/**
 * The single time field of the entry form.
 *   ""            → start the mite tracker now
 *   "930"         → entry from 9:30 until now
 *   "930 1215"    → completed entry (also "930-1215", "930,1215")
 * @returns {?{mode: "track"|"until-now"|"range", start?: number, end?: number}}
 *   null means the input is invalid and must not be committed.
 */
function parseTimeInput(text, nowMinutes) {
  var s = String(text || "").trim()
  if (s === "") return { mode: "track" }
  var tokens = s.split(/[\s,\-–]+/).filter(function(t) { return t !== "" })
  if (tokens.length === 1) {
    var start = parseTimeToken(tokens[0])
    if (start === null) return null
    var end = Math.max(start + 1, Math.round(nowMinutes))
    if (end > 24 * 60) return null
    return { mode: "until-now", start: start, end: end }
  }
  if (tokens.length === 2) {
    var a = parseTimeToken(tokens[0])
    var b = parseTimeToken(tokens[1])
    if (a === null || b === null || b <= a) return null
    return { mode: "range", start: a, end: b }
  }
  return null
}

// ---- Note time-prefix, exactly mite's own format: "(10:15 bis 12:05)".

var NOTE_RANGE = /^\((\d{1,2}):(\d{2}) bis (\d{1,2}):(\d{2})\)\s*/

/** "570" → "9:30" (no leading zero on hours, like mite). */
function formatClock(minutes) {
  var m = Math.round(minutes)
  return Math.floor(m / 60) + ":" + String(m % 60).padStart(2, "0")
}

function notePrefix(start, end) {
  return "(" + formatClock(start) + " bis " + formatClock(end) + ")"
}

/** @returns {?{start: number, end: number, label: string}} minutes from midnight. */
function parseNoteRange(note) {
  var text = String(note == null ? "" : note)
  var m = NOTE_RANGE.exec(text)
  if (!m) return null
  var h1 = Number(m[1]), min1 = Number(m[2]), h2 = Number(m[3]), min2 = Number(m[4])
  if (h1 > 23 || h2 > 23 || min1 > 59 || min2 > 59) return null
  var start = h1 * 60 + min1
  var end = h2 * 60 + min2
  if (end <= start) return null
  return { start: start, end: end, label: text.slice(m[0].length) }
}

/** Note for a completed entry: prefix + free text. */
function composeNote(start, end, label) {
  var text = String(label || "").trim()
  return text === "" ? notePrefix(start, end) : notePrefix(start, end) + " " + text
}

/** Prepend a prefix to a note that has none (used when stopping the tracker). */
function ensurePrefix(note, start, end) {
  if (parseNoteRange(note)) return String(note)
  return composeNote(start, end, note)
}

// ---- Fuzzy matching for the project/service pickers. Subsequence match;
//      earlier and word-initial hits score higher, so "om" finds
//      "Office Meetings" before "Homepage".

/** @returns {number} score, or -1 when query is not a subsequence of text. */
function fuzzyScore(query, text) {
  var q = String(query || "").toLowerCase()
  var t = String(text || "").toLowerCase()
  if (q === "") return 0
  var score = 0
  var ti = 0
  var prev = -2
  for (var qi = 0; qi < q.length; qi++) {
    var idx = t.indexOf(q[qi], ti)
    if (idx === -1) return -1
    if (idx === 0 || /[\s\-_./]/.test(t[idx - 1])) score += 10  // word start
    if (idx === prev + 1) score += 5                            // consecutive
    score -= (idx - ti)                                         // gaps cost
    prev = idx
    ti = idx + 1
  }
  if (t === q) score += 100
  return score
}

/**
 * Filter and rank by fuzzy score; stable for equal scores.
 * @param {Array} items  @param {function} nameOf  @returns {Array}
 */
function fuzzyFilter(items, query, nameOf) {
  var scored = []
  for (var i = 0; i < items.length; i++) {
    var s = fuzzyScore(query, nameOf(items[i]))
    if (s >= 0) scored.push({ item: items[i], score: s, index: i })
  }
  scored.sort(function(a, b) { return b.score - a.score || a.index - b.index })
  return scored.map(function(e) { return e.item })
}

// ---- Day timeline. Entries with a note prefix are positioned by it;
//      entries without one carry no clock time and are appended after the
//      last timed entry instead of being guessed. A running tracker entry
//      is positioned from its `since` timestamp to now.

var DEFAULT_FROM_HOUR = 8
var DEFAULT_TO_HOUR = 18

/**
 * Overlapping slots share the group's width; each takes the first column
 * free at its start. `columns` is the width of the whole overlap group.
 */
function assignColumns(slots) {
  var group = []
  var groupEnd = -1
  function closeGroup() {
    var width = 1
    for (var i = 0; i < group.length; i++) width = Math.max(width, group[i].column + 1)
    for (var j = 0; j < group.length; j++) group[j].columns = width
  }
  for (var k = 0; k < slots.length; k++) {
    var slot = slots[k]
    if (slot.start >= groupEnd) { closeGroup(); group = []; groupEnd = -1 }
    var ends = []
    for (var g = 0; g < group.length; g++)
      ends[group[g].column] = Math.max(ends[group[g].column] || 0, group[g].end)
    var column = -1
    for (var c = 0; c < ends.length; c++) if (ends[c] <= slot.start) { column = c; break }
    if (column === -1) column = ends.length
    slot.column = column
    group.push(slot)
    groupEnd = Math.max(groupEnd, slot.end)
  }
  closeGroup()
  return slots
}

/**
 * @param entries  raw mite time entries of one day ({id, minutes, note,
 *   project_name, service_name, tracking?: {since}}).
 * @param nowMinutes  minutes from midnight, for the running tracker slot.
 * @returns {{slots: Array, fromMinutes: number, toMinutes: number}}
 *   Slots carry: id, start, end, label, project, service, minutes, timed,
 *   tracking, overlap, column, columns, mismatch (duration ≠ prefix span).
 */
function layoutDay(entries, nowMinutes) {
  var timed = []
  var untimed = []
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i]
    var base = {
      id: e.id,
      minutes: e.minutes || 0,
      project: e.project_name || "",
      service: e.service_name || "",
      tracking: !!e.tracking,
      column: 0,
      columns: 1,
      overlap: false,
      mismatch: false,
    }
    var range = parseNoteRange(e.note)
    if (e.tracking && e.tracking.since) {
      var sinceDate = new Date(e.tracking.since)
      base.start = sinceDate.getHours() * 60 + sinceDate.getMinutes()
      base.end = Math.max(base.start + 1, Math.round(nowMinutes))
      base.label = String(e.note || "")
      base.timed = true
      timed.push(base)
    } else if (range) {
      base.start = range.start
      base.end = range.end
      base.label = range.label
      base.timed = true
      base.mismatch = Math.abs((range.end - range.start) - base.minutes) > 1
      timed.push(base)
    } else {
      base.label = String(e.note || "")
      base.timed = false
      untimed.push(base)
    }
  }

  timed.sort(function(a, b) { return a.start - b.start || a.end - b.end })
  for (var a = 0; a < timed.length; a++)
    for (var b = 0; b < timed.length; b++)
      if (a !== b && timed[b].start < timed[a].end && timed[a].start < timed[b].end)
        timed[a].overlap = true
  assignColumns(timed)

  // Untimed entries hang after the last timed one, back to back.
  var cursor = timed.length
    ? timed[timed.length - 1].end
    : DEFAULT_FROM_HOUR * 60
  for (var u = 0; u < untimed.length; u++) {
    untimed[u].start = cursor
    untimed[u].end = cursor + Math.max(untimed[u].minutes, 5)
    cursor = untimed[u].end
  }

  var slots = timed.concat(untimed)
  var from = DEFAULT_FROM_HOUR * 60
  var to = DEFAULT_TO_HOUR * 60
  for (var s = 0; s < slots.length; s++) {
    from = Math.min(from, Math.floor(slots[s].start / 60) * 60)
    to = Math.max(to, Math.ceil(slots[s].end / 60) * 60)
  }
  return { slots: slots, fromMinutes: from, toMinutes: to }
}

// ---- Totals and the bar state.

function totalMinutes(entries) {
  var total = 0
  for (var i = 0; i < entries.length; i++) total += entries[i].minutes || 0
  return total
}

/** Active = tracker running, or any entry's note prefix covering now. */
function isActive(entries, nowMinutes) {
  for (var i = 0; i < entries.length; i++) {
    if (entries[i].tracking) return true
    var range = parseNoteRange(entries[i].note)
    if (range && range.start <= nowMinutes && nowMinutes < range.end) return true
  }
  return false
}

// ---- Dates.

function dateKey(date) {
  return date.getFullYear() + "-"
    + String(date.getMonth() + 1).padStart(2, "0") + "-"
    + String(date.getDate()).padStart(2, "0")
}

function addDays(date, delta) {
  var d = new Date(date)
  d.setDate(d.getDate() + delta)
  return d
}

function minutesNow(date) {
  return date.getHours() * 60 + date.getMinutes()
}

// QML `import "Model.js" as Model` sees top-level functions; node's test
// runner loads this file through test/qmljs.mjs which collects the same.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseTimeToken: parseTimeToken,
    parseTimeInput: parseTimeInput,
    formatClock: formatClock,
    notePrefix: notePrefix,
    parseNoteRange: parseNoteRange,
    composeNote: composeNote,
    ensurePrefix: ensurePrefix,
    fuzzyScore: fuzzyScore,
    fuzzyFilter: fuzzyFilter,
    layoutDay: layoutDay,
    totalMinutes: totalMinutes,
    isActive: isActive,
    dateKey: dateKey,
    addDays: addDays,
    minutesNow: minutesNow,
  }
}
