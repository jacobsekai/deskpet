import Foundation

/// Cosmetics unlocked at level milestones. Every reward works on the built-in cat and on sprite packs.
/// Same table in the Windows app (extras.js).
enum Reward: String, CaseIterable {
    case bow, sparkleTrail, partyHat, balloon, petalTrail, cap, goldenAura, crown, butterfly, fireTrail
    case purpleAura, topHat, starBuddy, rainbowTrail, halo, snowAura, planets, diamondCrown, golden

    /// Which slot it fills; one reward per slot is worn at a time ("golden" is a toggle).
    enum Slot: String, CaseIterable {
        case hat, trail, aura, companion, golden
        var title: String {
            switch self {
            case .hat: return "Hats"
            case .trail: return "Trails"
            case .aura: return "Auras"
            case .companion: return "Companions"
            case .golden: return "Finish"
            }
        }
        /// Settings key that stores what's worn in this slot.
        var key: String {
            switch self {
            case .hat: return "hat"
            case .trail: return "trail"
            case .aura: return "auraStyle"
            case .companion: return "companion"
            case .golden: return "goldenFur"
            }
        }
    }

    var level: Int {
        switch self {
        case .bow: return 2
        case .sparkleTrail: return 3
        case .partyHat: return 5
        case .balloon: return 8
        case .petalTrail: return 10
        case .cap: return 12
        case .goldenAura: return 15
        case .crown: return 20
        case .butterfly: return 25
        case .fireTrail: return 30
        case .purpleAura: return 35
        case .topHat: return 40
        case .starBuddy: return 45
        case .rainbowTrail: return 50
        case .halo: return 60
        case .snowAura: return 70
        case .planets: return 80
        case .diamondCrown: return 90
        case .golden: return 100
        }
    }

    var title: String {
        switch self {
        case .bow: return "🎀 Bow"
        case .sparkleTrail: return "✨ Sparkle trail"
        case .partyHat: return "🎉 Party hat"
        case .balloon: return "🎈 Balloon"
        case .petalTrail: return "🌸 Petal trail"
        case .cap: return "🧢 Cap"
        case .goldenAura: return "🌟 Golden aura"
        case .crown: return "👑 Crown"
        case .butterfly: return "🦋 Butterfly"
        case .fireTrail: return "🔥 Fire trail"
        case .purpleAura: return "💜 Purple aura"
        case .topHat: return "🎩 Top hat"
        case .starBuddy: return "⭐ Star buddy"
        case .rainbowTrail: return "🌈 Rainbow trail"
        case .halo: return "😇 Halo"
        case .snowAura: return "❄️ Snow aura"
        case .planets: return "🪐 Orbiting planets"
        case .diamondCrown: return "💎 Diamond crown"
        case .golden: return "🏆 Golden shimmer"
        }
    }

    var slot: Slot {
        switch self {
        case .bow, .partyHat, .cap, .crown, .topHat, .halo, .diamondCrown: return .hat
        case .sparkleTrail, .petalTrail, .fireTrail, .rainbowTrail: return .trail
        case .goldenAura, .purpleAura, .snowAura: return .aura
        case .balloon, .butterfly, .starBuddy, .planets: return .companion
        case .golden: return .golden
        }
    }

    /// The value stored in the slot's setting (drawing code switches on it).
    var value: String {
        switch self {
        case .sparkleTrail: return "sparkle"
        case .petalTrail: return "petal"
        case .fireTrail: return "fire"
        case .rainbowTrail: return "rainbow"
        case .goldenAura: return "golden"
        case .purpleAura: return "purple"
        case .snowAura: return "snow"
        case .starBuddy: return "star"
        default: return rawValue
        }
    }

    static func next(after level: Int) -> Reward? { allCases.first { $0.level > level } }
}

/// Prestige ranks, Call of Duty style: max level 100, prestige resets to level 1 (rewards stay
/// unlocked), and Prestige 10 ("Prestige Master") keeps leveling up to 1000.
enum Prestige {
    static let maxRank = 10
    static let levelCap = 100
    static let masterCap = 1000

    static func title(_ rank: Int) -> String {
        switch rank {
        case 0: return ""
        case maxRank: return "💎 Prestige Master"
        default: return "\(emblem(rank)) Prestige \(rank)"
        }
    }

    static func emblem(_ rank: Int) -> String {
        switch rank {
        case 1...3: return "🥉"
        case 4...6: return "🥈"
        case 7...9: return "🥇"
        case maxRank...: return "💎"
        default: return ""
        }
    }
}
