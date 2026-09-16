import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const M = createRequire(import.meta.url)("../Model.js")

test("parseTimeToken", () => {
  assert.equal(M.parseTimeToken("930"), 9 * 60 + 30)
  assert.equal(M.parseTimeToken("0930"), 9 * 60 + 30)
  assert.equal(M.parseTimeToken("1215"), 12 * 60 + 15)
  assert.equal(M.parseTimeToken("9"), 9 * 60)
  assert.equal(M.parseTimeToken("23"), 23 * 60)
  assert.equal(M.parseTimeToken("2360"), null)
  assert.equal(M.parseTimeToken("2401"), null)
  assert.equal(M.parseTimeToken("9:30"), null)
  assert.equal(M.parseTimeToken(""), null)
})

test("parseTimeInput", () => {
  assert.deepEqual(M.parseTimeInput("", 600), { mode: "track" })
  assert.deepEqual(M.parseTimeInput("  ", 600), { mode: "track" })
  assert.deepEqual(M.parseTimeInput("930", 750), { mode: "until-now", start: 570, end: 750 })
  assert.deepEqual(M.parseTimeInput("930 1215", 0), { mode: "range", start: 570, end: 735 })
  assert.deepEqual(M.parseTimeInput("930-1215", 0), { mode: "range", start: 570, end: 735 })
  assert.equal(M.parseTimeInput("1215 930", 0), null, "end before start")
  assert.equal(M.parseTimeInput("930 930", 0), null, "zero length")
  assert.equal(M.parseTimeInput("abc", 0), null)
  assert.equal(M.parseTimeInput("9 10 11", 0), null)
  // start in the future relative to now still books at least one minute
  assert.deepEqual(M.parseTimeInput("930", 500), { mode: "until-now", start: 570, end: 571 })
})

test("note prefix round-trip", () => {
  assert.equal(M.notePrefix(570, 735), "(9:30 bis 12:15)")
  assert.equal(M.composeNote(570, 735, "daily standup"), "(9:30 bis 12:15) daily standup")
  assert.equal(M.composeNote(570, 735, ""), "(9:30 bis 12:15)")
  assert.deepEqual(M.parseNoteRange("(10:15 bis 12:05) review"), { start: 615, end: 725, label: "review" })
  assert.equal(M.parseNoteRange("no prefix here"), null)
  assert.equal(M.parseNoteRange("(12:05 bis 10:15) backwards"), null)
  // mite's web timer writes a zero-length prefix when started and stopped
  // within the same minute; rejecting it turns the entry "untimed" and makes
  // editing leak the prefix into the label.
  assert.deepEqual(M.parseNoteRange("(13:51 bis 13:51)"), { start: 831, end: 831, label: "" })
  assert.equal(M.parseNoteRange(null), null)
  assert.equal(M.ensurePrefix("(9:00 bis 9:30) kept", 600, 660), "(9:00 bis 9:30) kept")
  assert.equal(M.ensurePrefix("added", 600, 660), "(10:00 bis 11:00) added")
})

test("fuzzy", () => {
  assert.ok(M.fuzzyScore("wr", "Website Relaunch") > M.fuzzyScore("wr", "Lowrider"))
  assert.equal(M.fuzzyScore("xyz", "Website Relaunch"), -1)
  assert.equal(M.fuzzyScore("", "anything"), 0)
  const items = [{ name: "Homepage" }, { name: "Order Portal" }, { name: "Ops" }]
  const hits = M.fuzzyFilter(items, "o", (p) => p.name)
  assert.equal(hits[0].name, "Order Portal")
  assert.deepEqual(M.fuzzyFilter(items, "", (p) => p.name), items, "empty query keeps order")
  assert.ok(M.fuzzyScore("nordwnd", "Nordwind") >= 0, "subsequence within a word")
  assert.ok(M.fuzzyScore("nord", "Nordwind") > M.fuzzyScore("nord", "Hafennordseite"),
    "word start beats a hit in the middle")
})

test("fuzzy across fields and query words", () => {
  const projects = [
    { name: "Bildanalyse", customer_name: "Nordwind 4711" },
    { name: "Wartung", customer_name: "Nordwind 4711" },
    { name: "Nordlicht", customer_name: "Sonstiges 10" },
    { name: "Website Relaunch", customer_name: null },
  ]
  const of = (p) => [p.name, p.customer_name]
  const names = (q) => M.fuzzyFilter(projects, q, of).map((p) => p.name)

  assert.deepEqual(names("nordwind"),
    ["Bildanalyse", "Wartung"], "the customer finds its projects")
  assert.deepEqual(names("nord bild"), ["Bildanalyse"], "words match different fields")
  assert.deepEqual(names("bild nord"), ["Bildanalyse"], "word order does not matter")
  assert.deepEqual(names("nordwnd"), ["Bildanalyse", "Wartung"])
  assert.equal(names("nord")[0], "Nordlicht", "the project name outranks the customer")
  assert.deepEqual(names("relaunch"), ["Website Relaunch"], "an absent customer is no obstacle")
  assert.deepEqual(names("nordwind xyz"), [], "every word must match")
})

test("historyFrom collapses repeats, most recent first", () => {
  const entries = [
    { date_at: "2026-09-16", note: "(9:00 bis 9:15) Standup", project_id: 1, project_name: "Bildanalyse", service_id: 7, service_name: "Dev" },
    { date_at: "2026-09-15", note: "(9:00 bis 9:15) standup", project_id: 1, project_name: "Bildanalyse", service_id: 7, service_name: "Dev" },
    { date_at: "2026-09-14", note: "(9:00 bis 9:15) Standup", project_id: 2, project_name: "Wartung", service_id: 7, service_name: "Dev" },
    { date_at: "2026-09-13", note: "(10:00 bis 11:00) ", project_id: 1, project_name: "Bildanalyse", service_id: 7, service_name: "Dev" },
    { date_at: "2026-09-12", note: "No clock time", project_id: 1, project_name: "Bildanalyse", service_id: 7, service_name: "Dev" },
    { date_at: "2026-09-11", note: "(14:00 bis 14:30) (13:54 bis 13:54)", project_id: 1, project_name: "Bildanalyse", service_id: 7, service_name: "Dev" },
  ]
  const history = M.historyFrom(entries)
  assert.deepEqual(history.map((h) => h.label), ["Standup", "Standup", "No clock time"],
    "the note prefix is stripped — twice over where needed — and a description that is all clock drops out")
  assert.equal(history[0].count, 2, "same description, project and service collapse")
  assert.equal(history[0].date, "2026-09-16")
  assert.equal(history[0].project_name, "Bildanalyse")
  assert.equal(history[1].project_name, "Wartung", "another project is another entry")

  const hits = M.fuzzyFilter(history, "stand wart", (h) => [h.label, h.project_name])
  assert.deepEqual(hits.map((h) => h.project_name), ["Wartung"], "the history searches both")
})

test("parseDateKey reads a day key in local time", () => {
  const d = M.parseDateKey("2026-09-16")
  assert.equal(d.getFullYear(), 2026)
  assert.equal(d.getMonth(), 8)
  assert.equal(d.getDate(), 16)
  assert.equal(M.dateKey(d), "2026-09-16", "round-trips through dateKey")
  assert.equal(M.parseDateKey(""), null)
})

test("layoutDay positions, overlaps, appends untimed", () => {
  const entries = [
    { id: 1, minutes: 110, note: "(10:15 bis 12:05) a" },
    { id: 2, minutes: 60, note: "(11:00 bis 12:00) b" },
    { id: 3, minutes: 30, note: "no clock time" },
    { id: 4, minutes: 45, note: "(14:00 bis 15:00) mismatch" },
  ]
  const { slots, fromMinutes, toMinutes } = M.layoutDay(entries, 16 * 60)
  const byId = Object.fromEntries(slots.map((s) => [s.id, s]))
  assert.ok(byId[1].overlap && byId[2].overlap)
  assert.equal(byId[1].columns, 2)
  assert.notEqual(byId[1].column, byId[2].column)
  assert.ok(!byId[4].overlap)
  assert.ok(byId[4].mismatch, "45 booked minutes vs 60-minute span")
  assert.ok(!byId[1].mismatch)
  assert.equal(byId[3].timed, false)
  assert.equal(byId[3].start, byId[4].end, "untimed hangs after last timed")
  assert.equal(byId[3].end - byId[3].start, 30)
  assert.equal(fromMinutes, 8 * 60)
  assert.equal(toMinutes, 18 * 60)
})

test("layoutDay tracker slot runs until now", () => {
  const since = new Date()
  since.setHours(9, 0, 0, 0)
  const entries = [{ id: 7, minutes: 30, note: "live", tracking: { since: since.toISOString() } }]
  const { slots } = M.layoutDay(entries, 10 * 60)
  assert.equal(slots[0].start, 9 * 60)
  assert.equal(slots[0].end, 10 * 60)
  assert.ok(slots[0].tracking)
})

test("layoutDay splits lanes for blocks that collide only on screen", () => {
  const entries = [
    { id: 1, minutes: 2, note: "(10:53 bis 10:55) stop" },
    { id: 2, minutes: 3, note: "(10:57 bis 11:00) next" },
  ]
  const plain = M.layoutDay(entries, 12 * 60)
  assert.equal(plain.slots[0].columns, 1, "no time overlap, no min span, one lane")
  const { slots } = M.layoutDay(entries, 12 * 60, 24)
  assert.notEqual(slots[0].column, slots[1].column, "24-minute blocks collide on screen")
  assert.equal(slots[0].columns, 2)
  assert.ok(!slots[0].overlap, "a screen collision is not a booking overlap")
})

test("layoutDay grows the axis", () => {
  const { fromMinutes, toMinutes } = M.layoutDay(
    [{ id: 1, minutes: 60, note: "(6:30 bis 20:30)" }], 0)
  assert.equal(fromMinutes, 6 * 60)
  assert.equal(toMinutes, 21 * 60)
})

test("isActive", () => {
  const now = 11 * 60
  assert.ok(M.isActive([{ note: "(10:00 bis 12:00)" }], now))
  assert.ok(!M.isActive([{ note: "(8:00 bis 9:00)" }], now))
  assert.ok(M.isActive([{ note: "x", tracking: { since: "whenever" } }], now))
  assert.ok(!M.isActive([], now))
  assert.ok(!M.isActive([{ note: "(10:00 bis 11:00)" }], now), "end is exclusive")
})

test("toDigits round-trips through parseTimeToken", () => {
  for (const m of [0, 5, 570, 735, 23 * 60 + 59])
    assert.equal(M.parseTimeToken(M.toDigits(m)), m)
})

test("totals and dates", () => {
  assert.equal(M.totalMinutes([{ minutes: 30 }, { minutes: 75 }]), 105)
  assert.equal(M.formatClock(405), "6:45")
  assert.equal(M.dateKey(new Date(2026, 8, 3)), "2026-09-03")
  assert.equal(M.dateKey(M.addDays(new Date(2026, 8, 1), -1)), "2026-08-31")
})
