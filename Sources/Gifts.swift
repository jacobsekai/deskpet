import Foundation

/// MAS-style gifts: files named after the gift, ending in .gift, in ~/.deskpet/gifts. Given gifts move to given/.
/// Same rules as the Windows/Linux app (gifts in main.js); the companion engine decides how the pet reacts.
enum GiftFiles {
    static let folder = DeskPetPaths.home.appendingPathComponent("gifts")

    /// Makes sure the folder (and its how-to note) exists.
    @discardableResult
    static func ensureFolder() -> URL {
        let fm = FileManager.default
        try? fm.createDirectory(at: folder.appendingPathComponent("given"), withIntermediateDirectories: true)
        let note = folder.appendingPathComponent("How to give gifts.txt")
        if !fm.fileExists(atPath: note.path) {
            let text = """
            Give your pet a gift:
            1. Make a file named after the gift, ending in .gift (for example salmon_bento.gift or Haruka Merch.gift).
               An empty file is fine. The control center (Companion → Gifts) can make one for you.
            2. Talk to your pet → "I'd like to give you a gift" → choose the file (or drop it onto the pet).
            Gifts unlock once you're friends; some need a closer bond. Given gifts move to the "given" folder.

            """
            try? text.write(to: note, atomically: true, encoding: .utf8)
        }
        return folder
    }

    /// "salmon bento" → a new empty salmon_bento.gift (or salmon_bento 2.gift if it exists).
    static func make(_ raw: String) -> URL? {
        let name = raw.replacingOccurrences(of: ".gift", with: "", options: .caseInsensitive)
            .components(separatedBy: CharacterSet.alphanumerics.union(.init(charactersIn: " -_")).inverted).joined()
            .trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return nil }
        ensureFolder()
        var url = folder.appendingPathComponent("\(name).gift")
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = folder.appendingPathComponent("\(name) \(n).gift")
            n += 1
        }
        return FileManager.default.createFile(atPath: url.path, contents: Data()) ? url : nil
    }

    /// Moves a given gift out of the way (like MAS deleting it), keeping it in given/.
    static func consume(_ url: URL) {
        ensureFolder()
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let dest = folder.appendingPathComponent("given").appendingPathComponent("\(url.deletingPathExtension().lastPathComponent) \(stamp).gift")
        if (try? FileManager.default.moveItem(at: url, to: dest)) == nil { try? FileManager.default.removeItem(at: url) }
    }

    /// A safe topic id for the talk window: letters, digits, and underscores.
    static func topicID(_ url: URL) -> String {
        url.deletingPathExtension().lastPathComponent.lowercased()
            .components(separatedBy: CharacterSet.alphanumerics.inverted).filter { !$0.isEmpty }.joined(separator: "_")
    }
}
