// Thin mite API client on QML's XMLHttpRequest. All calls are asynchronous
// and report back with callback(error, data): error is a human-readable
// string or null, data the parsed JSON payload. mite wraps every resource
// ("time_entry", "project", ...); unwrap() flattens that.
//
// API reference: https://mite.de/api/ — auth via the X-MiteApiKey header,
// base URL https://<account>.mite.de. Qt's XHR forbids a custom User-Agent,
// so requests go out with the Qt default.

function baseUrl(cfg) {
  return "https://" + cfg.account + ".mite.de"
}

function request(cfg, method, path, body, callback) {
  if (!cfg || !cfg.account || !cfg.apiKey) {
    callback("Not configured: set \"account\" and \"apiKey\" in shell.json", null)
    return
  }
  var xhr = new XMLHttpRequest()
  xhr.open(method, baseUrl(cfg) + path)
  xhr.setRequestHeader("X-MiteApiKey", cfg.apiKey)
  xhr.setRequestHeader("Accept", "application/json")
  if (body !== null) xhr.setRequestHeader("Content-Type", "application/json")
  xhr.onreadystatechange = function() {
    if (xhr.readyState !== XMLHttpRequest.DONE) return
    if (xhr.status === 0) {
      callback("mite unreachable (offline?)", null)
    } else if (xhr.status === 401) {
      callback("mite rejected the API key", null)
    } else if (xhr.status < 200 || xhr.status >= 300) {
      var detail = ""
      try { detail = JSON.parse(xhr.responseText).error || "" } catch (e) {}
      callback("mite error " + xhr.status + (detail ? ": " + detail : ""), null)
    } else {
      var data = null
      try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {} } catch (e) {
        callback("mite sent unparsable JSON", null)
        return
      }
      callback(null, data)
    }
  }
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
