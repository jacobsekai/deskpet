import Foundation

/// Syncs progress across devices through a folder your cloud drive already syncs (iCloud Drive, OneDrive,
/// Dropbox, Google Drive, Nextcloud, …). Each device writes only its own file, `DeskPet/devices/<id>.json`,
/// so devices never overwrite each other: XP and daily stats add up across devices, while names, settings,
/// worn rewards, and prestige follow whichever device changed them last. Same format as the Windows/Linux app.
final class Sync {
    struct Device {
        let id: String
        let name: String
        let platform: String
        let updated: Double
        let xp: Int
    }

    struct Result {
        var remoteXP = 0
        var remoteDays: [String: Stats.Day] = [:]
        /// Set when another device changed names/settings/prestige more recently than this one.
        var newerProfile: [String: Any]?
    }

    private let defaults = appDefaults
    private(set) var devices: [Device] = []
    private(set) var lastSync: Date?
    private(set) var error: String?
    private var lastWritten = Data()
    private var lastProfileJSON = ""

    let deviceID: String
    let deviceName = Host.current().localizedName ?? "Mac"

    init() {
        deviceID = Self.thisDeviceID()
    }

    /// Identifies this computer for sync and trips (a visitor reads the home app's settings, so it gets the host's id).
    static func thisDeviceID() -> String {
        if let id = UserDefaults.standard.string(forKey: "syncDeviceID") { return id }
        let id = UUID().uuidString.lowercased()
        UserDefaults.standard.set(id, forKey: "syncDeviceID")
        return id
    }

    var folder: URL? {
        get { defaults.string(forKey: "syncFolder").map { URL(fileURLWithPath: $0) } }
        set {
            defaults.set(newValue?.path, forKey: "syncFolder")
            lastWritten = Data()
            devices = []
            error = nil
        }
    }

    var enabled: Bool { folder != nil }
    var root: URL? { folder?.appendingPathComponent("DeskPet") }
    var spritesFolder: URL? { root?.appendingPathComponent("sprites") }
    private var devicesDir: URL? { root?.appendingPathComponent("devices") }

    private var profileUpdatedAt: Double {
        get { defaults.double(forKey: "syncProfileUpdatedAt") }
        set { defaults.set(newValue, forKey: "syncProfileUpdatedAt") }
    }

    /// The newest remote profile already applied here, so it isn't applied twice.
    private var lastAppliedRemote: Double {
        get { defaults.double(forKey: "syncLastAppliedRemote") }
        set { defaults.set(newValue, forKey: "syncLastAppliedRemote") }
    }

    /// Cloud folders found on this Mac, for one-click setup.
    static func candidates() -> [(name: String, path: String)] {
        let home = URL(fileURLWithPath: NSHomeDirectory())
        let fm = FileManager.default
        var found: [(String, String)] = []
        let icloud = home.appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs")
        if fm.fileExists(atPath: icloud.path) { found.append(("iCloud Drive", icloud.path)) }
        let cloudStorage = home.appendingPathComponent("Library/CloudStorage")
        for item in (try? fm.contentsOfDirectory(atPath: cloudStorage.path)) ?? [] {
            let path = cloudStorage.appendingPathComponent(item).path
            if item.hasPrefix("OneDrive") { found.append(("OneDrive", path)) }
            else if item.hasPrefix("Dropbox") { found.append(("Dropbox", path)) }
            else if item.hasPrefix("GoogleDrive") {
                let myDrive = (path as NSString).appendingPathComponent("My Drive")
                found.append(("Google Drive", fm.fileExists(atPath: myDrive) ? myDrive : path))
            } else if item.hasPrefix("Box") { found.append(("Box", path)) }
        }
        for (name, folder) in [("Dropbox", "Dropbox"), ("Nextcloud", "Nextcloud"), ("Sync", "Sync")] {
            let path = home.appendingPathComponent(folder).path
            if fm.fileExists(atPath: path), !found.contains(where: { $0.0 == name }) { found.append((name, path)) }
        }
        return found
    }

    /// Other devices' totals already in a folder (before turning sync on).
    static func inspect(_ folder: URL, excluding id: String) -> (devices: Int, xp: Int, names: [String]) {
        let dir = folder.appendingPathComponent("DeskPet/devices")
        var count = 0, xp = 0
        var names: [String] = []
        for url in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] where url.pathExtension == "json" {
            guard let obj = (try? Data(contentsOf: url)).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
                  let device = obj["device"] as? [String: Any], device["id"] as? String != id else { continue }
            count += 1
            xp += (obj["stats"] as? [String: Any])?["xp"] as? Int ?? 0
            names.append(device["name"] as? String ?? "another device")
        }
        return (count, xp, names)
    }

    /// Writes this device's file and reads everyone else's.
    func sync(localStats: [String: Any], profile: [String: Any]) -> Result? {
        guard let devicesDir else { return nil }
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: devicesDir, withIntermediateDirectories: true)
        } catch {
            self.error = "can't write to the sync folder"
            return nil
        }

        // Profile changes made on this device get a fresh timestamp so other devices pick them up.
        let profileJSON = Self.canonical(profile)
        if profileJSON != lastProfileJSON {
            if !lastProfileJSON.isEmpty || profileUpdatedAt == 0 { profileUpdatedAt = Date().timeIntervalSince1970 }
            lastProfileJSON = profileJSON
        }

        var result = Result()
        var seen: [Device] = []
        var newest: (at: Double, profile: [String: Any])?
        for url in (try? fm.contentsOfDirectory(at: devicesDir, includingPropertiesForKeys: nil)) ?? [] {
            // iCloud keeps files it hasn't downloaded yet as ".name.json.icloud" placeholders.
            if url.lastPathComponent.hasSuffix(".icloud") {
                try? fm.startDownloadingUbiquitousItem(at: url)
                continue
            }
            guard url.pathExtension == "json",
                  let obj = (try? Data(contentsOf: url)).flatMap({ try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }),
                  let device = obj["device"] as? [String: Any], let id = device["id"] as? String else { continue }
            let stats = obj["stats"] as? [String: Any] ?? [:]
            seen.append(Device(id: id, name: device["name"] as? String ?? "Device", platform: device["platform"] as? String ?? "",
                               updated: obj["updated"] as? Double ?? 0, xp: stats["xp"] as? Int ?? 0))
            guard id != deviceID else { continue }
            result.remoteXP += stats["xp"] as? Int ?? 0
            if let days = stats["days"], let data = try? JSONSerialization.data(withJSONObject: days),
               let decoded = try? JSONDecoder().decode([String: Stats.Day].self, from: data) {
                for (key, day) in decoded { result.remoteDays[key] = (result.remoteDays[key] ?? Stats.Day()) + day }
            }
            if let profile = obj["profile"] as? [String: Any], let at = profile["updatedAt"] as? Double, at > (newest?.at ?? 0) {
                newest = (at, profile)
            }
        }
        if let newest, newest.at > profileUpdatedAt, newest.at > lastAppliedRemote {
            lastAppliedRemote = newest.at
            result.newerProfile = newest.profile
        }

        var mine = profile
        mine["updatedAt"] = profileUpdatedAt
        let file: [String: Any] = [
            "format": 1,
            "device": ["id": deviceID, "name": deviceName, "platform": "macOS"],
            "updated": Date().timeIntervalSince1970,
            "stats": localStats,
            "profile": mine,
        ]
        // Only rewrite when something changed, so cloud apps don't sync a new copy every few seconds.
        if let data = try? JSONSerialization.data(withJSONObject: file, options: [.sortedKeys]) {
            let comparable = (try? JSONSerialization.data(withJSONObject: file.filter { $0.key != "updated" }, options: [.sortedKeys])) ?? data
            if comparable != lastWritten {
                lastWritten = comparable
                try? data.write(to: devicesDir.appendingPathComponent("\(deviceID).json"), options: .atomic)
            }
        }
        devices = seen.sorted { $0.updated > $1.updated }
        lastSync = Date()
        error = nil
        return result
    }

    /// After applying another device's profile, remember it as ours without bumping its timestamp.
    func accept(profile: [String: Any]) {
        lastProfileJSON = Self.canonical(profile)
        profileUpdatedAt = lastAppliedRemote
    }

    /// Joining: whatever the other devices already have wins over this device's current settings.
    /// The first device in a folder owns the settings until someone changes them.
    func prepareJoin(profile: [String: Any], first: Bool) {
        lastProfileJSON = Self.canonical(profile)
        profileUpdatedAt = first ? Date().timeIntervalSince1970 : 1
        lastAppliedRemote = 0
    }

    func disable() {
        folder = nil
        lastProfileJSON = ""
    }

    private static func canonical(_ obj: [String: Any]) -> String {
        (try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? ""
    }
}

extension Stats.Day {
    static func + (a: Stats.Day, b: Stats.Day) -> Stats.Day {
        var d = Stats.Day()
        d.activeMinutes = a.activeMinutes + b.activeMinutes
        d.agentMinutes = a.agentMinutes + b.agentMinutes
        d.tasks = a.tasks + b.tasks
        d.pets = a.pets + b.pets
        d.throwsCount = a.throwsCount + b.throwsCount
        d.focusSessions = a.focusSessions + b.focusSessions
        d.openMinutes = a.openMinutes + b.openMinutes
        d.playXP = a.playXP + b.playXP
        d.greeted = a.greeted || b.greeted
        d.blocked = a.blocked + b.blocked
        return d
    }
}
