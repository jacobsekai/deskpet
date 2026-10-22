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
    private var center: UNUserNotificationCenter? {
        // Only available when running from an app bundle.
        Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
    }

    override init() {
        super.init()
        center?.delegate = self
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

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
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
        }
    }

    static let dailyPlayCap = 100

    private struct File: Codable {
        var xp = 0
        var days: [String: Day] = [:]
    }

    private var file: File
    private let url = DeskPetPaths.root.appendingPathComponent("stats.json")
    private var dirty = false

    init() {
        file = (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(File.self, from: $0) } ?? File()
    }

    var xp: Int { file.xp }
    var level: Int { Self.level(for: file.xp) }
    /// XP progress within the current level, 0...1.
    var progress: Double {
        let lo = Self.xpNeeded(level), hi = Self.xpNeeded(level + 1)
        return Double(file.xp - lo) / Double(max(1, hi - lo))
    }
    var xpToNext: Int { Self.xpNeeded(level + 1) - file.xp }

    static func xpNeeded(_ level: Int) -> Int { 25 * level * (level - 1) }
    static func level(for xp: Int) -> Int {
        var n = 1
        while xpNeeded(n + 1) <= xp { n += 1 }
        return n
    }

    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    var today: Day { file.days[Self.dayFormatter.string(from: Date())] ?? Day() }

    /// Updates today's counters; returns the new level if this XP gain leveled up.
    @discardableResult
    func record(xp gained: Int = 0, _ change: (inout Day) -> Void = { _ in }) -> Int? {
        let key = Self.dayFormatter.string(from: Date())
        var day = file.days[key] ?? Day()
        change(&day)
        file.days[key] = day
        let before = level
        file.xp += gained
        dirty = true
        return level > before ? level : nil
    }

    func saveIfNeeded() {
        guard dirty else { return }
        dirty = false
        // Keep about a year of history.
        if file.days.count > 400 {
            for key in file.days.keys.sorted().prefix(file.days.count - 400) { file.days[key] = nil }
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
