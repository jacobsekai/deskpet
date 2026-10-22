import Foundation

/// Ordered by display priority: when several agents run, the pet shows the highest one.
enum AgentActivity: Int {
    case idle = 0, done, tidying, thinking, reading, searching, delegating, typing, oops, error, needsYou
}

struct AgentSession {
    let id: String
    let name: String
    let project: String
    var activity: AgentActivity
    var detail: String
    var subagents: Int
    /// true when driven by hook events, false when guessed from CPU usage.
    var precise: Bool
}

/// A running agent CLI found in the process table, with its whole child tree.
struct ProcSession {
    let pid: pid_t
    let name: String
    let pids: Set<pid_t>
    let busy: Bool
}

private struct HookState {
    let url: URL
    let event: String
    let tool: String
    let ts: Double
    let subagents: Int
    let pid: pid_t
    let cwd: String
}

/// Executable basename -> display name for agent CLIs detected by process scanning.
private let knownAgents: [String: String] = [
    "claude": "Claude",
    "codex": "Codex",
    "kiro-cli": "Kiro",
    "kiro-cli-chat": "Kiro",
    "qchat": "Amazon Q",
    "q": "Amazon Q",
    "gemini": "Gemini",
    "cursor-agent": "Cursor",
    "goose": "Goose",
    "opencode": "opencode",
    "aider": "Aider",
    "amp": "Amp",
]

final class AgentMonitor {
    private(set) var procSessions: [ProcSession] = []
    private(set) var scanCount = 0
    private var scanning = false
    private var lastScan = 0.0

    // Only touched on `queue`.
    private let queue = DispatchQueue(label: "deskpet.scan")
    private var previousCPU: [pid_t: Double] = [:]
    private var previousScanTime = 0.0
    private var smoothedUsage: [pid_t: Double] = [:]

    func scanIfNeeded(now: Double) {
        guard !scanning, now - lastScan >= 2 else { return }
        scanning = true
        lastScan = now
        queue.async {
            let result = self.scan()
            DispatchQueue.main.async {
                self.procSessions = result
                self.scanCount += 1
                self.scanning = false
            }
        }
    }

    /// Synchronous scan, used by the `status` command.
    func scanNow() {
        procSessions = queue.sync { scan() }
        scanCount += 1
    }

    func sessions() -> [AgentSession] {
        let now = Date().timeIntervalSince1970
        var hooks = readHookStates()
        var result: [AgentSession] = []

        for proc in procSessions {
            let matching = hooks.filter { proc.pids.contains($0.pid) }
            if let hook = matching.max(by: { $0.ts < $1.ts }) {
                hooks.removeAll { proc.pids.contains($0.pid) }
                result.append(session(from: hook, id: "\(proc.name)-\(proc.pid)", name: proc.name, procBusy: proc.busy, now: now))
            } else {
                result.append(AgentSession(
                    id: "\(proc.name)-\(proc.pid)", name: proc.name, project: "",
                    activity: proc.busy ? .typing : .idle, detail: proc.busy ? "working…" : "ready",
                    subagents: 0, precise: false))
            }
        }

        // Hook files whose process the scanner hasn't matched (yet).
        for hook in hooks {
            if hook.pid > 0 && !isAlive(hook.pid) {
                try? FileManager.default.removeItem(at: hook.url)
            } else if now - hook.ts < 3600 && scanCount > 0 && hook.pid > 0 {
                result.append(session(from: hook, id: hook.url.lastPathComponent, name: "Claude", procBusy: true, now: now))
            }
        }
        return result
    }

    // MARK: - Hook state

    private func readHookStates() -> [HookState] {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: DeskPetPaths.sessions, includingPropertiesForKeys: nil) else { return [] }
        return files.filter { $0.pathExtension == "json" }.compactMap { url in
            guard let data = try? Data(contentsOf: url),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
            return HookState(
                url: url,
                event: obj["event"] as? String ?? "",
                tool: obj["tool"] as? String ?? "",
                ts: obj["ts"] as? Double ?? 0,
                subagents: obj["subagents"] as? Int ?? 0,
                pid: pid_t(obj["pid"] as? Int ?? 0),
                cwd: obj["cwd"] as? String ?? "")
        }
    }

    private func session(from hook: HookState, id: String, name: String, procBusy: Bool, now: Double) -> AgentSession {
        let age = now - hook.ts
        var activity: AgentActivity
        switch hook.event {
        case "UserPromptSubmit", "PostToolUse", "SubagentStop": activity = .thinking
        case "PreToolUse": activity = Self.activity(forTool: hook.tool)
        case "PostToolUseFailure": activity = age < 3 ? .oops : .thinking
        case "PermissionRequest", "Notification": activity = .needsYou
        case "SubagentStart": activity = .delegating
        case "Stop": activity = age < 5 ? .done : .idle
        case "StopFailure": activity = age < 20 ? .error : .idle
        case "PreCompact": activity = .tidying
        default: activity = .idle
        }
        // No "interrupted" hook exists, so a busy state with no new events and a quiet process is stale.
        let working: Set<AgentActivity> = [.thinking, .typing, .reading, .searching, .delegating, .tidying]
        if working.contains(activity) && age > 120 && !procBusy { activity = .idle }
        if activity == .needsYou && age > 3600 { activity = .idle }

        return AgentSession(
            id: id, name: name, project: (hook.cwd as NSString).lastPathComponent,
            activity: activity, detail: Self.detail(activity, tool: hook.tool),
            subagents: hook.subagents, precise: true)
    }

    private static func activity(forTool tool: String) -> AgentActivity {
        switch tool {
        case "Read", "Grep", "Glob", "LS", "NotebookRead": return .reading
        case "WebFetch", "WebSearch", "ToolSearch": return .searching
        case "Agent", "Task", "Workflow": return .delegating
        case "AskUserQuestion", "ExitPlanMode": return .needsYou
        default: return tool.hasPrefix("mcp__") ? .searching : .typing
        }
    }

    private static func detail(_ activity: AgentActivity, tool: String) -> String {
        switch activity {
        case .idle: return "ready"
        case .done: return "all done!"
        case .tidying: return "compacting memory"
        case .thinking: return "thinking…"
        case .reading: return "reading files"
        case .searching:
            if tool.hasPrefix("mcp__") {
                return "using \(tool.split(separator: "_", omittingEmptySubsequences: true).dropFirst().first ?? "a tool")"
            }
            return tool.hasPrefix("Web") ? "browsing the web" : "searching"
        case .delegating: return "running helpers"
        case .typing:
            switch tool {
            case "Edit", "Write", "MultiEdit", "NotebookEdit": return "writing code"
            case "Bash", "BashOutput", "PowerShell": return "running commands"
            default: return tool.isEmpty ? "working…" : "using \(tool)"
            }
        case .oops: return "a tool failed"
        case .error: return "hit an error"
        case .needsYou: return tool == "AskUserQuestion" ? "has a question" : "needs your OK"
        }
    }

    // MARK: - Process scanning (background queue)

    private struct Proc { let pid: pid_t; let ppid: pid_t; let cpu: Double; let base: String }

    private func scan() -> [ProcSession] {
        let now = Date().timeIntervalSince1970
        let procs = listProcesses()
        var children: [pid_t: [pid_t]] = [:]
        for p in procs { children[p.ppid, default: []].append(p.pid) }

        var candidates = procs.filter { knownAgents[$0.base] != nil }
        if !candidates.isEmpty {
            let args = arguments(of: candidates.map(\.pid))
            candidates.removeAll { (args[$0.pid] ?? "").contains("__otel-server") }
        }
        let candidateName = Dictionary(candidates.map { ($0.pid, knownAgents[$0.base]!) }, uniquingKeysWith: { a, _ in a })
        let cpuByPid = Dictionary(procs.map { ($0.pid, $0.cpu) }, uniquingKeysWith: { a, _ in a })
        let firstScan = previousScanTime == 0
        let interval = max(0.5, now - previousScanTime)

        var sessions: [ProcSession] = []
        for c in candidates {
            let name = candidateName[c.pid]!
            if candidateName[c.ppid] == name { continue } // inner process of the same session

            var tree: Set<pid_t> = [c.pid]
            var stack = [c.pid]
            while let next = stack.popLast() {
                for child in children[next] ?? [] where tree.insert(child).inserted { stack.append(child) }
            }

            var cpuSeconds = 0.0
            if !firstScan {
                for pid in tree {
                    let current = cpuByPid[pid] ?? 0
                    cpuSeconds += max(0, current - (previousCPU[pid] ?? current))
                }
            }
            let usage = 0.5 * (smoothedUsage[c.pid] ?? 0) + 0.5 * (cpuSeconds / interval)
            smoothedUsage[c.pid] = usage
            sessions.append(ProcSession(pid: c.pid, name: name, pids: tree, busy: usage > 0.15))
        }

        previousCPU = cpuByPid
        previousScanTime = now
        smoothedUsage = smoothedUsage.filter { pid, _ in sessions.contains { $0.pid == pid } }
        return sessions.sorted { $0.pid < $1.pid }
    }

    private func listProcesses() -> [Proc] {
        run("/bin/ps", ["-axww", "-o", "pid=,ppid=,time=,comm="]).split(separator: "\n").compactMap { line in
            let fields = splitFields(String(line), count: 3)
            guard fields.count == 4, let pid = pid_t(fields[0]), let ppid = pid_t(fields[1]) else { return nil }
            return Proc(pid: pid, ppid: ppid, cpu: parseCPUTime(fields[2]), base: (fields[3] as NSString).lastPathComponent)
        }
    }

    private func arguments(of pids: [pid_t]) -> [pid_t: String] {
        let list = pids.map(String.init).joined(separator: ",")
        var result: [pid_t: String] = [:]
        for line in run("/bin/ps", ["-ww", "-o", "pid=,args=", "-p", list]).split(separator: "\n") {
            let fields = splitFields(String(line), count: 1)
            if fields.count == 2, let pid = pid_t(fields[0]) { result[pid] = fields[1] }
        }
        return result
    }

    /// Splits off `count` whitespace-separated fields; the remainder (which may contain spaces) is the last element.
    private func splitFields(_ line: String, count: Int) -> [String] {
        var fields: [String] = []
        var rest = Substring(line)
        for _ in 0..<count {
            rest = rest.drop { $0 == " " }
            guard let end = rest.firstIndex(of: " ") else { return fields }
            fields.append(String(rest[..<end]))
            rest = rest[end...]
        }
        fields.append(String(rest.drop { $0 == " " }))
        return fields
    }

    /// ps `time` looks like "12:34.56" or "1:02:03.45".
    private func parseCPUTime(_ s: String) -> Double {
        s.split(separator: ":").reduce(0.0) { $0 * 60 + (Double($1) ?? 0) }
    }

    private func run(_ path: String, _ args: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: path)
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do { try process.run() } catch { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }
}
