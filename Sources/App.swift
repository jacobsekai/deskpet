import AppKit

struct Config {
    var ownerName: String
    var petName: String
    var spritePack: String
    var themeColor: String

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
    private let config = Config.load()
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
        say("hi \(config.ownerName)! 👋", for: 4)

        let timer = Timer(timeInterval: 1.0 / 30, repeats: true) { [weak self] _ in self?.tick() }
        RunLoop.main.add(timer, forMode: .common)
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
        }
        if idle > 240 && topSession.map({ $0.activity == .idle }) ?? true { wasAsleep = true }

        if idle > 300 {
            streakStart = now
        } else if now - streakStart > 50 * 60 {
            streakStart = now
            say("50 minutes straight — stretch break? 🙆", for: 6)
        }

        let hour = Calendar.current.component(.hour, from: Date())
        night = hour >= 23 || hour < 6
        if night && idle < 5 && now - lastNightNag > 3600 {
            lastNightNag = now
            say("it's late, \(config.ownerName)… bedtime soon? 🌙", for: 5)
        }

        mood = resolveMood(now: now, idle: idle, sinceKey: sinceKey)
        if mood == .idle && wander && !panel.isMiniaturized && now > nextWalkAt && velocity == nil && !petView.resizing { startWalk(now) }
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
            switch s.activity {
            case .done: say("\(s.name) is done! ✨", for: 4)
            case .needsYou: say("\(s.name) needs you! 🙋", for: 5)
            case .error: say("uh oh, \(s.name) hit an error 😵", for: 4)
            case .idle where !s.precise && now - (busySince[s.id] ?? now) > 15:
                say("\(s.name) looks done ✨", for: 4)
                transient = (.done, now + 3)
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
        let target = CGFloat.random(in: (vf.minX - 40)...(vf.maxX - size.width + 40))
        if abs(target - panel.frame.minX) > 80 { walkTarget = target }
    }

    private func move(dt: Double, now: Double) {
        var origin = panel.frame.origin
        if let v = velocity {
            simulateThrow(v, dt: CGFloat(dt), now: now)
            return
        }
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
        let floorY = vf.minY
        let ceilingY = vf.maxY - (PetView.ground + body.height)
        let bounciness: CGFloat = 0.72

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
        guard let remark = category.remarks.randomElement(), now - lastRemark > 45, Double.random(in: 0...1) < 0.4,
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
        menu.addItem(disabled("\(config.petName) — \(String(describing: mood))"))
        menu.addItem(.separator())
        if sessions.isEmpty {
            menu.addItem(disabled("No AI agents running"))
        } else {
            for s in sessions.sorted(by: { $0.activity.rawValue > $1.activity.rawValue }) {
                let project = s.project.isEmpty ? "" : " (\(s.project))"
                let source = s.precise ? "" : " · guessed from CPU"
                menu.addItem(disabled("\(s.activity == .idle ? "○" : "●") \(s.name)\(project) — \(s.detail)\(source)"))
            }
        }
        menu.addItem(.separator())
        menu.addItem(item("Wander around", #selector(toggleWander), checked: wander))
        menu.addItem(item("Gravity", #selector(toggleGravity), checked: gravity))
        menu.addItem(item("Bring \(config.petName) here", #selector(bringHere)))
        let sizeItem = NSMenuItem(title: "Size (\(Int((petView.scale * 100).rounded()))%)", action: nil, keyEquivalent: "")
        let sizeMenu = NSMenu()
        sizeMenu.addItem(item(petView.resizing ? "Finish resizing" : "Resize…", #selector(toggleResizing)))
        sizeMenu.addItem(.separator())
        for percent in [50, 75, 100, 125, 150, 200, 300] {
            let i = item("\(percent)%", #selector(chooseSize(_:)), checked: Int((petView.scale * 100).rounded()) == percent)
            i.tag = percent
            sizeMenu.addItem(i)
        }
        sizeItem.submenu = sizeMenu
        menu.addItem(sizeItem)
        let bubbleItem = NSMenuItem(title: "Thought bubble", action: nil, keyEquivalent: "")
        let bubbleMenu = NSMenu()
        for (title, size) in [("Large", ThoughtBubbleSize.large), ("Small", .small), ("Off", .off)] {
            let i = item(title, #selector(chooseThoughtBubble(_:)), checked: thoughtBubble == size)
            i.representedObject = size.rawValue
            bubbleMenu.addItem(i)
        }
        bubbleItem.submenu = bubbleMenu
        menu.addItem(bubbleItem)
        let themeTitle = petView.theme.accent.map { "Theme color (\($0.hexString))…" } ?? "Theme color…"
        menu.addItem(item(themeTitle, #selector(chooseTheme)))
        let spritesItem = NSMenuItem(title: "Sprites", action: nil, keyEquivalent: "")
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
        spritesMenu.addItem(item("Preview poses", #selector(previewPoses)))
        spritesMenu.addItem(item("Reload sprites", #selector(reloadSprites)))
        spritesMenu.addItem(item("Open sprites folder", #selector(openSpritesFolder)))
        spritesItem.submenu = spritesMenu
        menu.addItem(spritesItem)
        menu.addItem(item(panel.isVisible ? "Hide \(config.petName)" : "Show \(config.petName)", #selector(toggleVisible)))
        menu.addItem(.separator())
        menu.addItem(item("Quit DeskPet", #selector(quit), key: "q"))
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
