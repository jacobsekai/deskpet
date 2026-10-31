import AppKit
import CoreAudio
import CoreMediaIO
import UserNotifications

// MARK: - Jump to a session

enum SessionJumper {
    /// The app hosting an agent process: the terminal, IDE, or T3 Code window it runs in.
    static func hostApp(of pid: pid_t) -> NSRunningApplication? {
        var p = pid
        for _ in 0..<16 where p > 1 {
            if let app = NSRunningApplication(processIdentifier: p), app.activationPolicy == .regular { return app }
            p = parentPID(of: p)
        }
        return nil
    }

    @discardableResult
    static func jump(to pid: pid_t) -> Bool {
        guard pid > 0, let app = hostApp(of: pid) else { return false }
        return app.activate(options: [.activateAllWindows])
    }
}

// MARK: - Notifications

final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    var onClick: ((pid_t) -> Void)?
    /// A reminder was answered: "done", "snooze", or "dismiss".
    var onReminder: ((String) -> Void)?
    private static let reminderID = "deskpet.reminder"
    private var center: UNUserNotificationCenter? {
        // Only available when running from an app bundle.
        Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
    }

    override init() {
        super.init()
        center?.delegate = self
        // Reminders get Done / Snooze. They stay on screen when DeskPet's notification style is Alerts (the default
        // asked for in Info.plist; System Settings → Notifications → DeskPet if it was set to Banners before).
        let reminder = UNNotificationCategory(identifier: "reminder", actions: [
            UNNotificationAction(identifier: "done", title: "Done ✓"),
            UNNotificationAction(identifier: "snooze", title: "Snooze 10 min"),
        ], intentIdentifiers: [], options: [.customDismissAction])
        center?.setNotificationCategories([reminder])
    }

    func requestPermission() {
        center?.requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    func post(title: String, body: String, pid: pid_t) {
        guard let center else { return }
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.userInfo = ["pid": Int(pid)]
            center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
    }

    /// A reminder that waits for Done or Snooze. A newer one replaces it.
    func postReminder(title: String, body: String) {
        guard let center else { return }
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.categoryIdentifier = "reminder"
            center.add(UNNotificationRequest(identifier: Self.reminderID, content: content, trigger: nil))
        }
    }

    /// Takes the reminder down (answered from the pet, or turned off).
    func clearReminder() {
        center?.removeDeliveredNotifications(withIdentifiers: [Self.reminderID])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        if response.notification.request.content.categoryIdentifier == "reminder" {
            let answer = switch response.actionIdentifier {
            case "snooze": "snooze"
            case UNNotificationDismissActionIdentifier: "dismiss"
            default: "done"
            }
            DispatchQueue.main.async { self.onReminder?(answer) }
            return done()
        }
        let pid = pid_t(response.notification.request.content.userInfo["pid"] as? Int ?? 0)
        DispatchQueue.main.async { self.onClick?(pid) }
        done()
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list])
    }
}

// MARK: - Sounds

enum SoundEvent: String, CaseIterable {
    case pet, done, needsYou = "needs-you", bounce, wake, levelUp = "level-up", focusDone = "focus-done"

    /// Built-in macOS sounds used when the sprite pack doesn't bring its own.
    var systemSound: String {
        switch self {
        case .pet: return "Purr"
        case .done: return "Glass"
        case .needsYou: return "Ping"
        case .bounce: return "Pop"
        case .wake: return "Tink"
        case .levelUp: return "Hero"
        case .focusDone: return "Glass"
        }
    }
}

/// Plays pose sounds. A sprite pack can override any of them with `sounds/<event>.(wav|mp3|m4a|aiff|caf)`.
final class SoundPlayer {
    var enabled = true
    var muted = false
    var packDirectory: URL?
    private var lastPlayed: [SoundEvent: Double] = [:]

    func play(_ event: SoundEvent) {
        guard enabled, !muted else { return }
        let now = CACurrentMediaTime()
        if now - (lastPlayed[event] ?? 0) < 0.15 { return }
        lastPlayed[event] = now
        let custom = packDirectory.flatMap { dir in
            ["wav", "mp3", "m4a", "aiff", "caf"].lazy.map { dir.appendingPathComponent("sounds/\(event.rawValue).\($0)") }
                .first { FileManager.default.fileExists(atPath: $0.path) }
        }
        let sound = custom.flatMap { NSSound(contentsOf: $0, byReference: true) } ?? NSSound(named: event.systemSound)
        sound?.volume = 0.45
        sound?.play()
    }
}

// MARK: - Stats & levels (~/.deskpet/stats.json, same format on both apps)

final class Stats {
    struct Day: Codable {
        var activeMinutes = 0
        var agentMinutes = 0
        var tasks = 0
        var pets = 0
        var throwsCount = 0
        var focusSessions = 0
        var openMinutes = 0
        /// XP earned from playing today (capped so it can't be farmed).
        var playXP = 0
        var greeted = false
        /// Blocklisted sites caught during focus sessions.
        var blocked = 0

        init() {}

        // Older stats.json files lack newer fields; missing ones start at zero.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            activeMinutes = try c.decodeIfPresent(Int.self, forKey: .activeMinutes) ?? 0
            agentMinutes = try c.decodeIfPresent(Int.self, forKey: .agentMinutes) ?? 0
            tasks = try c.decodeIfPresent(Int.self, forKey: .tasks) ?? 0
            pets = try c.decodeIfPresent(Int.self, forKey: .pets) ?? 0
            throwsCount = try c.decodeIfPresent(Int.self, forKey: .throwsCount) ?? 0
            focusSessions = try c.decodeIfPresent(Int.self, forKey: .focusSessions) ?? 0
            openMinutes = try c.decodeIfPresent(Int.self, forKey: .openMinutes) ?? 0
            playXP = try c.decodeIfPresent(Int.self, forKey: .playXP) ?? 0
            greeted = try c.decodeIfPresent(Bool.self, forKey: .greeted) ?? false
            blocked = try c.decodeIfPresent(Int.self, forKey: .blocked) ?? 0
        }
    }

    static let dailyPlayCap = 100

    private struct File: Codable {
        /// Lifetime XP.
        var xp = 0
        var days: [String: Day] = [:]
        var prestige = 0
        /// Lifetime XP at the last prestige; levels count from here.
        var prestigeBase = 0
        /// Active minutes from days dropped out of the history, so time together never shrinks.
        var archivedMinutes = 0

        init() {}

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            xp = try c.decodeIfPresent(Int.self, forKey: .xp) ?? 0
            days = try c.decodeIfPresent([String: Day].self, forKey: .days) ?? [:]
            prestige = try c.decodeIfPresent(Int.self, forKey: .prestige) ?? 0
            prestigeBase = try c.decodeIfPresent(Int.self, forKey: .prestigeBase) ?? 0
            archivedMinutes = try c.decodeIfPresent(Int.self, forKey: .archivedMinutes) ?? 0
        }
    }

    private var file: File
    private let url = DeskPetPaths.root.appendingPathComponent("stats.json")
    private var dirty = false

    init() {
        file = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(File.self, from: $0) } ?? File()
    }

    // Other devices' progress (cloud sync). Totals include it; this device's file never does.
    var remoteXP = 0
    var remoteDays: [String: Day] = [:]
    /// Prestige shared through sync (whichever device prestiged last).
    var syncedPrestige: (rank: Int, base: Int)?

    var xp: Int { file.xp + remoteXP }
    var localXP: Int { file.xp }
    var prestige: Int { syncedPrestige?.rank ?? file.prestige }
    var prestigeBase: Int { syncedPrestige?.base ?? file.prestigeBase }
    /// XP earned since the last prestige.
    var levelXP: Int { xp - prestigeBase }
    var maxLevel: Int { prestige >= Prestige.maxRank ? Prestige.masterCap : Prestige.levelCap }
    var level: Int { Self.level(for: levelXP, cap: maxLevel) }
    var atMax: Bool { level >= maxLevel }
    var canPrestige: Bool { level >= Prestige.levelCap && prestige < Prestige.maxRank }
    /// XP progress within the current level, 0...1 (1 at the cap).
    var progress: Double {
        guard !atMax else { return 1 }
        let lo = Self.xpNeeded(level), hi = Self.xpNeeded(level + 1)
        return Double(levelXP - lo) / Double(max(1, hi - lo))
    }
    /// The last `count` days (oldest first), all synced devices combined, for the Insights page.
    func history(days count: Int = 14) -> [[String: Any]] {
        let cal = Calendar.current
        return (0..<count).reversed().compactMap { back -> [String: Any]? in
            guard let date = cal.date(byAdding: .day, value: -back, to: Date()) else { return nil }
            let key = Self.dayFormatter.string(from: date)
            let d = (file.days[key] ?? Day()) + (remoteDays[key] ?? Day())
            return ["day": key, "activeMinutes": d.activeMinutes, "agentMinutes": d.agentMinutes, "tasks": d.tasks,
                    "focusSessions": d.focusSessions, "pets": d.pets, "openMinutes": d.openMinutes]
        }
    }

    /// Lifetime minutes you've been active with the pet open, on every synced device.
    var togetherMinutes: Int {
        file.archivedMinutes + file.days.values.reduce(0) { $0 + $1.activeMinutes } + remoteDays.values.reduce(0) { $0 + $1.activeMinutes }
    }
    var xpToNext: Int { atMax ? 0 : Self.xpNeeded(level + 1) - levelXP }
    /// "Lv 42", "Prestige 3 · Lv 42", "💎 Prestige Master · Lv 345"
    var rankTitle: String { prestige == 0 ? "Lv \(level)" : "\(Prestige.title(prestige)) · Lv \(level)" }

    /// XP needed (since the last prestige) to reach `level`.
    static func xpNeeded(_ level: Int) -> Int {
        // Level n → n+1 costs 100 + 15n, so level 100 takes about 84,000 XP (a few months of daily use);
        // Prestige Master levels past 100 cost 2,000 each. Same curve in the Windows/Linux app.
        let n = min(level, Prestige.levelCap) - 1
        let base = 100 * n + 15 * n * (n + 1) / 2
        return base + max(0, level - Prestige.levelCap) * 2000
    }

    /// The 1.0–1.5 curve (level 100 at about 7,900 XP), only for moving people to the new one.
    static func oldLevel(for xp: Int) -> Int {
        var n = 1
        while n < Prestige.levelCap && 30 * n + n * (n + 1) / 2 <= xp { n += 1 }
        return n
    }

    static func level(for xp: Int, cap: Int = Prestige.levelCap) -> Int {
        var n = 1
        while n < cap && xpNeeded(n + 1) <= xp { n += 1 }
        return n
    }

    /// Resets to level 1 and raises the prestige rank. Rewards stay unlocked.
    func doPrestige() {
        guard canPrestige else { return }
        file.prestige = prestige + 1
        file.prestigeBase = xp
        if syncedPrestige != nil { syncedPrestige = (file.prestige, file.prestigeBase) }
        dirty = true
        saveIfNeeded()
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    /// Today across all synced devices.
    var today: Day {
        let key = Self.dayFormatter.string(from: Date())
        return (file.days[key] ?? Day()) + (remoteDays[key] ?? Day())
    }

    /// Updates today's counters; returns the new level if this XP gain leveled up.
    @discardableResult
    func record(xp gained: Int = 0, _ change: (inout Day) -> Void = { _ in }) -> Int? {
        let key = Self.dayFormatter.string(from: Date())
        var day = file.days[key] ?? Day()
        // Counters that cap across devices (play XP, daily hello) are checked against today's total.
        let remote = remoteDays[key] ?? Day()
        var combined = day + remote
        change(&combined)
        day.activeMinutes += combined.activeMinutes - (day + remote).activeMinutes
        day.agentMinutes += combined.agentMinutes - (day + remote).agentMinutes
        day.tasks += combined.tasks - (day + remote).tasks
        day.pets += combined.pets - (day + remote).pets
        day.throwsCount += combined.throwsCount - (day + remote).throwsCount
        day.focusSessions += combined.focusSessions - (day + remote).focusSessions
        day.openMinutes += combined.openMinutes - (day + remote).openMinutes
        day.playXP += combined.playXP - (day + remote).playXP
        day.blocked += combined.blocked - (day + remote).blocked
        day.greeted = day.greeted || combined.greeted
        file.days[key] = day
        let before = level
        file.xp += gained
        dirty = true
        return level > before ? level : nil
    }

    /// Everything (all synced devices combined) as JSON, for transfer keys.
    var exported: [String: Any] {
        var merged = file
        merged.xp = xp
        merged.prestige = prestige
        merged.prestigeBase = prestigeBase
        for (key, day) in remoteDays { merged.days[key] = (merged.days[key] ?? Day()) + day }
        return (try? JSONEncoder().encode(merged)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
    }

    /// Just this device's contribution, for its sync file.
    var deviceExport: [String: Any] {
        let days = (try? JSONEncoder().encode(file.days)).flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? [String: Any]()
        return ["xp": file.xp, "days": days]
    }

    /// Keeping a removed device's progress: its XP and days move onto this device.
    func absorbDevice(_ stats: [String: Any]) {
        file.xp += stats["xp"] as? Int ?? 0
        if let days = stats["days"], let data = try? JSONSerialization.data(withJSONObject: days),
           let decoded = try? JSONDecoder().decode([String: Day].self, from: data) {
            for (key, day) in decoded { file.days[key] = (file.days[key] ?? Day()) + day }
        }
        dirty = true
        saveIfNeeded()
    }

    /// Leaving sync: keep the shared prestige and current level progress on this device alone.
    func leaveSync() {
        if let synced = syncedPrestige {
            let progress = xp - synced.base
            file.prestige = synced.rank
            file.prestigeBase = file.xp - progress
        }
        syncedPrestige = nil
        remoteXP = 0
        remoteDays = [:]
        dirty = true
        saveIfNeeded()
    }

    /// "Use synced progress": this device starts from zero (a backup is kept) and adds onto the others.
    func resetLocal() {
        try? FileManager.default.removeItem(at: url.appendingPathExtension("bak"))
        try? FileManager.default.copyItem(at: url, to: url.appendingPathExtension("bak"))
        file.xp = 0
        file.days = [:]
        dirty = true
        saveIfNeeded()
    }

    /// Back from a trip: adds what the pet earned while away (the trip's stats minus what they were when it
    /// left), so progress made here in the meantime isn't lost. Returns the XP added.
    @discardableResult
    func absorb(trip: [String: Any], departure: [String: Any]) -> Int {
        let decode = { (json: [String: Any]) in
            (try? JSONSerialization.data(withJSONObject: json)).flatMap { try? JSONDecoder().decode(File.self, from: $0) }
        }
        guard let t = decode(trip), let d = decode(departure) else { return 0 }
        let gained = max(0, t.xp - d.xp)
        for (key, day) in t.days {
            let before = d.days[key] ?? Day()
            var delta = Day()
            delta.activeMinutes = max(0, day.activeMinutes - before.activeMinutes)
            delta.agentMinutes = max(0, day.agentMinutes - before.agentMinutes)
            delta.tasks = max(0, day.tasks - before.tasks)
            delta.pets = max(0, day.pets - before.pets)
            delta.throwsCount = max(0, day.throwsCount - before.throwsCount)
            delta.focusSessions = max(0, day.focusSessions - before.focusSessions)
            delta.openMinutes = max(0, day.openMinutes - before.openMinutes)
            delta.playXP = max(0, day.playXP - before.playXP)
            delta.blocked = max(0, day.blocked - before.blocked)
            delta.greeted = day.greeted && !before.greeted
            file.days[key] = (file.days[key] ?? Day()) + delta
        }
        file.xp += gained
        file.archivedMinutes += max(0, t.archivedMinutes - d.archivedMinutes)
        // Prestiged on the trip: keep the same progress into the new rank.
        if t.prestige > prestige {
            file.prestige = t.prestige
            file.prestigeBase = xp - (t.xp - t.prestigeBase)
            if syncedPrestige != nil { syncedPrestige = (file.prestige, file.prestigeBase) }
        }
        dirty = true
        saveIfNeeded()
        return gained
    }

    /// Replaces all stats (from a transfer key), keeping a backup of the old file.
    func replace(with json: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: json)
        let incoming = try JSONDecoder().decode(File.self, from: data)
        try? FileManager.default.removeItem(at: url.appendingPathExtension("bak"))
        try? FileManager.default.copyItem(at: url, to: url.appendingPathExtension("bak"))
        file = incoming
        dirty = true
        saveIfNeeded()
    }

    func saveIfNeeded() {
        guard dirty else { return }
        dirty = false
        // Keep about a year of history.
        if file.days.count > 400 {
            for key in file.days.keys.sorted().prefix(file.days.count - 400) {
                file.archivedMinutes += file.days[key]?.activeMinutes ?? 0
                file.days[key] = nil
            }
        }
        if let data = try? JSONEncoder().encode(file) { try? data.write(to: url, options: .atomic) }
    }
}

// MARK: - Focus timer

final class FocusTimer {
    enum Phase { case off, focus, rest }
    private(set) var phase = Phase.off
    private(set) var endsAt = Date()
    private(set) var minutes = 25

    var remaining: TimeInterval { max(0, endsAt.timeIntervalSinceNow) }
    var label: String {
        let r = Int(remaining.rounded(.up))
        let clock = String(format: "%d:%02d", r / 60, r % 60)
        switch phase {
        case .focus: return "🍅 focus · \(clock)"
        case .rest: return "☕ break · \(clock)"
        case .off: return ""
        }
    }

    func start(minutes: Int) {
        self.minutes = minutes
        phase = .focus
        endsAt = Date().addingTimeInterval(TimeInterval(minutes * 60))
    }

    func stop() { phase = .off }

    /// Advances phases; returns what just finished.
    func tick() -> Phase? {
        guard phase != .off, remaining <= 0 else { return nil }
        let finished = phase
        if phase == .focus {
            phase = .rest
            endsAt = Date().addingTimeInterval(TimeInterval(max(5, minutes / 5) * 60))
        } else {
            phase = .off
        }
        return finished
    }
}

// MARK: - Call detection (quiet mode)

/// Whether a microphone or camera is in use by any app. Needs no permissions:
/// it asks Core Audio / Core Media IO whether a device is running somewhere.
enum CallDetector {
    static func inCall() -> Bool { microphoneInUse() || cameraInUse() }

    static func microphoneInUse() -> Bool {
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
              device != 0 else { return false }
        var running = UInt32(0)
        size = UInt32(MemoryLayout<UInt32>.size)
        address.mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, &running) == noErr else { return false }
        return running != 0
    }

    static func cameraInUse() -> Bool {
        var address = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyDevices),
                                                mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
                                                mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
        var size = UInt32(0)
        guard CMIOObjectGetPropertyDataSize(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, &size) == noErr, size > 0 else { return false }
        let count = Int(size) / MemoryLayout<CMIOObjectID>.size
        var devices = [CMIOObjectID](repeating: 0, count: count)
        var used = UInt32(0)
        guard CMIOObjectGetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &address, 0, nil, size, &used, &devices) == noErr else { return false }
        for device in devices {
            var running = UInt32(0)
            var runningAddress = CMIOObjectPropertyAddress(mSelector: CMIOObjectPropertySelector(kCMIODevicePropertyDeviceIsRunningSomewhere),
                                                           mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeWildcard),
                                                           mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementWildcard))
            var out = UInt32(0)
            if CMIOObjectGetPropertyData(device, &runningAddress, 0, nil, UInt32(MemoryLayout<UInt32>.size), &out, &running) == noErr, running != 0 {
                return true
            }
        }
        return false
    }
}

// MARK: - Sprite pack zips

enum PackArchive {
    static let imageExtensions = ["png", "gif", "webp", "jpg", "jpeg", "heic"]

    /// Installs a dropped .zip or folder as a new pack, or adds dropped images to `currentPack`.
    /// Returns the pack name to switch to.
    static func importItems(_ urls: [URL], currentPack: String) throws -> String {
        let fm = FileManager.default
        if let zip = urls.first(where: { $0.pathExtension.lowercased() == "zip" }) {
            let dest = uniqueDirectory(zip.deletingPathExtension().lastPathComponent)
            try run("/usr/bin/ditto", ["-x", "-k", zip.path, dest.path])
            flatten(dest)
            return try validated(dest)
        }
        if let folder = urls.first(where: { (try? $0.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true }) {
            let dest = uniqueDirectory(folder.lastPathComponent)
            try fm.copyItem(at: folder, to: dest)
            return try validated(dest)
        }
        let images = urls.filter { imageExtensions.contains($0.pathExtension.lowercased()) }
        guard !images.isEmpty else { throw error("drop a .zip, a folder, or images") }
        let dir = currentPack.isEmpty ? uniqueDirectory("my-pack") : SpritePack.root.appendingPathComponent(currentPack)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        for image in images {
            let base = image.deletingPathExtension().lastPathComponent.lowercased()
            // A lone big image is most likely a spritesheet.
            let name = SpritePack.mood(named: SpritePack.splitFrameNumber(base).0) != nil ? image.lastPathComponent : "sheet.\(image.pathExtension.lowercased())"
            let target = dir.appendingPathComponent(name)
            try? fm.removeItem(at: target)
            try fm.copyItem(at: image, to: target)
        }
        return try validated(dir)
    }

    static func export(pack name: String, to zip: URL) throws {
        try? FileManager.default.removeItem(at: zip)
        try run("/usr/bin/ditto", ["-c", "-k", "--keepParent", SpritePack.root.appendingPathComponent(name).path, zip.path])
    }

    private static func uniqueDirectory(_ base: String) -> URL {
        let clean = base.replacingOccurrences(of: "/", with: "-")
        var url = SpritePack.root.appendingPathComponent(clean)
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = SpritePack.root.appendingPathComponent("\(clean) \(n)")
            n += 1
        }
        return url
    }

    /// Zips often wrap everything in one folder (plus __MACOSX); move its contents up.
    private static func flatten(_ dir: URL) {
        let fm = FileManager.default
        try? fm.removeItem(at: dir.appendingPathComponent("__MACOSX"))
        let items = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isDirectoryKey])) ?? []
        guard items.count == 1, let inner = items.first,
              (try? inner.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { return }
        for child in (try? fm.contentsOfDirectory(at: inner, includingPropertiesForKeys: nil)) ?? [] {
            try? fm.moveItem(at: child, to: dir.appendingPathComponent(child.lastPathComponent))
        }
        try? fm.removeItem(at: inner)
    }

    private static func validated(_ dir: URL) throws -> String {
        do {
            _ = try SpritePack(name: dir.lastPathComponent)
            return dir.lastPathComponent
        } catch {
            throw Self.error("no idle image found in \(dir.lastPathComponent)")
        }
    }

    private static func run(_ tool: String, _ args: [String]) throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: tool)
        p.arguments = args
        try p.run()
        p.waitUntilExit()
        if p.terminationStatus != 0 { throw error("\((tool as NSString).lastPathComponent) failed") }
    }

    private static func error(_ message: String) -> NSError {
        NSError(domain: "DeskPet", code: 3, userInfo: [NSLocalizedDescriptionKey: message])
    }
}

// MARK: - Updates from GitHub Releases

final class Updater {
    static let repo = "jacobsekai/deskpet"
    static var currentVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0" }

    private(set) var available: (version: String, url: URL, page: URL)?
    private(set) var installing = false

    /// Compares dotted versions numerically ("1.10.0" > "1.9.2").
    static func isNewer(_ a: String, than b: String) -> Bool {
        let pa = a.split(separator: ".").map { Int($0) ?? 0 }, pb = b.split(separator: ".").map { Int($0) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    func check(completion: @escaping (Bool) -> Void) {
        let url = URL(string: "https://api.github.com/repos/\(Self.repo)/releases/latest")!
        var request = URLRequest(url: url)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: request) { data, _, _ in
            guard let data, let release = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tag = release["tag_name"] as? String, let page = (release["html_url"] as? String).flatMap(URL.init),
                  let asset = (release["assets"] as? [[String: Any]])?.first(where: { ($0["name"] as? String) == "DeskPet-macOS.zip" }),
                  let download = (asset["browser_download_url"] as? String).flatMap(URL.init) else {
                return DispatchQueue.main.async { completion(false) }
            }
            let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
            DispatchQueue.main.async {
                self.available = Self.isNewer(version, than: Self.currentVersion) ? (version, download, page) : nil
                completion(self.available != nil)
            }
        }.resume()
    }

    /// Downloads the new zip, swaps the app bundle once this process exits, and relaunches.
    func install(onError: @escaping (String) -> Void) {
        guard let update = available, !installing else { return }
        let bundle = Bundle.main.bundleURL
        // Apps run straight from Downloads are "translocated" to a read-only path and can't replace themselves.
        if bundle.path.contains("/AppTranslocation/") || !FileManager.default.isWritableFile(atPath: bundle.deletingLastPathComponent().path) {
            NSWorkspace.shared.open(update.page)
            return onError("move DeskPet to Applications first, then update")
        }
        installing = true
        URLSession.shared.downloadTask(with: update.url) { file, _, error in
            DispatchQueue.main.async {
                guard let file, error == nil else {
                    self.installing = false
                    return onError("download failed")
                }
                let work = FileManager.default.temporaryDirectory.appendingPathComponent("deskpet-update-\(UUID().uuidString)")
                try? FileManager.default.createDirectory(at: work, withIntermediateDirectories: true)
                let zip = work.appendingPathComponent("update.zip")
                try? FileManager.default.moveItem(at: file, to: zip)
                let script = """
                set -e
                cd "\(work.path)"
                /usr/bin/ditto -x -k update.zip extracted
                NEW="$(/usr/bin/find extracted -maxdepth 3 -name DeskPet.app -type d | head -1)"
                [ -n "$NEW" ] || exit 1
                /usr/bin/xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true
                while /bin/kill -0 \(ProcessInfo.processInfo.processIdentifier) 2>/dev/null; do sleep 0.2; done
                /bin/rm -rf "\(bundle.path)"
                /bin/mv "$NEW" "\(bundle.path)"
                /usr/bin/open "\(bundle.path)"
                """
                let p = Process()
                p.executableURL = URL(fileURLWithPath: "/bin/bash")
                p.arguments = ["-c", script]
                do {
                    try p.run()
                    NSApp.terminate(nil)
                } catch {
                    self.installing = false
                    onError("couldn't start the updater")
                }
            }
        }.resume()
    }
}
