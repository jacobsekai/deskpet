import AppKit

enum ThoughtBubbleSize: String {
    case large, small, off
}

/// UI colors derived from one accent color. `nil` accent means the built-in look.
struct Theme {
    let accent: NSColor?

    static let `default` = Theme(accent: nil)

    init(accent: NSColor?) { self.accent = accent }

    init?(hex: String) {
        guard let color = NSColor(hex: hex) else { return nil }
        accent = color
    }

    private static let ink = NSColor(calibratedRed: 0.29, green: 0.19, blue: 0.15, alpha: 1)

    /// Outlines of speech and thought bubbles.
    var bubbleStroke: NSColor { accent.map { $0.darkened(to: 0.55) } ?? Self.ink }
    /// Inside of bubbles: a very light tint of the accent.
    var bubbleFill: NSColor { accent.map { $0.blended(withFraction: 0.9, of: .white) ?? .white } ?? .white }
    /// Text on bubbles; dark enough to read on `bubbleFill`.
    var bubbleText: NSColor { accent.map { $0.darkened(to: 0.35) } ?? Self.ink }
    /// The "!" alert circle.
    var alertFill: NSColor { accent ?? .systemYellow }
    var resizeAccent: NSColor { accent ?? .systemBlue }

    /// Caption pill color; the default theme colors by activity.
    func captionFill(_ statusColor: NSColor) -> NSColor { accent ?? statusColor }
    /// White or dark text, whichever reads better on `fill`.
    func text(on fill: NSColor) -> NSColor { fill.luminance > 0.62 ? Self.ink : .white }
}

extension NSColor {
    /// Accepts "#RGB", "#RRGGBB", with or without "#".
    convenience init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(srgbRed: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255,
                  blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }

    var hexString: String {
        guard let c = usingColorSpace(.sRGB) else { return "#000000" }
        return String(format: "#%02X%02X%02X", Int((c.redComponent * 255).rounded()),
                      Int((c.greenComponent * 255).rounded()), Int((c.blueComponent * 255).rounded()))
    }

    /// Relative luminance (0 = black, 1 = white).
    var luminance: CGFloat {
        guard let c = usingColorSpace(.sRGB) else { return 0.5 }
        return 0.2126 * c.redComponent + 0.7152 * c.greenComponent + 0.0722 * c.blueComponent
    }

    /// Darkens until luminance is at most `maxLuminance`, keeping the hue.
    func darkened(to maxLuminance: CGFloat) -> NSColor {
        var color = self
        var steps = 0
        while color.luminance > maxLuminance && steps < 12 {
            color = color.blended(withFraction: 0.15, of: .black) ?? color
            steps += 1
        }
        return color
    }
}
