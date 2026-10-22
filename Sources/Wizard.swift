import AppKit
import WebKit

/// Hosts the shared HTML setup wizard (electron/src/wizard, copied into the app bundle by build.sh)
/// in a native window. The page calls `webkit.messageHandlers.deskpet.postMessage({id, action, payload})`
/// and gets answers through `window.__deskpetReply(id, result)`.
final class WizardController: NSObject, WKScriptMessageHandler, NSWindowDelegate {
    typealias Handler = (_ action: String, _ payload: [String: Any]) -> Any?

    private let window: NSWindow
    private let webView: WKWebView
    private let handler: Handler
    var onClose: (() -> Void)?

    init(handler: @escaping Handler) {
        self.handler = handler
        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 780, height: 540), configuration: config)
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 780, height: 540),
                          styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
        super.init()
        config.userContentController.add(self, name: "deskpet")
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.title = "Welcome to DeskPet"
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentView = webView
        window.center()
        if let web = Bundle.main.resourceURL?.appendingPathComponent("web") {
            webView.loadFileURL(web.appendingPathComponent("wizard/index.html"), allowingReadAccessTo: web)
        }
    }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func close() { window.close() }

    /// `open DeskPet.app --args wizard-snapshot`: screenshots each step to ~/.deskpet/wizard-snapshots, then quits.
    func snapshotSteps(step: Int = 0) {
        let out = DeskPetPaths.root.appendingPathComponent("wizard-snapshots")
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        guard step < 6 else { return NSApp.terminate(nil) }
        webView.evaluateJavaScript("window.__wizardGo(\(step))")
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [self] in
            webView.takeSnapshot(with: nil) { image, _ in
                if let tiff = image?.tiffRepresentation, let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
                    try? png.write(to: out.appendingPathComponent("wizard-\(step).png"))
                }
                self.snapshotSteps(step: step + 1)
            }
        }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let id = body["id"] as? Int,
              let action = body["action"] as? String else { return }
        let result = handler(action, body["payload"] as? [String: Any] ?? [:]) ?? NSNull()
        guard let data = try? JSONSerialization.data(withJSONObject: ["r": result]),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__deskpetReply(\(id), \(json).r)")
    }

    func windowWillClose(_ notification: Notification) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "deskpet")
        onClose?()
    }
}

/// Adds or removes DeskPet's Claude Code hooks in ~/.claude/settings.json (the native twin of install-hooks.py).
enum HookInstaller {
    static let settingsURL = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".claude/settings.json")

    private static let events: [(name: String, matcher: String)] = [
        ("SessionStart", ""), ("UserPromptSubmit", ""), ("PreToolUse", ""), ("PostToolUse", ""), ("PostToolUseFailure", ""),
        ("PermissionRequest", ""), ("Notification", "permission_prompt"), ("SubagentStart", ""), ("SubagentStop", ""),
        ("Stop", ""), ("StopFailure", ""), ("PreCompact", ""), ("SessionEnd", ""),
    ]

    private static func isDeskPet(_ group: Any) -> Bool {
        let hooks = (group as? [String: Any])?["hooks"] as? [[String: Any]] ?? []
        return hooks.contains { ($0["command"] as? String ?? "").contains("DeskPet.app") }
    }

    private static func readSettings() throws -> [String: Any] {
        guard let data = try? Data(contentsOf: settingsURL) else { return [:] }
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw NSError(domain: "DeskPet", code: 2, userInfo: [NSLocalizedDescriptionKey: "settings.json isn't a JSON object, so it was left unchanged"])
        }
        return obj
    }

    static func installed() -> Bool {
        let hooks = (try? readSettings())?["hooks"] as? [String: Any] ?? [:]
        return hooks.values.contains { ($0 as? [Any] ?? []).contains(where: isDeskPet) }
    }

    static func setInstalled(_ install: Bool) throws {
        let fm = FileManager.default
        var settings = try readSettings()
        if fm.fileExists(atPath: settingsURL.path) {
            let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
            try? fm.copyItem(at: settingsURL, to: settingsURL.appendingPathExtension("deskpet-backup-\(stamp)"))
        } else {
            try fm.createDirectory(at: settingsURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        }

        let command = "\"\(Bundle.main.executablePath ?? "")\" hook --agent claude"
        var hooks = settings["hooks"] as? [String: Any] ?? [:]
        for event in events {
            var groups = (hooks[event.name] as? [Any] ?? []).filter { !isDeskPet($0) }
            if install {
                groups.append(["matcher": event.matcher, "hooks": [["type": "command", "command": command, "timeout": 2]]])
            }
            hooks[event.name] = groups.isEmpty ? nil : groups
        }
        settings["hooks"] = hooks.isEmpty ? nil : hooks

        let data = try JSONSerialization.data(withJSONObject: settings, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])
        try data.write(to: settingsURL, options: .atomic)
    }

    /// Any agent wrote session state in the last 10 minutes.
    static func live() -> Bool {
        let files = (try? FileManager.default.contentsOfDirectory(at: DeskPetPaths.sessions, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        let cutoff = Date().addingTimeInterval(-600)
        return files.contains { url in
            url.pathExtension == "json"
                && ((try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) > cutoff
        }
    }
}
