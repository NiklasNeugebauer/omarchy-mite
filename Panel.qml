import QtQuick
import Quickshell
import qs.Commons
import qs.Ui
import "Model.js" as Model
import "Mite.js" as Mite

// mite time tracking on the bar: the button shows today's booked hours and
// turns urgent-red while nothing covers the current time; the popup books
// entries with a few keystrokes and lays the day out on a timeline.
//
// Speed is the point. The panel opens focused on the time field; Tab walks
// time → project → service → note; Enter books from anywhere. Times are bare
// digits ("930 1215"), projects and services filter fuzzily while you type,
// and after booking the project snaps back to the configured default.
Panel {
  id: root
  moduleName: "niklasneugebauer.mite"
  ipcTarget: ""   // `omarchy-shell shell toggle niklasneugebauer.mite` routes via the bar

  // ---- Configuration (the widget's shell.json entry).
  readonly property var miteConfig: ({
    account: String(setting("account", "")),
    apiKey: String(setting("apiKey", "")),
  })
  readonly property bool configured: miteConfig.account !== "" && miteConfig.apiKey !== ""
  readonly property string defaultProjectName: String(setting("defaultProject", ""))
  readonly property int refreshMinutes: Math.max(1, parseInt(setting("refreshMinutes", 1), 10) || 1)

  // ---- Clock. nowMinutes drives the red state, the tracker slot, and the
  //      now-line, so a minute tick keeps all three honest.
  property date now: new Date()
  readonly property int nowMinutes: Model.minutesNow(now)
  readonly property string todayKey: Model.dateKey(now)

  // ---- Data. Today's entries feed the bar (polled every minute); the
  //      viewed day feeds the panel. On today they are the same fetch.
  property var todayEntries: []
  property var viewEntries: []
  property var projects: []
  property var services: []
  property date viewDate: new Date()
  readonly property string viewKey: Model.dateKey(viewDate)
  readonly property bool viewingToday: viewKey === todayKey
  property string error: ""
  property bool busy: false

  readonly property var dayLayout: Model.layoutDay(viewEntries, nowMinutes)
  readonly property bool activeNow: Model.isActive(todayEntries, nowMinutes)
  readonly property int todayTotal: Model.totalMinutes(todayEntries)
  readonly property var trackingEntry: {
    for (var i = 0; i < todayEntries.length; i++)
      if (todayEntries[i].tracking) return todayEntries[i]
    return null
  }

  // Entry cursor in the timeline (Ctrl+Down/Up); -1 means the form owns the
  // keys. Deleting takes Ctrl+D twice so a slip costs nothing.
  property int cursorIndex: -1
  property int pendingDeleteId: 0

  // ---- Colors.
  readonly property color fg: barForeground
  readonly property color urgent: bar ? bar.urgent : Color.urgent
  readonly property string fontFamily: bar ? bar.fontFamily : Style.font.family

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  property bool settingsOpen: false

  function open() {
    refreshView()
    refreshCatalogs(false)
    root.error = ""
    root.cursorIndex = -1
    root.pendingDeleteId = 0
    root.controller.show()
    if (!root.configured) { openSettings(); return }
    // KeyboardPanel focuses focusTarget on open, but the first mapping can
    // hand focus to the first focusable item instead — insist on the time
    // field, since entry speed is the whole point.
    Qt.callLater(function() { if (root.opened) timeField.forceActiveFocus() })
  }

  function close() {
    root.controller.hide()
  }

  function toggle() {
    if (root.opened) root.close()
    else root.open()
  }

  // ---- Fetching. Last-good data stays on screen; errors land in one line.
  function refreshToday() {
    if (!root.configured) return
    Mite.fetchDay(root.miteConfig, root.todayKey, function(err, entries) {
      if (err) { root.error = err; return }
      root.error = ""
      root.todayEntries = entries
      if (root.viewingToday) root.viewEntries = entries
    })
  }

  function refreshView() {
    root.now = new Date()
    if (!root.configured) return
    if (root.viewingToday) { refreshToday(); return }
    var requested = root.viewKey
    Mite.fetchDay(root.miteConfig, requested, function(err, entries) {
      if (err) { root.error = err; return }
      if (root.viewKey !== requested) return   // the day moved on meanwhile
      root.error = ""
      root.viewEntries = entries
    })
  }

  property double catalogsFetchedAt: 0
  function refreshCatalogs(force) {
    if (!root.configured) return
    var age = Date.now() - root.catalogsFetchedAt
    if (!force && root.projects.length > 0 && age < 15 * 60 * 1000) return
    root.catalogsFetchedAt = Date.now()
    Mite.fetchProjects(root.miteConfig, function(err, list) {
      if (err) { root.error = err; return }
      root.projects = list
      if (!projectField.selected) projectField.selected = root.findDefaultProject()
    })
    Mite.fetchServices(root.miteConfig, function(err, list) {
      if (err) { root.error = err; return }
      root.services = list
    })
  }

  function findDefaultProject() {
    var wanted = root.defaultProjectName.toLowerCase()
    if (wanted === "") return null
    for (var i = 0; i < root.projects.length; i++)
      if (String(root.projects[i].name).toLowerCase() === wanted) return root.projects[i]
    return null
  }

  function moveDay(delta) {
    root.viewDate = Model.addDays(root.viewDate, delta)
    root.viewEntries = root.viewingToday ? root.todayEntries : []
    root.cursorIndex = -1
    root.pendingDeleteId = 0
    refreshView()
  }

  function goToToday() {
    if (root.viewingToday) return
    root.viewDate = new Date()
    root.viewEntries = root.todayEntries
    root.cursorIndex = -1
    refreshView()
  }

  // ---- Booking. The same form edits an existing entry: a click in the
  //      timeline loads it, Enter then updates instead of creating.
  property int editingId: 0

  function startEdit(id) {
    var entry = null
    for (var i = 0; i < root.viewEntries.length; i++)
      if (root.viewEntries[i].id === id) entry = root.viewEntries[i]
    if (!entry) return
    var range = Model.parseNoteRange(entry.note)
    timeField.text = range ? Model.toDigits(range.start) + " " + Model.toDigits(range.end) : ""
    noteField.text = range ? range.label : String(entry.note || "")
    projectField.text = ""
    projectField.selected = entry.project_id ? { id: entry.project_id, name: entry.project_name } : null
    serviceField.text = ""
    serviceField.selected = entry.service_id ? { id: entry.service_id, name: entry.service_name } : null
    root.editingId = id
    root.cursorIndex = -1
    root.pendingDeleteId = 0
    root.error = ""
    timeField.forceActiveFocus()
    timeField.selectAll()
  }

  function cancelEdit() {
    root.editingId = 0
    timeField.text = ""
    noteField.text = ""
    projectField.text = ""
    serviceField.text = ""
    var fallback = root.findDefaultProject()
    if (fallback) projectField.selected = fallback
    timeField.forceActiveFocus()
  }

  function commit() {
    if (!root.configured || root.busy) return
    var time = Model.parseTimeInput(timeField.text, root.nowMinutes)
    if (!time) { root.error = "Time: \"930 1215\", \"930\", or empty to start the tracker"; return }
    var project = projectField.resolved()
    if (projectField.text !== "" && !project) { root.error = "No project matches \"" + projectField.text + "\""; return }
    var service = serviceField.resolved()
    if (serviceField.text !== "" && !service) { root.error = "No service matches \"" + serviceField.text + "\""; return }
    var note = noteField.text.trim()
    if (root.editingId !== 0) { commitEdit(time, project, service, note); return }
    var entry = {
      date_at: root.viewKey,
      project_id: project ? project.id : null,
      service_id: service ? service.id : null,
    }
    if (time.mode === "track") {
      if (!root.viewingToday) { root.error = "The tracker only runs on today"; return }
      entry.minutes = 0
      entry.note = note
      root.busy = true
      root.stopRunningTracker(function(err) {
        if (err) { root.busy = false; root.error = err; return }
        Mite.createEntry(root.miteConfig, entry, function(err2, created) {
          if (err2) { root.busy = false; root.error = err2; return }
          Mite.startTracker(root.miteConfig, created.id, function(err3) {
            root.busy = false
            if (err3) { root.error = err3; return }
            root.afterCommit()
          })
        })
      })
    } else {
      entry.minutes = time.end - time.start
      entry.note = Model.composeNote(time.start, time.end, note)
      root.busy = true
      Mite.createEntry(root.miteConfig, entry, function(err, created) {
        root.busy = false
        if (err) { root.error = err; return }
        root.afterCommit()
      })
    }
  }

  // Empty time keeps the entry's original timing (or lack of one); typed
  // times move it and recompute the duration.
  function commitEdit(time, project, service, note) {
    var original = null
    for (var i = 0; i < root.viewEntries.length; i++)
      if (root.viewEntries[i].id === root.editingId) original = root.viewEntries[i]
    if (!original) { root.error = "The entry is gone — reload with Ctrl+R"; root.editingId = 0; return }
    var fields = {
      project_id: project ? project.id : null,
      service_id: service ? service.id : null,
    }
    if (time.mode === "track") {
      var origRange = Model.parseNoteRange(original.note)
      fields.note = origRange ? Model.composeNote(origRange.start, origRange.end, note) : note
    } else {
      fields.note = Model.composeNote(time.start, time.end, note)
      fields.minutes = time.end - time.start
    }
    root.busy = true
    Mite.updateEntry(root.miteConfig, root.editingId, fields, function(err) {
      root.busy = false
      if (err) { root.error = err; return }
      root.afterCommit()
    })
  }

  function afterCommit() {
    root.error = ""
    root.editingId = 0
    timeField.text = ""
    noteField.text = ""
    projectField.text = ""
    serviceField.text = ""
    var fallback = root.findDefaultProject()
    if (fallback) projectField.selected = fallback
    timeField.forceActiveFocus()
    refreshView()
    refreshToday()
  }

  // Stopping writes the "(start bis end)" prefix the mite web timer would
  // have written, so the entry carries its clock time from then on.
  function stopRunningTracker(callback) {
    Mite.fetchTracker(root.miteConfig, function(err, tracker) {
      if (err) { callback(err); return }
      var running = tracker.tracking_time_entry
      if (!running) { callback(null); return }
      Mite.stopTracker(root.miteConfig, running.id, function(err2) {
        if (err2) { callback(err2); return }
        var since = new Date(running.since)
        var start = since.getHours() * 60 + since.getMinutes()
        var end = Math.max(start + 1, root.nowMinutes)
        var current = null
        for (var i = 0; i < root.todayEntries.length; i++)
          if (root.todayEntries[i].id === running.id) current = root.todayEntries[i]
        var note = Model.ensurePrefix(current ? current.note : "", start, end)
        Mite.updateEntry(root.miteConfig, running.id, { note: note }, callback)
      })
    })
  }

  function stopTracking() {
    if (root.busy || !root.trackingEntry) return
    root.busy = true
    root.stopRunningTracker(function(err) {
      root.busy = false
      if (err) { root.error = err; return }
      root.error = ""
      refreshToday()
    })
  }

  // ---- Settings, edited in place and written back to this widget's
  //      shell.json entry. Applied locally first so the panel reacts on the
  //      keystroke; the shell.json write comes back through the bar as the
  //      same value.
  function persistSettings(values) {
    var entry = { id: root.moduleName }
    for (var existing in root.settings) if (existing !== "id") entry[existing] = root.settings[existing]
    for (var key in values) entry[key] = values[key]
    root.settings = entry
    if (root.bar && root.bar.shell && typeof root.bar.shell.updateEntryInline === "function")
      root.bar.shell.updateEntryInline(root.moduleName, entry)
  }

  function openSettings() {
    settingsAccount.text = root.miteConfig.account
    settingsApiKey.text = root.miteConfig.apiKey
    settingsProject.text = root.defaultProjectName
    root.settingsOpen = true
    Qt.callLater(function() { settingsAccount.forceActiveFocus(); settingsAccount.selectAll() })
  }

  function saveSettings() {
    persistSettings({
      account: settingsAccount.text.trim(),
      apiKey: settingsApiKey.text.trim(),
      defaultProject: settingsProject.text.trim(),
    })
    root.settingsOpen = false
    root.error = ""
    root.catalogsFetchedAt = 0
    Qt.callLater(function() {
      refreshCatalogs(true)
      refreshToday()
      refreshView()
      timeField.forceActiveFocus()
    })
  }

  function cancelSettings() {
    if (!root.configured) { root.close(); return }
    root.settingsOpen = false
    Qt.callLater(function() { timeField.forceActiveFocus() })
  }

  function handleSettingsKey(event, next, previous) {
    if (event.key === Qt.Key_Escape) { cancelSettings(); event.accepted = true; return }
    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) { saveSettings(); event.accepted = true; return }
    if (event.key === Qt.Key_Tab) { next.forceActiveFocus(); event.accepted = true; return }
    if (event.key === Qt.Key_Backtab) { previous.forceActiveFocus(); event.accepted = true; return }
  }

  // ---- Entry cursor and deletion.
  function moveCursor(delta) {
    var count = root.dayLayout.slots.length
    if (count === 0) return
    var next = root.cursorIndex + delta
    if (next < -1) next = count - 1
    if (next >= count) next = -1
    root.cursorIndex = next
    root.pendingDeleteId = 0
  }

  function requestDelete() {
    if (root.cursorIndex < 0 || root.cursorIndex >= root.dayLayout.slots.length) return
    var slot = root.dayLayout.slots[root.cursorIndex]
    if (root.pendingDeleteId !== slot.id) { root.pendingDeleteId = slot.id; return }
    root.pendingDeleteId = 0
    Mite.deleteEntry(root.miteConfig, slot.id, function(err) {
      if (err) { root.error = err; return }
      root.error = ""
      root.cursorIndex = -1
      refreshView()
      refreshToday()
    })
  }

  // Shared by every field: the chords that must work no matter what has
  // focus. Returns true when the key was consumed.
  function handleGlobalKey(event) {
    var ctrl = event.modifiers & Qt.ControlModifier
    if (event.key === Qt.Key_Escape) {
      if (root.pendingDeleteId !== 0) root.pendingDeleteId = 0
      else if (root.editingId !== 0) root.cancelEdit()
      else if (root.cursorIndex !== -1) root.cursorIndex = -1
      else root.close()
      return true
    }
    if (ctrl && event.key === Qt.Key_E) {
      if (root.cursorIndex >= 0 && root.cursorIndex < root.dayLayout.slots.length)
        root.startEdit(root.dayLayout.slots[root.cursorIndex].id)
      return true
    }
    if (ctrl && event.key === Qt.Key_Left) { root.moveDay(-1); return true }
    if (ctrl && event.key === Qt.Key_Right) { root.moveDay(1); return true }
    if (ctrl && event.key === Qt.Key_Down) { root.moveCursor(1); return true }
    if (ctrl && event.key === Qt.Key_Up) { root.moveCursor(-1); return true }
    if (ctrl && event.key === Qt.Key_T) { root.goToToday(); return true }
    if (ctrl && event.key === Qt.Key_D) { root.requestDelete(); return true }
    if (ctrl && event.key === Qt.Key_R) { root.refreshView(); root.refreshCatalogs(true); return true }
    if (ctrl && event.key === Qt.Key_Comma) { root.openSettings(); return true }
    if (ctrl && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter)) { root.stopTracking(); return true }
    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) { root.commit(); return true }
    return false
  }

  Timer {
    interval: root.refreshMinutes * 60 * 1000
    running: root.configured
    repeat: true
    triggeredOnStart: true
    onTriggered: { root.now = new Date(); root.refreshToday() }
  }

  SystemClock {
    precision: SystemClock.Minutes
    onDateChanged: {
      root.now = date
      if (root.opened && root.viewingToday) root.refreshView()
    }
  }

  // ---- The bar button: timer glyph plus today's total, urgent-red while
  //      no entry covers the current time.
  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.vertical || root.todayTotal === 0
      ? "\u{f051b}"
      : "\u{f051b} " + Model.formatClock(root.todayTotal)
    active: root.configured && !root.activeNow
    dimmed: !root.configured
    tooltipText: !root.configured
      ? "mite: set account and apiKey in shell.json"
      : root.activeNow
        ? (root.trackingEntry ? "Tracking since " + trackingSince() : "Booked over the current time")
        : "Nothing booked right now"
    onPressed: root.toggle()
  }

  function trackingSince() {
    if (!root.trackingEntry || !root.trackingEntry.tracking.since) return "?"
    var d = new Date(root.trackingEntry.tracking.since)
    return Model.formatClock(d.getHours() * 60 + d.getMinutes())
  }

  component SettingsLabel: Text {
    textFormat: Text.PlainText
    color: Qt.darker(root.fg, 1.6)
    font.family: root.fontFamily
    font.pixelSize: Style.font.caption
    font.letterSpacing: 1
  }

  // ---- Autocomplete combobox for project/service: a selector, not an open
  //      entry field. The field shows the current selection; focusing drops
  //      the full list, typing fuzzy-filters it, and free text that matches
  //      nothing never books. Tab accepts the highlighted match and moves on.
  component FuzzyField: TextField {
    id: field
    property var items: []
    property var selected: null
    property string emptyLabel: ""
    property int highlight: 0
    // Arrow-navigating the unfiltered list is also a choice, so Tab/Enter
    // must take the highlighted row even with nothing typed.
    property bool navigated: false
    property Item nextField: null
    property Item previousField: null
    readonly property var matches: Model.fuzzyFilter(items, text, function(x) { return x.name }).slice(0, 8)
    readonly property bool listOpen: activeFocus && matches.length > 0

    foreground: root.fg
    accent: Color.accent
    font.family: root.fontFamily
    font.pixelSize: Style.font.body
    rightPadding: Style.space(24)
    placeholderText: selected ? "" : emptyLabel

    onTextChanged: highlight = 0
    onActiveFocusChanged: if (!activeFocus) { navigated = false; highlight = 0 }

    function choice() {
      return (text !== "" || navigated) && matches.length > 0
        ? matches[Math.min(highlight, matches.length - 1)] : null
    }

    function resolved() {
      var hit = choice()
      if (hit) return hit
      if (text !== "") return null
      return selected
    }

    function accept() {
      var hit = choice()
      if (hit) { selected = hit; text = ""; navigated = false }
    }

    Keys.priority: Keys.BeforeItem
    Keys.onPressed: function(event) {
      var plain = !(event.modifiers & Qt.ControlModifier)
      if (listOpen && plain && event.key === Qt.Key_Down) {
        highlight = Math.min(highlight + 1, matches.length - 1); navigated = true; event.accepted = true; return
      }
      if (listOpen && plain && event.key === Qt.Key_Up) {
        highlight = Math.max(highlight - 1, 0); navigated = true; event.accepted = true; return
      }
      if (event.key === Qt.Key_Escape && text !== "") {
        text = ""; navigated = false; event.accepted = true; return
      }
      if (event.key === Qt.Key_Tab) {
        accept()
        if (nextField) nextField.forceActiveFocus()
        event.accepted = true; return
      }
      if (event.key === Qt.Key_Backtab) {
        accept()
        if (previousField) previousField.forceActiveFocus()
        event.accepted = true; return
      }
      if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) {
        // The highlighted match books; keep it selected for next time.
        accept()
      }
      event.accepted = root.handleGlobalKey(event)
    }

    // Current selection, rendered as the field's value while no query is
    // being typed.
    Text {
      visible: field.text === "" && field.selected !== null
      anchors.verticalCenter: parent.verticalCenter
      anchors.left: parent.left
      anchors.leftMargin: field.leftPadding
      anchors.right: parent.right
      anchors.rightMargin: field.rightPadding
      textFormat: Text.PlainText
      elide: Text.ElideRight
      text: field.selected ? field.selected.name : ""
      color: field.activeFocus ? Qt.darker(root.fg, 1.4) : root.fg
      font.family: root.fontFamily
      font.pixelSize: Style.font.body
    }

    Text {
      anchors.verticalCenter: parent.verticalCenter
      anchors.right: parent.right
      anchors.rightMargin: Style.space(8)
      textFormat: Text.PlainText
      text: "\u{f0140}"
      color: Qt.darker(root.fg, 1.9)
      font.family: root.fontFamily
      font.pixelSize: Style.font.bodySmall
    }

    Rectangle {
      visible: field.listOpen
      y: field.height + Style.space(2)
      width: Math.max(field.width, Style.space(240))
      height: listColumn.implicitHeight + Style.space(8)
      z: 100
      radius: Style.cornerRadius
      color: Color.popups.background
      border.width: Style.normalBorderWidth
      border.color: Color.popups.border

      Column {
        id: listColumn
        anchors.fill: parent
        anchors.margins: Style.space(4)

        Repeater {
          model: field.matches

          Rectangle {
            required property var modelData
            required property int index
            width: parent.width
            height: Style.spacing.popupRowHeight
            radius: Style.cornerRadius
            color: index === field.highlight
              ? Style.selectedFillFor(root.fg, Color.accent)
              : "transparent"

            Text {
              anchors.verticalCenter: parent.verticalCenter
              anchors.left: parent.left
              anchors.leftMargin: Style.space(8)
              anchors.right: parent.right
              anchors.rightMargin: Style.space(8)
              textFormat: Text.PlainText
              elide: Text.ElideRight
              text: modelData.name + (modelData.customer_name ? "  ·  " + modelData.customer_name : "")
              color: Color.popups.text
              font.family: root.fontFamily
              font.pixelSize: Style.font.body
            }

            MouseArea {
              anchors.fill: parent
              onClicked: {
                field.highlight = index
                field.navigated = true
                field.accept()
              }
            }
          }
        }
      }
    }
  }

  KeyboardPanel {
    id: panel
    anchorItem: button
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: timeField
    contentWidth: panel.fittedContentWidth(Style.space(440))
    contentHeight: panel.fittedContentHeight(content.implicitHeight, Style.space(680))

    Column {
      id: content
      width: parent.width
      spacing: Style.space(10)

      // ---- Day header. The chevrons exist, but Ctrl+Left/Right is the way.
      Item {
        width: parent.width
        height: dayLabel.implicitHeight + Style.space(4)

        PanelActionButton {
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          iconText: "\u{f0141}"
          tooltipText: "Previous day (Ctrl+Left)"
          foreground: root.fg
          fontFamily: root.fontFamily
          onClicked: root.moveDay(-1)
        }

        Text {
          id: dayLabel
          anchors.centerIn: parent
          textFormat: Text.PlainText
          text: Qt.formatDate(root.viewDate, "dddd, d MMMM") + (root.viewingToday ? "" : "  ·  Ctrl+T today")
          color: root.viewingToday ? root.fg : Qt.darker(root.fg, 1.3)
          font.family: root.fontFamily
          font.pixelSize: Style.font.subtitle
          font.bold: root.viewingToday
        }

        PanelActionButton {
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          iconText: "\u{f0142}"
          tooltipText: "Next day (Ctrl+Right)"
          foreground: root.fg
          fontFamily: root.fontFamily
          onClicked: root.moveDay(1)
        }
      }

      // ---- Settings, in place of the day view while open.
      Column {
        visible: root.settingsOpen
        width: parent.width
        spacing: Style.space(8)

        SettingsLabel { text: "ACCOUNT — https://<account>.mite.de" }

        TextField {
          id: settingsAccount
          width: parent.width
          foreground: root.fg
          accent: Color.accent
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          placeholderText: "account"
          Keys.priority: Keys.BeforeItem
          Keys.onPressed: function(event) { root.handleSettingsKey(event, settingsApiKey, settingsProject) }
        }

        SettingsLabel { text: "API KEY — mite → Account" }

        TextField {
          id: settingsApiKey
          width: parent.width
          foreground: root.fg
          accent: Color.accent
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          password: true
          placeholderText: "api key"
          Keys.priority: Keys.BeforeItem
          Keys.onPressed: function(event) { root.handleSettingsKey(event, settingsProject, settingsAccount) }
        }

        SettingsLabel { text: "DEFAULT PROJECT — after each booking" }

        TextField {
          id: settingsProject
          width: parent.width
          foreground: root.fg
          accent: Color.accent
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          placeholderText: "project name, or empty"
          Keys.priority: Keys.BeforeItem
          Keys.onPressed: function(event) { root.handleSettingsKey(event, settingsAccount, settingsApiKey) }
        }

        SettingsLabel { text: "Enter saves · Esc " + (root.configured ? "cancels" : "closes") }
      }

      // ---- Entry form: time · project · service, then the note. Raised so
      //      the picker dropdowns paint over the rows below.
      Row {
        visible: !root.settingsOpen
        width: parent.width
        spacing: Style.space(6)
        z: 10

        TextField {
          id: timeField
          width: Style.space(96)
          foreground: root.fg
          accent: Color.accent
          font.family: root.fontFamily
          font.pixelSize: Style.font.body
          placeholderText: "930 1215"

          Keys.priority: Keys.BeforeItem
          Keys.onPressed: function(event) {
            if (event.key === Qt.Key_Tab) { projectField.forceActiveFocus(); event.accepted = true; return }
            if (event.key === Qt.Key_Backtab) { noteField.forceActiveFocus(); event.accepted = true; return }
            event.accepted = root.handleGlobalKey(event)
          }
        }

        FuzzyField {
          id: projectField
          width: parent.width - timeField.width - serviceField.width - 2 * parent.spacing
          items: root.projects
          emptyLabel: "project"
          nextField: serviceField
          previousField: timeField
        }

        FuzzyField {
          id: serviceField
          width: Style.space(120)
          items: root.services
          emptyLabel: "service"
          nextField: noteField
          previousField: projectField
        }
      }

      TextField {
        id: noteField
        visible: !root.settingsOpen
        width: parent.width
        foreground: root.fg
        accent: Color.accent
        font.family: root.fontFamily
        font.pixelSize: Style.font.body
        placeholderText: "note — Enter books" + (root.viewingToday ? ", empty time starts the tracker" : "")

        Keys.priority: Keys.BeforeItem
        Keys.onPressed: function(event) {
          if (event.key === Qt.Key_Tab) { timeField.forceActiveFocus(); event.accepted = true; return }
          if (event.key === Qt.Key_Backtab) { serviceField.forceActiveFocus(); event.accepted = true; return }
          event.accepted = root.handleGlobalKey(event)
        }
      }

      // ---- Edit-mode line.
      Text {
        visible: root.editingId !== 0 && !root.settingsOpen
        textFormat: Text.PlainText
        text: "editing entry — Enter saves · Esc cancels"
        color: Color.accent
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
      }

      // ---- Tracker line, only while one runs.
      Row {
        visible: root.trackingEntry !== null && !root.settingsOpen
        spacing: Style.space(8)

        Rectangle {
          width: Style.space(8)
          height: width
          radius: width / 2
          anchors.verticalCenter: parent.verticalCenter
          color: Color.accent
        }

        Text {
          textFormat: Text.PlainText
          text: root.trackingEntry
            ? "tracking " + (root.trackingEntry.project_name || "—") + " since " + root.trackingSince() + "  ·  Ctrl+Enter stops"
            : ""
          color: root.fg
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }

      // ---- Error / hint line.
      Text {
        visible: text !== ""
        width: parent.width
        wrapMode: Text.Wrap
        textFormat: Text.PlainText
        text: root.configured ? root.error : "Set \"account\" and \"apiKey\" on this widget's entry in shell.json"
        color: root.urgent
        font.family: root.fontFamily
        font.pixelSize: Style.font.bodySmall
      }

      PanelSeparator { visible: !root.settingsOpen; width: parent.width; foreground: root.fg }

      // ---- Day timeline. Positioned by the note prefix; overlaps side by
      //      side in urgent; entries without clock times hang below, dimmed.
      Item {
        id: timeline
        visible: !root.settingsOpen
        readonly property int fromMinutes: root.dayLayout.fromMinutes
        readonly property int toMinutes: root.dayLayout.toMinutes
        readonly property real pxPerMinute: Style.spaceReal(36) / 60
        readonly property int labelGutter: Style.space(38)
        width: parent.width
        height: (toMinutes - fromMinutes) * pxPerMinute

        function yFor(minutes) { return (minutes - fromMinutes) * pxPerMinute }

        Repeater {
          model: Math.floor(timeline.toMinutes / 60) - Math.ceil(timeline.fromMinutes / 60) + 1

          Item {
            required property int index
            readonly property int hour: Math.ceil(timeline.fromMinutes / 60) + index
            y: timeline.yFor(hour * 60)
            width: timeline.width
            height: 1

            Text {
              anchors.left: parent.left
              y: -implicitHeight / 2
              textFormat: Text.PlainText
              text: parent.hour
              color: Qt.darker(root.fg, 1.9)
              font.family: root.fontFamily
              font.pixelSize: Style.font.caption
            }

            Rectangle {
              anchors.left: parent.left
              anchors.leftMargin: timeline.labelGutter
              anchors.right: parent.right
              height: Style.spacing.hairline
              color: root.fg
              opacity: 0.08
            }
          }
        }

        // Now-line, only on today and only inside the axis.
        Rectangle {
          visible: root.viewingToday
            && root.nowMinutes >= timeline.fromMinutes && root.nowMinutes <= timeline.toMinutes
          y: timeline.yFor(root.nowMinutes)
          anchors.left: parent.left
          anchors.leftMargin: timeline.labelGutter
          anchors.right: parent.right
          height: Style.spacing.hairline
          color: root.urgent
          opacity: 0.7
        }

        Repeater {
          model: root.dayLayout.slots

          Rectangle {
            required property var modelData
            required property int index
            readonly property bool current: index === root.cursorIndex || root.editingId === modelData.id
            readonly property bool deleting: root.pendingDeleteId === modelData.id
            readonly property real laneWidth: (timeline.width - timeline.labelGutter) / modelData.columns

            x: timeline.labelGutter + modelData.column * laneWidth
            y: timeline.yFor(modelData.start)
            width: laneWidth - (modelData.columns > 1 ? Style.space(2) : 0)
            height: Math.max(Style.space(14), (modelData.end - modelData.start) * timeline.pxPerMinute - 1)
            radius: Style.cornerRadius
            opacity: modelData.timed ? 1 : 0.55
            color: deleting
              ? Util.alpha(root.urgent, 0.3)
              : modelData.overlap
                ? Util.alpha(root.urgent, 0.16)
                : Util.alpha(Color.accent, modelData.tracking ? 0.28 : 0.14)
            border.width: current ? Style.focusBorderWidth : Style.spacing.hairline
            border.color: current
              ? Style.focusStateColor(root.fg, Color.accent)
              : modelData.overlap || modelData.mismatch
                ? root.urgent
                : Util.alpha(root.fg, 0.25)

            Text {
              anchors.fill: parent
              anchors.leftMargin: Style.space(6)
              anchors.rightMargin: Style.space(6)
              verticalAlignment: Text.AlignVCenter
              textFormat: Text.PlainText
              elide: Text.ElideRight
              maximumLineCount: Math.max(1, Math.floor(parent.height / (Style.font.bodySmall + 4)))
              wrapMode: Text.Wrap
              text: (parent.deleting ? "Ctrl+D deletes — " : "")
                + (modelData.timed
                    ? Model.formatClock(modelData.start) + "–" + (modelData.tracking ? "now" : Model.formatClock(modelData.end))
                    : Model.formatClock(modelData.minutes) + " h, no clock time")
                + "  " + modelData.project
                + (modelData.mismatch ? "  ⚠ duration ≠ span" : "")
                + (modelData.label ? "  ·  " + modelData.label : "")
              color: root.fg
              font.family: root.fontFamily
              font.pixelSize: Style.font.bodySmall
            }

            MouseArea {
              anchors.fill: parent
              onClicked: root.startEdit(parent.modelData.id)
            }
          }
        }

        Text {
          visible: root.dayLayout.slots.length === 0
          anchors.centerIn: parent
          textFormat: Text.PlainText
          text: "no entries"
          color: Qt.darker(root.fg, 1.7)
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
        }
      }

      // ---- Footer: the day's total, the chord cheat-sheet, and the way
      //      into the settings — deliberately quiet.
      Item {
        visible: !root.settingsOpen
        width: parent.width
        height: Math.max(totalText.implicitHeight, settingsButton.height)

        Text {
          textFormat: Text.PlainText
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          text: "Ctrl+←/→ day · Ctrl+↓/↑ select · Ctrl+D delete ×2"
          color: Qt.darker(root.fg, 1.9)
          font.family: root.fontFamily
          font.pixelSize: Style.font.caption
        }

        Text {
          id: totalText
          textFormat: Text.PlainText
          anchors.right: settingsButton.left
          anchors.rightMargin: Style.space(6)
          anchors.verticalCenter: parent.verticalCenter
          text: Model.formatClock(Model.totalMinutes(root.viewEntries)) + " h"
          color: root.fg
          font.family: root.fontFamily
          font.pixelSize: Style.font.bodySmall
          font.bold: true
        }

        PanelActionButton {
          id: settingsButton
          anchors.right: parent.right
          anchors.rightMargin: -Style.space(6)
          anchors.verticalCenter: parent.verticalCenter
          iconText: "\u{f0493}"
          tooltipText: "Settings (Ctrl+,)"
          foreground: Qt.darker(root.fg, 1.9)
          fontFamily: root.fontFamily
          onClicked: root.openSettings()
        }
      }
    }
  }
}
