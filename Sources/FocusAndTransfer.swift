import AppKit

// MARK: - Focus blocklist

enum Blocklist {
    static let defaults = ["youtube.com", "reddit.com", "x.com", "twitter.com", "instagram.com",
                           "tiktok.com", "facebook.com", "netflix.com", "twitch.tv"]

    /// "https://www.youtube.com/watch?v=…" -> "youtube.com" if it (or a subdomain) is listed.
    static func match(url: String, in list: [String]) -> String? {
        guard let host = URL(string: url)?.host?.lowercased() else { return nil }
        let h = host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
        return list.first { h == $0 || h.hasSuffix("." + $0) }
    }

    /// Cleans user input: one domain per line, "https://www.Reddit.com/r/x" -> "reddit.com".
    static func parse(_ text: String) -> [String] {
        var seen = Set<String>()
        return text.split(whereSeparator: { $0 == "\n" || $0 == "," || $0 == " " }).compactMap { raw in
            var s = raw.trimmingCharacters(in: .whitespaces).lowercased()
            if let host = URL(string: s.contains("://") ? s : "https://" + s)?.host { s = host }
            if s.hasPrefix("www.") { s.removeFirst(4) }
            guard s.contains("."), seen.insert(s).inserted else { return nil }
            return s
        }
    }
}

/// Reads (and optionally closes) the active tab of scriptable browsers. macOS asks once per
/// browser for permission ("DeskPet wants to control Google Chrome").
enum BrowserWatcher {
    private static let safari: Set<String> = ["com.apple.Safari", "com.apple.SafariTechnologyPreview"]
    private static let chromium: Set<String> = ["com.google.Chrome", "com.google.Chrome.canary", "com.microsoft.edgemac",
                                                "com.brave.Browser", "company.thebrowser.Browser", "com.vivaldi.Vivaldi",
                                                "com.operasoftware.Opera"]
    /// AppleScript isn't thread-safe and can block on permission prompts, so it runs on one background queue.
    private static let queue = DispatchQueue(label: "deskpet.browser")

    static func isBrowser(_ app: NSRunningApplication?) -> Bool {
        guard let id = app?.bundleIdentifier else { return false }
        return safari.contains(id) || chromium.contains(id)
    }

    static func activeURL(of app: NSRunningApplication, completion: @escaping (String?) -> Void) {
        guard let id = app.bundleIdentifier else { return completion(nil) }
        let tab = safari.contains(id) ? "current tab" : "active tab"
        run("tell application id \"\(id)\" to get URL of \(tab) of front window") { completion($0) }
    }

    static func closeActiveTab(of app: NSRunningApplication) {
        guard let id = app.bundleIdentifier else { return }
        let tab = safari.contains(id) ? "current tab" : "active tab"
        run("tell application id \"\(id)\" to close \(tab) of front window") { _ in }
    }

    private static func run(_ source: String, completion: @escaping (String?) -> Void) {
        queue.async {
            var error: NSDictionary?
            let result = NSAppleScript(source: source)?.executeAndReturnError(&error).stringValue
            DispatchQueue.main.async { completion(error == nil ? result : nil) }
        }
    }
}

// MARK: - Transfer key

/// Moves names, stats, and settings between devices (macOS and Windows) as one pasteable string:
/// "DESKPET-1:" + base64url(raw DEFLATE(JSON)). Sprite pack images stay out (export packs as zips).
enum TransferKey {
    static let prefix = "DESKPET-1:"

    /// Settings that make sense on another machine (no window positions, hooks, or login items).
    static let settingKeys = ["spritePack", "themeColor", "thoughtBubble", "wander", "gravity", "walkOnWindows",
                              "quietInCalls", "notifications", "sounds", "autoUpdate", "blocklist", "strictBlock"]

    static func encode(_ payload: [String: Any]) throws -> String {
        let json = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        let compressed = try (json as NSData).compressed(using: .zlib) as Data
        let base64 = compressed.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
        return prefix + base64
    }

    static func decode(_ key: String) throws -> [String: Any] {
        let clean = key.components(separatedBy: .whitespacesAndNewlines).joined()
        guard clean.hasPrefix(prefix) else { throw error("that doesn't look like a DeskPet transfer key") }
        var base64 = String(clean.dropFirst(prefix.count)).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        base64 += String(repeating: "=", count: (4 - base64.count % 4) % 4)
        guard let data = Data(base64Encoded: base64),
              let json = try? (data as NSData).decompressed(using: .zlib) as Data,
              let payload = try? JSONSerialization.jsonObject(with: json) as? [String: Any],
              payload["app"] as? String == "deskpet" else {
            throw error("the key is incomplete or mistyped; copy it again")
        }
        return payload
    }

    /// "Mochi · Lv 4 (812 XP) · 23 days of stats"
    static func summary(_ payload: [String: Any]) -> String {
        let config = payload["config"] as? [String: Any] ?? [:]
        let stats = payload["stats"] as? [String: Any] ?? [:]
        let xp = stats["xp"] as? Int ?? 0
        let days = (stats["days"] as? [String: Any])?.count ?? 0
        return "\(config["petName"] as? String ?? "Mochi") · Lv \(Stats.level(for: xp)) (\(xp) XP) · \(days) day\(days == 1 ? "" : "s") of stats"
    }

    private static func error(_ message: String) -> NSError {
        NSError(domain: "DeskPet", code: 4, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
