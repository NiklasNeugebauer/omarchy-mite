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

test("totals and dates", () => {
  assert.equal(M.totalMinutes([{ minutes: 30 }, { minutes: 75 }]), 105)
  assert.equal(M.formatClock(405), "6:45")
  assert.equal(M.dateKey(new Date(2026, 8, 3)), "2026-09-03")
  assert.equal(M.dateKey(M.addDays(new Date(2026, 8, 1), -1)), "2026-08-31")
})
