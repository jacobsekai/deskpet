import AppKit

enum Mood {
    case idle, walking, sleepy, sleeping, petted, dragged, flying, dizzy, startled, userTyping
    case thinking, typing, reading, searching, delegating, needsYou, done, oops, error, tidying
}

enum Accessory { case none, headphones, glasses }

struct PetPose {
    var mood: Mood = .idle
    var accessory: Accessory = .none
    var nightcap = false
    var facingLeft = false
    /// Direction toward the mouse cursor, each component in -1...1.
    var look = CGPoint.zero
    var subagents = 0
    /// Rotation while thrown, in radians.
    var spin: CGFloat = 0
    var caption: String?
    /// "+3 XP" floating up from the pet, and how long it's been showing.
    var xpText: String?
    var xpAge: Double = 0
    var captionColor: NSColor = .systemGray
    var bubble: String?
}

protocol PetViewDelegate: AnyObject {
    func petTapped()
    func petDragBegan()
    /// `velocity` is how fast the mouse was moving on release, in points per second.
    func petDragEnded(velocity: CGVector)
    func petMenu() -> NSMenu
    /// Live updates while a resize handle is dragged.
    func petResize(to scale: CGFloat)
    func petResizeEnded()
    func petResizeFinished()
    /// Files dropped on the pet (sprite pack zips, folders, or images).
    func petReceivedFiles(_ urls: [URL])
    func petDragHover()
}

private enum EyeStyle { case open, focused, wide, closed, happy, half, cross }
private enum MouthStyle { case w, smile, open, yawn, flat }

private let outline = NSColor(calibratedRed: 0.29, green: 0.19, blue: 0.15, alpha: 1)
private let fur = NSColor(calibratedRed: 0.99, green: 0.77, blue: 0.54, alpha: 1)
private let furLight = NSColor(calibratedRed: 1.0, green: 0.93, blue: 0.82, alpha: 1)
private let pink = NSColor(calibratedRed: 1.0, green: 0.60, blue: 0.66, alpha: 1)

final class PetView: NSView {
    weak var delegate: PetViewDelegate?
    var pose = PetPose()
    private(set) var dragging = false
    private var dragStartMouse: NSPoint?
    private var dragStartOrigin = NSPoint.zero
    private var dragSamples: [(time: Double, point: NSPoint)] = []
    private var resizeDrag: (anchor: NSPoint, startDistance: CGFloat, startScale: CGFloat)?
    private let start = CACurrentMediaTime()

    /// The ground line, in both window and canvas coordinates; scaling happens around it.
    static let ground: CGFloat = 34

    /// On-screen size multiplier for the character (1 = 100%). Speech bubbles and captions stay readable.
    var scale: CGFloat = 1
    /// Shows the resize box with corner handles.
    var resizing = false
    var theme = Theme.default
    var thoughtBubble = ThoughtBubbleSize.large
    static let scaleRange: ClosedRange<CGFloat> = 0.25...4

    /// The unscaled drawing area. Everything except bubbles and captions is drawn here, then scaled.
    private var canvas: NSRect {
        NSRect(x: 0, y: 0, width: bounds.width / scale, height: (bounds.height - Self.ground * (1 - scale)) / scale)
    }

    private func toWindow(_ p: NSPoint) -> NSPoint { NSPoint(x: p.x * scale, y: Self.ground * (1 - scale) + p.y * scale) }
    private func toWindow(_ r: NSRect) -> NSRect {
        let o = toWindow(r.origin)
        return NSRect(x: o.x, y: o.y, width: r.width * scale, height: r.height * scale)
    }

    /// When set, these images replace the built-in cat.
    var sprites: SpritePack?
    private var lastSpriteRect = NSRect.zero

    private var petCenterX: CGFloat { pose.mood == .typing && sprites == nil ? canvas.midX - 32 : canvas.midX }
    /// Where the eyes are, in window coordinates (for following the cursor).
    var eyePosition: NSPoint { toWindow(NSPoint(x: petCenterX, y: Self.ground + 40)) }
    /// The clickable area in window coordinates; everything else in the window lets clicks pass through.
    var hitRect: NSRect {
        var r = sprites != nil && !lastSpriteRect.isEmpty
            ? toWindow(lastSpriteRect).insetBy(dx: -6, dy: -6)
            : toWindow(NSRect(x: petCenterX - 50, y: Self.ground - 12, width: 100, height: 104))
        if resizing { r = r.union(resizeBox.insetBy(dx: -12, dy: -12)).union(doneRect) }
        return r
    }
    /// Half-width and height of the character above the ground line in window points, for bouncing off screen edges.
    var bodyExtent: (halfWidth: CGFloat, height: CGFloat) {
        if sprites != nil && !lastSpriteRect.isEmpty { return (lastSpriteRect.width / 2 * scale, lastSpriteRect.height * scale) }
        return (46 * scale, 84 * scale)
    }

    /// The box drawn around the character while resizing, based on the idle pose so it doesn't jitter.
    private var resizeBox: NSRect {
        let cx = canvas.midX
        let box: NSRect
        if let sprites {
            let s = sprites.frame(for: .idle, at: 0).size
            box = NSRect(x: cx - s.width / 2, y: Self.ground, width: s.width, height: s.height)
        } else {
            box = NSRect(x: cx - 46, y: Self.ground - 2, width: 112, height: 88)
        }
        return toWindow(box).insetBy(dx: -8, dy: -8)
    }

    private var handleRects: [NSRect] {
        let b = resizeBox
        return [NSPoint(x: b.minX, y: b.minY), NSPoint(x: b.maxX, y: b.minY), NSPoint(x: b.minX, y: b.maxY), NSPoint(x: b.maxX, y: b.maxY)]
            .map { NSRect(x: $0.x - 6, y: $0.y - 6, width: 12, height: 12) }
    }

    private var doneLabel: NSAttributedString {
        NSAttributedString(string: "\(Int((scale * 100).rounded()))%   ·   Done", attributes: [
            .font: NSFont.systemFont(ofSize: 11.5, weight: .semibold), .foregroundColor: theme.text(on: theme.resizeAccent),
        ])
    }

    /// The "125% · Done" pill above the resize box.
    private var doneRect: NSRect {
        let w = doneLabel.size().width + 22
        return NSRect(x: resizeBox.midX - w / 2, y: min(resizeBox.maxY + 8, bounds.height - 24), width: w, height: 22)
    }
    /// Size of the sprite relative to the 82pt-tall cat, used to scale effects around it.
    private var spriteScale: CGFloat { sprites.map { min(1.8, max(0.7, $0.height / 82)) } ?? 1 }

    override init(frame: NSRect) {
        super.init(frame: frame)
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        delegate?.petDragHover()
        return .copy
    }

    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self]) as? [URL] ?? []
        guard !urls.isEmpty else { return false }
        delegate?.petReceivedFiles(urls)
        return true
    }

    override var isFlipped: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    // MARK: - Input

    override func mouseDown(with event: NSEvent) {
        if event.modifierFlags.contains(.control) { return rightMouseDown(with: event) }
        if resizing {
            let p = convert(event.locationInWindow, from: nil)
            if doneRect.contains(p) {
                delegate?.petResizeFinished()
                return
            }
            if handleRects.contains(where: { $0.insetBy(dx: -6, dy: -6).contains(p) }), let window {
                // Scale by how far the handle moves from the feet, which stay put.
                let anchor = window.convertPoint(toScreen: NSPoint(x: bounds.midX, y: Self.ground))
                let m = NSEvent.mouseLocation
                resizeDrag = (anchor, max(10, hypot(m.x - anchor.x, m.y - anchor.y)), scale)
                return
            }
        }
        dragStartMouse = NSEvent.mouseLocation
        dragStartOrigin = window?.frame.origin ?? .zero
        dragSamples = []
        dragging = false
    }

    override func mouseDragged(with event: NSEvent) {
        if let r = resizeDrag {
            let m = NSEvent.mouseLocation
            let raw = r.startScale * hypot(m.x - r.anchor.x, m.y - r.anchor.y) / r.startDistance
            let snapped = (raw * 100).rounded() / 100
            delegate?.petResize(to: min(Self.scaleRange.upperBound, max(Self.scaleRange.lowerBound, snapped)))
            return
        }
        guard let startMouse = dragStartMouse, let window else { return }
        let m = NSEvent.mouseLocation
        let dx = m.x - startMouse.x, dy = m.y - startMouse.y
        if !dragging && hypot(dx, dy) > 3 {
            dragging = true
            delegate?.petDragBegan()
        }
        if dragging { window.setFrameOrigin(NSPoint(x: dragStartOrigin.x + dx, y: dragStartOrigin.y + dy)) }
        let now = CACurrentMediaTime()
        dragSamples.append((now, m))
        dragSamples.removeAll { now - $0.time > 0.1 }
    }

    override func mouseUp(with event: NSEvent) {
        if resizeDrag != nil {
            resizeDrag = nil
            delegate?.petResizeEnded()
            return
        }
        guard dragStartMouse != nil else { return }
        dragStartMouse = nil
        if dragging {
            dragging = false
            delegate?.petDragEnded(velocity: releaseVelocity())
        } else {
            delegate?.petTapped()
        }
    }

    /// Mouse speed over the last 0.1s of the drag; zero if the mouse had stopped before release.
    private func releaseVelocity() -> CGVector {
        guard let first = dragSamples.first, let last = dragSamples.last,
              last.time - first.time > 0.01, CACurrentMediaTime() - last.time < 0.05 else { return .zero }
        let dt = last.time - first.time
        return CGVector(dx: (last.point.x - first.point.x) / dt, dy: (last.point.y - first.point.y) / dt)
    }

    override func rightMouseDown(with event: NSEvent) {
        if let menu = delegate?.petMenu() { NSMenu.popUpContextMenu(menu, with: event, for: self) }
    }

    // MARK: - Drawing

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        dirtyRect.fill(using: .copy)

        let t = CACurrentMediaTime() - start
        NSGraphicsContext.saveGraphicsState()
        let tf = NSAffineTransform()
        tf.translateX(by: 0, yBy: Self.ground * (1 - scale))
        tf.scale(by: scale)
        tf.concat()
        let bubbleAnchor = sprites.map { drawSprites($0, t) } ?? drawCatScene(t)
        NSGraphicsContext.restoreGraphicsState()

        if let text = pose.bubble {
            let a = toWindow(bubbleAnchor)
            drawSpeech(text, anchorX: a.x, y: a.y)
        }
        if let caption = pose.caption { drawCaption(caption, color: pose.captionColor) }
        if let xp = pose.xpText { drawXP(xp, from: toWindow(bubbleAnchor)) }
        if resizing { drawResizeOverlay() }
    }

    /// Draws the built-in cat in canvas coordinates; returns where a speech bubble should point.
    private func drawCatScene(_ t: Double) -> NSPoint {
        let m = pose.mood
        let cx = petCenterX
        let g = Self.ground
        let bob = bounce(m, t)
        let base = g + bob
        let lift: CGFloat = m == .dragged ? 8 : 0

        // Shadow shrinks as the pet hops.
        let s = m == .dragged ? 0.55 : 1 - min(bob, 12) / 36
        if m != .flying {
            NSColor(white: 0, alpha: 0.16).setFill()
            oval(cx, g - 1, 78 * s, 11 * s).fill()
        }

        if pose.subagents > 0 && m != .idle && m != .sleeping { drawMinis(cx: cx, g: g, t: t) }
        if m == .typing { draw(at: cx + 46, g) { drawLaptop(t) } }

        let face = faceFor(m, t)
        draw(at: cx, base + lift, flip: pose.facingLeft && m == .walking,
             rotate: m == .dragged ? sin(t * 4) * 0.12 : (m == .flying ? pose.spin : 0),
             pivotY: m == .flying ? 38 : 70,
             scaleY: m == .sleeping ? 1 + sin(t * 1.4) * 0.025 : 1) {
            drawCat(m, t, eyes: face.eyes, mouth: face.mouth, look: face.look ?? lookOffset())
        }

        drawProps(m, t, cx: cx, g: g, base: base)
        drawEffects(m, t, cx: cx, base: base)

        if pose.bubble == nil { drawThoughts(m, t, cx: cx, base: base) }
        return NSPoint(x: cx, y: base + 92)
    }

    private func drawResizeOverlay() {
        let box = resizeBox
        let accent = theme.resizeAccent
        accent.withAlphaComponent(0.06).setFill()
        NSBezierPath(roundedRect: box, xRadius: 6, yRadius: 6).fill()
        let border = NSBezierPath(roundedRect: box, xRadius: 6, yRadius: 6)
        border.setLineDash([6, 4], count: 2, phase: 0)
        border.lineWidth = 1.5
        accent.setStroke(); border.stroke()
        for h in handleRects {
            let p = NSBezierPath(roundedRect: h, xRadius: 3, yRadius: 3)
            NSColor.white.setFill(); p.fill()
            p.lineWidth = 2; accent.setStroke(); p.stroke()
        }
        let pill = doneRect
        accent.setFill()
        NSBezierPath(roundedRect: pill, xRadius: 11, yRadius: 11).fill()
        let label = doneLabel
        let sz = label.size()
        label.draw(at: NSPoint(x: pill.midX - sz.width / 2, y: pill.midY - sz.height / 2))
    }

    /// Draws a sprite pack in canvas coordinates; returns where a speech bubble should point.
    private func drawSprites(_ pack: SpritePack, _ t: Double) -> NSPoint {
        let m = pose.mood
        let canvas = self.canvas
        let cx = canvas.midX
        let g = Self.ground
        let bob = pack.bounce ? bounce(m, t) : 0
        let base = g + bob + (m == .dragged ? 8 : 0)
        var (image, size, offset) = pack.frame(for: m, at: t)
        let fit = min(1, (canvas.width - 10) / size.width, (canvas.height - g - 10) / size.height)
        size = NSSize(width: size.width * fit, height: size.height * fit)

        let s = m == .dragged ? 0.55 : 1 - min(bob, 12) / 36
        if m != .flying {
            NSColor(white: 0, alpha: 0.16).setFill()
            oval(cx, g - 1, size.width * 0.75 * s, 11 * s).fill()
        }

        if pose.subagents > 0 && m != .idle && m != .sleeping {
            let mini = pack.frame(for: .typing, at: t + 0.4)
            let w = mini.size.width * 0.4, h = mini.size.height * 0.4
            for (i, x) in [cx - size.width / 2 - w / 2 - 8, cx + size.width / 2 + w / 2 + 8].prefix(min(pose.subagents, 2)).enumerated()
            where x - w / 2 > 0 && x + w / 2 < canvas.width {
                let hop = CGFloat(abs(sin(t * 7 + Double(i) * 1.7))) * 3
                drawImage(mini.image, in: NSRect(x: x - w / 2, y: g + hop, width: w, height: h), pack: pack, flip: false)
            }
        }

        let rect = NSRect(x: cx - size.width / 2 + offset.x, y: base + offset.y, width: size.width, height: size.height)
        lastSpriteRect = rect
        let movingLeft = pose.facingLeft && m == .walking
        let movingRight = !pose.facingLeft && m == .walking
        NSGraphicsContext.saveGraphicsState()
        if m == .dragged {
            let tf = NSAffineTransform()
            tf.translateX(by: cx, yBy: rect.maxY); tf.rotate(byRadians: sin(t * 4) * 0.1); tf.translateX(by: -cx, yBy: -rect.maxY)
            tf.concat()
        } else if m == .walking && !pack.hasArt(for: .walking) {
            // No walk cycle drawn: rock side to side from the feet so she doesn't just slide.
            let tf = NSAffineTransform()
            tf.translateX(by: rect.midX, yBy: rect.minY); tf.rotate(byRadians: CGFloat(sin(t * 9)) * 0.07); tf.translateX(by: -rect.midX, yBy: -rect.minY)
            tf.concat()
        } else if m == .flying {
            let tf = NSAffineTransform()
            tf.translateX(by: rect.midX, yBy: rect.midY); tf.rotate(byRadians: pose.spin); tf.translateX(by: -rect.midX, yBy: -rect.midY)
            tf.concat()
        }
        drawImage(image, in: rect, pack: pack, flip: pack.facesLeft ? movingRight : movingLeft)
        NSGraphicsContext.restoreGraphicsState()

        let k = spriteScale
        if pack.effects {
            draw(at: cx, base + rect.height - 82 * k, scale: k) {
                drawEffects(m, t, cx: 0, base: 0)
                if pose.bubble == nil { drawThoughts(m, t, cx: 0, base: 0) }
            }
        }
        return NSPoint(x: cx, y: rect.maxY + 8)
    }

    private func drawImage(_ image: CGImage, in rect: NSRect, pack: SpritePack, flip: Bool) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        ctx.saveGState()
        ctx.interpolationQuality = pack.pixelated ? .none : .high
        if flip {
            ctx.translateBy(x: rect.midX, y: 0); ctx.scaleBy(x: -1, y: 1); ctx.translateBy(x: -rect.midX, y: 0)
        }
        ctx.draw(image, in: rect)
        ctx.restoreGState()
    }

    private func bounce(_ m: Mood, _ t: Double) -> CGFloat {
        switch m {
        case .walking: return abs(sin(t * 9)) * 4
        case .userTyping: return abs(sin(t * 11)) * 2
        case .needsYou: return abs(sin(t * 7)) * 7
        case .done: return abs(sin(t * 6)) * 9
        case .petted: return abs(sin(t * 8)) * 2
        case .startled: return abs(sin(t * 10)) * 6
        case .typing: return abs(sin(t * 14)) * 0.8
        case .sleeping, .sleepy, .dragged, .flying: return 0
        case .dizzy: return CGFloat(abs(sin(t * 3))) * 1.5
        default: return CGFloat(sin(t * 2)) * 1.2
        }
    }

    private func lookOffset() -> CGPoint { pose.look }

    private func faceFor(_ m: Mood, _ t: Double) -> (eyes: EyeStyle, mouth: MouthStyle, look: CGPoint?) {
        switch m {
        case .idle, .userTyping, .walking: return (.open, .w, nil)
        case .sleepy:
            let yawning = fmod(t, 7) < 1.6
            return (yawning ? .closed : .half, yawning ? .yawn : .flat, CGPoint(x: 0, y: -0.4))
        case .sleeping: return (.closed, .flat, .zero)
        case .petted, .done: return (.happy, .smile, .zero)
        case .dragged, .startled, .flying: return (.wide, .open, nil)
        case .dizzy: return (.cross, .w, .zero)
        case .thinking: return (.open, .flat, CGPoint(x: 0.6, y: 0.9))
        case .typing: return (.focused, .w, CGPoint(x: 0.9, y: -0.5))
        case .reading: return (.open, .flat, CGPoint(x: sin(t * 2.5) * 0.8, y: -0.9))
        case .searching: return (.wide, .flat, CGPoint(x: 0.8, y: 0.1))
        case .delegating: return (.open, .smile, CGPoint(x: sin(t * 1.3), y: -0.2))
        case .needsYou: return (.wide, .open, nil)
        case .oops: return (.wide, .flat, CGPoint(x: -0.3, y: 0.2))
        case .error: return (.cross, .open, .zero)
        case .tidying: return (.happy, .w, .zero)
        }
    }

    // MARK: Cat (local coordinates: origin = bottom-center of the body)

    private func drawCat(_ m: Mood, _ t: Double, eyes: EyeStyle, mouth: MouthStyle, look: CGPoint) {
        // Tail
        let sway = CGFloat(sin(t * (m == .needsYou || m == .done ? 7 : 2))) * 10
        let tail = NSBezierPath()
        if m == .dragged || m == .flying {
            tail.move(to: pt(30, 14))
            tail.curve(to: pt(40 + sway * 0.3, -18), controlPoint1: pt(44, 8), controlPoint2: pt(42, -6))
        } else {
            tail.move(to: pt(32, 12))
            tail.curve(to: pt(60, 42 + sway), controlPoint1: pt(58, 4), controlPoint2: pt(66, 24))
        }
        tail.lineCapStyle = .round
        tail.lineWidth = 12; outline.setStroke(); tail.stroke()
        tail.lineWidth = 7; fur.setStroke(); tail.stroke()

        // Ears (drawn first so the body covers their base)
        let perk: CGFloat = m == .needsYou || m == .startled ? 4 : (m == .sleepy || m == .sleeping ? -3 : 0)
        for side in [-1.0, 1.0] as [CGFloat] {
            let ear = NSBezierPath()
            ear.move(to: pt(side * 38, 46)); ear.line(to: pt(side * 32, 82 + perk)); ear.line(to: pt(side * 11, 62)); ear.close()
            ear.lineJoinStyle = .round
            fillStroke(ear, fur)
            let inner = NSBezierPath()
            inner.move(to: pt(side * 31, 54)); inner.line(to: pt(side * 30, 74 + perk)); inner.line(to: pt(side * 18, 61)); inner.close()
            pink.setFill(); inner.fill()
        }

        // Feet
        if m == .dragged || m == .flying {
            for side in [-1.0, 1.0] as [CGFloat] {
                fillStroke(oval(side * 15, -6 + CGFloat(sin(t * 5 + Double(side))) * 2, 13, 17), furLight)
            }
        } else {
            let step = m == .walking ? CGFloat(sin(t * 12)) * 3 : 0
            fillStroke(oval(-16, 3 + max(0, step), 18, 11), furLight)
            fillStroke(oval(16, 3 + max(0, -step), 18, 11), furLight)
        }

        // Body
        let body = NSBezierPath(roundedRect: NSRect(x: -42, y: 0, width: 84, height: 66), xRadius: 38, yRadius: 32)
        fillStroke(body, fur)
        furLight.setFill(); oval(0, 17, 50, 26).fill()

        // Face
        let lx = look.x * 3.5, ly = look.y * 2.5
        drawEyes(eyes, t: t, dx: lx, dy: ly)
        pink.withAlphaComponent(m == .petted || m == .done ? 0.95 : 0.55).setFill()
        oval(-27, 30, 11, 7).fill(); oval(27, 30, 11, 7).fill()
        pink.setFill(); oval(lx * 0.5, 33 + ly * 0.4, 5, 3.5).fill()
        drawMouth(mouth, dx: lx * 0.5, dy: ly * 0.4)

        // Accessories
        switch pose.accessory {
        case .glasses:
            let g = NSBezierPath()
            g.appendOval(in: NSRect(x: -25, y: 30, width: 20, height: 18))
            g.appendOval(in: NSRect(x: 5, y: 30, width: 20, height: 18))
            g.move(to: pt(-5, 41)); g.line(to: pt(5, 41))
            g.lineWidth = 2.2; outline.setStroke(); g.stroke()
            NSColor(white: 1, alpha: 0.18).setFill()
            NSBezierPath(ovalIn: NSRect(x: -25, y: 30, width: 20, height: 18)).fill()
            NSBezierPath(ovalIn: NSRect(x: 5, y: 30, width: 20, height: 18)).fill()
        case .headphones:
            let band = NSBezierPath()
            band.appendArc(withCenter: pt(0, 38), radius: 44, startAngle: 15, endAngle: 165)
            band.lineWidth = 5; outline.setStroke(); band.stroke()
            band.lineWidth = 2.5; NSColor.systemPink.setStroke(); band.stroke()
            for side in [-1.0, 1.0] as [CGFloat] {
                fillStroke(NSBezierPath(roundedRect: NSRect(x: side * 44 - 7, y: 26, width: 14, height: 24), xRadius: 6, yRadius: 6), .systemPink)
            }
        case .none: break
        }
        if pose.nightcap {
            let cap = NSBezierPath()
            cap.move(to: pt(-26, 58)); cap.curve(to: pt(26, 60), controlPoint1: pt(-10, 66), controlPoint2: pt(10, 68))
            cap.curve(to: pt(46, 66), controlPoint1: pt(34, 78), controlPoint2: pt(42, 78))
            cap.curve(to: pt(-26, 58), controlPoint1: pt(30, 90), controlPoint2: pt(-12, 86))
            cap.close()
            fillStroke(cap, NSColor(calibratedRed: 0.30, green: 0.40, blue: 0.85, alpha: 1))
            fillStroke(oval(46, 66, 11, 11), .white)
        }
    }

    private func drawEyes(_ style: EyeStyle, t: Double, dx: CGFloat, dy: CGFloat) {
        let blinking = fmod(t, 4.3) < 0.13
        for side in [-1.0, 1.0] as [CGFloat] {
            let ex = side * 15 + dx, ey = 40 + dy
            var style = style
            if blinking && (style == .open || style == .focused) { style = .closed }
            switch style {
            case .open, .focused:
                outline.setFill(); oval(ex, ey, 9, style == .focused ? 8 : 12).fill()
                NSColor.white.setFill(); oval(ex + 1.6, ey + 2.4, 3.2, 3.2).fill()
            case .wide:
                fillStroke(oval(ex, ey, 14, 15), .white, width: 2)
                outline.setFill(); oval(ex + dx * 0.4, ey + dy * 0.4, 6, 7).fill()
            case .closed:
                line([pt(ex - 5, ey), pt(ex, ey - 2.5), pt(ex + 5, ey)], width: 2.2)
            case .happy:
                line([pt(ex - 5, ey - 2), pt(ex, ey + 3), pt(ex + 5, ey - 2)], width: 2.4)
            case .half:
                outline.setFill(); oval(ex, ey - 2, 9, 7).fill()
                fur.setFill(); NSRect(x: ex - 6, y: ey - 1, width: 12, height: 6).fill()
                line([pt(ex - 5, ey - 1), pt(ex + 5, ey - 1)], width: 2.2)
            case .cross:
                line([pt(ex - 4, ey - 4), pt(ex + 4, ey + 4)], width: 2.4)
                line([pt(ex - 4, ey + 4), pt(ex + 4, ey - 4)], width: 2.4)
            }
        }
    }

    private func drawMouth(_ style: MouthStyle, dx: CGFloat, dy: CGFloat) {
        let x = dx, y = 30 + dy
        switch style {
        case .w:
            let p = NSBezierPath()
            p.appendArc(withCenter: pt(x - 3, y), radius: 3, startAngle: 180, endAngle: 360)
            p.appendArc(withCenter: pt(x + 3, y), radius: 3, startAngle: 180, endAngle: 360)
            p.lineWidth = 2; p.lineCapStyle = .round; outline.setStroke(); p.stroke()
        case .smile:
            let p = NSBezierPath()
            p.move(to: pt(x - 6, y)); p.curve(to: pt(x + 6, y), controlPoint1: pt(x - 4, y - 7), controlPoint2: pt(x + 4, y - 7))
            p.close(); outline.setFill(); p.fill()
            pink.setFill(); oval(x, y - 3.5, 5, 2.5).fill()
        case .open:
            outline.setFill(); oval(x, y - 2, 6, 7).fill()
        case .yawn:
            outline.setFill(); oval(x, y - 3, 10, 12).fill()
            pink.setFill(); oval(x, y - 6, 6, 4).fill()
        case .flat:
            line([pt(x - 4, y - 1), pt(x + 4, y - 1)], width: 2)
        }
    }

    // MARK: Props (window coordinates)

    private func drawProps(_ m: Mood, _ t: Double, cx: CGFloat, g: CGFloat, base: CGFloat) {
        switch m {
        case .typing:
            let tapA = CGFloat(abs(sin(t * 15))) * 4, tapB = CGFloat(abs(cos(t * 15))) * 4
            arm(from: pt(cx + 30, base + 22), to: pt(cx + 52, g + 11 + tapA))
            arm(from: pt(cx + 34, base + 16), to: pt(cx + 68, g + 10 + tapB))
        case .thinking:
            arm(from: pt(cx + 34, base + 14), to: pt(cx + 24, base + 25))
        case .reading:
            drawBook(cx: cx, y: base + 4, t: t)
        case .searching:
            let lens = pt(cx + 34 + CGFloat(sin(t * 1.7)) * 6, base + 40 + CGFloat(cos(t * 2.3)) * 4)
            let handle = NSBezierPath()
            handle.move(to: pt(lens.x + 9, lens.y - 9)); handle.line(to: pt(lens.x + 20, lens.y - 22))
            handle.lineCapStyle = .round
            handle.lineWidth = 7; outline.setStroke(); handle.stroke()
            handle.lineWidth = 4; NSColor.brown.setStroke(); handle.stroke()
            fillStroke(oval(lens.x, lens.y, 26, 26), NSColor.systemTeal.withAlphaComponent(0.3), width: 3.5)
            NSColor(white: 1, alpha: 0.7).setFill(); oval(lens.x - 5, lens.y + 5, 6, 4).fill()
            fillStroke(oval(lens.x + 20, lens.y - 22, 13, 11), furLight)
        case .needsYou:
            let a = 1.1 + sin(t * 12) * 0.45
            let shoulder = pt(cx + 30, base + 34)
            arm(from: shoulder, to: pt(shoulder.x + CGFloat(cos(a)) * 22, shoulder.y + CGFloat(sin(a)) * 22))
        case .tidying:
            let a = -0.5 + sin(t * 6) * 0.35
            let top = pt(cx + 36, base + 44)
            let end = pt(top.x + CGFloat(sin(a)) * 46, top.y - CGFloat(cos(a)) * 46)
            let stick = NSBezierPath(); stick.move(to: top); stick.line(to: end)
            stick.lineWidth = 6; outline.setStroke(); stick.stroke()
            stick.lineWidth = 3; NSColor.brown.setStroke(); stick.stroke()
            fillStroke(oval(end.x, end.y + 2, 20, 10), .systemYellow, width: 2)
            for i in 0..<3 {
                let phase = CGFloat(fmod(t * 1.5 + Double(i) / 3, 1))
                NSColor(white: 0.6, alpha: 0.6 * (1 - phase)).setFill()
                oval(end.x + 8 + phase * 20, g + 4 + phase * 10, 6 + phase * 8, 6 + phase * 8).fill()
            }
            fillStroke(oval(top.x, top.y, 13, 11), furLight)
        default: break
        }
    }

    /// Sparkles, hearts, sweat, and dizzy stars. Shared by the cat and sprite packs.
    private func drawEffects(_ m: Mood, _ t: Double, cx: CGFloat, base: CGFloat) {
        switch m {
        case .done, .petted:
            if m == .done {
                let spots: [(CGFloat, CGFloat)] = [(-56, 64), (52, 76), (-36, 100), (44, 36), (-58, 26)]
                for (i, s) in spots.enumerated() {
                    let r = 4 + CGFloat(abs(sin(t * 4 + Double(i)))) * 6
                    fillStroke(star(pt(cx + s.0, base + s.1), r), i % 2 == 0 ? .systemYellow : .systemOrange, width: 1.5)
                }
            } else {
                for i in 0..<3 {
                    let phase = CGFloat(fmod(t * 0.9 + Double(i) / 3, 1))
                    let x = cx + [-30, 2, 32][i] + CGFloat(sin(Double(phase) * 6)) * 5
                    NSGraphicsContext.saveGraphicsState()
                    NSColor.systemPink.withAlphaComponent(1 - phase).setFill()
                    heart(pt(x, base + 78 + phase * 44), 14).fill()
                    NSGraphicsContext.restoreGraphicsState()
                }
            }
        case .oops:
            fillStroke(teardrop(pt(cx + 33, base + 62)), NSColor.systemCyan.withAlphaComponent(0.8), width: 1.8)
        case .error, .dizzy:
            for i in 0..<3 {
                let a = t * 3 + Double(i) * 2.1
                fillStroke(star(pt(cx + CGFloat(cos(a)) * 32, base + 80 + CGFloat(sin(a)) * 6), 6), .systemYellow, width: 1.5)
            }
        default: break
        }
    }

    /// Thought cloud, Zzz, and "!" — hidden while a speech bubble is showing.
    private func drawThoughts(_ m: Mood, _ t: Double, cx: CGFloat, base: CGFloat) {
        switch m {
        case .thinking where thoughtBubble != .off:
            NSGraphicsContext.saveGraphicsState()
            if thoughtBubble == .small {
                // Shrink toward the head, where the trail of little circles starts.
                let head = pt(cx + 26, base + 78)
                let tf = NSAffineTransform()
                tf.translateX(by: head.x, yBy: head.y); tf.scale(by: 0.5); tf.translateX(by: -head.x, yBy: -head.y)
                tf.concat()
            }
            let c = pt(cx + 54, base + 116)
            // Cloud puffs plus two small trailing circles leading back to the head.
            let puffs: [(CGFloat, CGFloat, CGFloat)] = [(-22, 0, 15), (0, 7, 19), (22, 0, 15), (-9, -8, 13), (11, -8, 13),
                                                         (-28, -38, 3.5), (-20, -26, 5.5)]
            let paths = puffs.map { oval(c.x + $0.0, c.y + $0.1, $0.2 * 2, $0.2 * 2) }
            theme.bubbleStroke.setStroke()
            for p in paths { p.lineWidth = 5; p.stroke() }
            theme.bubbleFill.setFill()
            for p in paths { p.fill() }
            for i in 0..<3 {
                theme.bubbleText.setFill()
                oval(c.x - 12 + CGFloat(i) * 12, c.y + CGFloat(max(0, sin(t * 6 - Double(i)))) * 4, 6, 6).fill()
            }
            NSGraphicsContext.restoreGraphicsState()
        case .sleeping:
            for i in 0..<3 {
                let phase = CGFloat(fmod(t * 0.35 + Double(i) / 3, 1))
                text(i % 2 == 0 ? "z" : "Z", at: pt(cx + 30 + phase * 30, base + 74 + phase * 50),
                     size: 11 + phase * 10, color: outline.withAlphaComponent(1 - phase))
            }
        case .needsYou, .startled:
            let c = pt(cx + 44, base + 94)
            if m == .needsYou {
                let circle = oval(c.x, c.y, 28, 28)
                theme.alertFill.setFill(); circle.fill()
                theme.bubbleStroke.setStroke(); circle.lineWidth = 2.5; circle.stroke()
                text("!", at: c, size: 20, color: theme.text(on: theme.alertFill))
            } else {
                text("!", at: pt(cx, base + 96), size: 22, color: outline)
            }
        default: break
        }
    }

    private func drawLaptop(_ t: Double) {
        // Local coordinates: (0,0) = front-left of the keyboard.
        let screen = NSBezierPath(roundedRect: NSRect(x: 6, y: 8, width: 58, height: 42), xRadius: 4, yRadius: 4)
        fillStroke(screen, NSColor(white: 0.32, alpha: 1))
        let inner = NSRect(x: 10, y: 12, width: 50, height: 34)
        NSColor(calibratedRed: 0.10, green: 0.14, blue: 0.22, alpha: 1).setFill(); inner.fill()

        let widths: [CGFloat] = [28, 18, 36, 22, 30, 14, 40, 24, 20, 33]
        let colors: [NSColor] = [.systemPink, .systemTeal, .systemYellow, .systemGreen, .systemPurple]
        let progress = Int(t * 3.5)
        let visible = min(6, progress % 12 + 1)
        let scroll = progress / 12
        for i in 0..<visible {
            let k = (i + scroll * 3) % widths.count
            let indent: CGFloat = k % 3 == 1 ? 6 : 0
            colors[k % colors.count].withAlphaComponent(0.9).setFill()
            var w = widths[k]
            if i == visible - 1 { w *= CGFloat(fmod(t * 3.5, 1)) }
            NSRect(x: inner.minX + 4 + indent, y: inner.maxY - 6 - CGFloat(i) * 5, width: min(w, inner.width - 8 - indent), height: 2.4).fill()
        }

        let deck = NSBezierPath()
        deck.move(to: pt(-2, 0)); deck.line(to: pt(70, 0)); deck.line(to: pt(64, 9)); deck.line(to: pt(4, 9)); deck.close()
        deck.lineJoinStyle = .round
        fillStroke(deck, NSColor(white: 0.82, alpha: 1))
        NSColor(white: 0.6, alpha: 1).setFill()
        NSRect(x: 10, y: 4, width: 48, height: 2).fill()
    }

    private func drawBook(cx: CGFloat, y: CGFloat, t: Double) {
        let cover = NSBezierPath()
        cover.move(to: pt(cx - 30, y + 2)); cover.line(to: pt(cx, y - 2)); cover.line(to: pt(cx + 30, y + 2))
        cover.line(to: pt(cx + 30, y + 30)); cover.line(to: pt(cx, y + 26)); cover.line(to: pt(cx - 30, y + 30)); cover.close()
        fillStroke(cover, .systemRed)
        for side in [-1.0, 1.0] as [CGFloat] {
            let page = NSBezierPath()
            page.move(to: pt(cx, y)); page.line(to: pt(cx + side * 27, y + 4)); page.line(to: pt(cx + side * 27, y + 30)); page.line(to: pt(cx, y + 26)); page.close()
            fillStroke(page, .white, width: 1.5)
            NSColor(white: 0.7, alpha: 1).setFill()
            for i in 0..<4 { NSRect(x: side > 0 ? cx + 4 : cx - 23, y: y + 9 + CGFloat(i) * 5, width: 19, height: 1.5).fill() }
        }
        // Page flip every 2.5s
        let phase = CGFloat(fmod(t, 2.5) / 0.45)
        if phase < 1 {
            let edge = cx + 27 * (1 - 2 * phase)
            let flip = NSBezierPath()
            flip.move(to: pt(cx, y)); flip.line(to: pt(edge, y + 6)); flip.line(to: pt(edge, y + 32)); flip.line(to: pt(cx, y + 26)); flip.close()
            fillStroke(flip, NSColor(white: 0.96, alpha: 1), width: 1.5)
        }
        fillStroke(oval(cx - 31, y + 16, 13, 12), furLight)
        fillStroke(oval(cx + 31, y + 16, 13, 12), furLight)
    }

    private func drawMinis(cx: CGFloat, g: CGFloat, t: Double) {
        let xs = [cx - 82, cx + 82].filter { $0 > 20 && $0 < canvas.width - 20 }
        for (i, x) in xs.prefix(min(pose.subagents, 2)).enumerated() {
            let hop = CGFloat(abs(sin(t * 7 + Double(i) * 1.7))) * 3
            NSColor(white: 0, alpha: 0.12).setFill(); oval(x, g - 1, 32, 5).fill()
            draw(at: x - 6, g + hop, scale: 0.4) { drawCat(.typing, t + Double(i), eyes: .focused, mouth: .w, look: CGPoint(x: 0.9, y: -0.5)) }
            draw(at: x + 8, g, scale: 0.4) { drawLaptop(t + Double(i)) }
        }
        if pose.subagents > 2 { text("+\(pose.subagents - 2)", at: pt(cx + 82, g + 44), size: 11, color: outline) }
    }

    private func drawSpeech(_ s: String, anchorX: CGFloat, y: CGFloat) {
        let para = NSMutableParagraphStyle(); para.alignment = .center
        let str = NSAttributedString(string: s, attributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .semibold), .foregroundColor: theme.bubbleText, .paragraphStyle: para,
        ])
        let r = str.boundingRect(with: NSSize(width: 196, height: 80), options: [.usesLineFragmentOrigin, .usesFontLeading])
        let w = ceil(r.width) + 20, h = ceil(r.height) + 10
        let tailY = min(y, bounds.height - h - 12)
        let x = min(max(4, anchorX - w / 2), bounds.width - w - 4)
        let rect = NSRect(x: x, y: tailY + 8, width: w, height: h)
        let bubble = NSBezierPath(roundedRect: rect, xRadius: 10, yRadius: 10)
        let tail = NSBezierPath()
        tail.move(to: pt(anchorX - 7, tailY + 10)); tail.line(to: pt(anchorX + 2, tailY)); tail.line(to: pt(anchorX + 7, tailY + 10)); tail.close()
        theme.bubbleStroke.setStroke()
        for p in [bubble, tail] { p.lineWidth = 2.5; p.lineJoinStyle = .round; p.stroke() }
        theme.bubbleFill.withAlphaComponent(0.97).setFill()
        bubble.fill(); tail.fill()
        str.draw(with: rect.insetBy(dx: 10, dy: 5), options: [.usesLineFragmentOrigin, .usesFontLeading])
    }

    /// Rises and fades over ~1.4s, beside the head.
    private func drawXP(_ s: String, from anchor: NSPoint) {
        let t = CGFloat(min(1, pose.xpAge / 1.4))
        let gold = NSColor(calibratedRed: 1.0, green: 0.72, blue: 0.1, alpha: 1 - t * t)
        let shadow = NSShadow()
        shadow.shadowColor = NSColor(white: 0, alpha: 0.35 * (1 - t))
        shadow.shadowBlurRadius = 2
        shadow.shadowOffset = NSSize(width: 0, height: -1)
        let str = NSAttributedString(string: s, attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .heavy), .foregroundColor: gold, .shadow: shadow,
        ])
        let size = str.size()
        let x = min(bounds.width - size.width - 4, anchor.x + 34)
        str.draw(at: NSPoint(x: x, y: min(bounds.height - size.height - 2, anchor.y - 30 + t * 26)))
    }

    private func drawCaption(_ s: String, color statusColor: NSColor) {
        let color = theme.captionFill(statusColor)
        let para = NSMutableParagraphStyle(); para.alignment = .center; para.lineBreakMode = .byTruncatingTail
        let str = NSAttributedString(string: s, attributes: [
            .font: NSFont.systemFont(ofSize: 10.5, weight: .semibold), .foregroundColor: theme.text(on: color), .paragraphStyle: para,
        ])
        let w = min(bounds.width - 8, str.size().width + 18)
        let rect = NSRect(x: bounds.midX - w / 2, y: 3, width: w, height: 18)
        color.withAlphaComponent(0.92).setFill()
        NSBezierPath(roundedRect: rect, xRadius: 9, yRadius: 9).fill()
        str.draw(in: rect.insetBy(dx: 8, dy: 2))
    }

    // MARK: - Helpers

    private func draw(at x: CGFloat, _ y: CGFloat, scale: CGFloat = 1, flip: Bool = false, rotate: CGFloat = 0,
                      pivotY: CGFloat = 70, scaleY: CGFloat = 1, _ body: () -> Void) {
        NSGraphicsContext.saveGraphicsState()
        let tf = NSAffineTransform()
        tf.translateX(by: x, yBy: y)
        if rotate != 0 {
            // Swing from the scruff when carried (pivot 70), spin around the middle when thrown.
            tf.translateX(by: 0, yBy: pivotY); tf.rotate(byRadians: rotate); tf.translateX(by: 0, yBy: -pivotY)
        }
        tf.scaleX(by: flip ? -scale : scale, yBy: scale * scaleY)
        tf.concat()
        body()
        NSGraphicsContext.restoreGraphicsState()
    }

    private func pt(_ x: CGFloat, _ y: CGFloat) -> NSPoint { NSPoint(x: x, y: y) }

    private func oval(_ cx: CGFloat, _ cy: CGFloat, _ w: CGFloat, _ h: CGFloat) -> NSBezierPath {
        NSBezierPath(ovalIn: NSRect(x: cx - w / 2, y: cy - h / 2, width: w, height: h))
    }

    private func fillStroke(_ p: NSBezierPath, _ fill: NSColor, width: CGFloat = 2.5) {
        fill.setFill(); p.fill()
        outline.setStroke(); p.lineWidth = width; p.stroke()
    }

    private func line(_ points: [NSPoint], width: CGFloat) {
        let p = NSBezierPath()
        p.move(to: points[0])
        for q in points.dropFirst() { p.line(to: q) }
        p.lineWidth = width; p.lineCapStyle = .round; p.lineJoinStyle = .round
        outline.setStroke(); p.stroke()
    }

    private func arm(from a: NSPoint, to b: NSPoint) {
        let p = NSBezierPath(); p.move(to: a); p.line(to: b)
        p.lineCapStyle = .round
        p.lineWidth = 12; outline.setStroke(); p.stroke()
        p.lineWidth = 7.5; fur.setStroke(); p.stroke()
        fillStroke(oval(b.x, b.y, 14, 11), furLight)
    }

    private func text(_ s: String, at c: NSPoint, size: CGFloat, color: NSColor) {
        let str = NSAttributedString(string: s, attributes: [
            .font: NSFont.systemFont(ofSize: size, weight: .heavy), .foregroundColor: color,
        ])
        let sz = str.size()
        str.draw(at: NSPoint(x: c.x - sz.width / 2, y: c.y - sz.height / 2))
    }

    private func star(_ c: NSPoint, _ r: CGFloat) -> NSBezierPath {
        let p = NSBezierPath()
        for i in 0..<8 {
            let a = CGFloat(i) * .pi / 4 + .pi / 2
            let rr = i % 2 == 0 ? r : r * 0.38
            let q = pt(c.x + cos(a) * rr, c.y + sin(a) * rr)
            if i == 0 { p.move(to: q) } else { p.line(to: q) }
        }
        p.close()
        return p
    }

    private func heart(_ c: NSPoint, _ s: CGFloat) -> NSBezierPath {
        let p = NSBezierPath()
        p.move(to: pt(c.x, c.y - s * 0.5))
        p.curve(to: pt(c.x - s * 0.5, c.y + s * 0.15), controlPoint1: pt(c.x - s * 0.15, c.y - s * 0.25), controlPoint2: pt(c.x - s * 0.5, c.y - s * 0.1))
        p.appendArc(withCenter: pt(c.x - s * 0.25, c.y + s * 0.15), radius: s * 0.25, startAngle: 180, endAngle: 0, clockwise: true)
        p.appendArc(withCenter: pt(c.x + s * 0.25, c.y + s * 0.15), radius: s * 0.25, startAngle: 180, endAngle: 0, clockwise: true)
        p.curve(to: pt(c.x, c.y - s * 0.5), controlPoint1: pt(c.x + s * 0.5, c.y - s * 0.1), controlPoint2: pt(c.x + s * 0.15, c.y - s * 0.25))
        p.close()
        return p
    }

    private func teardrop(_ c: NSPoint) -> NSBezierPath {
        let p = NSBezierPath()
        p.move(to: pt(c.x, c.y + 10))
        p.curve(to: pt(c.x - 5, c.y - 2), controlPoint1: pt(c.x - 1, c.y + 6), controlPoint2: pt(c.x - 5, c.y + 2))
        p.appendArc(withCenter: pt(c.x, c.y - 2), radius: 5, startAngle: 180, endAngle: 0, clockwise: false)
        p.curve(to: pt(c.x, c.y + 10), controlPoint1: pt(c.x + 5, c.y + 2), controlPoint2: pt(c.x + 1, c.y + 6))
        p.close()
        return p
    }
}
