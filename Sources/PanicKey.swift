import Carbon

/// The emergency-hide shortcut: a system-wide hotkey (no Accessibility permission needed).
/// Same choices as the Windows/Linux app (PANIC_KEYS in main.js).
final class PanicKey {
    struct Choice {
        let id: String
        let label: String
        let keyCode: UInt32
        let modifiers: UInt32
    }

    static let choices = [
        Choice(id: "ctrl-alt-h", label: "⌃⌥H", keyCode: UInt32(kVK_ANSI_H), modifiers: UInt32(controlKey | optionKey)),
        Choice(id: "ctrl-alt-p", label: "⌃⌥P", keyCode: UInt32(kVK_ANSI_P), modifiers: UInt32(controlKey | optionKey)),
        Choice(id: "ctrl-shift-space", label: "⌃⇧Space", keyCode: UInt32(kVK_Space), modifiers: UInt32(controlKey | shiftKey)),
        Choice(id: "ctrl-alt-shift-h", label: "⌃⌥⇧H", keyCode: UInt32(kVK_ANSI_H), modifiers: UInt32(controlKey | optionKey | shiftKey)),
    ]
    static let defaultID = "ctrl-alt-h"

    private var ref: EventHotKeyRef?
    private static var handler: (() -> Void)?
    private static var installed = false

    init(onPress: @escaping () -> Void) { Self.handler = onPress }

    /// Registers the choice ("off" turns it off). False if another app already owns that shortcut.
    @discardableResult
    func register(_ id: String) -> Bool {
        unregister()
        guard let choice = Self.choices.first(where: { $0.id == id }) else { return id == "off" }
        if !Self.installed {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
                DispatchQueue.main.async { PanicKey.handler?() }
                return noErr
            }, 1, &spec, nil, nil)
            Self.installed = true
        }
        let hotKeyID = EventHotKeyID(signature: OSType(0x4450_4B59), id: 1) // "DPKY"
        return RegisterEventHotKey(choice.keyCode, choice.modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref) == noErr
    }

    func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
    }
}
