import AppKit
import SwiftUI

// MARK: - Window platforms (walk on windows)

/// Another app's window, in Cocoa screen coordinates (y up).
struct Platform {
    let id: Int
    let rect: NSRect
}

enum Platforms {
    /// Normal app windows, front to back. Window bounds need no permissions (titles would).
    static func current() -> [Platform] {
        guard let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return [] }
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        let me = ProcessInfo.processInfo.processIdentifier
        return info.compactMap { w in
            guard (w[kCGWindowLayer as String] as? Int) == 0,
                  (w[kCGWindowOwnerPID as String] as? Int).map(pid_t.init) != me,
                  (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.1,
                  let id = w[kCGWindowNumber as String] as? Int,
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
            let cg = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
            guard cg.width >= 120, cg.height >= 60 else { return nil }
            return Platform(id: id, rect: NSRect(x: cg.minX, y: primaryTop - cg.maxY, width: cg.width, height: cg.height))
        }
    }

    /// The highest visible window top edge under `x` at or below `feetY`.
    static func landing(below feetY: CGFloat, x: CGFloat, in platforms: [Platform], screen: NSRect, headroom: CGFloat) -> Platform? {
        var best: Platform?
        for (i, p) in platforms.enumerated() {
            let top = p.rect.maxY
            guard x > p.rect.minX + 12, x < p.rect.maxX - 12, top <= feetY + 1, top > screen.minY + 4,
                  top + headroom < screen.maxY else { continue }
            // An edge covered by a window in front of it isn't somewhere to stand.
            let probe = NSPoint(x: x, y: top - 2)
            if platforms[..<i].contains(where: { $0.rect.contains(probe) }) { continue }
            if top > (best?.rect.maxY ?? -.infinity) { best = p }
        }
        return best
    }
}

// MARK: - Hover card

final class HoverModel: ObservableObject {
    struct Row: Identifiable {
        let id: String
        let title: String
        let detail: String
        let color: Color
        let elapsed: String
        let tokens: String
        let pid: pid_t
        /// What the agent said it did, the last time it finished.
        var summary = ""
    }

    @Published var petName = "Mochi"
    @Published var level = 1
    @Published var rank = "Lv 1"
    @Published var atMax = false
    @Published var progress = 0.0
    @Published var xpToNext = 0
    @Published var today = ""
    @Published var together = ""
    /// "⚡ 70 · 🎈 40 · 🪙 12" when needs are turned on.
    @Published var needs = ""
    @Published var focus = ""
    @Published var quiet = false
    @Published var nextReward = ""
    @Published var rows: [Row] = []
    @Published var accent = Color.orange
    var onSelect: ((pid_t) -> Void)?
}

private struct HoverCardView: View {
    @ObservedObject var model: HoverModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Text(model.petName).font(.system(size: 13, weight: .bold))
                Text(model.rank)
                    .font(.system(size: 10.5, weight: .heavy))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(model.accent.opacity(0.18)))
                    .foregroundColor(model.accent)
                Spacer()
                Text(model.atMax ? "max level" : "\(model.xpToNext) XP to Lv \(model.level + 1)").font(.system(size: 10)).foregroundColor(.secondary)
            }
            ProgressView(value: model.progress).tint(model.accent)
            Text(model.today).font(.system(size: 11)).foregroundColor(.secondary)
            if !model.together.isEmpty { Text(model.together).font(.system(size: 11)).foregroundColor(.secondary) }
            if !model.needs.isEmpty { Text(model.needs).font(.system(size: 11)).foregroundColor(.secondary) }
            if !model.nextReward.isEmpty { Text(model.nextReward).font(.system(size: 10.5)).foregroundColor(.secondary) }
            if !model.focus.isEmpty { Text(model.focus).font(.system(size: 11.5, weight: .semibold)) }
            if model.quiet { Text("🤫 Quiet mode: you're on a call").font(.system(size: 11)).foregroundColor(.secondary) }
            Divider()
            if model.rows.isEmpty {
                Text("No AI agents running").font(.system(size: 11.5)).foregroundColor(.secondary)
            } else {
                ForEach(model.rows) { row in
                    Button { model.onSelect?(row.pid) } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Circle().fill(row.color).frame(width: 8, height: 8).padding(.top, 5)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(row.title).font(.system(size: 12, weight: .semibold))
                                Text(row.detail).font(.system(size: 11)).foregroundColor(.secondary)
                                if !row.summary.isEmpty { Text("✓ \(row.summary)").font(.system(size: 10.5)).foregroundColor(.secondary).lineLimit(2) }
                                if !row.tokens.isEmpty { Text(row.tokens).font(.system(size: 10)).foregroundColor(.secondary.opacity(0.8)) }
                            }
                            Spacer(minLength: 8)
                            Text(row.elapsed).font(.system(size: 10.5).monospacedDigit()).foregroundColor(.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("Jump to this session")
                }
                Text("Click a session to jump to it").font(.system(size: 9.5)).foregroundColor(.secondary.opacity(0.7))
            }
        }
        .padding(12)
        .frame(width: 270)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.regularMaterial))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(Color.primary.opacity(0.08)))
    }
}

/// A floating card above the pet listing agent sessions, level, and today's stats.
final class HoverCard {
    let model = HoverModel()
    private let panel: NSPanel
    private let hosting: NSHostingView<HoverCardView>

    init() {
        hosting = NSHostingView(rootView: HoverCardView(model: model))
        panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 270, height: 120),
                        styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.contentView = hosting
    }

    var isVisible: Bool { panel.isVisible }
    var frame: NSRect { panel.frame }

    /// Shows the card above `petRect` (screen coordinates), or below it near the top of the screen.
    func show(near petRect: NSRect) {
        let size = hosting.fittingSize
        let screen = NSScreen.screens.first { $0.frame.intersects(petRect) }?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        var x = petRect.midX - size.width / 2
        x = min(max(screen.minX + 6, x), screen.maxX - size.width - 6)
        var y = petRect.maxY + 6
        if y + size.height > screen.maxY { y = petRect.minY - size.height - 6 }
        panel.setFrame(NSRect(x: x, y: max(screen.minY, y), width: size.width, height: size.height), display: true)
        panel.orderFrontRegardless()
    }

    func refit() {
        guard panel.isVisible else { return }
        let size = hosting.fittingSize
        var f = panel.frame
        if abs(f.height - size.height) > 0.5 {
            f.size = size
            panel.setFrame(f, display: true)
        }
    }

    func hide() { panel.orderOut(nil) }
}
