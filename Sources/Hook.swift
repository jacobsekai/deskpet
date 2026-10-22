import Foundation
import Darwin

enum DeskPetPaths {
    static let root = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".deskpet")
    static let sessions = root.appendingPathComponent("sessions")
    static let config = root.appendingPathComponent("config.json")
}

/// Hook mode: read the hook JSON from stdin and record the session's latest event in
/// ~/.deskpet/sessions/<agent>-<session>.json. Must stay fast, silent, and always exit 0
/// (stdout from some hooks is fed back to the agent).
func runHook(_ args: [String]) -> Never {
    var agent = "claude"
    if let i = args.firstIndex(of: "--agent"), i + 1 < args.count { agent = args[i + 1] }

    let data = FileHandle.standardInput.readDataToEndOfFile()
    let payload = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    guard var event = (payload["hook_event_name"] as? String) ?? (payload["hookEventName"] as? String),
          !event.isEmpty else { exit(0) }
    event = event.prefix(1).uppercased() + event.dropFirst()

    let agentPID = findAncestor(named: agent)
    let rawID = (payload["session_id"] as? String) ?? (payload["sessionId"] as? String) ?? "pid\(agentPID)"
    let safeID = rawID.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }

    let fm = FileManager.default
    try? fm.createDirectory(at: DeskPetPaths.sessions, withIntermediateDirectories: true)
    let file = DeskPetPaths.sessions.appendingPathComponent("\(agent)-\(safeID).json")

    if event == "SessionEnd" {
        try? fm.removeItem(at: file)
        exit(0)
    }

    let previous = (try? Data(contentsOf: file))
        .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
    var subagents = previous["subagents"] as? Int ?? 0
    switch event {
    case "SubagentStart": subagents += 1
    case "SubagentStop": subagents = max(0, subagents - 1)
    case "SessionStart": subagents = 0
    default: break
    }

    var state: [String: Any] = [
        "agent": agent,
        "event": event,
        "ts": Date().timeIntervalSince1970,
        "subagents": subagents,
        "pid": Int(agentPID),
    ]
    if let tool = payload["tool_name"] as? String { state["tool"] = tool }
    if let cwd = payload["cwd"] as? String { state["cwd"] = cwd }
    if let transcript = payload["transcript_path"] as? String { state["transcript"] = transcript }
    if let out = try? JSONSerialization.data(withJSONObject: state) {
        try? out.write(to: file, options: .atomic)
    }
    exit(0)
}

/// Walk up the process tree to find the agent process that spawned this hook,
/// so the pet can match hook state to a live process (and notice crashed sessions).
private func findAncestor(named name: String) -> pid_t {
    var pid = getppid()
    for _ in 0..<8 {
        if pid <= 1 { break }
        let base = (processPath(pid) as NSString).lastPathComponent
        if base == name || base.hasPrefix(name + "-") { return pid }
        pid = parentPID(of: pid)
    }
    return getppid()
}

func processPath(_ pid: pid_t) -> String {
    var buffer = [CChar](repeating: 0, count: 4096)
    let n = proc_pidpath(pid, &buffer, UInt32(buffer.count))
    return n > 0 ? String(cString: buffer) : ""
}

func parentPID(of pid: pid_t) -> pid_t {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0, size > 0 else { return 0 }
    return info.kp_eproc.e_ppid
}

func isAlive(_ pid: pid_t) -> Bool {
    pid > 0 && (kill(pid, 0) == 0 || errno == EPERM)
}
