import Foundation

/// Cosmetics unlocked at level milestones. Same table in the Windows app (extras.js).
enum Reward: String, CaseIterable {
    case bow, sparkleTrail, partyHat, scarf, crown, aura, rainbowTrail, goldenFur

    var level: Int {
        switch self {
        case .bow: return 2
        case .sparkleTrail: return 3
        case .partyHat: return 5
        case .scarf: return 7
        case .crown: return 10
        case .aura: return 12
        case .rainbowTrail: return 15
        case .goldenFur: return 20
        }
    }

    var title: String {
        switch self {
        case .bow: return "🎀 Bow"
        case .sparkleTrail: return "✨ Sparkle trail"
        case .partyHat: return "🎉 Party hat"
        case .scarf: return "🧣 Scarf"
        case .crown: return "👑 Crown"
        case .aura: return "🌟 Golden aura"
        case .rainbowTrail: return "🌈 Rainbow trail"
        case .goldenFur: return "🏆 Golden fur"
        }
    }

    /// Hats, the scarf, and fur color only exist on the built-in cat.
    var catOnly: Bool { [.bow, .partyHat, .scarf, .crown, .goldenFur].contains(self) }

    /// The setting key and value that wears this reward.
    var setting: (key: String, value: Any) {
        switch self {
        case .bow: return ("hat", "bow")
        case .partyHat: return ("hat", "partyHat")
        case .crown: return ("hat", "crown")
        case .scarf: return ("scarf", true)
        case .sparkleTrail: return ("trail", "sparkle")
        case .rainbowTrail: return ("trail", "rainbow")
        case .aura: return ("aura", true)
        case .goldenFur: return ("goldenFur", true)
        }
    }

    static func unlocked(at level: Int) -> [Reward] { allCases.filter { $0.level <= level } }
    static func next(after level: Int) -> Reward? { allCases.first { $0.level > level } }
}
