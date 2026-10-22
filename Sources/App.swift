import AppKit
import ServiceManagement
import SwiftUI
import UniformTypeIdentifiers

struct Config {
    var ownerName: String
    var petName: String
    var spritePack: String
    var themeColor: String

    /// Merges changes into config.json (shared with the Windows app).
    static func save(_ changes: [String: Any]) {
        var obj = (try? Data(contentsOf: DeskPetPaths.config))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        obj.merge(changes) { _, new in new }
        try? FileManager.default.createDirectory(at: DeskPetPaths.root, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) {
            try? data.write(to: DeskPetPaths.config, options: .atomic)
        }
    }

    static func load() -> Config {
        let obj = (try? Data(contentsOf: DeskPetPaths.config))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let first = NSFullUserName().split(separator: " ").first.map(String.init) ?? "friend"
        return Config(ownerName: obj["ownerName"] as? String ?? first, petName: obj["petName"] as? String ?? "Mochi",
                      spritePack: obj["spritePack"] as? String ?? "",
                      themeColor: obj["themeColor"] as? String ?? "")
    }
}

/// What the frontmost app says about what you're doing.
enum AppCategory {
    case music, code, browser, chat, meeting, other

    init(_ app: NSRunningApplication?) {
        let s = ((app?.bundleIdentifier ?? "") + " " + (app?.localizedName ?? "")).lowercased()
        func has(_ keys: [String]) -> Bool { keys.contains { s.contains($0) } }
        if has(["spotify", "com.apple.music", "tidal", "deezer", "soundcloud", "podcasts"]) { self = .music }
        else if has(["zoom.us", "webex", "facetime"]) { self = .meeting }
        else if has(["terminal", "iterm", "vscode", "visual studio", "kiro", "t3 code", "xcode", "jetbrains", "intellij",
                     "pycharm", "cursor", "ghostty", "warp", "zed", "sublime", "alacritty", "kitty", "wezterm"]) { self = .code }
        else if has(["safari", "chrome", "firefox", "thebrowser", "edge", "brave", "opera"]) { self = .browser }
        else if has(["slack", "chime", "outlook", "com.apple.mail", "messages", "teams", "discord"]) { self = .chat }
        else { self = .other }
    }

    var remarks: [String] {
        switch self {
        case .music: return ["🎵 ooh, tunes!", "dance break? 💃", "turn it up! 🎶"]
        case .code: return ["let's build something! 💻", "coding time ⌨️", "go go go! 🚀"]
        case .browser: return ["whatcha looking up? 🔎", "find anything cool?"]
        case .chat: return ["say hi for me 👋", "ooh, gossip? 👀"]
        case .meeting: return ["🤫 I'll be quiet", "good luck in your meeting!"]
        case .other: return []
        }
    }
}

private final class PetPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate, PetViewDelegate {
    private var size = NSSize(width: 260, height: 220)
    private var panel: PetPanel!
    private var petView: PetView!
    private var statusItem: NSStatusItem!
    private let agents = AgentMonitor()
    private var config = Config.load()
    private var wizard: WizardController?
    private let defaults = UserDefaults.standard

    private var lastTick = CACurrentMediaTime()
    private var lastLogic = 0.0
    private var mood: Mood = .idle
    private var sessions: [AgentSession] = []
    private var known: [String: (name: String, activity: AgentActivity)] = [:]
    private var busySince: [String: Double] = [:]
    private var transient: (mood: Mood, until: Double)?
    private var speech: (text: String, until: Double)?
    private var accessory: Accessory = .none
    private var night = false

    private var walkTarget: CGFloat?
    private var walkDirection: CGFloat = 1
    private var nextWalkAt = CACurrentMediaTime() + 25
    /// Set while the pet is thrown or falling, in points per second.
    private var velocity: CGVector?
    private var spin: CGFloat = 0
    private var bounces = 0
    private var lastBumpRemark = 0.0

    private var wasAsleep = false
    private var lastRemark = 0.0
    private var lastNightNag = -10_000.0
    private var streakStart = CACurrentMediaTime()
    private var spriteFingerprint = Date.distantPast
    private var lastSpriteCheck = 0.0

    private let notifier = Notifier()
    private let sounds = SoundPlayer()
    private let stats = Stats()
    private let focus = FocusTimer()
    private let updater = Updater()
    private let transcriptTokens = TranscriptTokens()
    private let hoverCard = HoverCard()
    private var hoverBegan: Double?
    private var hoverLeftAt: Double?
    private var inCall = false
    private var lastCallCheck = 0.0
    private var lastMinute = CACurrentMediaTime()
    private var lastStatsSave = 0.0
    private var lastKiroCheck = 0.0
    private var updateAnnounced = false
    /// The window the pet is standing on, and where it was last seen.
    private var perch: (id: Int, rect: NSRect)?
    private var platforms: [Platform] = []
    private var lastPlatformScan = 0.0

    private var wander: Bool {
        get { defaults.object(forKey: "wander") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "wander") }
    }
    /// Name of the folder in ~/.deskpet/sprites to use, or "" for the built-in cat.
    private var spritePackName: String {
        get { defaults.string(forKey: "spritePack") ?? config.spritePack }
        set { defaults.set(newValue, forKey: "spritePack") }
    }
    /// Hex accent color, or "" for the built-in colors.
    private var themeHex: String {
        get { defaults.string(forKey: "themeColor") ?? config.themeColor }
        set { defaults.set(newValue, forKey: "themeColor") }
    }
    private var thoughtBubble: ThoughtBubbleSize {
        get { ThoughtBubbleSize(rawValue: defaults.string(forKey: "thoughtBubble") ?? "") ?? .large }
        set { defaults.set(newValue.rawValue, forKey: "thoughtBubble") }
    }
    private var gravity: Bool {
        get { defaults.object(forKey: "gravity") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "gravity") }
    }
    private func flag(_ key: String, _ fallback: Bool) -> Bool { defaults.object(forKey: key) as? Bool ?? fallback }
    private var notificationsOn: Bool { get { flag("notifications", true) } set { defaults.set(newValue, forKey: "notifications") } }
    private var soundsOn: Bool { get { flag("sounds", true) } set { defaults.set(newValue, forKey: "sounds"); sounds.enabled = newValue } }
    private var walkOnWindows: Bool { get { flag("walkOnWindows", true) } set { defaults.set(newValue, forKey: "walkOnWindows") } }
    private var quietInCalls: Bool { get { flag("quietInCalls", true) } set { defaults.set(newValue, forKey: "quietInCalls") } }
    private var autoUpdate: Bool { get { flag("autoUpdate", true) } set { defaults.set(newValue, forKey: "autoUpdate") } }
    private var kiroHooksOn: Bool { get { flag("kiroHooks", false) } set { defaults.set(newValue, forKey: "kiroHooks") } }
    /// On a call: no sounds and no chatty remarks.
    private var quiet: Bool { quietInCalls && inCall }

    private var topSession: AgentSession? { sessions.max { $0.activity.rawValue < $1.activity.rawValue } }

    // MARK: - Lifecycle

    func applicationDidFinishLaunching(_ notification: Notification) {
        if let id = Bundle.main.bundleIdentifier,
           NSRunningApplication.runningApplications(withBundleIdentifier: id).count > 1 {
            NSApp.terminate(nil)
            return
        }
        NSApp.setActivationPolicy(.accessory)
        try? FileManager.default.createDirectory(at: SpritePack.root, withIntermediateDirectories: true)
        setupPanel()
        loadSprites(announce: false)
        petView.theme = Theme(hex: themeHex) ?? .default
        petView.thoughtBubble = thoughtBubble
        setupStatusItem()
        observeWorkspace()
        accessory = Self.accessory(for: AppCategory(NSWorkspace.shared.frontmostApplication))
        if CommandLine.arguments.contains("wizard-snapshot") {
            openWizard()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.wizard?.snapshotSteps() }
        } else if defaults.bool(forKey: "setupComplete") {
            say("hi \(config.ownerName)! 👋", for: 4)
        } else {
            openWizard()
        }

        let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)

        sounds.enabled = soundsOn
        notifier.onClick = { [weak self] pid in self?.jump(to: pid) }
        if notificationsOn && defaults.bool(forKey: "setupComplete") { notifier.requestPermission() }
        hoverCard.model.onSelect = { [weak self] pid in self?.jump(to: pid) }
        if kiroHooksOn { KiroHooks.apply(true) }
        // Last time it may have been standing on a window; drop onto whatever is there now.
        if gravity && panel.frame.minY > petScreen().visibleFrame.minY + 2 { velocity = .zero }
        if autoUpdate { DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in self?.checkForUpdates(manual: false) } }
        Timer.scheduledTimer(withTimeInterval: 6 * 3600, repeats: true) { [weak self] _ in
            if self?.autoUpdate == true { self?.checkForUpdates(manual: false) }
        }
    }

    private func setupPanel() {
        panel = PetPanel(contentRect: NSRect(origin: initialOrigin(), size: size),
                         styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isMovable = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        petView = PetView(frame: NSRect(origin: .zero, size: size))
        petView.delegate = self
        panel.contentView = petView
        panel.orderFrontRegardless()
    }

    private func initialOrigin() -> NSPoint {
        if let x = defaults.object(forKey: "originX") as? Double, let y = defaults.object(forKey: "originY") as? Double {
            let saved = NSRect(origin: NSPoint(x: x, y: y), size: size)
            if NSScreen.screens.contains(where: { $0.frame.intersects(saved) }) { return saved.origin }
        }
        let vf = (NSScreen.main ?? NSScreen.screens[0]).visibleFrame
        return NSPoint(x: vf.maxX - size.width - 60, y: vf.minY)
    }

    private func setupStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "🐾"
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    private func observeWorkspace() {
        let nc = NSWorkspace.shared.notificationCenter
        nc.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] n in
            self?.appActivated(n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)
        }
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification] {
            nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                guard let self else { return }
                self.transient = (.startled, CACurrentMediaTime() + 1.2)
                self.say("welcome back! ☀️", for: 4)
            }
        }
    }

    // MARK: - Main loop

    private func tick() {
        let now = CACurrentMediaTime()
        let dt = min(0.1, now - lastTick)
        lastTick = now
        if now - lastLogic >= 0.25 {
            lastLogic = now
            think(now)
        }
        move(dt: dt, now: now)
        updateMousePassThrough()
        updateHoverCard(now)
        petView.pose = pose(now)
        petView.needsDisplay = true
    }

    /// Re-evaluates agents and user activity, then picks the pet's mood.
    private func think(_ now: Double) {
        if !spritePackName.isEmpty && now - lastSpriteCheck > 2 {
            lastSpriteCheck = now
            if SpritePack.fingerprint(spritePackName) != spriteFingerprint { loadSprites(announce: true) }
        }
        agents.scanIfNeeded(now: now)
        sessions = agents.sessions()
        if agents.scanCount > 0 { handleAgentChanges(now) }

        let idle = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
        let sinceKey = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)

        if wasAsleep && idle < 1 {
            wasAsleep = false
            transient = (.startled, now + 1.2)
            say("huh?! oh, hi! 😳", for: 3)
            sounds.play(.wake)
        }
        if idle > 240 && topSession.map({ $0.activity == .idle }) ?? true { wasAsleep = true }

        if idle > 300 {
            streakStart = now
        } else if now - streakStart > 50 * 60 {
            streakStart = now
            if !quiet && focus.phase == .off { say("50 minutes straight — stretch break? 🙆", for: 6) }
        }

        let hour = Calendar.current.component(.hour, from: Date())
        night = hour >= 23 || hour < 6
        if night && idle < 5 && now - lastNightNag > 3600 && !quiet {
            lastNightNag = now
            say("it's late, \(config.ownerName)… bedtime soon? 🌙", for: 5)
        }

        if now - lastCallCheck > 2 {
            lastCallCheck = now
            inCall = CallDetector.inCall()
            sounds.muted = quiet
        }
        if let finished = focus.tick() {
            if finished == .focus {
                transient = (.done, now + 3)
                say("focus session done! take a break ☕", for: 5)
                sounds.play(.focusDone)
                post("Focus session done", "Take a \(max(5, focus.minutes / 5)) minute break ☕", pid: 0)
                levelUp(stats.record(xp: 15) { $0.focusSessions += 1 })
            } else {
                say("break's over! ready for another round? 💪", for: 5)
                post("Break's over", "Ready for another focus session?", pid: 0)
            }
        }
        if now - lastMinute >= 60 {
            lastMinute = now
            let agentsBusy = sessions.contains { $0.activity != .idle && $0.activity != .done }
            levelUp(stats.record(xp: agentsBusy ? 1 : 0) {
                if idle < 60 { $0.activeMinutes += 1 }
                if agentsBusy { $0.agentMinutes += 1 }
            })
        }
        if now - lastStatsSave > 30 {
            lastStatsSave = now
            stats.saveIfNeeded()
        }
        if kiroHooksOn && now - lastKiroCheck > 600 {
            lastKiroCheck = now
            KiroHooks.apply(true) // tools like `aim` regenerate Kiro agent files
        }

        mood = resolveMood(now: now, idle: idle, sinceKey: sinceKey)
        if mood == .idle && wander && !panel.isMiniaturized && now > nextWalkAt && velocity == nil && !petView.resizing { startWalk(now) }
        if perch != nil && !walkOnWindows { dropFromPerch() }
    }

    private func resolveMood(now: Double, idle: Double, sinceKey: Double) -> Mood {
        if petView.resizing { return petView.dragging ? .dragged : .idle }
        if petView.dragging { return .dragged }
        if velocity != nil { return .flying }
        if let t = transient, t.until > now { return t.mood }
        if let top = topSession, top.activity != .idle { return Self.mood(for: top.activity) }
        if idle > 240 { return .sleeping }
        if idle > 75 { return .sleepy }
        if walkTarget != nil { return .walking }
        if sinceKey < 1.2 { return .userTyping }
        return .idle
    }

    private static func mood(for activity: AgentActivity) -> Mood {
        switch activity {
        case .idle: return .idle
        case .done: return .done
        case .tidying: return .tidying
        case .thinking: return .thinking
        case .reading: return .reading
        case .searching: return .searching
        case .delegating: return .delegating
        case .typing: return .typing
        case .oops: return .oops
        case .error: return .error
        case .needsYou: return .needsYou
        }
    }

    private func handleAgentChanges(_ now: Double) {
        let firstPass = known.isEmpty && busySince.isEmpty && agents.scanCount == 1
        var current: [String: (name: String, activity: AgentActivity)] = [:]
        for s in sessions {
            current[s.id] = (s.name, s.activity)
            let wasBusy = known[s.id].map { $0.activity != .idle } ?? false
            if s.activity != .idle && !wasBusy { busySince[s.id] = now }
            guard !firstPass else { continue }
            guard let previous = known[s.id] else {
                say("\(s.name) showed up 👀", for: 3.5)
                continue
            }
            guard previous.activity != s.activity else { continue }
            let project = s.project.isEmpty ? s.name : s.project
            switch s.activity {
            case .done:
                say("\(s.name) is done! ✨", for: 4)
                taskFinished(s, project: project)
            case .needsYou:
                say("\(s.name) needs you! 🙋", for: 5)
                sounds.play(.needsYou)
                postUnlessWatching(s, title: "\(s.name) needs you", body: "\(project): \(s.detail)")
            case .error:
                say("uh oh, \(s.name) hit an error 😵", for: 4)
                postUnlessWatching(s, title: "\(s.name) hit an error", body: project)
            case .idle where !s.precise && now - (busySince[s.id] ?? now) > 15:
                say("\(s.name) looks done ✨", for: 4)
                transient = (.done, now + 3)
                taskFinished(s, project: project)
            default: break
            }
        }
        if !firstPass {
            for (id, old) in known where current[id] == nil { say("bye, \(old.name)! 👋", for: 3) }
        }
        busySince = busySince.filter { current[$0.key] != nil }
        known = current
    }

    private func pose(_ now: Double) -> PetPose {
        var p = PetPose()
        p.mood = mood
        p.accessory = accessory
        p.nightcap = night
        p.facingLeft = walkDirection < 0
        p.look = lookVector()
        p.spin = spin
        if let top = topSession, top.activity != .idle {
            let others = sessions.filter { $0.activity != .idle }.count - 1
            p.caption = "\(top.name): \(top.detail)" + (others > 0 ? "  +\(others)" : "")
            p.captionColor = Self.color(for: top.activity)
            p.subagents = top.subagents
        }
        if p.caption == nil && focus.phase != .off {
            p.caption = focus.label
            p.captionColor = focus.phase == .focus ? .systemRed : .systemBrown
        }
        if let s = speech, s.until > now { p.bubble = s.text }
        return p
    }

    private static func color(for activity: AgentActivity) -> NSColor {
        switch activity {
        case .needsYou: return .systemOrange
        case .error, .oops: return .systemRed
        case .done: return .systemGreen
        case .thinking: return .systemPurple
        case .typing: return .systemBlue
        case .reading, .searching: return .systemTeal
        case .delegating: return .systemIndigo
        case .tidying, .idle: return .systemGray
        }
    }

    private func lookVector() -> CGPoint {
        let m = NSEvent.mouseLocation
        let eye = NSPoint(x: panel.frame.minX + petView.eyePosition.x, y: panel.frame.minY + petView.eyePosition.y)
        let dx = m.x - eye.x, dy = m.y - eye.y
        let d = hypot(dx, dy)
        guard d > 1 else { return .zero }
        let f = min(1, d / 150)
        return CGPoint(x: dx / d * f, y: dy / d * f)
    }

    /// Clicks only land on the pet itself; the rest of the window is click-through.
    private func updateMousePassThrough() {
        let m = NSEvent.mouseLocation
        let local = NSPoint(x: m.x - panel.frame.minX, y: m.y - panel.frame.minY)
        let over = petView.dragging || petView.hitRect.contains(local)
        if panel.ignoresMouseEvents == over { panel.ignoresMouseEvents = !over }
    }

    // MARK: - Sprites

    private func loadSprites(announce: Bool) {
        let name = spritePackName
        spriteFingerprint = name.isEmpty ? .distantPast : SpritePack.fingerprint(name)
        if name.isEmpty {
            petView.sprites = nil
        } else {
            do {
                petView.sprites = try SpritePack(name: name)
                if announce { say("new look! ✨", for: 2) }
            } catch {
                petView.sprites = nil
                say("couldn't load sprites: \(error.localizedDescription)", for: 6)
            }
        }
        petView.scale = CGFloat(defaults.object(forKey: scaleKey) as? Double ?? 1)
        sounds.packDirectory = name.isEmpty ? nil : SpritePack.root.appendingPathComponent(name)
        layoutWindow()
    }

    /// Each sprite pack (and the cat) remembers its own size.
    private var scaleKey: String { "scale." + (spritePackName.isEmpty ? "cat" : spritePackName) }

    /// Sizes the window for the character and scale, keeping the pet's feet where they were.
    private func layoutWindow() {
        let k = petView.sprites.map { min(1.8, max(0.7, $0.height / 82)) } ?? 1
        let base = NSSize(width: max(260, 2 * 95 * k + 20), height: max(220, PetView.ground + 140 * k + 14))
        let s = petView.scale
        // Extra headroom keeps unscaled speech bubbles and the resize pill on screen.
        size = NSSize(width: max(250, base.width * s), height: PetView.ground + (base.height - PetView.ground) * s + 40)
        let f = panel.frame
        panel.setFrame(NSRect(x: f.midX - size.width / 2, y: f.minY, width: size.width, height: size.height), display: true)
    }

    // MARK: - Movement

    private func startWalk(_ now: Double) {
        nextWalkAt = now + Double.random(in: 20...60)
        guard let vf = (panel.screen ?? NSScreen.main)?.visibleFrame else { return }
        var range = (vf.minX - 40)...(vf.maxX - size.width + 40)
        if let perch {
            // Stay on the window we're standing on.
            let lo = perch.rect.minX + 24 - size.width / 2, hi = perch.rect.maxX - 24 - size.width / 2
            guard hi - lo > 60 else { return }
            range = lo...hi
        }
        let target = CGFloat.random(in: range)
        if abs(target - panel.frame.minX) > 60 { walkTarget = target }
    }

    // MARK: - Walking on windows

    private func refreshPlatforms(_ now: Double) {
        guard walkOnWindows, gravity, now - lastPlatformScan > 0.1 else { return }
        lastPlatformScan = now
        platforms = Platforms.current()
    }

    /// Follows the window we're standing on, and falls when it closes, minimizes, or slides away.
    private func followPerch(_ now: Double) {
        guard let current = perch, velocity == nil, !petView.dragging else { return }
        refreshPlatforms(now)
        guard let window = platforms.first(where: { $0.id == current.id }) else { return dropFromPerch() }
        var o = panel.frame.origin
        let dx = window.rect.minX - current.rect.minX
        let feet = window.rect.maxY
        if dx != 0 || abs(o.y + PetView.ground - feet) > 0.5 {
            o.x += dx
            o.y = feet - PetView.ground
            if let target = walkTarget { walkTarget = target + dx }
            panel.setFrameOrigin(o)
        }
        perch = (window.id, window.rect)
        let center = o.x + size.width / 2
        if center < window.rect.minX + 4 || center > window.rect.maxX - 4 || feet + petView.bodyExtent.height > petScreen().visibleFrame.maxY {
            dropFromPerch()
        }
    }

    private func dropFromPerch() {
        perch = nil
        walkTarget = nil
        if gravity { velocity = .zero }
    }

    private func move(dt: Double, now: Double) {
        if let v = velocity {
            simulateThrow(v, dt: CGFloat(dt), now: now)
            return
        }
        followPerch(now)
        var origin = panel.frame.origin
        guard let target = walkTarget else { return }
        guard mood == .walking || mood == .idle, !petView.dragging else {
            walkTarget = nil
            return
        }
        walkDirection = target > origin.x ? 1 : -1
        let step = 45 * CGFloat(dt)
        if abs(target - origin.x) <= step {
            origin.x = target
            walkTarget = nil
            saveOrigin(origin)
        } else {
            origin.x += walkDirection * step
        }
        panel.setFrameOrigin(origin)
    }

    /// One physics step: gravity (optional), air drag, and bounces off the edges of the screen.
    private func simulateThrow(_ v0: CGVector, dt: CGFloat, now: Double) {
        var v = v0
        var o = panel.frame.origin
        let vf = petScreen().visibleFrame
        let body = petView.bodyExtent
        let minX = vf.minX - (size.width / 2 - body.halfWidth)
        let maxX = vf.maxX - (size.width / 2 + body.halfWidth)
        var floorY = vf.minY
        let ceilingY = vf.maxY - (PetView.ground + body.height)
        let bounciness: CGFloat = 0.72
        // Window tops count as floors when walking on windows is on.
        var landing: Platform?
        if gravity && walkOnWindows {
            refreshPlatforms(now)
            landing = Platforms.landing(below: o.y + PetView.ground, x: o.x + size.width / 2, in: platforms, screen: vf, headroom: body.height)
            if let landing { floorY = max(floorY, landing.rect.maxY - PetView.ground) }
        }

        if gravity { v.dy -= 2000 * dt }
        let drag = pow(gravity ? 0.9 : 0.45, dt)
        v.dx *= drag
        if !gravity { v.dy *= drag }
        o.x += v.dx * dt
        o.y += v.dy * dt

        var impact: CGFloat = 0
        var onFloor = false
        if o.x < minX { o.x = minX; impact = max(impact, abs(v.dx)); v.dx = abs(v.dx) * bounciness }
        if o.x > maxX { o.x = maxX; impact = max(impact, abs(v.dx)); v.dx = -abs(v.dx) * bounciness }
        if o.y > ceilingY { o.y = ceilingY; impact = max(impact, abs(v.dy)); v.dy = -abs(v.dy) * bounciness }
        if o.y < floorY {
            o.y = floorY
            onFloor = true
            impact = max(impact, abs(v.dy))
            v.dy = abs(v.dy) * bounciness
            if v.dy < 140 { v.dy = 0 } // too weak to bounce again: slide to a stop
            v.dx *= 0.8
        }

        if impact > 300 { sounds.play(.bounce) }
        if impact > 700 {
            bounces += 1
            if now - lastBumpRemark > 0.7 {
                lastBumpRemark = now
                say(["boing!", "oof!", "whoa!", "wheee!", "ow ow ow"].randomElement()!, for: 0.9)
            }
        }
        spin -= v.dx * dt / 40

        let resting = gravity ? (onFloor && v.dy == 0 && abs(v.dx) < 15) : hypot(v.dx, v.dy) < 20
        panel.setFrameOrigin(o)
        guard resting else {
            velocity = v
            return
        }
        velocity = nil
        spin = 0
        perch = (landing != nil && abs(o.y - floorY) < 1) ? (landing!.id, landing!.rect) : nil
        saveOrigin(o)
        if bounces >= 3 {
            transient = (.dizzy, now + 2.5)
            say(["@_@ the room is spinning…", "again! again!", "I saw stars 💫"].randomElement()!, for: 2.5)
        } else {
            transient = (.startled, now + 0.6)
        }
        bounces = 0
    }

    private func petScreen() -> NSScreen {
        let f = panel.frame
        let center = NSPoint(x: f.midX, y: f.minY + PetView.ground + 40)
        return NSScreen.screens.first { $0.frame.contains(center) } ?? panel.screen ?? NSScreen.main ?? NSScreen.screens[0]
    }

    private func saveOrigin(_ o: NSPoint) {
        defaults.set(Double(o.x), forKey: "originX")
        defaults.set(Double(o.y), forKey: "originY")
    }

    // MARK: - Reactions

    private func say(_ text: String, for seconds: Double) {
        speech = (text, CACurrentMediaTime() + seconds)
    }

    private func appActivated(_ app: NSRunningApplication?) {
        guard app?.processIdentifier != ProcessInfo.processInfo.processIdentifier else { return }
        let category = AppCategory(app)
        accessory = Self.accessory(for: category)
        let now = CACurrentMediaTime()
        guard !quiet, focus.phase == .off, let remark = category.remarks.randomElement(), now - lastRemark > 45, Double.random(in: 0...1) < 0.4,
              topSession.map({ $0.activity == .idle }) ?? true else { return }
        lastRemark = now
        say(remark, for: 3)
    }

    private static func accessory(for category: AppCategory) -> Accessory {
        switch category {
        case .music: return .headphones
        case .code: return .glasses
        default: return .none
        }
    }

    func petTapped() {
        let now = CACurrentMediaTime()
        walkTarget = nil
        // When an agent wants attention, a click takes you to it.
        if let top = topSession, [.needsYou, .done, .error, .oops].contains(top.activity), top.pid > 0 {
            transient = (.petted, now + 1)
            say(jump(to: top.pid) ? "taking you to \(top.name) 👉" : "go check on \(top.name)! 👉", for: 2.5)
            return
        }
        sounds.play(.pet)
        levelUp(stats.record(xp: stats.today.pets < 20 ? 1 : 0) { $0.pets += 1 })
        if let top = topSession, top.activity != .idle, top.activity != .done {
            transient = (.petted, now + 1)
            say(top.activity == .needsYou ? "go check on \(top.name)! 👉" : "shh, \(top.name) is working 🤫", for: 2.5)
        } else {
            transient = (.petted, now + 2.2)
            say(["purr~ 💕", "hehe", "more pets pls", "♥︎", "you're the best, \(config.ownerName)!"].randomElement()!, for: 2.2)
        }
    }

    func petDragBegan() {
        walkTarget = nil
        perch = nil
        hoverCard.hide()
        velocity = nil
        spin = 0
        bounces = 0
        say("wheee!", for: 1.5)
    }

    func petDragEnded(velocity v: CGVector) {
        if petView.resizing {
            saveOrigin(panel.frame.origin)
            return
        }
        let speed = hypot(v.dx, v.dy)
        let floor = petScreen().visibleFrame.minY
        guard speed > 60 || (gravity && panel.frame.minY > floor + 2) else {
            saveOrigin(panel.frame.origin)
            return
        }
        let limit: CGFloat = 4000
        let scale = speed > limit ? limit / speed : 1
        velocity = CGVector(dx: v.dx * scale, dy: v.dy * scale)
        if speed > 1200 { say("yeeeet! 🚀", for: 1.2) }
        if speed > 400 { levelUp(stats.record(xp: 2) { $0.throwsCount += 1 }) }
    }

    // MARK: - Attention, stats, and the hover card

    @discardableResult
    private func jump(to pid: pid_t) -> Bool {
        hoverCard.hide()
        return SessionJumper.jump(to: pid)
    }

    private func post(_ title: String, _ body: String, pid: pid_t) {
        guard notificationsOn else { return }
        notifier.post(title: title, body: body, pid: pid)
    }

    /// Notifies unless you're already looking at the app the agent runs in.
    private func postUnlessWatching(_ s: AgentSession, title: String, body: String) {
        if s.pid > 0, let host = SessionJumper.hostApp(of: s.pid), host == NSWorkspace.shared.frontmostApplication { return }
        post(title, body, pid: s.pid)
    }

    private func taskFinished(_ s: AgentSession, project: String) {
        sounds.play(.done)
        postUnlessWatching(s, title: "\(s.name) is done ✨", body: project)
        levelUp(stats.record(xp: 10) { $0.tasks += 1 })
    }

    private func levelUp(_ newLevel: Int?) {
        guard let newLevel else { return }
        transient = (.done, CACurrentMediaTime() + 3)
        say("level up! I'm level \(newLevel) now ✨", for: 4)
        sounds.play(.levelUp)
    }

    private func todaySummary() -> String {
        let d = stats.today
        func hm(_ minutes: Int) -> String { minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes)m" }
        return "⌨️ \(hm(d.activeMinutes)) you · 🤖 \(hm(d.agentMinutes)) agents · ✅ \(d.tasks) task\(d.tasks == 1 ? "" : "s")"
    }

    /// Shows the card after hovering the pet for a moment; keeps it while the mouse is on the pet or the card.
    private func updateHoverCard(_ now: Double) {
        let m = NSEvent.mouseLocation
        let local = NSPoint(x: m.x - panel.frame.minX, y: m.y - panel.frame.minY)
        let overPet = petView.hitRect.contains(local) && !petView.dragging && !petView.resizing && velocity == nil
        let overCard = hoverCard.isVisible && hoverCard.frame.insetBy(dx: -8, dy: -8).contains(m)
        if overPet || overCard {
            hoverLeftAt = nil
            if hoverBegan == nil { hoverBegan = now }
            if !hoverCard.isVisible, now - (hoverBegan ?? now) > 0.6 {
                refreshHoverModel(now)
                let pet = petView.hitRect.offsetBy(dx: panel.frame.minX, dy: panel.frame.minY)
                hoverCard.show(near: pet)
            }
        } else {
            hoverBegan = nil
            if hoverCard.isVisible {
                if hoverLeftAt == nil { hoverLeftAt = now }
                if now - (hoverLeftAt ?? now) > 0.35 { hoverCard.hide() }
            }
        }
        if hoverCard.isVisible && Int(now * 4) != Int((now - 1.0 / 30) * 4) {
            refreshHoverModel(now)
            hoverCard.refit()
        }
    }

    private func refreshHoverModel(_ now: Double) {
        let model = hoverCard.model
        model.petName = config.petName
        model.level = stats.level
        model.progress = stats.progress
        model.xpToNext = stats.xpToNext
        model.today = todaySummary()
        model.focus = focus.phase == .off ? "" : focus.label
        model.quiet = quiet
        model.accent = Color(nsColor: petView.theme.accent ?? .systemOrange)
        model.rows = sessions.sorted { $0.activity.rawValue > $1.activity.rawValue }.map { s in
            let elapsed: String
            if s.activity == .idle { elapsed = "idle" } else {
                let secs = Int(now - (busySince[s.id] ?? now))
                elapsed = secs >= 60 ? "\(secs / 60)m" : "\(secs)s"
            }
            let usage = s.isCodex ? CodexLog.state(path: s.logPath, procBusy: true)?.tokens : transcriptTokens.usage(s.logPath)
            let tokens = usage.map { "\(Self.compact($0.output)) out · \(Self.compact($0.context)) context" } ?? ""
            return HoverModel.Row(id: s.id, title: s.name + (s.project.isEmpty ? "" : " · \(s.project)"),
                                  detail: s.detail + (s.precise ? "" : " (guessed)"), color: Color(nsColor: Self.color(for: s.activity)),
                                  elapsed: elapsed, tokens: tokens, pid: s.pid)
        }
    }

    private static func compact(_ n: Int) -> String {
        n >= 1_000_000 ? String(format: "%.1fM", Double(n) / 1e6) : n >= 1000 ? String(format: "%.1fk", Double(n) / 1000) : "\(n)"
    }

    // MARK: - Updates

    private func checkForUpdates(manual: Bool) {
        updater.check { [weak self] found in
            guard let self else { return }
            if found, let update = self.updater.available {
                if manual || !self.updateAnnounced {
                    self.updateAnnounced = true
                    self.say("update available: v\(update.version)! ✨ (🐾 menu)", for: 6)
                }
            } else if manual {
                self.say("I'm up to date! (v\(Updater.currentVersion))", for: 3)
            }
        }
    }

    @objc private func manualUpdateCheck() { checkForUpdates(manual: true) }
    @objc private func toggleAutoUpdate() { autoUpdate.toggle() }

    @objc private func installUpdate() {
        say("updating… see you in a sec! 🔄", for: 4)
        updater.install { [weak self] message in self?.say(message, for: 5) }
    }

    // MARK: - Drops and pack files

    func petDragHover() {
        transient = (.startled, CACurrentMediaTime() + 1)
        say("ooh, what's that? 👀", for: 1.5)
    }

    func petReceivedFiles(_ urls: [URL]) {
        do {
            let name = try PackArchive.importItems(urls, currentPack: spritePackName)
            spritePackName = name
            loadSprites(announce: false)
            transient = (.done, CACurrentMediaTime() + 2.5)
            say("new look: \(name)! ✨", for: 3)
        } catch {
            say("hmm: \(error.localizedDescription)", for: 4)
        }
    }

    @objc private func importPack() {
        let open = NSOpenPanel()
        open.allowsMultipleSelection = true
        open.canChooseDirectories = true
        open.allowedContentTypes = [.zip, .image, .folder]
        open.message = "Choose a sprite pack .zip, a pack folder, or images"
        NSApp.activate(ignoringOtherApps: true)
        if open.runModal() == .OK { petReceivedFiles(open.urls) }
    }

    @objc private func exportPack() {
        let save = NSSavePanel()
        save.nameFieldStringValue = "\(spritePackName).zip"
        save.allowedContentTypes = [.zip]
        NSApp.activate(ignoringOtherApps: true)
        guard save.runModal() == .OK, let url = save.url else { return }
        do {
            try PackArchive.export(pack: spritePackName, to: url)
            say("packed up! 📦", for: 2)
        } catch {
            say("couldn't export: \(error.localizedDescription)", for: 4)
        }
    }

    // MARK: - Menu actions for new options

    @objc private func jumpToSession(_ sender: NSMenuItem) {
        if !jump(to: pid_t(sender.tag)) { say("couldn't find that window 🤔", for: 2.5) }
    }

    @objc private func startFocus(_ sender: NSMenuItem) {
        focus.start(minutes: sender.tag)
        say("focus mode: \(sender.tag) minutes. you got this! 🍅", for: 3)
    }

    @objc private func stopFocus() { focus.stop() }
    @objc private func toggleWalkOnWindows() { walkOnWindows.toggle() }
    @objc private func toggleQuietInCalls() { quietInCalls.toggle() }
    @objc private func toggleSounds() { soundsOn.toggle() }

    @objc private func toggleNotifications() {
        notificationsOn.toggle()
        if notificationsOn { notifier.requestPermission() }
    }

    @objc private func toggleClaudeHooks() {
        do {
            let install = !HookInstaller.installed()
            try HookInstaller.setInstalled(install)
            say(install ? "Claude Code connected! 🔌" : "Claude Code hooks removed", for: 3)
        } catch {
            say("couldn't update Claude settings: \(error.localizedDescription)", for: 5)
        }
    }

    @objc private func toggleKiroHooks() {
        kiroHooksOn.toggle()
        let changed = KiroHooks.apply(kiroHooksOn)
        if kiroHooksOn {
            say(changed > 0 ? "Kiro connected (\(changed) agents)! 🔌" : "no Kiro agents found in ~/.kiro/agents", for: 4)
        } else {
            say("Kiro hooks removed", for: 3)
        }
    }

    // MARK: - Menu

    func petMenu() -> NSMenu {
        let menu = NSMenu()
        fill(menu)
        return menu
    }

    func menuNeedsUpdate(_ menu: NSMenu) { fill(menu) }

    private func fill(_ menu: NSMenu) {
        menu.removeAllItems()
        menu.addItem(disabled("\(config.petName) · Lv \(stats.level) — \(String(describing: mood))"))
        menu.addItem(disabled("Today: \(todaySummary())"))
        if quiet { menu.addItem(disabled("🤫 Quiet: a mic or camera is in use")) }
        menu.addItem(.separator())
        if sessions.isEmpty {
            menu.addItem(disabled("No AI agents running"))
        } else {
            for s in sessions.sorted(by: { $0.activity.rawValue > $1.activity.rawValue }) {
                let project = s.project.isEmpty ? "" : " (\(s.project))"
                let source = s.precise ? "" : " · guessed from CPU"
                let i = item("\(s.activity == .idle ? "○" : "●") \(s.name)\(project) — \(s.detail)\(source)", #selector(jumpToSession(_:)))
                i.tag = Int(s.pid)
                i.isEnabled = s.pid > 0
                i.toolTip = "Jump to this session"
                menu.addItem(i)
            }
        }
        menu.addItem(.separator())

        let focusMenu = NSMenu()
        for minutes in [15, 25, 50] {
            let i = item("Focus for \(minutes) minutes", #selector(startFocus(_:)))
            i.tag = minutes
            focusMenu.addItem(i)
        }
        if focus.phase != .off { focusMenu.addItem(item("Stop timer", #selector(stopFocus))) }
        menu.addItem(submenu(focus.phase == .off ? "Focus timer" : focus.label, focusMenu))
        menu.addItem(item("Bring \(config.petName) here", #selector(bringHere)))

        let sizeMenu = NSMenu()
        sizeMenu.addItem(item(petView.resizing ? "Finish resizing" : "Resize…", #selector(toggleResizing)))
        sizeMenu.addItem(.separator())
        for percent in [50, 75, 100, 125, 150, 200, 300] {
            let i = item("\(percent)%", #selector(chooseSize(_:)), checked: Int((petView.scale * 100).rounded()) == percent)
            i.tag = percent
            sizeMenu.addItem(i)
        }
        menu.addItem(submenu("Size (\(Int((petView.scale * 100).rounded()))%)", sizeMenu))

        let bubbleMenu = NSMenu()
        for (title, size) in [("Large", ThoughtBubbleSize.large), ("Small", .small), ("Off", .off)] {
            let i = item(title, #selector(chooseThoughtBubble(_:)), checked: thoughtBubble == size)
            i.representedObject = size.rawValue
            bubbleMenu.addItem(i)
        }
        menu.addItem(submenu("Thought bubble", bubbleMenu))
        let themeTitle = petView.theme.accent.map { "Theme color (\($0.hexString))…" } ?? "Theme color…"
        menu.addItem(item(themeTitle, #selector(chooseTheme)))

        let spritesMenu = NSMenu()
        let builtIn = item("Built-in cat", #selector(chooseSprites(_:)), checked: spritePackName.isEmpty)
        builtIn.representedObject = ""
        spritesMenu.addItem(builtIn)
        for pack in SpritePack.available() {
            let i = item(pack, #selector(chooseSprites(_:)), checked: spritePackName == pack)
            i.representedObject = pack
            spritesMenu.addItem(i)
        }
        spritesMenu.addItem(.separator())
        spritesMenu.addItem(item("Import pack…", #selector(importPack)))
        if !spritePackName.isEmpty { spritesMenu.addItem(item("Export \(spritePackName)…", #selector(exportPack))) }
        spritesMenu.addItem(item("Preview poses", #selector(previewPoses)))
        spritesMenu.addItem(item("Reload sprites", #selector(reloadSprites)))
        spritesMenu.addItem(item("Open sprites folder", #selector(openSpritesFolder)))
        menu.addItem(submenu("Sprites", spritesMenu))

        let behaviorMenu = NSMenu()
        behaviorMenu.addItem(item("Wander around", #selector(toggleWander), checked: wander))
        behaviorMenu.addItem(item("Gravity", #selector(toggleGravity), checked: gravity))
        behaviorMenu.addItem(item("Walk on windows", #selector(toggleWalkOnWindows), checked: walkOnWindows))
        behaviorMenu.addItem(item("Quiet during calls", #selector(toggleQuietInCalls), checked: quietInCalls))
        behaviorMenu.addItem(.separator())
        behaviorMenu.addItem(item("Notifications", #selector(toggleNotifications), checked: notificationsOn))
        behaviorMenu.addItem(item("Sounds", #selector(toggleSounds), checked: soundsOn))
        menu.addItem(submenu("Behavior", behaviorMenu))

        let agentsMenu = NSMenu()
        agentsMenu.addItem(item("Claude Code hooks", #selector(toggleClaudeHooks), checked: HookInstaller.installed()))
        agentsMenu.addItem(item("Kiro CLI hooks", #selector(toggleKiroHooks), checked: kiroHooksOn))
        agentsMenu.addItem(disabled("Codex: automatic (reads its session log)"))
        menu.addItem(submenu("Agents", agentsMenu))

        menu.addItem(.separator())
        menu.addItem(item(panel.isVisible ? "Hide \(config.petName)" : "Show \(config.petName)", #selector(toggleVisible)))
        menu.addItem(item("Setup…", #selector(openWizard)))
        if let update = updater.available {
            menu.addItem(item("Update to v\(update.version)…", #selector(installUpdate)))
        } else {
            menu.addItem(item("Check for updates…", #selector(manualUpdateCheck)))
        }
        menu.addItem(item("Automatic updates", #selector(toggleAutoUpdate), checked: autoUpdate))
        menu.addItem(.separator())
        menu.addItem(item("Quit DeskPet", #selector(quit), key: "q"))
    }

    private func submenu(_ title: String, _ menu: NSMenu) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        i.submenu = menu
        return i
    }

    private func disabled(_ title: String) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        i.isEnabled = false
        return i
    }

    private func item(_ title: String, _ action: Selector, checked: Bool = false, key: String = "") -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.target = self
        i.state = checked ? .on : .off
        return i
    }

    @objc private func toggleWander() { wander.toggle(); walkTarget = nil }
    @objc private func toggleGravity() { gravity.toggle() }
    @objc private func reloadSprites() { loadSprites(announce: true) }

    @objc private func chooseThoughtBubble(_ sender: NSMenuItem) {
        thoughtBubble = ThoughtBubbleSize(rawValue: sender.representedObject as? String ?? "") ?? .large
        petView.thoughtBubble = thoughtBubble
    }

    /// Asks for a hex code; "Default" restores the built-in colors.
    @objc private func chooseTheme() {
        let alert = NSAlert()
        alert.messageText = "Theme color"
        alert.informativeText = "Enter a hex code, like #FF8FB1. It tints speech and thought bubbles, captions, the \"!\" alert, and the resize box."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 220, height: 24))
        field.stringValue = petView.theme.accent?.hexString ?? ""
        field.placeholderString = "#FF8FB1"
        alert.accessoryView = field
        alert.addButton(withTitle: "Apply")
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Default")
        alert.window.initialFirstResponder = field
        NSApp.activate(ignoringOtherApps: true)

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            guard let theme = Theme(hex: field.stringValue), let accent = theme.accent else {
                NSSound.beep()
                say("hmm, \"\(field.stringValue)\" isn't a hex color 🤔", for: 3)
                return
            }
            themeHex = accent.hexString
            petView.theme = theme
            say("ooh, \(accent.hexString)! 🎨", for: 2.5)
        case .alertThirdButtonReturn:
            themeHex = ""
            petView.theme = .default
            say("back to classic 🐾", for: 2)
        default:
            break
        }
    }

    // MARK: - Setup wizard (the shared HTML in electron/src/wizard)

    @objc private func openWizard() {
        if let wizard { return wizard.show() }
        let controller = WizardController { [weak self] action, payload in self?.wizardCall(action, payload) }
        controller.onClose = { [weak self] in
            self?.defaults.set(true, forKey: "setupComplete")
            self?.wizard = nil
        }
        wizard = controller
        controller.show()
    }

    private func wizardStatus() -> [String: Any] {
        let installed = HookInstaller.installed()
        return [
            "hooksInstalled": installed,
            "hooksLive": installed && HookInstaller.live(),
            "running": Array(Set(agents.procSessions.map(\.name))).sorted(),
        ]
    }

    private func wizardCall(_ action: String, _ payload: [String: Any]) -> Any? {
        switch action {
        case "state":
            return [
                "platform": "mac", "chrome": "native",
                "ownerName": config.ownerName, "petName": config.petName,
                "packs": SpritePack.available(), "spritePack": spritePackName,
                "themeColor": themeHex, "thoughtBubble": thoughtBubble.rawValue,
                "wander": wander, "gravity": gravity,
                "startAtLogin": SMAppService.mainApp.status == .enabled, "startAtLoginSupported": true,
                "notifications": notificationsOn, "sounds": soundsOn, "walkOnWindows": walkOnWindows,
                "quietInCalls": quietInCalls, "autoUpdate": autoUpdate, "kiroInstalled": kiroHooksOn && KiroHooks.installed(),
            ].merging(wizardStatus()) { a, _ in a }
        case "status":
            return wizardStatus()
        case "pack":
            let name = payload["name"] as? String ?? ""
            let dir = SpritePack.root.appendingPathComponent(name)
            let options = (try? Data(contentsOf: dir.appendingPathComponent("pack.json")))
                .flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? [String: Any]()
            let images = ((try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? [])
                .filter { ["png", "gif", "webp", "jpg", "jpeg"].contains($0.pathExtension.lowercased()) }
            let files = images.compactMap { url -> [String: Any]? in
                guard let data = try? Data(contentsOf: url) else { return nil }
                return ["name": url.lastPathComponent, "data": data.base64EncodedString()]
            }
            return ["name": name, "options": options, "files": files]
        case "save":
            let owner = payload["ownerName"] as? String ?? config.ownerName
            let pet = payload["petName"] as? String ?? config.petName
            Config.save(["ownerName": owner, "petName": pet])
            config.ownerName = owner
            config.petName = pet
            return ["ok": true]
        case "set":
            let value = payload["value"]
            switch payload["key"] as? String ?? "" {
            case "spritePack":
                spritePackName = value as? String ?? ""
                loadSprites(announce: false)
            case "themeColor":
                themeHex = value as? String ?? ""
                petView.theme = Theme(hex: themeHex) ?? .default
            case "thoughtBubble":
                thoughtBubble = ThoughtBubbleSize(rawValue: value as? String ?? "") ?? .large
                petView.thoughtBubble = thoughtBubble
            case "wander":
                wander = value as? Bool ?? true
                walkTarget = nil
            case "gravity":
                gravity = value as? Bool ?? true
            case "startAtLogin":
                if value as? Bool == true { try? SMAppService.mainApp.register() } else { try? SMAppService.mainApp.unregister() }
                return ["value": SMAppService.mainApp.status == .enabled]
            case "notifications":
                notificationsOn = value as? Bool ?? true
                if notificationsOn { notifier.requestPermission() }
            case "sounds":
                soundsOn = value as? Bool ?? true
                if soundsOn { sounds.play(.pet) }
            case "walkOnWindows": walkOnWindows = value as? Bool ?? true
            case "quietInCalls": quietInCalls = value as? Bool ?? true
            case "autoUpdate": autoUpdate = value as? Bool ?? true
            default:
                break
            }
            return ["value": value ?? NSNull()]
        case "hooks":
            do {
                try HookInstaller.setInstalled(payload["install"] as? Bool ?? true)
                return ["ok": true]
            } catch {
                return ["ok": false, "error": error.localizedDescription]
            }
        case "openSprites":
            NSWorkspace.shared.open(SpritePack.root)
            return ["ok": true]
        case "kiro":
            let install = payload["install"] as? Bool ?? true
            kiroHooksOn = install
            let changed = KiroHooks.apply(install)
            return ["ok": !install || changed > 0 || KiroHooks.installed(), "changed": changed]
        case "finish":
            _ = wizardCall("save", payload)
            defaults.set(true, forKey: "setupComplete")
            if notificationsOn { notifier.requestPermission() }
            wizard?.close()
            transient = (.done, CACurrentMediaTime() + 2.5)
            say("hi \(config.ownerName)! I'm \(config.petName) 🐾", for: 4)
            return ["ok": true]
        case "close":
            wizard?.close()
            return ["ok": true]
        default:
            return nil
        }
    }

    @objc private func toggleResizing() {
        if petView.resizing { return petResizeFinished() }
        walkTarget = nil
        velocity = nil
        petView.resizing = true
        if !panel.isVisible { panel.orderFrontRegardless() }
    }

    @objc private func chooseSize(_ sender: NSMenuItem) {
        petResize(to: CGFloat(sender.tag) / 100)
        petResizeEnded()
    }

    func petResize(to scale: CGFloat) {
        petView.scale = scale
        layoutWindow()
    }

    func petResizeEnded() { defaults.set(Double(petView.scale), forKey: scaleKey) }

    func petResizeFinished() {
        petView.resizing = false
        petResizeEnded()
        saveOrigin(panel.frame.origin)
        say("\(Int((petView.scale * 100).rounded()))% it is! ✨", for: 2)
    }

    /// Shows every pose for 2 seconds each, with its name in a bubble.
    @objc private func previewPoses() {
        let poses: [(String, Mood)] = [
            ("idle", .idle), ("typing", .typing), ("thinking", .thinking), ("needs-you", .needsYou), ("done", .done),
            ("petted", .petted), ("sleeping", .sleeping), ("sleepy", .sleepy), ("dragged", .dragged),
            ("startled", .startled), ("reading", .reading), ("searching", .searching), ("oops", .oops),
            ("error", .error), ("walking", .walking), ("flying", .flying), ("dizzy", .dizzy),
        ]
        for (i, pose) in poses.enumerated() {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 2) { [weak self] in
                guard let self else { return }
                self.transient = (pose.1, CACurrentMediaTime() + 2)
                self.say(pose.0, for: 2)
            }
        }
    }
    @objc private func openSpritesFolder() { NSWorkspace.shared.open(SpritePack.root) }

    @objc private func chooseSprites(_ sender: NSMenuItem) {
        spritePackName = sender.representedObject as? String ?? ""
        loadSprites(announce: true)
    }
    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func toggleVisible() {
        if panel.isVisible { panel.orderOut(nil) } else { panel.orderFrontRegardless() }
    }

    @objc private func bringHere() {
        let m = NSEvent.mouseLocation
        let screen = NSScreen.screens.first { $0.frame.contains(m) } ?? NSScreen.main!
        let origin = NSPoint(x: m.x - size.width / 2, y: screen.visibleFrame.minY)
        walkTarget = nil
        panel.setFrameOrigin(origin)
        panel.orderFrontRegardless()
        saveOrigin(origin)
        say("here I am! 🐾", for: 2)
    }
}
