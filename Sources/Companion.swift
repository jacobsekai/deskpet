import AppKit
import JavaScriptCore
import WebKit

/// Runs the shared companion engine (electron/src/companion/engine.js, copied into the app bundle by build.sh)
/// in JavaScriptCore: conversations, affection, memories, reminders, and remarks about your day.
/// The same file runs in the Windows/Linux app, so both talk exactly alike.
final class Companion {
    static let stateURL = DeskPetPaths.root.appendingPathComponent("companion.json")

    private let context = JSContext()!
    private var engine: JSValue?

    init() {
        context.exceptionHandler = { _, exception in
            NSLog("DeskPet companion: \(exception?.toString() ?? "unknown error")")
        }
        guard let web = Bundle.main.resourceURL?.appendingPathComponent("web/companion"),
              let script = try? String(contentsOf: web.appendingPathComponent("engine.js"), encoding: .utf8) else { return }
        context.evaluateScript(script)

        // State and personalities go over as JSON text: bridging Foundation dictionaries turns every empty
        // `{}` into one shared JavaScript object, which tangled memories and milestones together.
        var personalities: [String: Any] = [:]
        let dir = web.appendingPathComponent("personalities")
        for url in (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [] where url.pathExtension == "json" {
            if let obj = Self.readJSON(url) { personalities[url.deletingPathExtension().lastPathComponent] = obj }
        }
        let save: @convention(block) (String) -> Void = { json in
            try? FileManager.default.createDirectory(at: DeskPetPaths.root, withIntermediateDirectories: true)
            try? Data(json.utf8).write(to: Self.stateURL, options: .atomic)
        }
        let host = JSValue(newObjectIn: context)!
        host.setObject(save, forKeyedSubscript: "save" as NSString)
        host.setObject("mac", forKeyedSubscript: "platform" as NSString)
        var options: [String: Any] = ["personalities": Self.json(personalities), "personality": "cat"]
        if let state = try? String(contentsOf: Self.stateURL, encoding: .utf8) { options["state"] = state }
        let opts = JSValue(object: options, in: context)!
        opts.setObject(host, forKeyedSubscript: "host" as NSString)
        engine = context.objectForKeyedSubscript("DeskPetCompanion")?.invokeMethod("create", withArguments: [opts])
    }

    private static func json(_ object: Any) -> String {
        (try? JSONSerialization.data(withJSONObject: object)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }

    private static func readJSON(_ url: URL) -> Any? {
        (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) }
    }

    private func call(_ method: String, _ args: [Any] = []) -> JSValue? {
        engine?.invokeMethod(method, withArguments: args)
    }

    private func effects(_ value: JSValue?) -> [[String: Any]] {
        value?.toArray()?.compactMap { $0 as? [String: Any] } ?? []
    }

    func tick(_ ctx: [String: Any]) -> [[String: Any]] { effects(call("tick", [ctx])) }
    func event(_ name: String, _ data: [String: Any] = [:]) -> [[String: Any]] { effects(call("event", [name, data])) }

    func ui(_ action: String, _ payload: [String: Any]) -> (result: Any?, effects: [[String: Any]]) {
        guard let r = call("ui", [action, payload])?.toDictionary() as? [String: Any] else { return (nil, []) }
        let result = r["result"].flatMap { $0 is NSNull ? nil : $0 }
        return (result, (r["effects"] as? [Any])?.compactMap { $0 as? [String: Any] } ?? [])
    }

    func line(_ key: String, _ fallback: String) -> String {
        let v = call("line", [key, fallback])
        return v?.isString == true ? v!.toString() : fallback
    }

    var hasOffer: Bool { call("hasOffer")?.toBool() ?? false }
    func summary() -> [String: Any] { call("summary")?.toDictionary() as? [String: Any] ?? [:] }
    func exportData() -> [String: Any] { call("exportData")?.toDictionary() as? [String: Any] ?? [:] }
    func mergeData(_ data: [String: Any]) { _ = call("mergeData", [Self.json(data)]) }
    func replaceData(_ data: [String: Any]) { _ = call("replaceData", [Self.json(data)]) }
    func setNames(owner: String, pet: String) { _ = call("setNames", [owner, pet]) }
    func flush() { _ = call("flush") }

    /// The built-in cat talks like a cat. A sprite pack can ship its own dialogue.json (which extends a built-in
    /// personality), or name one in pack.json ("personality": "minori"); packs named Minori get hers.
    func setPersonality(forPack name: String, override: String? = nil) {
        let (personality, source) = Self.personality(forPack: name, override: override)
        _ = call("setPersonality", [personality, source])
    }

    private static func personality(forPack name: String, override: String?) -> (Any, String) {
        if let override { return (override, "command line") }
        if name.isEmpty { return ("cat", "built-in cat") }
        let dir = SpritePack.root.appendingPathComponent(name)
        if var custom = readJSON(dir.appendingPathComponent("dialogue.json")) as? [String: Any] {
            if custom["extends"] == nil { custom["extends"] = "friend" }
            if custom["name"] == nil { custom["name"] = name }
            return (custom, "\(name)/dialogue.json")
        }
        if let id = (readJSON(dir.appendingPathComponent("pack.json")) as? [String: Any])?["personality"] as? String {
            return (id, "\(name)/pack.json")
        }
        return name.range(of: "minori", options: .caseInsensitive) != nil ? ("minori", "matched by name") : ("friend", "default")
    }

    /// Dialogue moods arrive as pose names.
    static func mood(_ name: String) -> Mood? {
        let moods: [String: Mood] = [
            "idle": .idle, "petted": .petted, "done": .done, "thinking": .thinking, "sleepy": .sleepy, "startled": .startled,
            "oops": .oops, "reading": .reading, "dizzy": .dizzy, "typing": .typing, "sleeping": .sleeping, "needsYou": .needsYou,
        ]
        return moods[name]
    }
}

/// The talk window: the shared HTML in electron/src/companion/talk.html in a borderless, see-through panel
/// that sits beside the pet. Speaks the same `{id, action, payload}` bridge as the control center.
final class TalkWindow: NSObject, WKScriptMessageHandler {
    private final class Panel: NSPanel {
        override var canBecomeKey: Bool { true }
    }

    static let width: CGFloat = 460
    private let window: Panel
    private let webView: WKWebView
    private let handler: WizardController.Handler
    var onClose: (() -> Void)?

    init(frame: NSRect, handler: @escaping WizardController.Handler) {
        self.handler = handler
        let config = WKWebViewConfiguration()
        webView = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]
        window = Panel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        config.userContentController.add(self, name: "deskpet")
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.level = .floating
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.contentView = webView
        if let web = Bundle.main.resourceURL?.appendingPathComponent("web") {
            webView.loadFileURL(web.appendingPathComponent("companion/talk.html"), allowingReadAccessTo: web)
        }
    }

    var isVisible: Bool { window.isVisible }
    var frame: NSRect { window.frame }

    func show() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func close() {
        guard window.isVisible else { return }
        window.orderOut(nil)
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "deskpet")
        onClose?()
    }

    func run(_ script: String) { webView.evaluateJavaScript(script) }

    /// Grows or shrinks upward, keeping the bottom edge where it is.
    func setHeight(_ height: CGFloat) {
        var f = window.frame
        f.size.height = height
        if let vf = window.screen?.visibleFrame { f.origin.y = min(f.origin.y, vf.maxY - height) }
        window.setFrame(f, display: true)
    }

    /// `open DeskPet.app --args talk-snapshot`: screenshots a few talk states to ~/.deskpet/talk-snapshots, then quits.
    func snapshot(steps: [(String, String)]) {
        let out = DeskPetPaths.root.appendingPathComponent("talk-snapshots")
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        guard let (name, script) = steps.first else { return NSApp.terminate(nil) }
        if !script.isEmpty { webView.evaluateJavaScript(script) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [self] in
            if let cg = CGWindowListCreateImage(.null, .optionIncludingWindow, CGWindowID(window.windowNumber), [.boundsIgnoreFraming, .bestResolution]),
               let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) {
                try? png.write(to: out.appendingPathComponent("talk-\(name).png"))
            }
            snapshot(steps: Array(steps.dropFirst()))
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
}
