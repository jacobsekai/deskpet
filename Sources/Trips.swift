import AppKit
import DiskArbitration

// Trips on a USB drive and moving-homes files. Same formats as the Windows/Linux app (electron/src/trips.js);
// see docs/trips-and-moving.md.

// MARK: - Visiting another computer

/// When DeskPet runs from a trip drive (or is started with `--trip <folder>`), it's a visitor: the pet's
/// data comes from the drive, lives in a temporary folder while it's here, and is written back to the drive.
enum Visitor {
    static let suiteName = "deskpet.trip"

    /// The trip folder this instance is visiting from, if any.
    static let trip: URL? = {
        let args = CommandLine.arguments
        if let i = args.firstIndex(of: "--trip"), i + 1 < args.count { return URL(fileURLWithPath: args[i + 1]) }
        // A portable copy sitting in the trip folder next to trip.json.
        let parent = Bundle.main.bundleURL.deletingLastPathComponent()
        if FileManager.default.fileExists(atPath: parent.appendingPathComponent("trip.json").path) { return parent }
        return nil
    }()

    static var active: Bool { trip != nil }

    /// Fresh for every visit, so nothing from one computer leaks into the next.
    static let dataRoot = FileManager.default.temporaryDirectory.appendingPathComponent("DeskPet-trip-\(getpid())")

    /// Running visitors leave a marker so the home instance doesn't mistake them for a duplicate of itself.
    static let markers = DeskPetPaths.home.appendingPathComponent("visitors")

    static func visitorPIDs() -> Set<pid_t> {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: markers.path)) ?? []
        return Set(names.compactMap { pid_t($0) })
    }

    static func register() {
        try? FileManager.default.createDirectory(at: markers, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: markers.appendingPathComponent("\(getpid())").path, contents: nil)
    }

    static func cleanUp() {
        try? FileManager.default.removeItem(at: markers.appendingPathComponent("\(getpid())"))
        try? FileManager.default.removeItem(at: dataRoot)
        UserDefaults.standard.removePersistentDomain(forName: suiteName)
    }
}

/// Settings storage: the usual UserDefaults, or a separate suite while visiting (a visitor shares the
/// bundle id with the home app, so it must not touch the home app's settings).
let appDefaults: UserDefaults = {
    guard Visitor.active else { return .standard }
    UserDefaults.standard.removePersistentDomain(forName: Visitor.suiteName)
    return UserDefaults(suiteName: Visitor.suiteName) ?? .standard
}()

// MARK: - Trip folders

struct TripDrive {
    let url: URL
    let name: String
}

enum TripFiles {
    static let folderName = "DeskPet Trip"

    /// USB drives, SD cards, and other removable or external volumes.
    static func drives() -> [TripDrive] {
        let keys: [URLResourceKey] = [.volumeNameKey, .volumeIsRemovableKey, .volumeIsEjectableKey, .volumeIsInternalKey,
                                      .volumeIsRootFileSystemKey, .volumeIsReadOnlyKey, .volumeIsLocalKey]
        let volumes = FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: keys, options: [.skipHiddenVolumes]) ?? []
        return volumes.compactMap { url in
            guard let v = try? url.resourceValues(forKeys: Set(keys)), v.volumeIsRootFileSystem != true,
                  v.volumeIsReadOnly != true, v.volumeIsLocal != false,
                  v.volumeIsRemovable == true || v.volumeIsEjectable == true || v.volumeIsInternal == false,
                  !isDiskImage(url) else { return nil }
            return TripDrive(url: url, name: v.volumeName ?? url.lastPathComponent)
        }
    }

    private static let diskSession = DASessionCreate(kCFAllocatorDefault)

    /// Mounted .dmg and sparse images look ejectable too, but you can't carry them anywhere.
    private static func isDiskImage(_ url: URL) -> Bool {
        guard let session = diskSession, let disk = DADiskCreateFromVolumePath(kCFAllocatorDefault, session, url as CFURL),
              let info = DADiskCopyDescription(disk) as? [CFString: Any] else { return false }
        let model = info[kDADiskDescriptionDeviceModelKey] as? String ?? ""
        let proto = info[kDADiskDescriptionDeviceProtocolKey] as? String ?? ""
        return model.contains("Disk Image") || proto == "Virtual Interface"
    }

    /// The trip folder for a drive or a chosen folder.
    static func folder(for url: URL) -> URL {
        url.lastPathComponent == folderName ? url : url.appendingPathComponent(folderName)
    }

    /// Every trip folder currently reachable: the remembered one plus one per drive.
    static func candidates(including path: String?) -> [URL] {
        var seen = Set<String>()
        var out: [URL] = []
        for url in (path.map { [URL(fileURLWithPath: $0)] } ?? []) + drives().map({ folder(for: $0.url) }) where seen.insert(url.path).inserted {
            out.append(url)
        }
        return out
    }

    static func read(_ folder: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent("trip.json")),
              let trip = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              trip["app"] as? String == "deskpet", trip["kind"] as? String == "trip" else { return nil }
        return trip
    }

    /// Writes trip.json through a temporary file, so a yanked drive never leaves half a file.
    static func write(_ trip: [String: Any], to folder: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: trip, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        let tmp = folder.appendingPathComponent("trip.json.tmp")
        let dest = folder.appendingPathComponent("trip.json")
        try data.write(to: tmp)
        // FAT/exFAT drives can't rename over an existing file.
        if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
        try fm.moveItem(at: tmp, to: dest)
    }

    static func copyPack(_ name: String, to folder: URL) throws {
        let fm = FileManager.default
        let sprites = folder.appendingPathComponent("sprites")
        try? fm.removeItem(at: sprites)
        guard !name.isEmpty else { return }
        try fm.createDirectory(at: sprites, withIntermediateDirectories: true)
        let dest = sprites.appendingPathComponent(name)
        try fm.copyItem(at: SpritePack.root.appendingPathComponent(name), to: dest)
        try? fm.removeItem(at: dest.appendingPathComponent("sliced"))
    }

    static var appCopyName: String { "DeskPet.app" }

    static func appSize() -> String {
        let bytes = (FileManager.default.enumerator(at: Bundle.main.bundleURL, includingPropertiesForKeys: [.fileSizeKey])?
            .compactMap { ($0 as? URL).flatMap { try? $0.resourceValues(forKeys: [.fileSizeKey]).fileSize } }.reduce(0, +)) ?? 0
        return ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }

    /// A portable copy of this app, so the pet can come out on Macs without DeskPet. Skipped if the same version is already there.
    static func copyApp(to folder: URL) throws {
        let dest = folder.appendingPathComponent(appCopyName)
        let version = { (url: URL) in Bundle(url: url)?.infoDictionary?["CFBundleShortVersionString"] as? String }
        if FileManager.default.fileExists(atPath: dest.path), version(dest) == version(Bundle.main.bundleURL) { return }
        try? FileManager.default.removeItem(at: dest)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        p.arguments = ["--norsrc", "--noextattr", "--noqtn", Bundle.main.bundleURL.path, dest.path]
        try p.run()
        p.waitUntilExit()
        if p.terminationStatus != 0 { throw error("couldn't copy DeskPet onto the drive") }
    }

    static func writeReadMe(to folder: URL, pet: String, owner: String) {
        let text = """
        \(pet) is on a trip with \(owner)! 🧳

        • On a computer with DeskPet: plug this drive in and DeskPet offers to let \(pet) out.
        • On a computer without it: open DeskPet.app (Mac), DeskPet-Windows\\DeskPet.exe (Windows), or DeskPet-Linux.AppImage (Linux) from this folder, if \(owner) packed one.
        • Quit DeskPet (or choose Go home) before ejecting the drive.
        • Back home: plug the drive in and \(pet) comes home and asks about your day.

        Please don't edit trip.json. https://github.com/jacobsekai/deskpet

        """
        try? text.write(to: folder.appendingPathComponent("Read me.txt"), atomically: false, encoding: .utf8)
    }

    /// The volume a path lives on, if it's one that can be ejected.
    static func ejectableVolume(of url: URL) -> URL? {
        guard let v = try? url.resourceValues(forKeys: [.volumeURLKey]), let vol = v.volume,
              let r = try? vol.resourceValues(forKeys: [.volumeIsEjectableKey, .volumeIsRemovableKey, .volumeIsRootFileSystemKey]),
              r.volumeIsRootFileSystem != true, r.volumeIsEjectable == true || r.volumeIsRemovable == true else { return nil }
        return vol
    }

    static func error(_ message: String) -> NSError {
        NSError(domain: "DeskPet", code: 7, userInfo: [NSLocalizedDescriptionKey: message])
    }

    static let iso = ISO8601DateFormatter()
}

// MARK: - Moving-homes files

/// `<Pet>.chr` (like Monika After Story's monika.chr): the transfer-key payload plus the sprite pack, in one JSON file.
enum MovingFile {
    /// `.deskpet` is what the first builds wrote.
    static let extensions: Set<String> = ["chr", "deskpet"]
    static let maxPackBytes = 40 * 1024 * 1024

    /// Builds the file. The note says if the sprite pack had to stay behind.
    static func make(profile: [String: Any], packName: String, device: String) -> (data: Data, note: String?) {
        var note: String?
        var pack: Any = NSNull()
        if !packName.isEmpty {
            let dir = SpritePack.root.appendingPathComponent(packName)
            var files: [String: String] = [:]
            var total = 0
            let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles])
            while let url = e?.nextObject() as? URL {
                let rel = String(url.standardizedFileURL.path.dropFirst(dir.standardizedFileURL.path.count + 1))
                if rel == "sliced" || rel.hasPrefix("sliced/") { e?.skipDescendants(); continue }
                guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
                      let data = try? Data(contentsOf: url) else { continue }
                total += data.count
                files[rel] = data.base64EncodedString()
            }
            if total > maxPackBytes {
                note = "packed! the \(packName) sprite pack is too big for the file, so move it separately (Look → Export)"
            } else if !files.isEmpty {
                pack = ["name": packName, "files": files]
            }
        }
        let file: [String: Any] = ["app": "deskpet", "kind": "home", "v": 1, "packed": TripFiles.iso.string(from: Date()),
                                   "from": "macOS", "device": device, "profile": profile, "pack": pack]
        let data = (try? JSONSerialization.data(withJSONObject: file, options: [.sortedKeys])) ?? Data()
        return (data, note)
    }

    static func read(_ url: URL) throws -> [String: Any] {
        guard let data = try? Data(contentsOf: url) else { throw TripFiles.error("couldn't open that file") }
        guard let file = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              file["app"] as? String == "deskpet", file["kind"] as? String == "home",
              let profile = file["profile"] as? [String: Any], profile["app"] as? String == "deskpet" else {
            throw TripFiles.error("that isn't a DeskPet moving-homes file")
        }
        return file
    }

    static func summary(_ file: [String: Any]) -> String {
        let base = TransferKey.summary(file["profile"] as? [String: Any] ?? [:])
        let pack = (file["pack"] as? [String: Any])?["name"] as? String
        return pack.map { "\(base) · brings the \($0) look" } ?? base
    }

    /// Writes the packed sprite pack into the sprites folder; returns its name.
    static func installPack(_ file: [String: Any]) throws -> String? {
        guard let pack = file["pack"] as? [String: Any], let raw = pack["name"] as? String,
              let files = pack["files"] as? [String: String] else { return nil }
        let name = (raw as NSString).lastPathComponent
        guard !name.isEmpty, name != "..", name != "." else { return nil }
        let dir = SpritePack.root.appendingPathComponent(name)
        for (rel, base64) in files {
            // Only plain relative paths inside the pack folder.
            let parts = rel.split(separator: "/", omittingEmptySubsequences: false)
            guard !rel.hasPrefix("/"), !parts.contains(where: { $0.isEmpty || $0 == ".." || $0 == "." }),
                  let data = Data(base64Encoded: base64) else { continue }
            let dest = dir.appendingPathComponent(rel)
            try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: dest, options: .atomic)
        }
        return name
    }
}

// MARK: - Hook repair

/// After DeskPet moves (say, into Applications), Claude Code's hooks still point at the old copy and every
/// prompt reports a failed hook. On launch, point hooks whose app no longer exists at this copy.
enum HookRepair {
    @discardableResult
    static func run(settingsURL: URL = HookInstaller.settingsURL, executable: String? = Bundle.main.executablePath) -> Int {
        guard let exe = executable, let data = try? Data(contentsOf: settingsURL),
              var settings = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              var hooks = settings["hooks"] as? [String: Any] else { return 0 }
        var fixed = 0
        let fm = FileManager.default
        func repair(_ command: String) -> String {
            // "\"/old/place/DeskPet.app/Contents/MacOS/DeskPet\" hook --agent claude"
            guard command.hasPrefix("\""), command.contains("\" hook --agent "),
                  let end = command.dropFirst().firstIndex(of: "\"") else { return command }
            let path = String(command[command.index(after: command.startIndex)..<end])
            guard path.hasSuffix("/Contents/MacOS/DeskPet"), path != exe, !fm.fileExists(atPath: path) else { return command }
            fixed += 1
            return "\"\(exe)\"" + command[command.index(after: end)...]
        }
        for (event, value) in hooks {
            guard let groups = value as? [[String: Any]] else { continue }
            hooks[event] = groups.map { group -> [String: Any] in
                var g = group
                g["hooks"] = (group["hooks"] as? [[String: Any]])?.map { h -> [String: Any] in
                    var h = h
                    if let c = h["command"] as? String { h["command"] = repair(c) }
                    return h
                } ?? group["hooks"]
                return g
            }
        }
        guard fixed > 0 else { return 0 }
        settings["hooks"] = hooks
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        try? fm.copyItem(at: settingsURL, to: settingsURL.appendingPathExtension("deskpet-backup-\(stamp)"))
        guard let out = try? JSONSerialization.data(withJSONObject: settings, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) else { return 0 }
        try? out.write(to: settingsURL, options: .atomic)
        return fixed
    }
}
