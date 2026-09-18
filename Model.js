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

/** 570 → "930": the bare-digit form the time field takes. */
function toDigits(minutes) {
  return String(Math.floor(minutes / 60)) + String(minutes % 60).padStart(2, "0")
}

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
  // end == start is real data: mite's web timer writes a zero-length prefix
  // when started and stopped within the same minute.
  if (end < start) return null
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

// ---- Fuzzy matching for the project/service pickers.
//
// A project is worth finding by anything that names it: its own name or its
// customer (the cost centre a project hangs under). Words of the query are
// matched independently, each against whichever field suits it best, so
// "nord bild" finds the project "Bildanalyse" of customer "Nordwind 4711"
// and word order does not matter. Within one word the match is a subsequence
// ("nordwnd" → "Nordwind"), scored so that word-initial and contiguous hits
// win: "wr" finds "Website Relaunch" before "Lowrider".

var WORD_BREAK = /[\s\-_./&,()[\]]/

var CHAR_BASE = 10        // every matched character is worth having
var WORD_START = 15
var CONSECUTIVE = 10
var MAX_GAP_COST = 6      // capped, so a long name is not ruled out by one gap
var MAX_START_COST = 10
var SECONDARY_FIELD = 0.7 // a hit on the customer ranks under one on the name

/**
 * Greedy subsequence match of `word` in `text`, anchored at `text[start]`.
 * Costs stay below CHAR_BASE per character, so any match scores >= 0.
 * @returns {number} score, or -1 when the rest of `word` does not fit.
 */
function scoreFrom(word, text, start) {
  var score = 0
  var ti = start
  var prev = -2
  for (var qi = 0; qi < word.length; qi++) {
    var idx = text.indexOf(word[qi], ti)
    if (idx === -1) return -1
    score += CHAR_BASE
    if (idx === 0 || WORD_BREAK.test(text[idx - 1])) score += WORD_START
    if (idx === prev + 1) score += CONSECUTIVE
    else if (qi > 0) score -= Math.min(idx - ti, MAX_GAP_COST)
    prev = idx
    ti = idx + 1
  }
  return score - Math.min(start, MAX_START_COST)
}

/**
 * Best placement of one query word in one field. Every start is tried, not
 * just the leftmost, so a walk that begins on an early stray character can
 * never hide the tight match further along.
 * @returns {number} score, or -1 when the word is no subsequence of the field.
 */
function wordScore(word, text) {
  if (word === "") return 0
  var best = -1
  for (var s = 0; s + word.length <= text.length; s++) {
    if (text[s] !== word[0]) continue
    var score = scoreFrom(word, text, s)
    if (score > best) best = score
  }
  if (best < 0) return -1
  if (text === word) return best + 100
  if (text.indexOf(word) === 0) return best + 30
  return best
}

/** Best field for one word, ranked down for fields after the first. */
function fieldScore(word, fields) {
  var best = -1
  for (var i = 0; i < fields.length; i++) {
    var s = wordScore(word, fields[i])
    if (s < 0) continue
    if (i > 0) s *= SECONDARY_FIELD
    if (s > best) best = s
  }
  return best
}

/**
 * @param query  whitespace-separated words, each matched on its own
 * @param text   one string, or several fields in order of importance
 * @returns {number} summed score, or -1 when a word matches no field.
 */
function fuzzyScore(query, text) {
  var raw = Array.isArray(text) ? text : [text]
  var fields = []
  for (var f = 0; f < raw.length; f++) {
    var value = String(raw[f] == null ? "" : raw[f]).toLowerCase()
    if (value !== "") fields.push(value)
  }
  var words = String(query == null ? "" : query).toLowerCase().trim().split(/\s+/)
    .filter(function(w) { return w !== "" })
  var total = 0
  for (var w = 0; w < words.length; w++) {
    var s = fieldScore(words[w], fields)
    if (s < 0) return -1
    total += s
  }
  return total
}

/**
 * Filter and rank by fuzzy score; stable for equal scores.
 * @param {Array} items
 * @param {function} fieldsOf  item → string or array of strings to match on
 * @returns {Array}
 */
function fuzzyFilter(items, query, fieldsOf) {
  var scored = []
  for (var i = 0; i < items.length; i++) {
    var s = fuzzyScore(query, fieldsOf(items[i]))
    if (s >= 0) scored.push({ item: items[i], score: s, index: i })
  }
  scored.sort(function(a, b) { return b.score - a.score || a.index - b.index })
  return scored.map(function(e) { return e.item })
}

// ---- Description history, the shell's Ctrl+R applied to bookings. Past
//      entries collapse to their distinct (description, project, service)
//      triples: recalling one recalls the whole booking, not just its text.
//      Most recently used first, so an empty query lists what you did last.

/**
 * @param entries  raw mite time entries, any order
 * @returns {Array} {label, project_id, project_name, customer_name,
 *   service_id, service_name, date, count}
 */
function historyFrom(entries) {
  var seen = {}
  var out = []
  for (var i = 0; i < entries.length; i++) {
    var e = entries[i]
    // Stripped repeatedly: a note that got prefixed twice (mite's web timer
    // stopped inside one minute, then edited) is all clock and no
    // description, and drops out rather than being offered back.
    var label = String(e.note || "")
    for (var range = parseNoteRange(label); range; range = parseNoteRange(label)) label = range.label
    label = label.trim()
    if (label === "") continue
    var date = String(e.date_at || "")
    // "k:" keeps a description like "constructor" off Object.prototype.
    var key = "k:" + label.toLowerCase() + " " + (e.project_id || 0) + " " + (e.service_id || 0)
    if (seen[key]) {
      seen[key].count += 1
      // Keep the spelling that goes with the most recent booking.
      if (date > seen[key].date) { seen[key].date = date; seen[key].label = label }
      continue
    }
    seen[key] = {
      label: label,
      project_id: e.project_id || 0,
      project_name: e.project_name || "",
      customer_name: e.customer_name || "",
      service_id: e.service_id || 0,
      service_name: e.service_name || "",
      date: date,
      count: 1,
    }
    out.push(seen[key])
  }
  out.sort(function(a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0 })
  return out
}

/** "2026-09-16" → a local Date; `new Date(key)` would read it as UTC. */
function parseDateKey(key) {
  var p = String(key || "").split("-")
  if (p.length !== 3) return null
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]))
  return isNaN(d.getTime()) ? null : d
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
 * Columns are assigned on visualEnd, not end: a rendered block never gets
 * shorter than the minimum readable height, so two short entries can collide
 * on screen without overlapping in time — they must split lanes too.
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
      ends[group[g].column] = Math.max(ends[group[g].column] || 0, group[g].visualEnd)
    var column = -1
    for (var c = 0; c < ends.length; c++) if (ends[c] <= slot.start) { column = c; break }
    if (column === -1) column = ends.length
    slot.column = column
    group.push(slot)
    groupEnd = Math.max(groupEnd, slot.visualEnd)
  }
  closeGroup()
  return slots
}

/**
 * @param entries  raw mite time entries of one day ({id, minutes, note,
 *   project_name, service_name, tracking?: {since}}).
 * @param nowMinutes  minutes from midnight, for the running tracker slot.
 * @param minSlotMinutes  the time span a minimum-height block covers on
 *   screen; lanes split on it so short entries stay legible side by side.
 * @returns {{slots: Array, fromMinutes: number, toMinutes: number}}
 *   Slots carry: id, start, end, visualEnd, label, project, service,
 *   minutes, timed, tracking, overlap, column, columns, mismatch
 *   (duration ≠ prefix span).
 */
function layoutDay(entries, nowMinutes, minSlotMinutes) {
  var minSpan = Math.max(0, minSlotMinutes || 0)
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
  for (var v = 0; v < timed.length; v++)
    timed[v].visualEnd = Math.max(timed[v].end, timed[v].start + minSpan)
  assignColumns(timed)

  // Untimed entries hang after the last timed one, back to back.
  var cursor = DEFAULT_FROM_HOUR * 60
  for (var t = 0; t < timed.length; t++) cursor = Math.max(cursor, timed[t].visualEnd)
  for (var u = 0; u < untimed.length; u++) {
    untimed[u].start = cursor
    untimed[u].end = cursor + Math.max(untimed[u].minutes, minSpan, 5)
    untimed[u].visualEnd = untimed[u].end
    cursor = untimed[u].end
  }

  var slots = timed.concat(untimed)
  var from = DEFAULT_FROM_HOUR * 60
  var to = DEFAULT_TO_HOUR * 60
  for (var s = 0; s < slots.length; s++) {
    from = Math.min(from, Math.floor(slots[s].start / 60) * 60)
    to = Math.max(to, Math.ceil(slots[s].visualEnd / 60) * 60)
  }
  return { slots: slots, fromMinutes: from, toMinutes: to }
}

// ---- Totals and the bar state.

/**
 * Minutes an entry stands for at `nowMs`. mite keeps a running tracker's
 * time out of the entry's `minutes` until the tracker stops (it reports it
 * separately, floored to whole minutes), so a tracked entry counts the time
 * since `tracking.since` on top — locally, so the total moves between polls.
 */
function entryMinutes(entry, nowMs) {
  var minutes = entry.minutes || 0
  if (entry.tracking && entry.tracking.since) {
    var since = new Date(entry.tracking.since).getTime()
    if (!isNaN(since)) minutes += Math.max(0, Math.floor((nowMs - since) / 60000))
  }
  return minutes
}

/** @param now  Date or ms; defaults to the current time. */
function totalMinutes(entries, now) {
  var nowMs = now === undefined ? Date.now() : Number(now)
  var total = 0
  for (var i = 0; i < entries.length; i++) total += entryMinutes(entries[i], nowMs)
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

// QML's `import "Model.js" as Model` sees the top-level functions directly;
// node (which runs the tests) needs them exported, and defines `module`
// where QML's JS environment does not.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    parseTimeToken: parseTimeToken,
    parseTimeInput: parseTimeInput,
    toDigits: toDigits,
    formatClock: formatClock,
    notePrefix: notePrefix,
    parseNoteRange: parseNoteRange,
    composeNote: composeNote,
    ensurePrefix: ensurePrefix,
    fuzzyScore: fuzzyScore,
    fuzzyFilter: fuzzyFilter,
    historyFrom: historyFrom,
    parseDateKey: parseDateKey,
    layoutDay: layoutDay,
    entryMinutes: entryMinutes,
    totalMinutes: totalMinutes,
    isActive: isActive,
    dateKey: dateKey,
    addDays: addDays,
    minutesNow: minutesNow,
  }
}
