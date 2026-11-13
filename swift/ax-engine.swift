// The resident accessibility engine behind hackamore: one JSON request per stdin line, one JSON reply per stdout
// line, no model in the loop. A resident copy (the Ouro Reins Agent, src/ax.mjs) answers in milliseconds, not a launch.
//   swiftc -O ax-engine.swift -o ax-engine && printf '{"id":1,"op":"trust"}\n' | ./ax-engine
// Ops: trust, apps, front, tree, menus, perform, set, focus, raise, key, type, click, scroll, open, windows, ocr.
// Elements are addressed by raw index paths ("w0.3.5": window 0, child 3, child 5; "m2.4": menu 2, item 4) that the
// caller resolves fresh from a tree it just read; stable role+label addresses live in src/ax.mjs.
// Permissions: Accessibility for tree/perform/set/key/type/click/scroll (macOS attributes it to the process that
// launched us: a shell's node, or the Ouro Reins Agent app). It never asks: AXIsProcessTrusted() without the prompt option, so no dialog appears on
// a screen nobody is at (request-trust, the one exception, runs only when a person at the Mac asks for it). ocr and
// windows need no permission.
import AppKit
import ApplicationServices
import Foundation
import Vision

setvbuf(stdout, nil, _IOLBF, 0)

func reply(_ o: [String: Any]) {
  guard let d = try? JSONSerialization.data(withJSONObject: o, options: []), var s = String(data: d, encoding: .utf8) else {
    print("{\"ok\":false,\"error\":\"unencodable reply\"}")
    return
  }
  s = s.replacingOccurrences(of: "\n", with: "\\n")
  print(s)
}

// ---------- reading ----------

let readAttrs = ["AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXValue", "AXIdentifier", "AXEnabled", "AXFocused",
                 "AXPosition", "AXSize", "AXChildren", "AXHelp", "AXPlaceholderValue", "AXSelected"] as [CFString]

func copyMany(_ el: AXUIElement) -> [String: Any] {
  var out: [String: Any] = [:]
  var vals: CFArray?
  guard AXUIElementCopyMultipleAttributeValues(el, readAttrs as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &vals) == .success,
        let arr = vals as? [AnyObject] else { return out }
  for (i, name) in readAttrs.enumerated() where i < arr.count {
    let v = arr[i]
    if CFGetTypeID(v) == AXValueGetTypeID() {
      let ax = v as! AXValue
      switch AXValueGetType(ax) {
      case .cgPoint: var p = CGPoint.zero; AXValueGetValue(ax, .cgPoint, &p); out[name as String] = p
      case .cgSize: var s = CGSize.zero; AXValueGetValue(ax, .cgSize, &s); out[name as String] = s
      case .axError: continue
      default: continue
      }
    } else {
      out[name as String] = v
    }
  }
  return out
}

func str(_ v: Any?, max: Int = 200) -> String? {
  guard let v = v else { return nil }
  var s: String?
  if let x = v as? String { s = x }
  else if let x = v as? NSAttributedString { s = x.string }
  else if let x = v as? NSNumber { s = CFGetTypeID(x) == CFBooleanGetTypeID() ? (x.boolValue ? "true" : "false") : x.stringValue }
  else if let x = v as? URL { s = x.absoluteString }
  guard var t = s else { return nil }
  t = t.trimmingCharacters(in: .whitespacesAndNewlines)
  if t.isEmpty { return nil }
  return t.count > max ? String(t.prefix(max)) + "…" : t
}

func bool(_ v: Any?) -> Bool? { (v as? NSNumber).map { $0.boolValue } }

func actions(_ el: AXUIElement) -> [String] {
  var names: CFArray?
  guard AXUIElementCopyActionNames(el, &names) == .success, let a = names as? [String] else { return [] }
  return a.filter { !$0.hasPrefix("AXScrollTo") && $0 != "AXShowDefaultUI" && $0 != "AXShowAlternateUI" }
}

func settable(_ el: AXUIElement, _ attr: String = "AXValue") -> Bool {
  var b: DarwinBoolean = false
  return AXUIElementIsAttributeSettable(el, attr as CFString, &b) == .success && b.boolValue
}

struct Budget { var nodes: Int; let deadline: Date; var truncated = false }

// What makes a read fast (2026-11-08: Finder's Recents took 1.5 s for 1,200 nodes): tables and outlines give only
// their visible rows (path segment "v<i>": an index into AXVisibleRows), anything clipped out of its scroll area is
// read but not descended, and plain text and cells skip the action-name call (one IPC fewer per node).
let noActions: Set<String> = ["AXStaticText", "AXCell", "AXColumn", "AXHeading", "AXLayoutItem", "AXUnknown"]
let visibleRowRoles: Set<String> = ["AXTable", "AXOutline"]
let scrollRoles: Set<String> = ["AXScrollArea", "AXTable", "AXOutline", "AXList", "AXBrowser", "AXCollection", "AXWebArea"]

func node(_ el: AXUIElement, path: String, depth: Int, maxDepth: Int, maxChildren: Int, budget: inout Budget, clip: CGRect? = nil) -> [String: Any] {
  budget.nodes -= 1
  let a = copyMany(el)
  var n: [String: Any] = ["p": path]
  if let r = a["AXRole"] as? String { n["role"] = r }
  if let r = a["AXSubrole"] as? String { n["subrole"] = r }
  if let t = str(a["AXTitle"]) { n["title"] = t }
  if let t = str(a["AXDescription"]) { n["desc"] = t }
  if let t = str(a["AXHelp"], max: 120) { n["help"] = t }
  if let t = str(a["AXPlaceholderValue"], max: 80) { n["placeholder"] = t }
  if let t = str(a["AXIdentifier"], max: 80) { n["ident"] = t }
  let role = n["role"] as? String ?? ""
  if role != "AXSecureTextField", let v = str(a["AXValue"], max: 300) { n["value"] = v }
  if role == "AXSecureTextField" { n["secure"] = true }
  if let e = bool(a["AXEnabled"]) { n["enabled"] = e }
  if let f = bool(a["AXFocused"]), f { n["focused"] = true }
  if let s = bool(a["AXSelected"]), s { n["selected"] = true }
  var rect: CGRect? = nil
  if let p = a["AXPosition"] as? CGPoint, let s = a["AXSize"] as? CGSize {
    n["frame"] = [Int(p.x.rounded()), Int(p.y.rounded()), Int(s.width.rounded()), Int(s.height.rounded())]
    rect = CGRect(origin: p, size: s)
  }
  if let r = rect, let c = clip, r.width > 0, r.height > 0, !r.intersects(c) {
    n["clipped"] = true
    return n
  }
  if !noActions.contains(role) {
    let acts = actions(el)
    if !acts.isEmpty { n["actions"] = acts }
  }
  if ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSlider", "AXCheckBox", "AXSecureTextField"].contains(role) || n["subrole"] as? String == "AXSearchField" {
    if settable(el) { n["settable"] = true }
  }
  if depth < maxDepth {
    var kids: [AXUIElement] = []
    var prefix = ""
    var total = 0
    if visibleRowRoles.contains(role) {
      var v: CFTypeRef?
      if AXUIElementCopyAttributeValue(el, "AXVisibleRows" as CFString, &v) == .success, let rows = v as? [AXUIElement] {
        kids = rows; prefix = "v"
        var cnt: CFIndex = 0
        if AXUIElementGetAttributeValueCount(el, "AXRows" as CFString, &cnt) == .success { total = cnt }
      }
    }
    if prefix.isEmpty, let k = a["AXChildren"] as? [AXUIElement] { kids = k; total = k.count }
    let nextClip: CGRect? = scrollRoles.contains(role) ? (rect.map { r in clip.map { $0.intersection(r) } ?? r }) : clip
    var out: [[String: Any]] = []
    for (i, k) in kids.prefix(maxChildren).enumerated() {
      if budget.nodes <= 0 || Date() > budget.deadline { budget.truncated = true; break }
      out.append(node(k, path: "\(path).\(prefix)\(i)", depth: depth + 1, maxDepth: maxDepth, maxChildren: maxChildren, budget: &budget, clip: nextClip))
    }
    if kids.count > maxChildren { n["more"] = kids.count - maxChildren; budget.truncated = true }
    if !prefix.isEmpty && total > kids.count { n["rows"] = total; n["visible_rows"] = kids.count }
    if !out.isEmpty { n["children"] = out }
  }
  return n
}

func appElement(_ pid: pid_t) -> AXUIElement {
  let app = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(app, 1.5)
  return app
}

func windows(of app: AXUIElement) -> [AXUIElement] {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(app, "AXWindows" as CFString, &v) == .success, let w = v as? [AXUIElement] else { return [] }
  return w
}

func child(_ el: AXUIElement, _ attr: String) -> AXUIElement? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success, let x = v, CFGetTypeID(x) == AXUIElementGetTypeID() else { return nil }
  return (x as! AXUIElement)
}

func children(_ el: AXUIElement) -> [AXUIElement] {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, "AXChildren" as CFString, &v) == .success, let k = v as? [AXUIElement] else { return [] }
  return k
}

// "w0.3.5" → windows[0].children[3].children[5]; "m2.4" → menu bar item 2 → its menu → item 4 (and "m2.4.1" goes on
// into item 4's submenu).
func resolve(pid: pid_t, path: String) -> AXUIElement? {
  let app = appElement(pid)
  var parts = path.split(separator: ".").map(String.init)
  guard let head = parts.first, let i = Int(head.dropFirst()) else { return nil }
  parts.removeFirst()
  if head.hasPrefix("w") {
    let ws = windows(of: app)
    guard i < ws.count else { return nil }
    var el = ws[i]
    for p in parts {
      var k: [AXUIElement]
      var idx = p
      if p.hasPrefix("v") {
        idx = String(p.dropFirst())
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, "AXVisibleRows" as CFString, &v) == .success, let rows = v as? [AXUIElement] else { return nil }
        k = rows
      } else { k = children(el) }
      guard let j = Int(idx), j < k.count else { return nil }
      el = k[j]
    }
    return el
  }
  // x<i>[.<j>…]: a menu-bar app's status item (AXExtrasMenuBar), then children: how OneDrive and other
  // menu-bar apps are reached without the pointer (first-use #13).
  if head.hasPrefix("x") {
    guard let bar = child(app, "AXExtrasMenuBar") else { return nil }
    var el: AXUIElement? = children(bar).indices.contains(i) ? children(bar)[i] : nil
    for p in parts {
      guard let cur = el, let j = Int(p) else { return nil }
      let k = children(cur)
      el = k.indices.contains(j) ? k[j] : nil
    }
    return el
  }
  if head.hasPrefix("m") {
    guard let bar = child(app, "AXMenuBar") else { return nil }
    let top = children(bar)
    guard i < top.count else { return nil }
    var el = top[i]
    for p in parts {
      guard let j = Int(p), let menu = children(el).first else { return nil }
      let items = children(menu)
      guard j < items.count else { return nil }
      el = items[j]
    }
    return el
  }
  return nil
}

func role(_ el: AXUIElement) throws -> String? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, "AXRole" as CFString, &v) == .success else { return nil }
  return v as? String
}

func menus(pid: pid_t, depth: Int) -> [[String: Any]] {
  let app = appElement(pid)
  guard let bar = child(app, "AXMenuBar") else { return [] }
  var out: [[String: Any]] = []
  for (i, item) in children(bar).enumerated() {
    let a = copyMany(item)
    guard let t = str(a["AXTitle"]) else { continue }
    var m: [String: Any] = ["p": "m\(i)", "title": t]
    if depth > 0, let menu = children(item).first {
      var items: [[String: Any]] = []
      for (j, mi) in children(menu).enumerated() {
        let b = copyMany(mi)
        guard let mt = str(b["AXTitle"]) else { continue }
        var x: [String: Any] = ["p": "m\(i).\(j)", "title": mt]
        if let e = bool(b["AXEnabled"]) { x["enabled"] = e }
        if !children(mi).isEmpty { x["submenu"] = true }
        items.append(x)
      }
      m["items"] = items
    }
    out.append(m)
  }
  return out
}

// ---------- input events ----------

let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
  "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
  "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "return": 36, "enter": 36, "l": 37, "j": 38,
  "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
  "delete": 51, "backspace": 51, "escape": 53, "esc": 53, "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101,
  "f11": 103, "f10": 109, "f12": 111, "home": 115, "pageup": 116, "forwarddelete": 117, "f4": 118, "end": 119,
  "f2": 120, "pagedown": 121, "f1": 122, "left": 123, "right": 124, "down": 125, "up": 126,
]

func parseCombo(_ combo: String) -> (CGKeyCode, CGEventFlags)? {
  var flags: CGEventFlags = []
  var key: CGKeyCode?
  for raw in combo.lowercased().split(separator: "+").map({ String($0).trimmingCharacters(in: .whitespaces) }) {
    switch raw {
    case "cmd", "command": flags.insert(.maskCommand)
    case "shift": flags.insert(.maskShift)
    case "alt", "option", "opt": flags.insert(.maskAlternate)
    case "ctrl", "control": flags.insert(.maskControl)
    case "fn": flags.insert(.maskSecondaryFn)
    default: key = keyCodes[raw]
    }
  }
  guard let k = key else { return nil }
  return (k, flags)
}

func post(_ e: CGEvent?, pid: pid_t?) {
  guard let e = e else { return }
  if let p = pid, p > 0 { e.postToPid(p) } else { e.post(tap: .cghidEventTap) }
}

func pressKey(_ combo: String, pid: pid_t?) -> Bool {
  guard let (k, f) = parseCombo(combo) else { return false }
  let src = CGEventSource(stateID: .hidSystemState)
  let down = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: true); down?.flags = f
  let up = CGEvent(keyboardEventSource: src, virtualKey: k, keyDown: false); up?.flags = f
  post(down, pid: pid); usleep(8000); post(up, pid: pid)
  return true
}

func typeText(_ text: String, pid: pid_t?) {
  let src = CGEventSource(stateID: .hidSystemState)
  let units = Array(text.utf16)
  var i = 0
  while i < units.count {
    let chunk = Array(units[i..<min(i + 16, units.count)])
    let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
    down?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
    let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
    up?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
    post(down, pid: pid); usleep(4000); post(up, pid: pid); usleep(4000)
    i += 16
  }
}

func click(x: Double, y: Double, count: Int, right: Bool) {
  let p = CGPoint(x: x, y: y)
  let src = CGEventSource(stateID: .hidSystemState)
  let (dt, ut, b): (CGEventType, CGEventType, CGMouseButton) = right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
  CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: b)?.post(tap: .cghidEventTap)
  usleep(15000)
  for n in 1...max(1, min(3, count)) {
    let d = CGEvent(mouseEventSource: src, mouseType: dt, mouseCursorPosition: p, mouseButton: b)
    d?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
    let u = CGEvent(mouseEventSource: src, mouseType: ut, mouseCursorPosition: p, mouseButton: b)
    u?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
    d?.post(tap: .cghidEventTap); usleep(12000); u?.post(tap: .cghidEventTap); usleep(12000)
  }
}

func scroll(x: Double, y: Double, dy: Int32, dx: Int32) {
  let src = CGEventSource(stateID: .hidSystemState)
  let p = CGPoint(x: x, y: y)
  CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
  usleep(10000)
  let e = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
  e?.location = p
  e?.post(tap: .cghidEventTap)
}

// ---------- apps, windows, OCR ----------

func appInfo(_ a: NSRunningApplication) -> [String: Any] {
  var o: [String: Any] = ["pid": Int(a.processIdentifier), "name": a.localizedName ?? "?", "active": a.isActive, "hidden": a.isHidden]
  if let b = a.bundleIdentifier { o["bundle"] = b }
  if let u = a.bundleURL?.path { o["path"] = u }
  return o
}

func frontPid() -> pid_t? {
  if let f = NSWorkspace.shared.frontmostApplication { return f.processIdentifier }
  return nil
}

func windowList() -> [[String: Any]] {
  guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
  return info.compactMap { w in
    let b = w[kCGWindowBounds as String] as? [String: Any] ?? [:]
    let layer = w[kCGWindowLayer as String] as? Int ?? 0
    guard let owner = w[kCGWindowOwnerName as String] as? String else { return nil }
    var o: [String: Any] = ["layer": layer, "owner": owner, "pid": w[kCGWindowOwnerPID as String] as? Int ?? 0,
                            "frame": [b["X"] as? Int ?? 0, b["Y"] as? Int ?? 0, b["Width"] as? Int ?? 0, b["Height"] as? Int ?? 0]]
    if let t = w[kCGWindowName as String] as? String, !t.isEmpty { o["title"] = t }
    return o
  }
}

func ocr(file: String, fast: Bool) -> [String: Any] {
  guard let img = NSImage(contentsOfFile: file), let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
    return ["ok": false, "error": "cannot read image \(file)"]
  }
  let W = Double(cg.width), H = Double(cg.height)
  let req = VNRecognizeTextRequest()
  req.recognitionLevel = fast ? .fast : .accurate
  req.usesLanguageCorrection = false
  do { try VNImageRequestHandler(cgImage: cg, options: [:]).perform([req]) } catch { return ["ok": false, "error": "vision: \(error)"] }
  var lines: [[String: Any]] = []
  for obs in req.results ?? [] {
    guard let c = obs.topCandidates(1).first else { continue }
    let bb = obs.boundingBox
    lines.append(["text": c.string, "conf": Double(Int(c.confidence * 100)) / 100,
                  "box": [Int(bb.minX * W), Int((1 - bb.maxY) * H), Int(bb.width * W), Int(bb.height * H)]])
  }
  return ["ok": true, "width": Int(W), "height": Int(H), "lines": lines]
}

func screens() -> [[String: Any]] {
  NSScreen.screens.map { s in
    ["frame": [Int(s.frame.minX), Int(s.frame.minY), Int(s.frame.width), Int(s.frame.height)], "scale": Double(s.backingScaleFactor)]
  }
}

// ---------- requests ----------

func pidArg(_ r: [String: Any]) -> pid_t? {
  if let p = r["pid"] as? Int { return pid_t(p) }
  return frontPid()
}

func handle(_ r: [String: Any]) -> [String: Any] {
  let op = r["op"] as? String ?? ""
  let trusted = AXIsProcessTrusted()
  let needsAX: Set<String> = ["appwindows", "tree", "menus", "extras", "perform", "set", "focus", "raise", "key", "type", "click", "scroll", "sysfocus"]
  if needsAX.contains(op) && !trusted {
    return ["ok": false, "error": "not-trusted", "message": "this process has no Accessibility permission"]
  }
  switch op {
  case "request-trust":
    // Only for `hackamore agent grant --person-here`: shows macOS's own "would like to control this computer" dialog
    // so the person at the Mac can turn Accessibility on. Never called otherwise (no prompt on an empty screen).
    let opts = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
    let ax = AXIsProcessTrustedWithOptions(opts)
    var sc = CGPreflightScreenCaptureAccess()
    if r["screen"] as? Bool == true && !sc { sc = CGRequestScreenCaptureAccess() }
    return ["ok": true, "ax": ax, "screen_capture": sc]
  case "trust":
    return ["ok": true, "ax": trusted, "screen_capture": CGPreflightScreenCaptureAccess(), "screens": screens(), "pid": Int(getpid())]
  case "idle":
    // The gate's two facts, in-process (gate.mjs reads the same from ioreg in two spawns): seconds since the last
    // input event of any kind, and whether the console session is unlocked and logged in.
    let idle = CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: CGEventType(rawValue: ~0)!)
    var locked = true, why = "no console session (login window or FileVault)", user: Any = NSNull()
    if let d = CGSessionCopyCurrentDictionary() as? [String: Any] {
      let onConsole = (d[kCGSessionOnConsoleKey as String] as? Bool) ?? false
      let done = (d[kCGSessionLoginDoneKey as String] as? Bool) ?? false
      let scr = (d["CGSSessionScreenIsLocked"] as? Bool) ?? false
      user = d[kCGSessionUserNameKey as String] ?? NSNull()
      if !onConsole { why = "no session on the console" } else if scr { why = "screen locked" } else if !done { why = "login not finished" } else { locked = false; why = "unlocked" }
    }
    return ["ok": true, "idle": Int(idle), "idle_ms": Int(idle * 1000), "locked": locked, "why": why, "user": user, "now": Int(Date().timeIntervalSince1970)]
  case "apps":
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.map(appInfo)
    return ["ok": true, "apps": apps, "front": NSWorkspace.shared.frontmostApplication.map(appInfo) ?? NSNull()]
  case "sysfocus":
    // Where the keyboard's focus is across every process: the system-wide focused element, which reaches fields an
    // app draws in another process (an authentication sheet's password field). Role, subrole and owning pid only.
    let sys = AXUIElementCreateSystemWide()
    guard let f = child(sys, "AXFocusedUIElement") else { return ["ok": true, "focused": NSNull()] }
    var pid: pid_t = 0
    AXUIElementGetPid(f, &pid)
    var o: [String: Any] = ["pid": Int(pid)]
    if let r = try? role(f) { o["role"] = r }
    var v: CFTypeRef?
    if AXUIElementCopyAttributeValue(f, "AXSubrole" as CFString, &v) == .success, let sr = v as? String { o["subrole"] = sr }
    if let a = NSRunningApplication(processIdentifier: pid) { o["app"] = a.localizedName ?? NSNull(); o["bundle"] = a.bundleIdentifier ?? NSNull() }
    return ["ok": true, "focused": o]
  case "front":
    return ["ok": true, "front": NSWorkspace.shared.frontmostApplication.map(appInfo) ?? NSNull()]
  case "windows":
    return ["ok": true, "windows": windowList()]
  case "appwindows":
    // One app's windows as the restart tool needs them back: title, frame in screen points, full screen, minimized.
    guard let pid = r["pid"] as? Int else { return ["ok": false, "error": "no-app"] }
    var out: [[String: Any]] = []
    for (i, w) in windows(of: appElement(pid_t(pid))).enumerated() {
      var x: [String: Any] = ["index": i]
      var v: CFTypeRef?
      if AXUIElementCopyAttributeValue(w, "AXTitle" as CFString, &v) == .success, let t = v as? String { x["title"] = t }
      var pv: CFTypeRef?, sv: CFTypeRef?
      var pt = CGPoint.zero, sz = CGSize.zero
      if AXUIElementCopyAttributeValue(w, "AXPosition" as CFString, &pv) == .success, let a = pv, CFGetTypeID(a) == AXValueGetTypeID() { AXValueGetValue(a as! AXValue, .cgPoint, &pt) }
      if AXUIElementCopyAttributeValue(w, "AXSize" as CFString, &sv) == .success, let a = sv, CFGetTypeID(a) == AXValueGetTypeID() { AXValueGetValue(a as! AXValue, .cgSize, &sz) }
      x["frame"] = [Int(pt.x.rounded()), Int(pt.y.rounded()), Int(sz.width.rounded()), Int(sz.height.rounded())]
      var f: CFTypeRef?
      x["fullscreen"] = AXUIElementCopyAttributeValue(w, "AXFullScreen" as CFString, &f) == .success && (f as? Bool ?? false)
      var m: CFTypeRef?
      x["minimized"] = AXUIElementCopyAttributeValue(w, "AXMinimized" as CFString, &m) == .success && (m as? Bool ?? false)
      out.append(x)
    }
    return ["ok": true, "windows": out]
  case "tree":
    guard let pid = pidArg(r) else { return ["ok": false, "error": "no-app"] }
    let app = appElement(pid)
    // Electron apps build their tree only when asked; harmless for everything else.
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    let maxDepth = r["maxDepth"] as? Int ?? 30
    let maxChildren = r["maxChildren"] as? Int ?? 80
    var budget = Budget(nodes: r["maxNodes"] as? Int ?? 2500, deadline: Date().addingTimeInterval((r["budgetMs"] as? Double ?? 1500) / 1000))
    let t0 = Date()
    var ws: [[String: Any]] = []
    let all = windows(of: app)
    for (i, w) in all.enumerated() {
      // the front window in full; the others only their own controls (title, close), so a busy app stays fast
      ws.append(node(w, path: "w\(i)", depth: 0, maxDepth: i == 0 || r["allWindows"] as? Bool == true ? maxDepth : 1, maxChildren: maxChildren, budget: &budget))
      if budget.nodes <= 0 { budget.truncated = true; break }
    }
    var focusedPath: String? = nil
    if let f = child(app, "AXFocusedUIElement"), let fr = try? role(f) { focusedPath = fr }
    var o: [String: Any] = ["ok": true, "pid": Int(pid), "windows": ws, "truncated": budget.truncated, "ms": Int(Date().timeIntervalSince(t0) * 1000)]
    if let f = focusedPath { o["focused_role"] = f }
    if r["menus"] as? Bool == true { o["menus"] = menus(pid: pid, depth: r["menuDepth"] as? Int ?? 1) }
    return o
  case "extras":
    // The status items of a menu-bar app, and the menu each opens when it is open: { p, title, desc, items }.
    guard let pid = r["pid"] as? Int else { return ["ok": false, "error": "no-app"] }
    guard let bar = child(appElement(pid_t(pid)), "AXExtrasMenuBar") else { return ["ok": true, "extras": []] }
    var out: [[String: Any]] = []
    for (i, item) in children(bar).enumerated() {
      let a = copyMany(item)
      var x: [String: Any] = ["p": "x\(i)"]
      if let t = str(a["AXTitle"]) { x["title"] = t }
      if let d = str(a["AXDescription"]) { x["desc"] = d }
      if let p = a["AXPosition"] as? CGPoint, let z = a["AXSize"] as? CGSize { x["frame"] = [Int(p.x.rounded()), Int(p.y.rounded()), Int(z.width.rounded()), Int(z.height.rounded())] }
      out.append(x)
    }
    return ["ok": true, "extras": out]
  case "menus":
    guard let pid = pidArg(r) else { return ["ok": false, "error": "no-app"] }
    return ["ok": true, "menus": menus(pid: pid, depth: r["depth"] as? Int ?? 1)]
  case "perform":
    guard let pid = pidArg(r), let p = r["path"] as? String, let el = resolve(pid: pid, path: p) else { return ["ok": false, "error": "no-element"] }
    let action = r["action"] as? String ?? "AXPress"
    let e = AXUIElementPerformAction(el, action as CFString)
    return e == .success ? ["ok": true] : ["ok": false, "error": "ax-\(e.rawValue)", "message": "\(action) failed (AXError \(e.rawValue))"]
  case "set":
    guard let pid = pidArg(r), let p = r["path"] as? String, let el = resolve(pid: pid, path: p) else { return ["ok": false, "error": "no-element"] }
    let attr = r["attr"] as? String ?? "AXValue"
    var v: CFTypeRef = (r["value"] as? String ?? "") as CFString
    if let b = r["value"] as? Bool { v = (b ? kCFBooleanTrue : kCFBooleanFalse) as CFTypeRef }
    if let n = r["value"] as? Double, !(r["value"] is Bool) { v = NSNumber(value: n) }
    // A window's place and size: {"x","y"} is a point (AXPosition), {"w","h"} a size (AXSize), in screen points.
    if let d = r["value"] as? [String: Any] {
      if let x = d["x"] as? Double, let y = d["y"] as? Double { var pt = CGPoint(x: x, y: y); if let av = AXValueCreate(.cgPoint, &pt) { v = av } }
      else if let w = d["w"] as? Double, let h = d["h"] as? Double { var sz = CGSize(width: w, height: h); if let av = AXValueCreate(.cgSize, &sz) { v = av } }
      else { return ["ok": false, "error": "bad-value", "message": "a dictionary value is {x,y} or {w,h}"] }
    }
    let e = AXUIElementSetAttributeValue(el, attr as CFString, v)
    return e == .success ? ["ok": true] : ["ok": false, "error": "ax-\(e.rawValue)", "message": "setting \(attr) failed (AXError \(e.rawValue))"]
  case "focus":
    guard let pid = pidArg(r), let p = r["path"] as? String, let el = resolve(pid: pid, path: p) else { return ["ok": false, "error": "no-element"] }
    let e = AXUIElementSetAttributeValue(el, "AXFocused" as CFString, kCFBooleanTrue)
    return e == .success ? ["ok": true] : ["ok": false, "error": "ax-\(e.rawValue)"]
  case "raise":
    guard let pid = r["pid"] as? Int else { return ["ok": false, "error": "no-app"] }
    let app = appElement(pid_t(pid))
    NSRunningApplication(processIdentifier: pid_t(pid))?.activate(options: [])
    let e = AXUIElementSetAttributeValue(app, "AXFrontmost" as CFString, kCFBooleanTrue)
    if let w = r["window"] as? Int { let ws = windows(of: app); if w < ws.count { AXUIElementPerformAction(ws[w], "AXRaise" as CFString) } }
    return ["ok": e == .success || NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(pid)]
  case "key":
    guard let combo = r["combo"] as? String else { return ["ok": false, "error": "no-combo"] }
    return pressKey(combo, pid: (r["pid"] as? Int).map { pid_t($0) }) ? ["ok": true] : ["ok": false, "error": "bad-combo", "message": "unknown key in \(combo)"]
  case "type":
    typeText(r["text"] as? String ?? "", pid: (r["pid"] as? Int).map { pid_t($0) })
    return ["ok": true]
  case "click":
    click(x: r["x"] as? Double ?? 0, y: r["y"] as? Double ?? 0, count: r["count"] as? Int ?? 1, right: r["button"] as? String == "right")
    return ["ok": true]
  case "scroll":
    scroll(x: r["x"] as? Double ?? 0, y: r["y"] as? Double ?? 0, dy: Int32(r["dy"] as? Int ?? 0), dx: Int32(r["dx"] as? Int ?? 0))
    return ["ok": true]
  case "open":
    guard let p = r["path"] as? String else { return ["ok": false, "error": "no-path"] }
    let cfg = NSWorkspace.OpenConfiguration(); cfg.activates = r["activate"] as? Bool ?? true
    let done = DispatchSemaphore(value: 0)
    var err: String? = nil
    var pid: Int? = nil
    NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: p), configuration: cfg) { app, e in
      err = e?.localizedDescription; pid = app.map { Int($0.processIdentifier) }; done.signal()
    }
    // the completion handler runs on a background queue, so waiting here on main is safe
    _ = done.wait(timeout: .now() + 8)
    return err == nil ? ["ok": true, "pid": pid ?? NSNull()] : ["ok": false, "error": "open-failed", "message": err!]
  case "ocr":
    guard let f = r["file"] as? String else { return ["ok": false, "error": "no-file"] }
    return ocr(file: f, fast: r["fast"] as? Bool ?? false)
  default:
    return ["ok": false, "error": "unknown-op", "message": "unknown op \(op)"]
  }
}

// Vision's accurate recognizer calls back onto the main queue, so OCR on the main queue deadlocks (2026-11-08: it
// hung for minutes). OCR touches no app state, so it runs on the thread that read the request.
let pendingOCR = DispatchGroup()
func offMain(_ line: String) -> Bool { line.contains("\"op\":\"ocr\"") }

func respond(_ line: String) -> String {
  let isOCR = offMain(line)
  if isOCR { pendingOCR.enter() }
  defer { if isOCR { pendingOCR.leave() } }
  guard let d = line.data(using: .utf8), let r = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
    return "{\"ok\":false,\"error\":\"bad-request\"}"
  }
  var o = handle(r)
  if let id = r["id"] { o["id"] = id }
  guard let out = try? JSONSerialization.data(withJSONObject: o, options: []), let s = String(data: out, encoding: .utf8) else {
    return "{\"ok\":false,\"error\":\"unencodable reply\"}"
  }
  return s.replacingOccurrences(of: "\n", with: "\\n")
}

// --socket <path>: serve the same lines on a Unix socket (mode 0600), as the resident Ouro Reins Agent run by its
// own LaunchAgent, so macOS attributes Accessibility to this signed app and not to whatever started it.
// Otherwise: stdin/stdout, as a child of the process that started it.
let args = CommandLine.arguments
if let i = args.firstIndex(of: "--socket"), i + 1 < args.count {
  let path = args[i + 1]
  unlink(path)
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8CString)
  guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else { FileHandle.standardError.write("socket path too long\n".data(using: .utf8)!); exit(2) }
  withUnsafeMutableBytes(of: &addr.sun_path) { p in for (k, b) in bytes.enumerated() { p[k] = UInt8(bitPattern: b) } }
  let len = socklen_t(MemoryLayout<sockaddr_un>.size)
  let ok = withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) } }
  guard ok == 0, listen(fd, 16) == 0 else { FileHandle.standardError.write("bind/listen failed: \(errno)\n".data(using: .utf8)!); exit(2) }
  chmod(path, 0o600)
  Thread.detachNewThread {
    while true {
      let c = accept(fd, nil, nil)
      if c < 0 { continue }
      Thread.detachNewThread {
        let h = FileHandle(fileDescriptor: c, closeOnDealloc: true)
        var buf = Data()
        while true {
          let chunk = h.availableData
          if chunk.isEmpty { break }
          buf.append(chunk)
          while let nl = buf.firstIndex(of: 0x0A) {
            let lineData = buf.subdata(in: buf.startIndex..<nl)
            buf.removeSubrange(buf.startIndex...nl)
            guard let line = String(data: lineData, encoding: .utf8), !line.isEmpty else { continue }
            // requests from every connection run one at a time on the main queue, except OCR (offMain)
            let out = offMain(line) ? respond(line) : DispatchQueue.main.sync { respond(line) }
            h.write((out + "\n").data(using: .utf8)!)
          }
        }
      }
    }
  }
} else {
  Thread.detachNewThread {
    let outQ = DispatchQueue(label: "out")
    while let line = readLine(strippingNewline: true) {
      if line.isEmpty { continue }
      if offMain(line) { DispatchQueue.global().async { let o = respond(line); outQ.sync { print(o) } } }
      else { DispatchQueue.main.async { let o = respond(line); outQ.sync { print(o) } } }
    }
    // pending OCR finishes before we leave
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { pendingOCR.wait(); exit(0) }
  }
}
RunLoop.main.run()
