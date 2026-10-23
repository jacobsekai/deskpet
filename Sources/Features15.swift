import AppKit
import EventKit

// DeskPet 1.5: agent summaries, quiet hours, playdates, seasonal events, calendar heads-up, and the sprite
// pack gallery. Same behavior as the Windows/Linux app; see docs/v1.5-features.md.

// MARK: - "What did the agent just do?"

enum AgentSummary {
    /// The newest assistant text in a Claude transcript or Codex rollout log.
    static func lastText(path: String, codex: Bool) -> String? {
        guard !path.isEmpty else { return nil }
        for r in tailRecords(path, bytes: 512 * 1024) {
            if codex {
                let payload = r["payload"] as? [String: Any] ?? [:]
                let type = r["type"] as? String, sub = payload["type"] as? String
                if type == "event_msg", sub == "agent_message", let text = payload["message"] as? String, !text.isEmpty { return text }
                if type == "response_item", sub == "message", payload["role"] as? String == "assistant" {
                    let text = (payload["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined(separator: " ")
                    if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
                }
            } else if r["type"] as? String == "assistant" {
                let content = (r["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
                let text = content.filter { $0["type"] as? String == "text" }.compactMap { $0["text"] as? String }.joined(separator: " ")
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return text }
            }
        }
        return nil
    }

    /// Markdown stripped, first sentence, at most 90 characters.
    static func summarize(_ raw: String) -> String? {
        var s = raw
        func replace(_ pattern: String, _ with: String, _ options: NSRegularExpression.Options = []) {
            guard let re = try? NSRegularExpression(pattern: pattern, options: options) else { return }
            s = re.stringByReplacingMatches(in: s, range: NSRange(s.startIndex..., in: s), withTemplate: with)
        }
        replace("```.*?(```|$)", " ", [.dotMatchesLineSeparators])
        replace("\\[([^\\]]+)\\]\\([^)]*\\)", "$1")
        replace("`", "")
        replace("\\*\\*|__", "")
        replace("^[ \\t]*(#+|>+|[-*+][ \\t]+|\\d+\\.[ \\t]+)[ \\t]*", "", [.anchorsMatchLines])
        replace("\\s+", " ")
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if let re = try? NSRegularExpression(pattern: "^.*?[.!?](?=\\s|$)"),
           let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), let r = Range(m.range, in: s) {
            s = String(s[r])
        }
        if s.count > 90 { s = String(s.prefix(89)).trimmingCharacters(in: .whitespaces) + "…" }
        return s
    }
}

// MARK: - Quiet hours

struct QuietHours {
    var enabled = false
    /// 0 = Sunday.
    var days = [1, 2, 3, 4, 5]
    var from = "09:00"
    var to = "17:00"
    /// Agent notifications still come through.
    var notifications = true

    init() {}

    init(_ dict: [String: Any]?) {
        guard let d = dict else { return }
        enabled = d["enabled"] as? Bool ?? false
        days = (d["days"] as? [Any])?.compactMap { ($0 as? NSNumber)?.intValue }.filter { (0...6).contains($0) } ?? days
        from = Self.clean(d["from"] as? String) ?? from
        to = Self.clean(d["to"] as? String) ?? to
        notifications = d["notifications"] as? Bool ?? true
    }

    var dict: [String: Any] { ["enabled": enabled, "days": days, "from": from, "to": to, "notifications": notifications] }

    private static func clean(_ s: String?) -> String? {
        guard let s, let m = minutes(s) else { return nil }
        return String(format: "%02d:%02d", m / 60, m % 60)
    }

    static func minutes(_ s: String) -> Int? {
        let parts = s.split(separator: ":").compactMap { Int($0) }
        guard parts.count == 2, (0...23).contains(parts[0]), (0...59).contains(parts[1]) else { return nil }
        return parts[0] * 60 + parts[1]
    }

    /// `from` after `to` crosses midnight: the late part counts for the day it started.
    func active(at date: Date = Date()) -> Bool {
        guard enabled, let a = Self.minutes(from), let b = Self.minutes(to) else { return false }
        let cal = Calendar(identifier: .gregorian)
        let day = cal.component(.weekday, from: date) - 1
        let now = cal.component(.hour, from: date) * 60 + cal.component(.minute, from: date)
        if a == b { return days.contains(day) }
        if a < b { return days.contains(day) && now >= a && now < b }
        return (days.contains(day) && now >= a) || (days.contains((day + 6) % 7) && now < b)
    }
}

// MARK: - Playdates

/// Every running DeskPet writes where its pet is, so pets on one computer can find each other.
enum Presence {
    struct Pet {
        let pid: pid_t
        let name: String
        let x: CGFloat
        let y: CGFloat
        let width: CGFloat
        let height: CGFloat
    }

    static let folder = DeskPetPaths.home.appendingPathComponent("presence")
    private static var mine: URL { folder.appendingPathComponent("\(getpid()).json") }

    static func publish(name: String, frame: NSRect) {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let obj: [String: Any] = ["pid": Int(getpid()), "pet": name, "x": Double(frame.midX), "y": Double(frame.minY),
                                  "width": Double(frame.width), "height": Double(frame.height), "at": Date().timeIntervalSince1970 * 1000]
        if let data = try? JSONSerialization.data(withJSONObject: obj) { try? data.write(to: mine, options: .atomic) }
    }

    static func withdraw() { try? FileManager.default.removeItem(at: mine) }

    /// Other pets seen in the last 4 seconds.
    static func others() -> [Pet] {
        let now = Date().timeIntervalSince1970 * 1000
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        return files.compactMap { url in
            guard url.pathExtension == "json", let data = try? Data(contentsOf: url),
                  let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let pid = (o["pid"] as? NSNumber)?.int32Value, pid != getpid(),
                  now - ((o["at"] as? NSNumber)?.doubleValue ?? 0) < 4000 else { return nil }
            let n = { (k: String) in CGFloat((o[k] as? NSNumber)?.doubleValue ?? 0) }
            return Pet(pid: pid, name: o["pet"] as? String ?? "friend", x: n("x"), y: n("y"), width: n("width"), height: n("height"))
        }
    }
}

enum PlaydateMath {
    /// Where to stand (the pet's centre x) next to the other pet, which way to face, and whether we're there.
    /// About a pet-width apart; on the same spot, the older process goes left so they don't both pick one side.
    static func spot(me: CGFloat, other: CGFloat, gap: CGFloat, myPID: pid_t, otherPID: pid_t) -> (desired: CGFloat, side: CGFloat, arrived: Bool) {
        let dx = other - me
        let side: CGFloat = abs(dx) > 1 ? (dx > 0 ? 1 : -1) : (myPID < otherPID ? 1 : -1)
        // Both aim at the shared midpoint (half a gap to each side), so they meet without overshooting each other,
        // and a pet whose friend stays put still ends up next to it.
        let desired = (me + other) / 2 - side * gap / 2
        return (desired, side, abs(dx) >= gap - 14 && abs(dx) <= gap + 14)
    }
}

// MARK: - Seasonal events

struct SeasonalEvent {
    let id: String
    let title: String
    let emoji: String
    /// "MM-DD", inclusive. `to` before `from` wraps into the next year.
    let from: String
    let to: String
    let rewards: [Reward]
    static let goal = 60

    static let all = [
        SeasonalEvent(id: "halloween", title: "Halloween", emoji: "🎃", from: "10-24", to: "11-01", rewards: [.witchHat, .pumpkin]),
        SeasonalEvent(id: "winter", title: "Winter holidays", emoji: "❄️", from: "12-15", to: "01-01", rewards: [.santaHat, .snowman]),
        SeasonalEvent(id: "valentine", title: "Valentine's", emoji: "💘", from: "02-07", to: "02-14", rewards: [.heartAura]),
    ]

    private static func monthDay(_ date: Date) -> String {
        let c = Calendar(identifier: .gregorian).dateComponents([.month, .day], from: date)
        return String(format: "%02d-%02d", c.month ?? 1, c.day ?? 1)
    }

    func contains(_ date: Date) -> Bool {
        let md = Self.monthDay(date)
        return from <= to ? (md >= from && md <= to) : (md >= from || md <= to)
    }

    /// The year the event started (winter that runs into January belongs to the December).
    func year(of date: Date) -> Int {
        let y = Calendar(identifier: .gregorian).component(.year, from: date)
        return from > to && Self.monthDay(date) <= to ? y - 1 : y
    }

    static func active(_ date: Date = Date()) -> SeasonalEvent? { all.first { $0.contains(date) } }

    /// The next event to start after today.
    static func next(after date: Date = Date()) -> (event: SeasonalEvent, from: Date)? {
        let cal = Calendar(identifier: .gregorian)
        let year = cal.component(.year, from: date)
        let starts: [(SeasonalEvent, Date)] = all.flatMap { e -> [(SeasonalEvent, Date)] in
            let p = e.from.split(separator: "-").compactMap { Int($0) }
            return [year, year + 1].compactMap { y in cal.date(from: DateComponents(year: y, month: p[0], day: p[1])).map { (e, $0) } }
        }
        return starts.filter { $0.1 > date }.min { $0.1 < $1.1 }
    }
}

// MARK: - Calendar heads-up

/// Upcoming meetings from Calendar.app (EventKit) or an ICS feed. Meeting titles never leave the computer.
final class CalendarWatcher {
    struct Meeting {
        let title: String
        let start: Date
        let link: String?
    }

    private let store = EKEventStore()
    private(set) var meetings: [Meeting] = []
    private(set) var status = "off"
    private var lastFetch = Date.distantPast
    private var fetching = false

    static var systemAuthorized: Bool {
        let s = EKEventStore.authorizationStatus(for: .event)
        if #available(macOS 14.0, *) { return s == .fullAccess }
        return s == .authorized
    }

    static var systemDenied: Bool {
        let s = EKEventStore.authorizationStatus(for: .event)
        return s == .denied || s == .restricted
    }

    /// Asks once (macOS shows its own prompt).
    func requestAccess(_ done: @escaping (Bool) -> Void) {
        let finish: (Bool, Error?) -> Void = { ok, _ in DispatchQueue.main.async { done(ok) } }
        if #available(macOS 14.0, *) { store.requestFullAccessToEvents(completion: finish) } else { store.requestAccess(to: .event, completion: finish) }
    }

    func reset() {
        meetings = []
        status = "off"
        lastFetch = .distantPast
    }

    /// Refreshes the meeting list now and then (every minute for Calendar.app, 10 minutes for a feed).
    func refresh(source: String, icsURL: String, force: Bool = false, done: (() -> Void)? = nil) {
        switch source {
        case "system":
            defer { done?() }
            guard force || Date().timeIntervalSince(lastFetch) > 60 else { return }
            lastFetch = Date()
            guard Self.systemAuthorized else { status = Self.systemDenied ? "denied" : "off"; meetings = []; return }
            let now = Date()
            let predicate = store.predicateForEvents(withStart: now.addingTimeInterval(-15 * 60), end: now.addingTimeInterval(24 * 3600), calendars: nil)
            meetings = store.events(matching: predicate).filter { e in
                !e.isAllDay && e.status != .canceled
                    && e.attendees?.first(where: { $0.isCurrentUser })?.participantStatus != .declined
            }.map { e in
                Meeting(title: e.title ?? "Meeting", start: e.startDate,
                        link: Self.meetingLink([e.url?.absoluteString, e.location, e.notes].compactMap { $0 }.joined(separator: " ")))
            }.sorted { $0.start < $1.start }
            status = "ok"
        case "ics":
            guard !fetching, force || Date().timeIntervalSince(lastFetch) > 600 else { done?(); return }
            guard var comps = URLComponents(string: icsURL.trimmingCharacters(in: .whitespaces)) else { status = "that link doesn't look right"; done?(); return }
            if comps.scheme == "webcal" { comps.scheme = "https" }
            guard let url = comps.url, ["https", "http"].contains(url.scheme ?? "") else { status = "that link doesn't look right"; done?(); return }
            fetching = true
            lastFetch = Date()
            URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
                let text = data.flatMap { String(data: $0, encoding: .utf8) }
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                DispatchQueue.main.async {
                    guard let self else { return }
                    defer { done?() }
                    self.fetching = false
                    guard let text, error == nil, (200..<300).contains(code), text.contains("BEGIN:VCALENDAR") else {
                        self.status = error.map { "couldn't load the feed: \($0.localizedDescription)" } ?? "couldn't load the feed (HTTP \(code))"
                        return
                    }
                    let now = Date()
                    self.meetings = ICS.occurrences(text, from: now.addingTimeInterval(-15 * 60), to: now.addingTimeInterval(24 * 3600))
                        .map { Meeting(title: $0.title, start: $0.start, link: $0.link) }
                    self.status = "ok"
                }
            }.resume()
        default:
            reset()
            done?()
        }
    }

    /// The next meeting that hasn't started more than 10 minutes ago.
    var next: Meeting? { meetings.first { $0.start.timeIntervalSinceNow > -10 * 60 } }

    private static let linkPattern = try? NSRegularExpression(
        pattern: "https?://[^\\s\"'<>]*(chime\\.aws|zoom\\.us|meet\\.google\\.com|teams\\.microsoft\\.com|teams\\.live\\.com|webex\\.com)[^\\s\"'<>]*",
        options: [.caseInsensitive])

    static func meetingLink(_ text: String) -> String? {
        guard let re = linkPattern, let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let r = Range(m.range, in: text) else { return nil }
        return String(text[r]).trimmingCharacters(in: CharacterSet(charactersIn: ".,;)>"))
    }
}

/// A small iCalendar reader: VEVENTs with UTC, floating, or TZID times; daily/weekly RRULEs; EXDATE; overrides.
enum ICS {
    struct Occurrence {
        let title: String
        let start: Date
        let link: String?
    }

    private struct Property {
        let name: String
        let params: [String: String]
        let value: String
    }

    /// Windows time zone names some servers (Exchange) put in TZID.
    private static let windowsZones: [String: String] = [
        "Pacific Standard Time": "America/Los_Angeles", "Mountain Standard Time": "America/Denver", "US Mountain Standard Time": "America/Phoenix",
        "Central Standard Time": "America/Chicago", "Eastern Standard Time": "America/New_York", "Atlantic Standard Time": "America/Halifax",
        "Alaskan Standard Time": "America/Anchorage", "Hawaiian Standard Time": "Pacific/Honolulu", "GMT Standard Time": "Europe/London",
        "Greenwich Standard Time": "Atlantic/Reykjavik", "W. Europe Standard Time": "Europe/Berlin", "Romance Standard Time": "Europe/Paris",
        "Central Europe Standard Time": "Europe/Budapest", "Central European Standard Time": "Europe/Warsaw", "E. Europe Standard Time": "Europe/Bucharest",
        "FLE Standard Time": "Europe/Kiev", "GTB Standard Time": "Europe/Athens", "Russian Standard Time": "Europe/Moscow",
        "India Standard Time": "Asia/Kolkata", "China Standard Time": "Asia/Shanghai", "Tokyo Standard Time": "Asia/Tokyo",
        "Korea Standard Time": "Asia/Seoul", "Singapore Standard Time": "Asia/Singapore", "AUS Eastern Standard Time": "Australia/Sydney",
        "New Zealand Standard Time": "Pacific/Auckland", "UTC": "UTC", "Coordinated Universal Time": "UTC", "Israel Standard Time": "Asia/Jerusalem",
        "Arabian Standard Time": "Asia/Dubai", "South Africa Standard Time": "Africa/Johannesburg", "E. South America Standard Time": "America/Sao_Paulo",
    ]

    private static func lines(_ text: String) -> [String] {
        var out: [String] = []
        for raw in text.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n") {
            if (raw.hasPrefix(" ") || raw.hasPrefix("\t")), !out.isEmpty { out[out.count - 1] += raw.dropFirst() } else { out.append(raw) }
        }
        return out
    }

    private static func parse(_ line: String) -> Property? {
        // NAME;PARAM=VALUE;PARAM="quoted":value (the value may contain colons).
        var inQuote = false
        var colon: String.Index?
        for i in line.indices {
            if line[i] == "\"" { inQuote.toggle() }
            if line[i] == ":" && !inQuote { colon = i; break }
        }
        guard let colon else { return nil }
        let head = line[..<colon].split(separator: ";").map(String.init)
        guard let name = head.first?.uppercased() else { return nil }
        var params: [String: String] = [:]
        for p in head.dropFirst() {
            let kv = p.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { params[kv[0].uppercased()] = kv[1].trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
        }
        return Property(name: name, params: params, value: String(line[line.index(after: colon)...]))
    }

    private static func unescape(_ s: String) -> String {
        s.replacingOccurrences(of: "\\n", with: " ").replacingOccurrences(of: "\\N", with: " ")
            .replacingOccurrences(of: "\\,", with: ",").replacingOccurrences(of: "\\;", with: ";").replacingOccurrences(of: "\\\\", with: "\\")
    }

    static func zone(_ tzid: String?) -> TimeZone? {
        guard let tzid else { return nil }
        let id = tzid.trimmingCharacters(in: CharacterSet(charactersIn: "/\""))
        return TimeZone(identifier: id) ?? windowsZones[id].flatMap(TimeZone.init(identifier:))
    }

    /// "20261023T090000Z", "20261023T090000" (+TZID), or a date (all-day: returns nil `time`).
    static func date(_ value: String, tzid: String?) -> (date: Date, allDay: Bool, zone: TimeZone)? {
        let v = value.trimmingCharacters(in: .whitespaces)
        let utc = v.hasSuffix("Z")
        let digits = v.replacingOccurrences(of: "Z", with: "")
        let tz = utc ? TimeZone(identifier: "UTC")! : (zone(tzid) ?? .current)
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = tz
        let parts = digits.split(separator: "T")
        guard let d = parts.first, d.count == 8, let y = Int(d.prefix(4)), let mo = Int(d.dropFirst(4).prefix(2)), let da = Int(d.suffix(2)) else { return nil }
        var c = DateComponents(year: y, month: mo, day: da)
        if parts.count > 1, parts[1].count >= 4 {
            let t = parts[1]
            c.hour = Int(t.prefix(2)); c.minute = Int(t.dropFirst(2).prefix(2)); c.second = t.count >= 6 ? Int(t.dropFirst(4).prefix(2)) : 0
        }
        guard let date = cal.date(from: c) else { return nil }
        return (date, parts.count == 1, tz)
    }

    private static let weekdays = ["SU": 1, "MO": 2, "TU": 3, "WE": 4, "TH": 5, "FR": 6, "SA": 7]

    /// Every occurrence starting in [from, to], sorted.
    static func occurrences(_ text: String, from: Date, to: Date) -> [Occurrence] {
        var events: [[Property]] = []
        var current: [Property]?
        for line in lines(text) {
            if line.uppercased() == "BEGIN:VEVENT" { current = [] } else if line.uppercased() == "END:VEVENT" {
                if let c = current { events.append(c) }
                current = nil
            } else if current != nil, let p = parse(line) { current?.append(p) }
        }
        // Moved or edited instances of a recurring event replace the original time.
        var overridden: [String: Set<Date>] = [:]
        for e in events {
            if let uid = e.first(where: { $0.name == "UID" })?.value, let rid = e.first(where: { $0.name == "RECURRENCE-ID" }),
               let d = date(rid.value, tzid: rid.params["TZID"]) {
                overridden[uid, default: []].insert(d.date)
            }
        }
        var out: [Occurrence] = []
        for e in events {
            func prop(_ n: String) -> Property? { e.first { $0.name == n } }
            guard let ds = prop("DTSTART"), let start = date(ds.value, tzid: ds.params["TZID"]), !start.allDay,
                  ds.params["VALUE"]?.uppercased() != "DATE", prop("STATUS")?.value.uppercased() != "CANCELLED" else { continue }
            let title = unescape(prop("SUMMARY")?.value ?? "Meeting")
            let link = CalendarWatcher.meetingLink(unescape([prop("URL")?.value, prop("LOCATION")?.value, prop("DESCRIPTION")?.value]
                .compactMap { $0 }.joined(separator: " ")))
            var skip = Set<Date>()
            for ex in e where ex.name == "EXDATE" {
                for v in ex.value.split(separator: ",") { if let d = date(String(v), tzid: ex.params["TZID"]) { skip.insert(d.date) } }
            }
            let isOverride = prop("RECURRENCE-ID") != nil
            if let uid = prop("UID")?.value, !isOverride { skip.formUnion(overridden[uid] ?? []) }
            for d in expand(start: start.date, zone: start.zone, rrule: isOverride ? nil : prop("RRULE")?.value, until: to)
                where d >= from && d <= to && !skip.contains(d) {
                out.append(Occurrence(title: title, start: d, link: link))
            }
        }
        return out.sorted { $0.start < $1.start }
    }

    /// Start times for an event: just `start`, or its DAILY/WEEKLY repeats up to `limit`.
    static func expand(start: Date, zone: TimeZone, rrule: String?, until limit: Date) -> [Date] {
        guard let rrule else { return [start] }
        var rule: [String: String] = [:]
        for part in rrule.split(separator: ";") {
            let kv = part.split(separator: "=", maxSplits: 1).map(String.init)
            if kv.count == 2 { rule[kv[0].uppercased()] = kv[1] }
        }
        let freq = rule["FREQ"]?.uppercased() ?? ""
        guard freq == "DAILY" || freq == "WEEKLY" else { return [start] }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = zone
        let interval = max(1, Int(rule["INTERVAL"] ?? "1") ?? 1)
        let count = rule["COUNT"].flatMap { Int($0) }
        let until = rule["UNTIL"].flatMap { date($0, tzid: zone.identifier)?.date } ?? .distantFuture
        let end = min(limit, until)
        let time = cal.dateComponents([.hour, .minute, .second], from: start)
        var out: [Date] = []
        var made = 0
        func add(_ d: Date) -> Bool {
            guard d >= start else { return true }
            if d > end { return false }
            made += 1
            if let count, made > count { return false }
            out.append(d)
            return true
        }
        if freq == "DAILY" {
            var d = start
            for _ in 0..<5000 {
                guard add(d), let n = cal.date(byAdding: .day, value: interval, to: d) else { break }
                d = n
            }
            return out
        }
        let days = (rule["BYDAY"] ?? "").split(separator: ",").compactMap { weekdays[String($0.suffix(2)).uppercased()] }
        let wanted = days.isEmpty ? [cal.component(.weekday, from: start)] : days.sorted()
        // Weeks start on Sunday here; each week at `interval`, every wanted weekday at the event's time.
        guard var week = cal.dateInterval(of: .weekOfYear, for: start)?.start else { return [start] }
        outer: for _ in 0..<2000 {
            for wd in wanted {
                guard let day = cal.date(byAdding: .day, value: wd - 1, to: week),
                      let d = cal.date(bySettingHour: time.hour ?? 0, minute: time.minute ?? 0, second: time.second ?? 0, of: day) else { continue }
                if !add(d) { break outer }
            }
            guard let n = cal.date(byAdding: .weekOfYear, value: interval, to: week) else { break }
            week = n
        }
        return out
    }
}

// MARK: - Sprite pack gallery

/// Packs listed in packs/index.json in the DeskPet repository.
enum Gallery {
    static let base = URL(string: "https://raw.githubusercontent.com/jacobsekai/deskpet/main/packs/")!

    struct Pack {
        let id: String
        let name: String
        let author: String
        let description: String
        let preview: String
        let files: [String]
    }

    static func validID(_ id: String) -> Bool {
        !id.isEmpty && id.count <= 40 && id.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_" }
    }

    /// A plain relative path inside the pack folder.
    static func safePath(_ p: String) -> Bool {
        let parts = p.split(separator: "/", omittingEmptySubsequences: false)
        return !p.isEmpty && !p.hasPrefix("/") && !p.contains("\\") && !parts.contains { $0.isEmpty || $0 == "." || $0 == ".." }
    }

    static func list(_ done: @escaping (Result<[Pack], Error>) -> Void) {
        URLSession.shared.dataTask(with: base.appendingPathComponent("index.json")) { data, _, error in
            let result: Result<[Pack], Error>
            if let data, let list = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] {
                result = .success(list.compactMap { o in
                    guard let id = o["id"] as? String, validID(id) else { return nil }
                    let preview = (o["preview"] as? String).map { $0.hasPrefix("http") ? $0 : base.appendingPathComponent(id).appendingPathComponent($0).absoluteString } ?? ""
                    return Pack(id: id, name: o["name"] as? String ?? id, author: o["author"] as? String ?? "", description: o["description"] as? String ?? "",
                                preview: preview, files: (o["files"] as? [String] ?? []).filter(safePath))
                })
            } else {
                result = .failure(error ?? TripFiles.error("the gallery isn't reachable right now"))
            }
            DispatchQueue.main.async { done(result) }
        }.resume()
    }

    /// Downloads every file into sprites/<id>/ (to a temporary folder first, so a failed download leaves nothing half-done).
    static func install(_ pack: Pack, into root: URL, _ done: @escaping (Error?) -> Void) {
        guard validID(pack.id), !pack.files.isEmpty else { return done(TripFiles.error("that pack has no files")) }
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("deskpet-gallery-\(UUID().uuidString)")
        let group = DispatchGroup()
        var failure: Error?
        let lock = NSLock()
        for file in pack.files {
            group.enter()
            URLSession.shared.dataTask(with: base.appendingPathComponent(pack.id).appendingPathComponent(file)) { data, response, error in
                defer { group.leave() }
                let ok = ((response as? HTTPURLResponse)?.statusCode ?? 0) == 200
                guard let data, ok, error == nil else {
                    lock.lock(); failure = failure ?? error ?? TripFiles.error("couldn't download \(file)"); lock.unlock()
                    return
                }
                let dest = tmp.appendingPathComponent(file)
                do {
                    try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try data.write(to: dest)
                } catch {
                    lock.lock(); failure = failure ?? error; lock.unlock()
                }
            }.resume()
        }
        group.notify(queue: .main) {
            defer { try? FileManager.default.removeItem(at: tmp) }
            if let failure { return done(failure) }
            let dest = root.appendingPathComponent(pack.id)
            do {
                try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
                try? FileManager.default.removeItem(at: dest)
                try FileManager.default.moveItem(at: tmp, to: dest)
                done(nil)
            } catch {
                done(error)
            }
        }
    }
}

/// A control-center reply that arrives later (network requests). WizardController sends it when it's delivered.
final class DeferredReply {
    var deliver: ((Any?) -> Void)?
    private var value: Any??

    func resolve(_ v: Any?) {
        if let deliver { deliver(v) } else { value = .some(v) }
    }

    func onReady(_ f: @escaping (Any?) -> Void) {
        if let v = value { f(v) } else { deliver = f }
    }
}
