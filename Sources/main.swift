import AppKit

// `DeskPet hook --agent claude` is invoked by Claude Code hooks; anything else launches the pet.
let arguments = CommandLine.arguments
if arguments.count > 1 && arguments[1] == "hook" {
    runHook(arguments)
}
if arguments.count > 1 && arguments[1] == "slice" {
    SpritePack.runSliceCommand(arguments)
}
if arguments.count > 1 && arguments[1] == "status" {
    let monitor = AgentMonitor()
    monitor.scanNow()
    Thread.sleep(forTimeInterval: 2)
    monitor.scanNow()
    let sessions = monitor.sessions()
    if sessions.isEmpty { print("No AI agents running") }
    for s in sessions {
        print("\(s.name)\(s.project.isEmpty ? "" : " (\(s.project))"): \(s.detail) [\(s.precise ? "hooks" : "cpu")]")
    }
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
