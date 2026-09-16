// Thin mite API client on QML's XMLHttpRequest. All calls are asynchronous
// and report back with callback(error, data): error is a human-readable
// string or null, data the parsed JSON payload. mite wraps every resource
// ("time_entry", "project", ...); unwrap() flattens that.
//
// API reference: https://mite.de/api/ — auth via the X-MiteApiKey header,
// base URL https://<account>.mite.de. Qt's XHR forbids a custom User-Agent,
// so requests go out with the Qt default.
//
// Qt's XHR `timeout` is not trusted here: on a stalled connection (packets
// dropped, wifi gone mid-request) Qt 6.11 fires no event at all — not
// ontimeout, not DONE — no matter when the timeout is set. A request that
// never calls back wedges the panel's busy flag shut forever. So every
// request registers a deadline instead, and the panel ticks reapStale(),
// which aborts overdue requests; abort() reliably fires DONE with status 0.

var TIMEOUT_MS = 10000

/** In-flight requests: {xhr, deadline, timedOut, finished}. */
var pending = []

function baseUrl(cfg) {
  return "https://" + cfg.account + ".mite.de"
}

/** Abort every in-flight request past its deadline. `now` defaults to Date.now(). */
function reapStale(now) {
  if (now === undefined) now = Date.now()
  // abort() calls back synchronously and finish() splices `pending`, so
  // walk a snapshot.
  var stale = pending.filter(function(p) { return now >= p.deadline })
  for (var i = 0; i < stale.length; i++) {
    stale[i].timedOut = true
    stale[i].xhr.abort()
  }
}

function request(cfg, method, path, body, callback) {
  if (!cfg || !cfg.account || !cfg.apiKey) {
    callback("Not configured: set \"account\" and \"apiKey\" in shell.json", null)
    return
  }
  var xhr = new XMLHttpRequest()
  var entry = { xhr: xhr, deadline: Date.now() + TIMEOUT_MS, timedOut: false, finished: false }
  function finish(err, data) {
    if (entry.finished) return
    entry.finished = true
    var idx = pending.indexOf(entry)
    if (idx !== -1) pending.splice(idx, 1)
    callback(err, data)
  }
  xhr.open(method, baseUrl(cfg) + path)
  xhr.setRequestHeader("X-MiteApiKey", cfg.apiKey)
  xhr.setRequestHeader("Accept", "application/json")
  if (body !== null) xhr.setRequestHeader("Content-Type", "application/json")
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== XMLHttpRequest.DONE) return
    if (entry.timedOut) {
      finish("mite did not answer within " + TIMEOUT_MS / 1000 + "s", null)
    } else if (xhr.status === 0) {
      finish("mite unreachable (offline?)", null)
    } else if (xhr.status === 401) {
      finish("mite rejected the API key", null)
    } else if (xhr.status < 200 || xhr.status >= 300) {
      var detail = ""
      try { detail = JSON.parse(xhr.responseText).error || "" } catch (e) {}
      finish("mite error " + xhr.status + (detail ? ": " + detail : ""), null)
    } else {
      var data = null
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {} } catch (e) {
        finish("mite sent unparsable JSON", null)
        return
      }
      finish(null, data)
    }
  }
  pending.push(entry)
  xhr.send(body === null ? undefined : JSON.stringify(body))
}

/** [{time_entry: {...}}, ...] → [{...}, ...] */
function unwrap(list, key) {
  var out = []
  for (var i = 0; i < (list || []).length; i++) out.push(list[i][key])
  return out
}

/** Time entries of the current user for one day ("YYYY-MM-DD"). */
function fetchDay(cfg, dateKey, callback) {
  var p = dateKey.split("-")
  request(cfg, "GET", "/daily/" + Number(p[0]) + "/" + Number(p[1]) + "/" + Number(p[2]) + ".json", null,
    function(err, data) { callback(err, err ? null : unwrap(data, "time_entry")) })
}

/**
 * The current user's entries between two "YYYY-MM-DD" days, newest first —
 * the raw material for the description history. mite caps a page at 1000,
 * which a quarter of one person's bookings stays well under.
 */
function fetchEntryRange(cfg, fromKey, toKey, callback) {
  request(cfg, "GET", "/time_entries.json?from=" + fromKey + "&to=" + toKey
      + "&limit=1000&sort=date&direction=desc", null,
    function(err, data) { callback(err, err ? null : unwrap(data, "time_entry")) })
}

/** Active (non-archived) projects and services, newest first as mite returns them. */
function fetchProjects(cfg, callback) {
  request(cfg, "GET", "/projects.json", null,
    function(err, data) { callback(err, err ? null : unwrap(data, "project")) })
}

function fetchServices(cfg, callback) {
  request(cfg, "GET", "/services.json", null,
    function(err, data) { callback(err, err ? null : unwrap(data, "service")) })
}

/**
 * @param entry {date_at, minutes, note, project_id, service_id}
 * @returns the created time entry via callback.
 */
function createEntry(cfg, entry, callback) {
  request(cfg, "POST", "/time_entries.json", { time_entry: entry },
    function(err, data) { callback(err, err ? null : data.time_entry) })
}

function updateEntry(cfg, id, fields, callback) {
  request(cfg, "PATCH", "/time_entries/" + id + ".json", { time_entry: fields }, callback)
}

function deleteEntry(cfg, id, callback) {
  request(cfg, "DELETE", "/time_entries/" + id + ".json", null, callback)
}

/** @returns {tracking_time_entry: {id, minutes, since}} or {} via callback. */
function fetchTracker(cfg, callback) {
  request(cfg, "GET", "/tracker.json", null,
    function(err, data) { callback(err, err ? null : (data.tracker || {})) })
}

function startTracker(cfg, entryId, callback) {
  request(cfg, "PATCH", "/tracker/" + entryId + ".json", null, callback)
}

function stopTracker(cfg, entryId, callback) {
  request(cfg, "DELETE", "/tracker/" + entryId + ".json", null, callback)
}

// QML's `import "Mite.js" as Mite` sees the top-level functions directly;
// node (which runs the tests against a fake XMLHttpRequest) needs them
// exported, and defines `module` where QML's JS environment does not.
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    TIMEOUT_MS: TIMEOUT_MS,
    pending: pending,
    reapStale: reapStale,
    request: request,
  }
}
