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
    private var controlCenter: WizardController?
    private let defaults = appDefaults

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
    private let sync = Sync()
    /// Conversations, affection, memories, and reminders (the engine shared with the Windows/Linux app).
    private let companion = Companion()
    private var talk: TalkWindow?
    private var lastCompanionTick = 0.0
    private var lastTap = 0.0
    private var talkOpen: Bool { talk?.isVisible ?? false }
    private var lastSyncTick = 0.0
    private var lastBrowserCheck = 0.0
    private var lastBlockNag = 0.0
    /// Recent XP gain shown floating above the pet.
    private var xpPopup: (amount: Int, at: Double)?
    // Trips: the pet away on a drive (home), or visiting this computer from one (visitor).
    private var tripState: [String: Any]? {
        get { defaults.dictionary(forKey: "trip") }
        set { defaults.set(newValue, forKey: "trip") }
    }
    private var petAway: Bool { tripState != nil }
    /// Playtime: until then, throws are a game and never hurt the bond.
    private var playUntil: Date?
    private var playing: Bool { (playUntil ?? .distantPast) > Date() }
    private var lastTripWatch = 0.0
    private var tripLaunchCheck = true
    /// Other people's pets on drives plugged in here, by trip folder path.
    private var visitorsAtDoor: [String: [String: Any]] = [:]
    private var announcedVisitors = Set<String>()
    private var letOut = Set<String>()
    /// Visitor mode: the trip.json this instance is visiting from.
    private var visitorTrip: [String: Any]?
    private var visitStarted = Date()
    private var lastVisitSave = 0.0
    private lazy var appCopySize = TripFiles.appSize()

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
    /// While you type, the pet types on its laptop too (otherwise it just bobs along).
    private var typeAlong: Bool { get { flag("typeAlong", true) } set { defaults.set(newValue, forKey: "typeAlong") } }
    /// Keeps the typing pose up through short pauses, so the laptop doesn't flicker in and out.
    private var typingAlongUntil = 0.0
    private var quietInCalls: Bool { get { flag("quietInCalls", true) } set { defaults.set(newValue, forKey: "quietInCalls") } }
    private var autoUpdate: Bool { get { flag("autoUpdate", true) } set { defaults.set(newValue, forKey: "autoUpdate") } }
    private var kiroHooksOn: Bool { get { flag("kiroHooks", false) } set { defaults.set(newValue, forKey: "kiroHooks") } }
    private var blockDuringFocus: Bool { get { flag("blockDuringFocus", true) } set { defaults.set(newValue, forKey: "blockDuringFocus") } }
    private var strictBlock: Bool { get { flag("strictBlock", false) } set { defaults.set(newValue, forKey: "strictBlock") } }
    // MARK: Rewards state

    /// Rewards stay unlocked forever once you've prestiged.
    private func isUnlocked(_ reward: Reward) -> Bool { stats.prestige > 0 || stats.level >= reward.level }
    private func wearing(_ reward: Reward) -> Bool {
        reward.slot == .golden ? defaults.bool(forKey: reward.slot.key) : defaults.string(forKey: reward.slot.key) == reward.value
    }
    private func worn(_ slot: Reward.Slot) -> Reward? { Reward.allCases.first { $0.slot == slot && isUnlocked($0) && wearing($0) } }
    private var showPrestigeBadge: Bool { get { flag("showPrestigeBadge", true) } set { defaults.set(newValue, forKey: "showPrestigeBadge") } }
    private var blocklist: [String] {
        get { defaults.stringArray(forKey: "blocklist") ?? Blocklist.defaults }
        set { defaults.set(newValue, forKey: "blocklist") }
    }
    /// On a call: no sounds and no chatty remarks.
    private var quiet: Bool { quietInCalls && inCall }

    private var topSession: AgentSession? { sessions.max { $0.activity.rawValue < $1.activity.rawValue } }

    // MARK: - Lifecycle

    func applicationWillTerminate(_ notification: Notification) {
        companion.flush()
        if Visitor.active {
            saveVisit()
            Visitor.cleanUp()
        }
    }

    /// Opening a moving-homes file (double-click, or dragging it onto the app icon).
    func application(_ application: NSApplication, open urls: [URL]) {
        if let url = urls.first(where: { MovingFile.extensions.contains($0.pathExtension.lowercased()) }) {
            DispatchQueue.main.async { self.confirmMoveIn(url) }
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if Visitor.active {
            guard checkVisit() else { return NSApp.terminate(nil) }
        } else if let id = Bundle.main.bundleIdentifier {
            // One pet per computer, though a visiting pet can run alongside it.
            let visitors = Visitor.visitorPIDs()
            let others = NSRunningApplication.runningApplications(withBundleIdentifier: id)
                .filter { $0.processIdentifier != getpid() && !visitors.contains($0.processIdentifier) }
            if !others.isEmpty {
                NSApp.terminate(nil)
                return
            }
            for pid in visitors where kill(pid, 0) != 0 { try? FileManager.default.removeItem(at: Visitor.markers.appendingPathComponent("\(pid)")) }
            HookRepair.run()
        }
        NSApp.setActivationPolicy(.accessory)
        try? FileManager.default.createDirectory(at: SpritePack.root, withIntermediateDirectories: true)
        setupPanel()
        loadSprites(announce: false)
        petView.theme = Theme(hex: themeHex) ?? .default
        petView.thoughtBubble = thoughtBubble
        setupStatusItem()
        observeWorkspace()
        companion.setNames(owner: config.ownerName, pet: config.petName)
        setPersonality()
        accessory = Self.accessory(for: AppCategory(NSWorkspace.shared.frontmostApplication))
        if CommandLine.arguments.contains("panel-snapshot") {
            openControlCenter(page: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { self.controlCenter?.snapshotPanel() }
        } else if CommandLine.arguments.contains("wizard-snapshot") {
            openWizard()
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.wizard?.snapshotSteps() }
        } else if CommandLine.arguments.contains("talk-snapshot") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.snapshotTalk() }
        } else if let i = CommandLine.arguments.firstIndex(of: "take-trip"), i + 1 < CommandLine.arguments.count {
            // Test mode: pack for a trip into the given folder, print the result, quit.
            let path = CommandLine.arguments[i + 1]
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                let r = self.takeTrip(path: path, copyApp: true)
                print((try? JSONSerialization.data(withJSONObject: r)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}")
                fflush(stdout)
                DispatchQueue.main.asyncAfter(deadline: .now() + 5) { NSApp.terminate(nil) }
            }
        } else if Visitor.active {
            beginVisit()
        } else if defaults.bool(forKey: "setupComplete") {
            apply(companion.event("launch"))
            if petAway {
                panel.orderOut(nil)
                statusItem.button?.title = "🧳"
            }
        } else {
            openWizard()
        }

        let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)

        sounds.enabled = soundsOn
        notifier.onClick = { [weak self] pid in self?.jump(to: pid) }
        if notificationsOn && defaults.bool(forKey: "setupComplete") && !Visitor.active { notifier.requestPermission() }
        hoverCard.model.onSelect = { [weak self] pid in self?.jump(to: pid) }
        if kiroHooksOn && !Visitor.active { KiroHooks.apply(true) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 6) { [weak self] in self?.wearEarnedRewardsOnce() }
        // Last time it may have been standing on a window; drop onto whatever is there now.
        if gravity && panel.frame.minY > petScreen().visibleFrame.minY + 2 { velocity = .zero }
        guard !Visitor.active else { return }
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
        statusItem.button?.title = Visitor.active ? "🧳" : "🐾"
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
                self.apply(self.companion.event("resume"))
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
            apply(companion.event("wake"))
            sounds.play(.wake)
        }
        if idle > 240 && topSession.map({ $0.activity == .idle }) ?? true { wasAsleep = true }

        let hour = Calendar.current.component(.hour, from: Date())
        night = hour >= 23 || hour < 6
        // Greetings, reminders (water, breaks, bedtime), remarks about your day, and conversations it starts.
        if now - lastCompanionTick >= 5 && !petAway {
            lastCompanionTick = now
            tickCompanion(now, idle: idle)
        }
        if now - lastTripWatch >= 3 {
            lastTripWatch = now
            if Visitor.active { watchVisit(now) } else { watchTrips() }
        }

        if now - lastCallCheck > 2 {
            lastCallCheck = now
            inCall = CallDetector.inCall()
            sounds.muted = quiet
        }
        if let until = playUntil, until <= Date() { endPlaytime() }
        if let finished = focus.tick() {
            if finished == .focus {
                transient = (.done, now + 3)
                say(companion.line("focus.done", "focus session done! take a break ☕"), for: 5)
                sounds.play(.focusDone)
                post("Focus session done", "Take a \(max(5, focus.minutes / 5)) minute break ☕", pid: 0)
                gainXP(15) { $0.focusSessions += 1 }
            } else {
                say(companion.line("focus.over", "break's over! ready for another round? 💪"), for: 5)
                post("Break's over", "Ready for another focus session?", pid: 0)
            }
        }
        if focus.phase == .focus && blockDuringFocus && !blocklist.isEmpty && now - lastBrowserCheck > 2 {
            lastBrowserCheck = now
            checkForDistraction()
        }
        if sync.enabled && now - lastSyncTick > 5 {
            lastSyncTick = now
            syncTick()
        }
        if now - lastMinute >= 60 {
            lastMinute = now
            let agentsBusy = sessions.contains { $0.activity != .idle && $0.activity != .done }
            // Hanging out counts too: +1 XP for every 5 minutes the pet is open.
            let openMinutes = stats.today.openMinutes + 1
            gainXP((agentsBusy ? 1 : 0) + (openMinutes % 5 == 0 ? 1 : 0)) {
                $0.openMinutes += 1
                if idle < 60 { $0.activeMinutes += 1 }
                if agentsBusy { $0.agentMinutes += 1 }
            }
        }
        if !stats.today.greeted {
            gainXP(10) { $0.greeted = true }
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
        if mood == .idle && wander && !panel.isMiniaturized && now > nextWalkAt && velocity == nil && !petView.resizing && !talkOpen { startWalk(now) }
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
        if sinceKey < 1.2 { typingAlongUntil = now + 2 }
        if now < typingAlongUntil { return typeAlong ? .typing : .userTyping }
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
        if p.caption == nil, let until = playUntil, until > Date() {
            let left = Int(until.timeIntervalSinceNow)
            p.caption = String(format: "🎾 playtime %d:%02d", left / 60, left % 60)
            p.captionColor = .systemGreen
        }
        if let s = speech, s.until > now { p.bubble = s.text }
        if let popup = xpPopup, now - popup.at < 1.4 { p.xpText = "+\(popup.amount) XP"; p.xpAge = now - popup.at }
        p.hat = worn(.hat)?.value
        p.trail = worn(.trail)?.value
        p.aura = worn(.aura)?.value
        p.companion = worn(.companion)?.value
        p.golden = worn(.golden) != nil
        p.prestige = showPrestigeBadge ? stats.prestige : 0
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
        setPersonality()
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
        if perch != nil { gainXP(2, play: true) }
        if bounces >= 3 {
            gainXP(5, play: true)
            transient = (.dizzy, now + 2.5)
            say(companion.line("dizzy", "@_@ the room is spinning…"), for: 2.5)
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
        apply(companion.event("app", ["name": app?.localizedName ?? ""]))
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
        // The pet wants to talk (it said so in a bubble), or a quick double-click: open the talk window.
        if companion.hasOffer { return openTalk(topic: "offer") }
        if now - lastTap < 0.45 {
            lastTap = 0
            return openTalk(topic: nil)
        }
        lastTap = now
        sounds.play(.pet)
        gainXP(2, play: true) { $0.pets += 1 }
        if let top = topSession, top.activity != .idle, top.activity != .done {
            transient = (.petted, now + 1)
            say(top.activity == .needsYou ? "go check on \(top.name)! 👉" : "shh, \(top.name) is working 🤫", for: 2.5)
        } else {
            transient = (.petted, now + 2.2)
            apply(companion.event("petted"))
        }
    }

    // MARK: - Companion (conversations, affection, reminders: electron/src/companion)

    private func setPersonality() {
        let args = CommandLine.arguments
        let forced = args.firstIndex(of: "personality").flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
        companion.setPersonality(forPack: spritePackName, override: forced)
    }

    private func tickCompanion(_ now: Double, idle: Double) {
        let top = topSession
        let today = stats.today
        let ctx: [String: Any] = [
            "idle": idle, "owner": config.ownerName, "pet": config.petName, "focus": focus.phase == .off ? "off" : focus.phase == .focus ? "focus" : "rest",
            "quiet": quiet, "speaking": (speech?.until ?? 0) > now, "talking": talkOpen,
            "attention": top.map { [.needsYou, .error].contains($0.activity) } ?? false || !panel.isVisible,
            "activeMinutes": today.activeMinutes, "tasks": today.tasks, "focusSessions": today.focusSessions,
            "togetherMinutes": stats.togetherMinutes,
        ]
        apply(companion.tick(ctx))
    }

    /// Carries out what the companion engine asks for.
    private func apply(_ effects: [[String: Any]]) {
        for f in effects {
            switch f["type"] as? String ?? "" {
            case "say":
                if let text = f["text"] as? String { say(text, for: f["seconds"] as? Double ?? 4) }
            case "mood":
                if let mood = (f["mood"] as? String).flatMap(Companion.mood) { transient = (mood, CACurrentMediaTime() + (f["seconds"] as? Double ?? 6)) }
            case "xp":
                gainXP(f["amount"] as? Int ?? 0, play: f["play"] as? Bool ?? false)
            case "offer":
                transient = (.startled, CACurrentMediaTime() + 0.8)
                sounds.play(.needsYou)
            case "tier":
                if f["down"] as? Bool != true { sounds.play(.levelUp) }
            case "playtime":
                startPlaytime(minutes: f["minutes"] as? Double ?? 10)
            case "openTalk":
                openTalk(topic: f["topic"] as? String)
            case "trip":
                openControlCenter(page: "trips")
            case "quit":
                DispatchQueue.main.asyncAfter(deadline: .now() + (f["delay"] as? Double ?? 500) / 1000) { [weak self] in
                    self?.talk?.close()
                    self?.quit()
                }
            default: break
            }
        }
    }

    @objc private func openTalkAction() { openTalk(topic: nil) }

    private var talkStart: String?

    private func openTalk(topic: String?) {
        walkTarget = nil
        if let talk, talk.isVisible {
            talk.show()
            if let topic { talk.run("window.__talkOpen(\(topic == "offer" ? "'offer'" : "'\(topic)'"))") }
            return
        }
        talkStart = topic
        let t = TalkWindow(frame: talkFrame(height: 230)) { [weak self] action, payload in self?.talkCall(action, payload) }
        t.onClose = { [weak self] in self?.talk = nil }
        talk = t
        t.show()
    }

    /// Beside the pet, bottom-aligned with its feet, on whichever side has room.
    private func talkFrame(height: CGFloat) -> NSRect {
        let vf = petScreen().visibleFrame
        let pet = petView.hitRect.offsetBy(dx: panel.frame.minX, dy: panel.frame.minY)
        let w = TalkWindow.width
        let roomRight = vf.maxX - pet.maxX, roomLeft = pet.minX - vf.minX
        var x = (roomRight >= w || roomRight > roomLeft) && pet.midX < vf.minX + vf.width * 0.6 ? pet.maxX - 4 : pet.minX - w + 4
        x = max(vf.minX, min(vf.maxX - w, x))
        let y = max(vf.minY, min(vf.maxY - height, panel.frame.minY + PetView.ground - 10))
        return NSRect(x: x, y: y, width: w, height: height)
    }

    private func talkCall(_ action: String, _ payload: [String: Any]) -> Any? {
        switch action {
        case "init":
            defer { talkStart = nil }
            return ["theme": themeHex.isEmpty ? NSNull() : themeHex, "start": talkStart ?? NSNull(), "platform": "mac"] as [String: Any]
        case "resize":
            let h = min(600, max(150, payload["height"] as? Double ?? 230))
            talk?.setHeight(CGFloat(h))
            return ["ok": true]
        case "close":
            apply(companion.ui("close", [:]).effects)
            talk?.close()
            return ["ok": true]
        case "log":
            NSLog("DeskPet talk: \(payload["message"] as? String ?? "")")
            return ["ok": true]
        default:
            let r = companion.ui(action, payload)
            apply(r.effects)
            return r.result
        }
    }

    /// `open DeskPet.app --args talk-snapshot [personality minori]`.
    private func snapshotTalk() {
        openTalk(topic: nil)
        let demo = { (action: String, payload: String) in "window.__talkDemo('\(action)', \(payload))" }
        talk?.snapshot(steps: [
            ("menu", ""), ("ask-about", demo("menu", "{id: 'cats'}")), ("question", demo("menu", "{id: 'topic:q_chronotype'}")),
            ("game-ttt", demo("menu", "{id: 'game:ttt'}")), ("game-words", demo("menu", "{id: 'game:words'}")),
        ])
    }

    func petDragBegan() {
        if velocity != nil {
            gainXP(3, play: true)
            say(companion.line("caught", "nice catch! 🙌"), for: 1.5)
        }
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
        if speed > 400 {
            gainXP(3, play: true) { $0.throwsCount += 1 }
            apply(companion.event("thrown", ["playful": playing]))
        }
    }

    @objc private func togglePlaytime() {
        if playing { endPlaytime() } else { startPlaytime(minutes: 10) }
    }

    private func startPlaytime(minutes: Double) {
        playUntil = Date().addingTimeInterval(minutes * 60)
        apply(companion.event("playtimeStart"))
    }

    private func endPlaytime() {
        playUntil = nil
        apply(companion.event("playtimeEnd"))
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
        gainXP(10) { $0.tasks += 1 }
    }

    /// Awards XP (play XP is capped per day), shows "+N XP", and celebrates level-ups.
    private func gainXP(_ amount: Int, play: Bool = false, _ change: (inout Stats.Day) -> Void = { _ in }) {
        var xp = amount
        if play { xp = max(0, min(amount, Stats.dailyPlayCap - stats.today.playXP)) }
        let newLevel = stats.record(xp: xp) {
            change(&$0)
            if play { $0.playXP += xp }
        }
        if xp > 0 {
            let now = CACurrentMediaTime()
            let pending = xpPopup.map { now - $0.at < 1.2 ? $0.amount : 0 } ?? 0
            xpPopup = (pending + xp, now)
        }
        levelUp(newLevel)
    }

    private func levelUp(_ newLevel: Int?) {
        guard let newLevel else { return }
        transient = (.done, CACurrentMediaTime() + 3)
        sounds.play(.levelUp)
        if stats.prestige >= Prestige.maxRank {
            let big = newLevel % 100 == 0
            say(big ? "Prestige Master level \(newLevel)! 💎" : "level \(newLevel)! 💎", for: big ? 5 : 3)
            if big { post("Level \(newLevel)!", "\(config.petName) is a level \(newLevel) Prestige Master 💎", pid: 0) }
            return
        }
        if stats.canPrestige {
            say("MAX LEVEL! prestige from 🐾 → Rewards ⭐", for: 6)
            post("Level 100!", "\(config.petName) can prestige now: 🐾 → Rewards → Prestige", pid: 0)
            return
        }
        // First time through, new rewards are worn right away so you see them.
        let fresh = stats.prestige == 0 ? Reward.allCases.filter { $0.level == newLevel } : []
        for reward in fresh { wear(reward) }
        if let reward = fresh.first {
            say("level \(newLevel)! unlocked \(reward.title) ✨", for: 5)
            post("Level \(newLevel)!", "\(config.petName) unlocked \(reward.title). Change rewards in the 🐾 menu.", pid: 0)
        } else {
            say("level up! \(stats.rankTitle) ✨", for: 4)
        }
    }

    private func wear(_ reward: Reward) {
        if reward.slot == .golden { defaults.set(true, forKey: reward.slot.key) } else { defaults.set(reward.value, forKey: reward.slot.key) }
    }

    /// One-time setup when the reward track changes: carry over what you wore, then point at the menu.
    private func wearEarnedRewardsOnce() {
        if defaults.object(forKey: "aura") as? Bool == true, defaults.string(forKey: "auraStyle") == nil {
            defaults.set("golden", forKey: "auraStyle")   // the old Lv 12 aura
        }
        guard defaults.integer(forKey: "rewardsVersion") < 2 else { return }
        defaults.set(2, forKey: "rewardsVersion")
        let earned = Reward.allCases.filter(isUnlocked)
        guard !earned.isEmpty else { return }
        for slot in [Reward.Slot.hat, .trail, .companion] where worn(slot) == nil {
            if let best = earned.last(where: { $0.slot == slot }) { wear(best) }
        }
        say("\(earned.count) reward\(earned.count == 1 ? "" : "s") unlocked so far! see 🐾 → Rewards ✨", for: 5)
    }

    @objc private func chooseReward(_ sender: NSMenuItem) {
        guard let reward = Reward(rawValue: sender.representedObject as? String ?? "") else { return }
        if reward.slot == .golden {
            defaults.set(!defaults.bool(forKey: reward.slot.key), forKey: reward.slot.key)
        } else {
            defaults.set(wearing(reward) ? "" : reward.value, forKey: reward.slot.key)
        }
    }

    @objc private func clearSlot(_ sender: NSMenuItem) {
        guard let slot = Reward.Slot(rawValue: sender.representedObject as? String ?? "") else { return }
        defaults.set("", forKey: slot.key)
    }

    @objc private func togglePrestigeBadge() { showPrestigeBadge.toggle() }

    @objc private func prestigeNow() {
        guard stats.canPrestige else { return }
        let next = stats.prestige + 1
        let alert = NSAlert()
        alert.messageText = "Enter \(Prestige.title(next))?"
        alert.informativeText = next == Prestige.maxRank
            ? "\(config.petName) goes back to level 1 as a Prestige Master and can then level all the way to 1000. Every reward stays unlocked."
            : "\(config.petName) goes back to level 1 and earns a \(Prestige.emblem(next)) prestige badge. Every reward stays unlocked."
        alert.addButton(withTitle: "Prestige")
        alert.addButton(withTitle: "Not yet")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        performPrestige()
    }

    private func performPrestige() {
        guard stats.canPrestige else { return }
        let next = stats.prestige + 1
        stats.doPrestige()
        transient = (.done, CACurrentMediaTime() + 4)
        sounds.play(.levelUp)
        say("\(Prestige.title(next).uppercased())! back to level 1 ⭐", for: 6)
        post(Prestige.title(next), "\(config.petName) prestiged! Every reward stays unlocked.", pid: 0)
    }

    // MARK: - Rename

    @objc private func rename() {
        let alert = NSAlert()
        alert.messageText = "Rename"
        alert.informativeText = "Change your pet's name, or what it calls you."
        let petField = NSTextField(string: config.petName)
        let ownerField = NSTextField(string: config.ownerName)
        let stack = NSStackView(views: [NSTextField(labelWithString: "Pet's name"), petField,
                                        NSTextField(labelWithString: "Your name"), ownerField])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 4
        stack.setCustomSpacing(12, after: petField)
        for f in [petField, ownerField] { f.widthAnchor.constraint(equalToConstant: 240).isActive = true }
        stack.frame = NSRect(x: 0, y: 0, width: 240, height: 104)
        alert.accessoryView = stack
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = petField
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let pet = petField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let owner = ownerField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        applyNames(pet: pet.isEmpty ? config.petName : String(pet.prefix(20)),
                   owner: owner.isEmpty ? config.ownerName : String(owner.prefix(24)))
    }

    private func applyNames(pet: String, owner: String) {
        let renamed = pet != config.petName
        Config.save(["petName": pet, "ownerName": owner])
        config.petName = pet
        config.ownerName = owner
        transient = (.petted, CACurrentMediaTime() + 2.5)
        say(renamed ? "\(pet)? I love it! 💕" : "got it, \(owner)! 👋", for: 3)
    }

    private func todaySummary() -> String {
        let d = stats.today
        func hm(_ minutes: Int) -> String { minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes)m" }
        let blocked = d.blocked > 0 ? " · 🍅 \(d.blocked) blocked" : ""
        return "⌨️ \(hm(d.activeMinutes)) you · 🤖 \(hm(d.agentMinutes)) agents · ✅ \(d.tasks) task\(d.tasks == 1 ? "" : "s")\(blocked)"
    }

    /// Shows the card after hovering the pet for a moment; keeps it while the mouse is on the pet or the card.
    private func updateHoverCard(_ now: Double) {
        let m = NSEvent.mouseLocation
        let local = NSPoint(x: m.x - panel.frame.minX, y: m.y - panel.frame.minY)
        let overPet = panel.isVisible && petView.hitRect.contains(local) && !petView.dragging && !petView.resizing && velocity == nil
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
        model.rank = stats.rankTitle
        model.atMax = stats.atMax
        model.progress = stats.progress
        model.xpToNext = stats.xpToNext
        model.today = todaySummary()
        let together = stats.togetherMinutes
        model.together = "⏱ \(together >= 60 ? "\(together / 60)h \(together % 60)m" : "\(together)m") together"
        model.focus = focus.phase == .off ? "" : focus.label
        model.quiet = quiet
        model.nextReward = stats.canPrestige ? "⭐ Ready to prestige! (🐾 → Rewards)"
            : stats.prestige > 0 ? "" : Reward.next(after: stats.level).map { "Next reward: \($0.title) at Lv \($0.level)" } ?? ""
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
        if let url = urls.first(where: { MovingFile.extensions.contains($0.pathExtension.lowercased()) }) { return confirmMoveIn(url) }
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
        let blocking = blockDuringFocus && !blocklist.isEmpty ? ", blocking \(blocklist.count) sites" : ""
        say("focus mode: \(sender.tag) minutes\(blocking). you got this! 🍅", for: 3.5)
    }

    // MARK: - Cloud sync

    private func syncProfile() -> [String: Any] {
        var settings: [String: Any] = [:]
        for key in TransferKey.settingKeys { if let v = defaults.object(forKey: key) { settings[key] = v } }
        return ["names": ["petName": config.petName, "ownerName": config.ownerName], "settings": settings,
                "prestige": stats.prestige, "prestigeBase": stats.prestigeBase, "companion": companion.exportData()]
    }

    private func syncTick() {
        guard !Visitor.active else { return }
        let levelBefore = stats.level
        if stats.syncedPrestige == nil { stats.syncedPrestige = (stats.prestige, stats.prestigeBase) }
        guard let result = sync.sync(localStats: stats.deviceExport, profile: syncProfile()) else { return }
        stats.remoteXP = result.remoteXP
        stats.remoteDays = result.remoteDays
        if let profile = result.newerProfile { applySyncProfile(profile) }
        if stats.level > levelBefore { levelUp(stats.level) }
    }

    /// Another device changed names, settings, or prestige more recently: follow it.
    private func applySyncProfile(_ profile: [String: Any]) {
        let packBefore = spritePackName
        if let names = profile["names"] as? [String: Any] {
            let pet = names["petName"] as? String ?? config.petName, owner = names["ownerName"] as? String ?? config.ownerName
            if pet != config.petName || owner != config.ownerName {
                Config.save(["petName": pet, "ownerName": owner])
                config.petName = pet
                config.ownerName = owner
            }
        }
        for (key, value) in profile["settings"] as? [String: Any] ?? [:] where TransferKey.settingKeys.contains(key) && !(value is NSNull) {
            defaults.set(value, forKey: key)
        }
        if let rank = profile["prestige"] as? Int, let base = profile["prestigeBase"] as? Int { stats.syncedPrestige = (rank, base) }
        if let data = profile["companion"] as? [String: Any] { companion.mergeData(data) }
        if spritePackName != packBefore { loadSprites(announce: false) }
        petView.theme = Theme(hex: themeHex) ?? .default
        petView.thoughtBubble = thoughtBubble
        sounds.enabled = soundsOn
        sync.accept(profile: syncProfile())
    }

    private func syncState() -> [String: Any] {
        let fmt = RelativeDateTimeFormatter()
        fmt.unitsStyle = .short
        return [
            "enabled": sync.enabled, "folder": sync.folder?.path as Any, "folderName": sync.folder?.lastPathComponent as Any,
            "devices": sync.devices.map { d in
                ["name": d.name, "platform": d.platform, "me": d.id == sync.deviceID, "xp": d.xp,
                 "updated": fmt.localizedString(for: Date(timeIntervalSince1970: d.updated), relativeTo: Date())] as [String: Any]
            },
            "lastSync": sync.lastSync.map { fmt.localizedString(for: $0, relativeTo: Date()) } as Any,
            "error": sync.error as Any,
            "syncPacks": defaults.bool(forKey: "syncPacks"),
            "candidates": Sync.candidates().map { ["name": $0.name, "path": $0.path] },
            "deviceName": sync.deviceName,
        ]
    }

    private func enableSync(path: String, fresh: Bool) {
        if fresh { stats.resetLocal() }
        let folder = URL(fileURLWithPath: path)
        let first = Sync.inspect(folder, excluding: sync.deviceID).devices == 0
        sync.folder = folder
        stats.syncedPrestige = (stats.prestige, stats.prestigeBase)
        sync.prepareJoin(profile: syncProfile(), first: first)
        lastSyncTick = 0
        syncTick()
        say(fresh ? "synced! picking up where you left off ☁️" : "sync is on: progress adds up across devices ☁️", for: 4)
    }

    private func disableSync() {
        stats.leaveSync()
        sync.disable()
        if defaults.bool(forKey: "syncPacks") {
            defaults.set(false, forKey: "syncPacks")
            loadSprites(announce: false)
        }
        say("sync is off ☁️", for: 2.5)
    }

    /// Moving packs into the sync folder copies the local ones there first.
    private func setSyncPacks(_ on: Bool) {
        if on, let dest = sync.spritesFolder {
            let local = DeskPetPaths.root.appendingPathComponent("sprites")
            try? FileManager.default.createDirectory(at: dest, withIntermediateDirectories: true)
            for name in (try? FileManager.default.contentsOfDirectory(atPath: local.path)) ?? [] where !name.hasPrefix(".") {
                let target = dest.appendingPathComponent(name)
                if !FileManager.default.fileExists(atPath: target.path) {
                    try? FileManager.default.copyItem(at: local.appendingPathComponent(name), to: target)
                }
            }
        }
        defaults.set(on, forKey: "syncPacks")
        loadSprites(announce: false)
    }

    // MARK: - Focus blocklist

    private func checkForDistraction() {
        guard let app = NSWorkspace.shared.frontmostApplication, BrowserWatcher.isBrowser(app) else { return }
        let list = blocklist
        BrowserWatcher.activeURL(of: app) { [weak self] url in
            guard let self, self.focus.phase == .focus, let url, let domain = Blocklist.match(url: url, in: list) else { return }
            let now = CACurrentMediaTime()
            if self.strictBlock {
                BrowserWatcher.closeActiveTab(of: app)
                self.say("closed \(domain). focus! 🍅", for: 3)
            } else if now - self.lastBlockNag > 15 {
                self.lastBlockNag = now
                self.say("🍅 \(domain) is on your blocklist!", for: 4)
            } else {
                return
            }
            self.transient = (.startled, now + 1.2)
            self.sounds.play(.needsYou)
            self.stats.record { $0.blocked += 1 }
        }
    }

    @objc private func toggleBlockDuringFocus() { blockDuringFocus.toggle() }
    @objc private func toggleStrictBlock() { strictBlock.toggle() }

    @objc private func editBlocklist() {
        let alert = NSAlert()
        alert.messageText = "Focus blocklist"
        alert.informativeText = "One site per line. During focus sessions \(config.petName) calls you out on these, or closes the tab in strict mode. Works in Safari, Chrome, Edge, Brave, Arc, Vivaldi, and Opera."
        let scroll = NSTextView.scrollableTextView()
        scroll.frame = NSRect(x: 0, y: 0, width: 320, height: 170)
        scroll.borderType = .bezelBorder
        let text = scroll.documentView as! NSTextView
        text.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        text.string = blocklist.joined(separator: "\n")
        text.isAutomaticSpellingCorrectionEnabled = false
        alert.accessoryView = scroll
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Reset to defaults")
        alert.window.initialFirstResponder = text
        NSApp.activate(ignoringOtherApps: true)
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            blocklist = Blocklist.parse(text.string)
            say("blocklist saved: \(blocklist.count) site\(blocklist.count == 1 ? "" : "s") 🍅", for: 2.5)
        case .alertThirdButtonReturn:
            blocklist = Blocklist.defaults
            say("blocklist reset 🍅", for: 2)
        default:
            break
        }
    }

    // MARK: - Transfer key

    private func transferPayload() -> [String: Any] {
        var settings: [String: Any] = [:]
        for key in TransferKey.settingKeys { if let v = defaults.object(forKey: key) { settings[key] = v } }
        var scales: [String: Any] = [:]
        for (key, value) in defaults.dictionaryRepresentation() where key.hasPrefix("scale.") { scales[String(key.dropFirst(6))] = value }
        settings["scales"] = scales
        let iso = ISO8601DateFormatter().string(from: Date())
        return ["app": "deskpet", "v": 1, "exported": iso, "from": "macOS",
                "config": ["ownerName": config.ownerName, "petName": config.petName],
                "settings": settings, "stats": stats.exported, "companion": companion.exportData()]
    }

    /// Applies an imported key. Returns a note about anything that didn't come along.
    @discardableResult
    private func applyTransfer(_ payload: [String: Any], quietly: Bool = false) throws -> String {
        let incoming = payload["config"] as? [String: Any] ?? [:]
        let owner = incoming["ownerName"] as? String ?? config.ownerName
        let pet = incoming["petName"] as? String ?? config.petName
        Config.save(["ownerName": owner, "petName": pet])
        config.ownerName = owner
        config.petName = pet
        let settings = payload["settings"] as? [String: Any] ?? [:]
        for key in TransferKey.settingKeys { if let v = settings[key], !(v is NSNull) { defaults.set(v, forKey: key) } }
        for (name, value) in settings["scales"] as? [String: Any] ?? [:] { defaults.set(value, forKey: "scale." + name) }
        if let s = payload["stats"] as? [String: Any] { try stats.replace(with: s) }
        if let c = payload["companion"] as? [String: Any] { companion.replaceData(c) }
        defaults.set(true, forKey: "setupComplete")

        var note = ""
        if !spritePackName.isEmpty && !SpritePack.available().contains(spritePackName) {
            note = "the \(spritePackName) sprite pack isn't on this Mac: export it as a zip and drop it on me"
            spritePackName = ""
        }
        loadSprites(announce: false)
        petView.theme = Theme(hex: themeHex) ?? .default
        petView.thoughtBubble = thoughtBubble
        sounds.enabled = soundsOn
        companion.setNames(owner: owner, pet: pet)
        setPersonality()
        guard !quietly else { return note }
        transient = (.done, CACurrentMediaTime() + 3)
        say(note.isEmpty ? "welcome home, \(owner)! everything's here ✨" : note, for: 5)
        return note
    }

    @objc private func exportTransferKey() {
        guard let key = try? TransferKey.encode(transferPayload()) else { return say("couldn't make a transfer key 😵", for: 3) }
        let alert = NSAlert()
        alert.messageText = "Your transfer key"
        alert.informativeText = "On the other device, open the 🐾 menu (system tray on Windows) → Import transfer key…, or use \"Have a transfer key?\" in setup. It holds your names, level and stats, look, and settings. Sprite pack images aren't included: export packs as zips."
        let scroll = NSTextView.scrollableTextView()
        scroll.frame = NSRect(x: 0, y: 0, width: 360, height: 110)
        scroll.borderType = .bezelBorder
        let text = scroll.documentView as! NSTextView
        text.font = .monospacedSystemFont(ofSize: 10.5, weight: .regular)
        text.string = key
        text.isEditable = false
        alert.accessoryView = scroll
        alert.addButton(withTitle: "Copy")
        alert.addButton(withTitle: "Save as File…")
        alert.addButton(withTitle: "Done")
        NSApp.activate(ignoringOtherApps: true)
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(key, forType: .string)
            say("transfer key copied! 📋", for: 2.5)
        case .alertSecondButtonReturn:
            let save = NSSavePanel()
            save.nameFieldStringValue = "DeskPet transfer key.txt"
            save.allowedContentTypes = [.plainText]
            if save.runModal() == .OK, let url = save.url {
                try? key.write(to: url, atomically: true, encoding: .utf8)
                say("saved your transfer key 💾", for: 2.5)
            }
        default:
            break
        }
    }

    @objc private func importTransferKey() {
        let alert = NSAlert()
        alert.messageText = "Import a transfer key"
        alert.informativeText = "Paste the key from your other device. This replaces your names, level, stats, and settings here."
        let scroll = NSTextView.scrollableTextView()
        scroll.frame = NSRect(x: 0, y: 0, width: 360, height: 110)
        scroll.borderType = .bezelBorder
        let text = scroll.documentView as! NSTextView
        text.font = .monospacedSystemFont(ofSize: 10.5, weight: .regular)
        alert.accessoryView = scroll
        alert.addButton(withTitle: "Import")
        alert.addButton(withTitle: "Open File…")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = text
        NSApp.activate(ignoringOtherApps: true)
        var key = ""
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            key = text.string
        case .alertSecondButtonReturn:
            let open = NSOpenPanel()
            open.allowedContentTypes = [.plainText]
            guard open.runModal() == .OK, let url = open.url, let contents = try? String(contentsOf: url) else { return }
            key = contents
        default:
            return
        }
        do {
            let payload = try TransferKey.decode(key)
            let confirm = NSAlert()
            confirm.messageText = "Bring over \(TransferKey.summary(payload))?"
            confirm.informativeText = "Your current level, stats, and settings on this Mac will be replaced (a backup of the stats is kept)."
            confirm.addButton(withTitle: "Import")
            confirm.addButton(withTitle: "Cancel")
            guard confirm.runModal() == .alertFirstButtonReturn else { return }
            try applyTransfer(payload)
        } catch {
            say("hmm: \(error.localizedDescription)", for: 4)
        }
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

    /// The quick menu (menu bar and right-click). Everything else lives in the control center.
    private func fill(_ menu: NSMenu) {
        menu.removeAllItems()
        if Visitor.active {
            menu.addItem(disabled("🧳 \(config.petName) is visiting \(sync.deviceName)"))
        } else if petAway {
            menu.addItem(disabled("🧳 \(config.petName) is out with you"))
        } else {
            menu.addItem(disabled("\(config.petName) · \(stats.rankTitle) — \(String(describing: mood))"))
        }
        menu.addItem(disabled("Today: \(todaySummary())"))
        if quiet { menu.addItem(disabled("🤫 Quiet: a mic or camera is in use")) }
        if let update = updater.available { menu.addItem(item("⬆️ Update to v\(update.version)", #selector(installUpdate))) }
        menu.addItem(.separator())
        if sessions.isEmpty {
            menu.addItem(disabled("No AI agents running"))
        } else {
            for s in sessions.sorted(by: { $0.activity.rawValue > $1.activity.rawValue }) {
                let project = s.project.isEmpty ? "" : " (\(s.project))"
                let i = item("\(s.activity == .idle ? "○" : "●") \(s.name)\(project) — \(s.detail)", #selector(jumpToSession(_:)))
                i.tag = Int(s.pid)
                i.isEnabled = s.pid > 0
                menu.addItem(i)
            }
        }
        for (path, trip) in visitorsAtDoor where !letOut.contains(path) {
            let i = item("🚪 Let \(trip["pet"] as? String ?? "them") out (visiting from \(Self.homeName(trip)))", #selector(letOutVisitor(_:)))
            i.representedObject = path
            menu.addItem(i)
        }
        menu.addItem(.separator())
        if petAway {
            if tripFolderPresent() { menu.addItem(item("🏠 Welcome \(config.petName) home", #selector(welcomeHomeAction))) }
            menu.addItem(item("Call \(config.petName) home without the drive", #selector(callHomeAction)))
            menu.addItem(item("Open DeskPet…", #selector(openControlCenterAction), key: ","))
            menu.addItem(.separator())
            menu.addItem(item("Quit DeskPet", #selector(quit), key: "q"))
            return
        }
        menu.addItem(item("💬 Talk to \(config.petName)…", #selector(openTalkAction)))
        menu.addItem(item("Open DeskPet…", #selector(openControlCenterAction), key: ","))
        if focus.phase == .off {
            let f = item("🍅 Focus for 25 minutes", #selector(startFocus(_:)))
            f.tag = 25
            menu.addItem(f)
        } else {
            menu.addItem(item("⏹ Stop focus (\(focus.label))", #selector(stopFocus)))
        }
        menu.addItem(item(playing ? "⏹ Stop playtime" : "🎾 Playtime: throw \(config.petName) around (10 min)", #selector(togglePlaytime)))
        menu.addItem(item("Rewards (\(stats.rankTitle))…", #selector(openRewardsPage)))
        if !Visitor.active { menu.addItem(item("🧳 Take \(config.petName) on a trip…", #selector(openTripsPage))) }
        menu.addItem(item("Bring \(config.petName) here", #selector(bringHere)))
        menu.addItem(item(panel.isVisible ? "Hide \(config.petName)" : "Show \(config.petName)", #selector(toggleVisible)))
        menu.addItem(.separator())
        menu.addItem(Visitor.active ? item("🏠 Go home (quit)", #selector(quit), key: "q") : item("Quit DeskPet", #selector(quit), key: "q"))
    }

    // MARK: - Trips (home side)

    private static func homeName(_ trip: [String: Any]) -> String { (trip["home"] as? [String: Any])?["name"] as? String ?? "another computer" }
    private static func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

    private func tripFolderPresent() -> Bool {
        guard let s = tripState, let path = s["path"] as? String else { return false }
        return TripFiles.read(URL(fileURLWithPath: path))?["id"] as? String == s["id"] as? String
    }

    /// Packs the pet onto a drive (or any folder) and sends it off with you.
    private func takeTrip(path: String, copyApp: Bool) -> [String: Any] {
        guard !Visitor.active else { return ["ok": false, "error": "\(config.petName) is already visiting"] }
        guard !petAway else { return ["ok": false, "error": "\(config.petName) is already on a trip"] }
        let folder = TripFiles.folder(for: URL(fileURLWithPath: path))
        let id = UUID().uuidString.lowercased()
        let iso = TripFiles.iso.string(from: Date())
        let profile = transferPayload()
        let pack = SpritePack.available().contains(spritePackName) ? spritePackName : ""
        let trip: [String: Any] = [
            "app": "deskpet", "kind": "trip", "v": 1, "id": id, "status": "away",
            "home": ["device": sync.deviceID, "name": sync.deviceName, "os": "macOS"],
            "pet": config.petName, "owner": config.ownerName, "leftAt": iso,
            "departure": ["stats": profile["stats"] ?? [:]], "profile": profile, "pack": pack, "visits": [], "updatedAt": iso,
        ]
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try TripFiles.copyPack(pack, to: folder)
            if copyApp { try TripFiles.copyApp(to: folder) }
            try TripFiles.write(trip, to: folder)
            TripFiles.writeReadMe(to: folder, pet: config.petName, owner: config.ownerName)
        } catch {
            let full = (error as NSError).code == NSFileWriteOutOfSpaceError
            return ["ok": false, "error": full ? "the drive is full" : error.localizedDescription]
        }
        let volume = (try? folder.resourceValues(forKeys: [.volumeNameKey]).volumeName) ?? folder.deletingLastPathComponent().lastPathComponent
        tripState = ["id": id, "path": folder.path, "volume": volume, "leftAt": Self.nowMs(), "sawGone": false]
        talk?.close()
        hoverCard.hide()
        walkTarget = nil
        apply(companion.event("tripLeave"))
        statusItem.button?.title = "🧳"
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) { [weak self] in
            guard let self, self.petAway else { return }
            self.panel.orderOut(nil)
        }
        return ["ok": true, "ejectable": TripFiles.ejectableVolume(of: folder) != nil]
    }

    /// Every few seconds: is the pet's drive back? Is someone else's pet at the door?
    private func watchTrips() {
        let state = tripState
        var foreign: [String: [String: Any]] = [:]
        var present = false
        for folder in TripFiles.candidates(including: state?["path"] as? String) {
            guard let trip = TripFiles.read(folder), trip["status"] as? String == "away" else { continue }
            let home = trip["home"] as? [String: Any] ?? [:]
            guard home["device"] as? String == sync.deviceID else {
                foreign[folder.path] = trip
                continue
            }
            if let state, trip["id"] as? String == state["id"] as? String {
                present = true
                let away = Self.nowMs() - (state["leftAt"] as? Double ?? 0)
                // Back from the trip once the drive has been away (or, after a restart, once some time has passed).
                if state["sawGone"] as? Bool == true || (tripLaunchCheck && away > 10 * 60 * 1000) {
                    tripLaunchCheck = false
                    return tripReturned(folder: folder, trip: trip)
                }
            } else {
                absorbLuggage(folder: folder, trip: trip)
            }
        }
        tripLaunchCheck = false
        if var s = state, !present, s["sawGone"] as? Bool != true {
            s["sawGone"] = true
            tripState = s
        }
        letOut = letOut.filter { foreign[$0] != nil }
        for (path, trip) in foreign where !letOut.contains(path) {
            let id = trip["id"] as? String ?? path
            guard announcedVisitors.insert(id).inserted else { continue }
            let pet = trip["pet"] as? String ?? "Someone"
            if !petAway { say("🧳 knock knock! \(pet) is visiting from \(Self.homeName(trip))!", for: 5) }
            post("🧳 \(pet) is at the door", "Visiting from \(Self.homeName(trip)). Open the 🐾 menu to let them out.", pid: 0)
        }
        visitorsAtDoor = foreign
    }

    /// Back home: unpack what the pet earned on the trip, then ask about your day.
    private func tripReturned(folder: URL, trip: [String: Any]) {
        let levelBefore = stats.level
        unpack(trip)
        var done = trip
        done["status"] = "home"
        done["returnedAt"] = TripFiles.iso.string(from: Date())
        try? TripFiles.write(done, to: folder)
        let leftAt = tripState?["leftAt"] as? Double ?? Self.nowMs()
        tripState = nil
        statusItem.button?.title = "🐾"
        panel.orderFrontRegardless()
        if gravity { velocity = .zero }
        sounds.play(.wake)
        let visits = (trip["visits"] as? [[String: Any]] ?? []).compactMap { $0["device"] as? String }
        apply(companion.event("tripReturn", ["minutes": (Self.nowMs() - leftAt) / 60000, "visits": visits, "id": trip["id"] ?? ""]))
        if stats.level > levelBefore { levelUp(stats.level) }
    }

    /// Stats earned on the trip, the pet's memories, and a rename made while away.
    private func unpack(_ trip: [String: Any]) {
        let profile = trip["profile"] as? [String: Any] ?? [:]
        let departure = (trip["departure"] as? [String: Any])?["stats"] as? [String: Any] ?? [:]
        if let s = profile["stats"] as? [String: Any] { stats.absorb(trip: s, departure: departure) }
        if let c = profile["companion"] as? [String: Any] { companion.mergeData(c) }
        let names = profile["config"] as? [String: Any] ?? [:]
        if let pet = names["petName"] as? String, pet != trip["pet"] as? String, !pet.isEmpty {
            Config.save(["petName": pet])
            config.petName = pet
            companion.setNames(owner: config.ownerName, pet: pet)
        }
    }

    /// An older trip's drive (the pet was called home without it): bring its progress back quietly.
    private func absorbLuggage(folder: URL, trip: [String: Any]) {
        let levelBefore = stats.level
        unpack(trip)
        var done = trip
        done["status"] = "home"
        done["returnedAt"] = TripFiles.iso.string(from: Date())
        try? TripFiles.write(done, to: folder)
        if !petAway { apply(companion.event("tripLuggage")) }
        if stats.level > levelBefore { levelUp(stats.level) }
    }

    @objc private func callHomeAction() { callHome() }

    private func callHome() {
        guard petAway else { return }
        tripState = nil
        statusItem.button?.title = "🐾"
        panel.orderFrontRegardless()
        if gravity { velocity = .zero }
        apply(companion.event("tripCalledHome"))
    }

    @objc private func welcomeHomeAction() { _ = welcomeHome() }

    private func welcomeHome() -> Bool {
        guard let s = tripState, let path = s["path"] as? String else { return false }
        let folder = URL(fileURLWithPath: path)
        guard let trip = TripFiles.read(folder), trip["id"] as? String == s["id"] as? String else { return false }
        tripReturned(folder: folder, trip: trip)
        return true
    }

    private func ejectTripDrive() -> [String: Any] {
        guard let path = tripState?["path"] as? String, let volume = TripFiles.ejectableVolume(of: URL(fileURLWithPath: path)) else {
            return ["ok": false, "error": "that isn't an ejectable drive"]
        }
        do {
            try NSWorkspace.shared.unmountAndEjectDevice(at: volume)
            if var s = tripState { s["sawGone"] = true; tripState = s }
            return ["ok": true]
        } catch {
            return ["ok": false, "error": "couldn't eject: \(error.localizedDescription)"]
        }
    }

    @objc private func letOutVisitor(_ sender: NSMenuItem) {
        if let path = sender.representedObject as? String { _ = letVisitorOut(path) }
    }

    /// Starts a second DeskPet for someone else's pet, with its data on their drive.
    private func letVisitorOut(_ path: String) -> [String: Any] {
        guard !Visitor.active, visitorsAtDoor[path] != nil else { return ["ok": false, "error": "that pet isn't here anymore"] }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.createsNewApplicationInstance = true
        cfg.arguments = ["--trip", path]
        cfg.activates = false
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: cfg) { _, _ in }
        letOut.insert(path)
        return ["ok": true]
    }

    private func tripPanelState() -> [String: Any] {
        var away: Any = NSNull()
        if let s = tripState {
            let leftAt = s["leftAt"] as? Double ?? Self.nowMs()
            let path = s["path"] as? String ?? ""
            away = ["volume": s["volume"] ?? "", "leftAt": leftAt, "minutes": Int((Self.nowMs() - leftAt) / 60000),
                    "present": tripFolderPresent(), "ejectable": TripFiles.ejectableVolume(of: URL(fileURLWithPath: path)) != nil]
        }
        var visiting: Any = NSNull()
        if let trip = visitorTrip { visiting = ["host": sync.deviceName, "homeName": Self.homeName(trip)] }
        return [
            "mode": Visitor.active ? "visiting" : petAway ? "away" : "home",
            "drives": TripFiles.drives().map { ["path": $0.url.path, "name": $0.name] },
            "away": away, "visiting": visiting,
            "ejectable": (away as? [String: Any])?["ejectable"] as? Bool ?? false,
            "visitors": visitorsAtDoor.filter { !letOut.contains($0.key) }.map { path, trip in
                ["path": path, "pet": trip["pet"] as? String ?? "Someone", "homeName": Self.homeName(trip)]
            },
            "appCopy": ["possible": !Visitor.active, "size": appCopySize],
        ]
    }

    // MARK: - Trips (visitor side)

    /// Before anything loads: is this a trip we can visit from?
    private func checkVisit() -> Bool {
        let alert = NSAlert()
        guard let folder = Visitor.trip, let trip = TripFiles.read(folder) else {
            alert.messageText = "No trip here"
            alert.informativeText = "This drive's trip file is missing or damaged."
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
            return false
        }
        let pet = trip["pet"] as? String ?? "Your pet"
        let atHome = (trip["home"] as? [String: Any])?["device"] as? String == Sync.thisDeviceID()
        if atHome || trip["status"] as? String != "away" {
            alert.messageText = atHome ? "\(pet) lives on this computer!" : "\(pet) is already home"
            alert.informativeText = atHome
                ? "Plug the drive in while DeskPet is open here and \(pet) comes home from the trip."
                : "This trip is over. Take \(pet) on a new trip from their home computer."
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
            return false
        }
        visitorTrip = trip
        Visitor.register()
        return true
    }

    private func beginVisit() {
        guard let folder = Visitor.trip, var trip = visitorTrip else { return }
        if let profile = trip["profile"] as? [String: Any] { _ = try? applyTransfer(profile, quietly: true) }
        var visits = trip["visits"] as? [[String: Any]] ?? []
        let first = !visits.contains { $0["device"] as? String == sync.deviceName }
        visits.append(["device": sync.deviceName, "os": "macOS", "at": TripFiles.iso.string(from: Date()), "minutes": 0])
        trip["visits"] = visits
        visitStarted = Date()
        visitorTrip = trip
        try? TripFiles.write(trip, to: folder)
        apply(companion.event("tripArrive", ["host": sync.deviceName, "homeName": Self.homeName(trip), "first": first]))
        // Ejecting the drive: save first, then leave with it.
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.willUnmountNotification, object: nil, queue: .main) { [weak self] n in
            guard let vol = n.userInfo?[NSWorkspace.volumeURLUserInfoKey] as? URL, folder.path.hasPrefix(vol.path) else { return }
            self?.saveVisit()
            NSApp.terminate(nil)
        }
    }

    private func watchVisit(_ now: Double) {
        guard let folder = Visitor.trip else { return }
        // The drive is gone: nothing left to save to.
        guard FileManager.default.fileExists(atPath: folder.appendingPathComponent("trip.json").path) else {
            visitorTrip = nil
            return NSApp.terminate(nil)
        }
        if now - lastVisitSave >= 20 {
            lastVisitSave = now
            saveVisit()
        }
    }

    /// Writes the pet's progress here back to the drive.
    private func saveVisit() {
        guard let folder = Visitor.trip, var trip = visitorTrip,
              FileManager.default.fileExists(atPath: folder.appendingPathComponent("trip.json").path) else { return }
        stats.saveIfNeeded()
        companion.flush()
        trip["profile"] = transferPayload()
        if var visits = trip["visits"] as? [[String: Any]], !visits.isEmpty {
            visits[visits.count - 1]["minutes"] = Int(Date().timeIntervalSince(visitStarted) / 60)
            trip["visits"] = visits
        }
        trip["updatedAt"] = TripFiles.iso.string(from: Date())
        try? TripFiles.write(trip, to: folder)
        visitorTrip = trip
    }

    // MARK: - Moving homes

    private static let movingType = UTType(filenameExtension: "chr") ?? .data

    private func packForMoving() -> [String: Any] {
        let save = NSSavePanel()
        save.nameFieldStringValue = "\(config.petName).chr"
        save.allowedContentTypes = [Self.movingType]
        NSApp.activate(ignoringOtherApps: true)
        guard save.runModal() == .OK, let url = save.url else { return ["ok": false] }
        let made = MovingFile.make(profile: transferPayload(), packName: spritePackName, device: sync.deviceName)
        do {
            try made.data.write(to: url, options: .atomic)
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
        apply(companion.event("movingOut"))
        return ["ok": true, "path": url.path, "note": made.note as Any]
    }

    private func openMovingFile() -> [String: Any] {
        let open = NSOpenPanel()
        open.allowedContentTypes = [Self.movingType, UTType(filenameExtension: "deskpet") ?? .data, .json]
        NSApp.activate(ignoringOtherApps: true)
        guard open.runModal() == .OK, let url = open.url else { return ["ok": false] }
        do {
            return ["ok": true, "path": url.path, "summary": MovingFile.summary(try MovingFile.read(url))]
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
    }

    @discardableResult
    private func moveIn(from url: URL) -> [String: Any] {
        guard !Visitor.active else { return ["ok": false, "error": "can't move in while visiting"] }
        do {
            let file = try MovingFile.read(url)
            _ = try MovingFile.installPack(file)
            let note = try applyTransfer(file["profile"] as? [String: Any] ?? [:], quietly: true)
            if note.isEmpty { apply(companion.event("movedIn")) } else { say(note, for: 5) }
            return ["ok": true, "note": note]
        } catch {
            return ["ok": false, "error": error.localizedDescription]
        }
    }

    /// Dropped on the pet or opened from Finder.
    private func confirmMoveIn(_ url: URL) {
        let alert = NSAlert()
        do {
            let file = try MovingFile.read(url)
            alert.messageText = "Move in \(MovingFile.summary(file))?"
            alert.informativeText = "This replaces the names, level, stats, memories, and settings on this Mac (a backup of the stats is kept)."
            alert.addButton(withTitle: "Move in")
            alert.addButton(withTitle: "Cancel")
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            let r = moveIn(from: url)
            if r["ok"] as? Bool != true { say("hmm: \(r["error"] as? String ?? "couldn't move in")", for: 4) }
        } catch {
            say("hmm: \(error.localizedDescription)", for: 4)
        }
    }

    // MARK: - Control center (the shared HTML in electron/src/panel)

    @objc private func openControlCenterAction() { openControlCenter(page: nil) }
    @objc private func openRewardsPage() { openControlCenter(page: "rewards") }
    @objc private func openTripsPage() { openControlCenter(page: "trips") }

    private func openControlCenter(page: String?) {
        if let controlCenter {
            controlCenter.show()
            if let page { controlCenter.run("window.__panelShow('\(page)')") }
            return
        }
        controlCenterPage = page
        let c = WizardController(page: "panel/index.html", size: NSSize(width: 940, height: 640), title: "DeskPet") { [weak self] action, payload in
            self?.panelCall(action, payload)
        }
        c.onClose = { [weak self] in self?.controlCenter = nil }
        controlCenter = c
        c.show()
    }

    private var controlCenterPage: String?

    private func panelState() -> [String: Any] {
        let now = CACurrentMediaTime()
        refreshHoverModel(now)
        let rows: [[String: Any]] = sessions.sorted { $0.activity.rawValue > $1.activity.rawValue }.map { s in
            let secs = Int(now - (busySince[s.id] ?? now))
            let usage = s.isCodex ? CodexLog.state(path: s.logPath, procBusy: true)?.tokens : transcriptTokens.usage(s.logPath)
            return [
                "name": s.name, "project": s.project, "detail": s.detail, "precise": s.precise, "pid": Int(s.pid),
                "color": Self.color(for: s.activity).hexString,
                "elapsed": s.activity == .idle ? "idle" : secs >= 60 ? "\(secs / 60)m" : "\(secs)s",
                "tokens": usage.map { "\(Self.compact($0.output)) out · \(Self.compact($0.context)) context" } ?? "",
            ]
        }
        let d = stats.today
        let pose = self.pose(now)
        let state: [String: Any] = [
            "platform": "mac", "chrome": "native", "version": Updater.currentVersion,
            "openPage": controlCenterPage as Any,
            "names": ["petName": config.petName, "ownerName": config.ownerName],
            "rank": [
                "title": stats.rankTitle, "level": stats.level, "progress": stats.progress, "xpToNext": stats.xpToNext,
                "atMax": stats.atMax, "prestige": stats.prestige, "canPrestige": stats.canPrestige,
                "prestigeTitle": Prestige.title(stats.prestige), "nextPrestigeTitle": Prestige.title(stats.prestige + 1),
                "emblem": Prestige.emblem(stats.prestige), "nextEmblem": Prestige.emblem(stats.prestige + 1).isEmpty ? "⭐" : Prestige.emblem(stats.prestige + 1),
                "xpToPrestige": max(0, Stats.xpNeeded(Prestige.levelCap) - stats.levelXP),
            ],
            "nextReward": hoverCard.model.nextReward,
            "slots": Reward.Slot.allCases.map { ["id": $0.rawValue, "title": $0.title] },
            "rewards": Reward.allCases.map { r in
                ["id": r.rawValue, "title": r.title, "level": r.level, "slot": r.slot.rawValue, "value": r.value,
                 "unlocked": isUnlocked(r), "worn": isUnlocked(r) && wearing(r)] as [String: Any]
            },
            "togetherMinutes": stats.togetherMinutes,
            "today": ["activeMinutes": d.activeMinutes, "agentMinutes": d.agentMinutes, "tasks": d.tasks, "pets": d.pets,
                      "focusSessions": d.focusSessions, "blocked": d.blocked],
            "sessions": rows,
            "focus": ["phase": focus.phase == .off ? "off" : focus.phase == .focus ? "focus" : "rest", "label": focus.label,
                      "remaining": focus.remaining, "minutes": focus.minutes,
                      "total": (focus.phase == .rest ? max(5, focus.minutes / 5) : focus.minutes) * 60],
            "blocklist": blocklist, "blockDuringFocus": blockDuringFocus, "strictBlock": strictBlock,
            "look": ["packs": SpritePack.available(), "spritePack": spritePackName, "themeColor": themeHex,
                     "thoughtBubble": thoughtBubble.rawValue, "scale": Double(petView.scale)],
            "toggles": ["wander": wander, "gravity": gravity, "walkOnWindows": walkOnWindows, "quietInCalls": quietInCalls, "typeAlong": typeAlong,
                        "notifications": notificationsOn, "sounds": soundsOn, "autoUpdate": autoUpdate,
                        "startAtLogin": SMAppService.mainApp.status == .enabled, "startAtLoginSupported": true,
                        "showPrestigeBadge": showPrestigeBadge],
            "hooks": ["claudeInstalled": HookInstaller.installed(), "claudeLive": HookInstaller.installed() && HookInstaller.live(),
                      "kiroInstalled": kiroHooksOn && KiroHooks.installed(), "kiroSupported": true],
            "update": ["available": updater.available?.version as Any],
            "sync": syncState(),
            "companion": companion.summary(),
            "trip": tripPanelState(),
            "preview": ["hat": pose.hat as Any, "trail": pose.trail as Any, "aura": pose.aura as Any,
                        "companion": pose.companion as Any, "golden": pose.golden, "prestige": pose.prestige],
        ]
        controlCenterPage = nil
        return state
    }

    private func panelCall(_ action: String, _ payload: [String: Any]) -> Any? {
        let homeOnly = ["hooks", "kiro", "transferImport", "syncEnable", "syncPacks", "checkUpdates", "installUpdate", "openWizard",
                        "tripTake", "movingApply", "tripLetOut"]
        if Visitor.active && (homeOnly.contains(action) || (action == "set" && payload["key"] as? String == "startAtLogin")) {
            return ["ok": false, "error": "not while \(config.petName) is visiting"]
        }
        switch action {
        case "state":
            return panelState()
        case "tripDrives":
            return ["drives": TripFiles.drives().map { ["path": $0.url.path, "name": $0.name] }]
        case "tripChooseFolder":
            let open = NSOpenPanel()
            open.canChooseDirectories = true
            open.canChooseFiles = false
            open.canCreateDirectories = true
            open.prompt = "Pack here"
            NSApp.activate(ignoringOtherApps: true)
            return open.runModal() == .OK ? ["path": open.url?.path ?? ""] : nil
        case "tripTake":
            return takeTrip(path: payload["path"] as? String ?? "", copyApp: payload["copyApp"] as? Bool ?? false)
        case "tripEject":
            return ejectTripDrive()
        case "tripCallHome":
            callHome()
            return ["ok": true]
        case "tripWelcome":
            return welcomeHome() ? ["ok": true] : ["ok": false, "error": "the drive isn't plugged in"]
        case "tripLetOut":
            return letVisitorOut(payload["path"] as? String ?? "")
        case "movingPack":
            return packForMoving()
        case "movingOpen":
            return openMovingFile()
        case "movingApply":
            return moveIn(from: URL(fileURLWithPath: payload["path"] as? String ?? ""))
        case "set":
            let value = payload["value"]
            switch payload["key"] as? String ?? "" {
            case "scale":
                petResize(to: min(4, max(0.25, CGFloat(value as? Double ?? 1))))
                petResizeEnded()
            case "blocklist":
                blocklist = (value as? [String]).map { Blocklist.parse($0.joined(separator: "\n")) } ?? Blocklist.defaults
            case "blockDuringFocus": blockDuringFocus = value as? Bool ?? true
            case "strictBlock": strictBlock = value as? Bool ?? false
            case "showPrestigeBadge": showPrestigeBadge = value as? Bool ?? true
            case "wander":
                wander = value as? Bool ?? true
                walkTarget = nil
            case "gravity": gravity = value as? Bool ?? true
            default:
                return wizardCall("set", payload)
            }
            return ["ok": true]
        case "wear":
            if let r = Reward(rawValue: payload["id"] as? String ?? ""), isUnlocked(r) {
                if r.slot == .golden { defaults.set(!wearing(r), forKey: r.slot.key) } else { defaults.set(wearing(r) ? "" : r.value, forKey: r.slot.key) }
            }
            return ["ok": true]
        case "prestige":
            performPrestige()
            return ["ok": true]
        case "focusStart":
            let minutes = payload["minutes"] as? Int ?? 25
            focus.start(minutes: minutes)
            let blocking = blockDuringFocus && !blocklist.isEmpty ? ", blocking \(blocklist.count) sites" : ""
            say("focus mode: \(minutes) minutes\(blocking). you got this! 🍅", for: 3.5)
            return ["ok": true]
        case "focusStop":
            focus.stop()
            return ["ok": true]
        case "jump":
            return ["ok": jump(to: pid_t(payload["pid"] as? Int ?? 0))]
        case "hooks":
            do {
                try HookInstaller.setInstalled(payload["install"] as? Bool ?? true)
                return ["ok": true]
            } catch {
                return ["ok": false, "error": error.localizedDescription]
            }
        case "kiro":
            return wizardCall("kiro", payload)
        case "rename":
            let pet = (payload["petName"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let owner = (payload["ownerName"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            applyNames(pet: pet.isEmpty ? config.petName : String(pet.prefix(20)), owner: owner.isEmpty ? config.ownerName : String(owner.prefix(24)))
            return ["ok": true]
        case "transferExport":
            return ["key": (try? TransferKey.encode(transferPayload())) ?? ""]
        case "copy":
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(payload["text"] as? String ?? "", forType: .string)
            say("transfer key copied! 📋", for: 2.5)
            return ["ok": true]
        case "saveKey":
            let save = NSSavePanel()
            save.nameFieldStringValue = "DeskPet transfer key.txt"
            save.allowedContentTypes = [.plainText]
            guard save.runModal() == .OK, let url = save.url else { return ["ok": false] }
            try? (payload["key"] as? String ?? "").write(to: url, atomically: true, encoding: .utf8)
            return ["ok": true]
        case "openKey":
            let open = NSOpenPanel()
            open.allowedContentTypes = [.plainText]
            guard open.runModal() == .OK, let url = open.url, let key = try? String(contentsOf: url) else { return [:] as [String: Any] }
            return ["key": key]
        case "transferPreview":
            do {
                return ["ok": true, "summary": TransferKey.summary(try TransferKey.decode(payload["key"] as? String ?? ""))]
            } catch {
                return ["ok": false, "error": error.localizedDescription]
            }
        case "transferImport":
            do {
                let note = try applyTransfer(try TransferKey.decode(payload["key"] as? String ?? ""))
                return ["ok": true, "note": note]
            } catch {
                return ["ok": false, "error": error.localizedDescription]
            }
        case "syncInspect":
            let found = Sync.inspect(URL(fileURLWithPath: payload["path"] as? String ?? ""), excluding: sync.deviceID)
            return ["devices": found.devices, "xp": found.xp, "names": found.names, "localXP": stats.localXP]
        case "syncChoose":
            let open = NSOpenPanel()
            open.canChooseDirectories = true
            open.canChooseFiles = false
            open.canCreateDirectories = true
            open.message = "Choose a folder your cloud drive syncs (iCloud Drive, OneDrive, Dropbox, …)"
            NSApp.activate(ignoringOtherApps: true)
            guard open.runModal() == .OK, let url = open.url else { return [:] as [String: Any] }
            return ["path": url.path]
        case "syncEnable":
            enableSync(path: payload["path"] as? String ?? "", fresh: payload["mode"] as? String == "fresh")
            return ["ok": true]
        case "syncDisable":
            disableSync()
            return ["ok": true]
        case "syncNow":
            syncTick()
            return ["ok": true]
        case "syncPacks":
            setSyncPacks(payload["on"] as? Bool ?? false)
            return ["ok": true]
        case "importPack": importPack(); return ["ok": true]
        case "exportPack": exportPack(); return ["ok": true]
        case "previewPoses": previewPoses(); return ["ok": true]
        case "talk": openTalk(topic: payload["topic"] as? String); return ["ok": true]
        case "companion":
            let r = companion.ui(payload["op"] as? String ?? "summary", payload)
            apply(r.effects)
            return r.result
        case "bringHere": bringHere(); return ["ok": true]
        case "resize": toggleResizing(); return ["ok": true]
        case "checkUpdates": checkForUpdates(manual: true); return ["ok": true]
        case "installUpdate": installUpdate(); return ["ok": true]
        case "openWizard": openWizard(); return ["ok": true]
        case "quit": quit(); return ["ok": true]
        case "close": controlCenter?.close(); return ["ok": true]
        case "log":
            let line = "\(Date()) \(payload["message"] as? String ?? "")\n"
            let url = DeskPetPaths.root.appendingPathComponent("panel.log")
            if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(Data(line.utf8)); h.closeFile() } else { try? line.write(to: url, atomically: true, encoding: .utf8) }
            return ["ok": true]
        default:
            return wizardCall(action, payload) // pack, openSprites, …
        }
    }

    private func rewardsMenu() -> NSMenu {
        let menu = NSMenu()
        menu.addItem(disabled(stats.rankTitle + (stats.atMax ? " · max" : " · \(stats.xpToNext) XP to next level")))
        if stats.canPrestige {
            menu.addItem(item("⭐ Prestige now → \(Prestige.title(stats.prestige + 1))", #selector(prestigeNow)))
        } else if stats.prestige == 0, let next = Reward.next(after: stats.level) {
            menu.addItem(disabled("Next: \(next.title) at Lv \(next.level) (\(Stats.xpNeeded(next.level) - stats.levelXP) XP to go)"))
        } else if stats.prestige < Prestige.maxRank {
            menu.addItem(disabled("Reach level 100 to prestige (\(Stats.xpNeeded(Prestige.levelCap) - stats.levelXP) XP to go)"))
        }
        for slot in Reward.Slot.allCases {
            menu.addItem(.separator())
            menu.addItem(disabled(slot.title))
            for reward in Reward.allCases where reward.slot == slot {
                let unlocked = isUnlocked(reward)
                let i = item(unlocked ? reward.title : "🔒 \(reward.title) · Lv \(reward.level)", #selector(chooseReward(_:)),
                             checked: unlocked && wearing(reward))
                i.representedObject = reward.rawValue
                i.isEnabled = unlocked
                menu.addItem(i)
            }
            if slot != .golden {
                let none = item("None", #selector(clearSlot(_:)), checked: worn(slot) == nil)
                none.representedObject = slot.rawValue
                menu.addItem(none)
            }
        }
        if stats.prestige > 0 {
            menu.addItem(.separator())
            menu.addItem(item("Show prestige badge", #selector(togglePrestigeBadge), checked: showPrestigeBadge))
        }
        return menu
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
            case "typeAlong": typeAlong = value as? Bool ?? true
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
        case "moving-open":
            return openMovingFile()
        case "moving-apply":
            let r = moveIn(from: URL(fileURLWithPath: payload["path"] as? String ?? ""))
            if r["ok"] as? Bool == true, let file = try? MovingFile.read(URL(fileURLWithPath: payload["path"] as? String ?? "")) {
                return r.merging(["summary": MovingFile.summary(file)]) { a, _ in a }
            }
            return r
        case "transfer-import":
            do {
                let payload = try TransferKey.decode(payload["key"] as? String ?? "")
                let note = try applyTransfer(payload)
                return ["ok": true, "summary": TransferKey.summary(payload), "note": note]
            } catch {
                return ["ok": false, "error": error.localizedDescription]
            }
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
    /// Quit from a menu: the pet counts it as a goodbye.
    @objc private func quit() {
        _ = companion.event("quit")
        guard Visitor.active else { return NSApp.terminate(nil) }
        // Going home from a visit: a little goodbye, then pack up (saving to the drive happens on terminate).
        say(companion.line("trip.goHome", "see you at home! 🏠"), for: 2)
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { NSApp.terminate(nil) }
    }

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
