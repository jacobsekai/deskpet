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
    /// true when driven by hook events or a session log, false when guessed from CPU usage.
    var precise: Bool
    /// The agent's process, for bringing its window forward. 0 if unknown.
    var pid: pid_t = 0
    /// Claude transcript or Codex session log, for token counts.
    var logPath: String = ""
    var isCodex = false
}

/// A running agent CLI found in the process table, with its whole child tree.
struct ProcSession {
    let pid: pid_t
    let name: String
    let pids: Set<pid_t>
    let busy: Bool
    /// For Codex: the session log it's writing.
    var codexLog: String?
}

private struct HookState {
    let url: URL
    let agent: String
    let event: String
    let tool: String
    let ts: Double
    let subagents: Int
    let pid: pid_t
    let cwd: String
    let transcript: String
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
                var s = session(from: hook, id: "\(proc.name)-\(proc.pid)", name: proc.name, procBusy: proc.busy, now: now)
                s.pid = proc.pid
                result.append(s)
            } else if let log = proc.codexLog, let state = CodexLog.state(path: log, procBusy: proc.busy) {
                result.append(AgentSession(
                    id: "\(proc.name)-\(proc.pid)", name: proc.name, project: "",
                    activity: state.activity, detail: state.detail, subagents: 0, precise: true,
                    pid: proc.pid, logPath: log, isCodex: true))
            } else {
                result.append(AgentSession(
                    id: "\(proc.name)-\(proc.pid)", name: proc.name, project: "",
                    activity: proc.busy ? .typing : .idle, detail: proc.busy ? "working…" : "ready",
                    subagents: 0, precise: false, pid: proc.pid))
            }
        }

        // Hook files whose process the scanner hasn't matched (yet).
        for hook in hooks {
            if hook.pid > 0 && !isAlive(hook.pid) {
                try? FileManager.default.removeItem(at: hook.url)
            } else if now - hook.ts < 3600 && scanCount > 0 && hook.pid > 0 {
                var s = session(from: hook, id: hook.url.lastPathComponent, name: Self.displayName(hook.agent), procBusy: true, now: now)
                s.pid = hook.pid
                result.append(s)
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
                agent: obj["agent"] as? String ?? "claude",
                event: obj["event"] as? String ?? "",
                tool: obj["tool"] as? String ?? "",
                ts: obj["ts"] as? Double ?? 0,
                subagents: obj["subagents"] as? Int ?? 0,
                pid: pid_t(obj["pid"] as? Int ?? 0),
                cwd: obj["cwd"] as? String ?? "",
                transcript: obj["transcript"] as? String ?? "")
        }
    }

    private func session(from hook: HookState, id: String, name: String, procBusy: Bool, now: Double) -> AgentSession {
        let age = now - hook.ts
        var activity: AgentActivity
        switch hook.event {
        case "UserPromptSubmit", "PostToolUse", "SubagentStop", "AgentSpawn": activity = hook.event == "AgentSpawn" ? .idle : .thinking
        case "PreToolUse": activity = Self.activity(forTool: hook.tool)
        case "PostToolUseFailure": activity = age < 3 ? .oops : .thinking
        case "PermissionRequest", "Notification": activity = .needsYou
        case "SubagentStart": activity = .delegating
        case "Stop": activity = age < 5 ? .done : .idle
        case "StopFailure": activity = age < 20 ? .error : .idle
        case "PreCompact": activity = .tidying
        default: activity = .idle
        }
        // Interrupting Claude (Esc) sends no hook at all, so check how the transcript ends,
        // and fall back to "no events for a while and a quiet process".
        let working: Set<AgentActivity> = [.thinking, .typing, .reading, .searching, .delegating, .tidying]
        if working.contains(activity) && age > 2 && turnEnded(transcript: hook.transcript) { activity = .idle }
        if working.contains(activity) && age > 120 && !procBusy { activity = .idle }
        if activity == .needsYou && age > 3600 { activity = .idle }

        return AgentSession(
            id: id, name: name, project: (hook.cwd as NSString).lastPathComponent,
            activity: activity, detail: Self.detail(activity, tool: hook.tool),
            subagents: hook.subagents, precise: true, logPath: hook.transcript)
    }

    private var transcriptCache: [String: (modified: Date, size: Int, ended: Bool)] = [:]

    /// True when the transcript's last turn finished (a final reply) or was interrupted.
    private func turnEnded(transcript path: String) -> Bool {
        guard !path.isEmpty, let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let modified = attrs[.modificationDate] as? Date, let size = (attrs[.size] as? NSNumber)?.intValue else { return false }
        if let cached = transcriptCache[path], cached.modified == modified, cached.size == size { return cached.ended }

        var ended = false
        if let handle = FileHandle(forReadingAtPath: path) {
            let chunk = 256 * 1024
            handle.seek(toFileOffset: UInt64(max(0, size - chunk)))
            let data = handle.readDataToEndOfFile()
            handle.closeFile()
            // Walk back to the latest user or assistant record; other record types are bookkeeping.
            for line in data.split(separator: UInt8(ascii: "\n")).reversed() {
                guard let record = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                      let type = record["type"] as? String, type == "assistant" || type == "user" else { continue }
                let message = record["message"] as? [String: Any] ?? [:]
                if type == "assistant" {
                    ended = message["stop_reason"] as? String == "end_turn"
                } else {
                    let content = message["content"]
                    let text = (content as? String) ?? ((content as? [[String: Any]])?.compactMap { $0["text"] as? String }.joined() ?? "")
                    ended = text.contains("[Request interrupted by user")
                }
                break
            }
        }
        transcriptCache[path] = (modified, size, ended)
        return ended
    }

    static func displayName(_ agent: String) -> String {
        switch agent {
        case "kiro": return "Kiro"
        case "codex": return "Codex"
        default: return "Claude"
        }
    }

    private static func activity(forTool tool: String) -> AgentActivity {
        switch tool {
        // Kiro CLI tool names
        case "fs_read", "grep", "glob", "code", "knowledge", "read": return .reading
        case "fs_write", "execute_bash", "execute_cmd", "shell", "write": return .typing
        case "web_search", "web_fetch", "use_aws": return .searching
        case "use_subagent", "delegate": return .delegating
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
            case "Bash", "BashOutput", "PowerShell", "execute_bash", "execute_cmd", "shell": return "running commands"
            case "fs_write", "write": return "writing code"
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
            var session = ProcSession(pid: c.pid, name: name, pids: tree, busy: usage > 0.15)
            if name == "Codex" { session.codexLog = CodexLog.logPath(for: tree) }
            sessions.append(session)
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
