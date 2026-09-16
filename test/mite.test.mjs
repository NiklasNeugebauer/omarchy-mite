import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

// Fake XHR mimicking the verified Qt 6.11 behavior: a stalled connection
// fires no event at all (Qt's own `timeout` included), while abort() fires
// onreadystatechange with DONE and status 0.
class FakeXHR {
  static DONE = 4
  constructor() { this.readyState = 0; this.status = 0 }
  open() {}
  setRequestHeader() {}
  send() {}
  abort() {
    this.readyState = FakeXHR.DONE
    this.status = 0
    if (this.onreadystatechange) this.onreadystatechange()
  }
  respond(status, text) {
    this.readyState = FakeXHR.DONE
    this.status = status
    this.responseText = text
    if (this.onreadystatechange) this.onreadystatechange()
  }
}

globalThis.XMLHttpRequest = FakeXHR
const Mite = createRequire(import.meta.url)("../Mite.js")

const cfg = { account: "test", apiKey: "key" }

function startRequest() {
  const calls = []
  Mite.request(cfg, "GET", "/x.json", null, (err, data) => calls.push([err, data]))
  return { entry: Mite.pending[Mite.pending.length - 1], calls }
}

test("a stalled request is reaped at its deadline and reports a timeout once", () => {
  const { entry, calls } = startRequest()
  const t0 = entry.deadline - Mite.TIMEOUT_MS

  Mite.reapStale(t0 + Mite.TIMEOUT_MS - 1)
  assert.equal(calls.length, 0, "must not reap before the deadline")

  Mite.reapStale(t0 + Mite.TIMEOUT_MS)
  assert.equal(calls.length, 1)
  assert.match(calls[0][0], /did not answer/)
  assert.equal(Mite.pending.includes(entry), false)

  // A late DONE from the aborted xhr (or a second reap) must not call back again.
  entry.xhr.respond(200, "{}")
  Mite.reapStale(t0 + 2 * Mite.TIMEOUT_MS)
  assert.equal(calls.length, 1)
})

test("a completed request leaves pending and is untouched by later reaps", () => {
  const { entry, calls } = startRequest()
  entry.xhr.respond(200, '{"ok": true}')
  assert.deepEqual(calls, [[null, { ok: true }]])
  assert.equal(Mite.pending.includes(entry), false)
  Mite.reapStale(entry.deadline + 1)
  assert.equal(calls.length, 1)
})

test("one reap pass aborts every stale request, sparing fresh ones", () => {
  const a = startRequest()
  const b = startRequest()
  const c = startRequest()
  c.entry.deadline += 5000 // still fresh at reap time

  Mite.reapStale(a.entry.deadline)
  assert.equal(a.calls.length, 1)
  assert.equal(b.calls.length, 1)
  assert.equal(c.calls.length, 0)
  assert.deepEqual(Mite.pending, [c.entry])
  c.entry.xhr.respond(200, "{}")
})

test("network error (status 0 without reap) reports unreachable", () => {
  const { entry, calls } = startRequest()
  entry.xhr.abort() // same event shape Qt fires for refused/DNS failures
  assert.equal(calls.length, 1)
  assert.match(calls[0][0], /unreachable/)
  assert.equal(Mite.pending.length, 0)
})
