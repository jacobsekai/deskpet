import Foundation

/// Token totals shown in the hover card.
struct TokenUsage {
    var output = 0
    /// Size of the latest request's context (input + cached input).
    var context = 0
}

/// Reads the tail of a JSONL log, newest record first. Logs can be many MB, so only the end is read.
func tailRecords(_ path: String, bytes: Int = 256 * 1024) -> [[String: Any]] {
    guard let handle = FileHandle(forReadingAtPath: path) else { return [] }
    defer { handle.closeFile() }
    let size = handle.seekToEndOfFile()
    handle.seek(toFileOffset: size > UInt64(bytes) ? size - UInt64(bytes) : 0)
    let data = handle.readDataToEndOfFile()
    return data.split(separator: UInt8(ascii: "\n")).reversed().compactMap {
        try? JSONSerialization.jsonObject(with: Data($0)) as? [String: Any]
    }
}

private let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

// MARK: - Codex

/// Exact Codex states from its session log (~/.codex/sessions/…/rollout-*.jsonl), no setup needed.
enum CodexLog {
    struct State {
        var activity: AgentActivity
        var detail: String
        var tokens: TokenUsage?
        var cwd: String
    }

    static func state(path: String, procBusy: Bool) -> State? {
        let records = tailRecords(path)
        guard !records.isEmpty else { return nil }
        var tokens: TokenUsage?
        var result: State?
        let now = Date()

        for r in records {
            let payload = r["payload"] as? [String: Any] ?? [:]
            let type = r["type"] as? String ?? ""
            let sub = payload["type"] as? String ?? ""
            if tokens == nil, type == "event_msg", sub == "token_count",
               let info = payload["info"] as? [String: Any] {
                let total = info["total_token_usage"] as? [String: Any] ?? [:]
                let last = info["last_token_usage"] as? [String: Any] ?? [:]
                tokens = TokenUsage(output: (total["output_tokens"] as? Int ?? 0) + (total["reasoning_output_tokens"] as? Int ?? 0),
                                    context: (last["input_tokens"] as? Int ?? 0) + (last["cached_input_tokens"] as? Int ?? 0))
            }
            guard result == nil else { if tokens != nil { break } else { continue } }

            let age = (r["timestamp"] as? String).flatMap { isoFormatter.date(from: $0) }.map { now.timeIntervalSince($0) } ?? 0
            var state: (AgentActivity, String)?
            switch (type, sub) {
            case ("event_msg", "task_complete"): state = age < 5 ? (.done, "all done!") : (.idle, "ready")
            case ("event_msg", "turn_aborted"): state = (.idle, "ready")
            case ("event_msg", "task_started"), ("response_item", "reasoning"), ("response_item", "function_call_output"):
                state = (.thinking, "thinking…")
            case ("event_msg", let s) where s.contains("approval"): state = (.needsYou, "needs your OK")
            case ("response_item", "message"):
                if payload["role"] as? String != "developer" { state = (.thinking, "thinking…") }
            case ("response_item", "function_call"), ("response_item", "custom_tool_call"):
                state = codexTool(payload)
            default: break
            }
            guard var (activity, detail) = state else { continue }
            // Interrupts don't always reach the log; a quiet process with an old busy state is idle.
            if activity != .idle && activity != .done && activity != .needsYou && age > 120 && !procBusy {
                (activity, detail) = (.idle, "ready")
            }
            result = State(activity: activity, detail: detail, tokens: nil, cwd: "")
        }
        result?.tokens = tokens
        return result
    }

    private static func codexTool(_ payload: [String: Any]) -> (AgentActivity, String) {
        let name = payload["name"] as? String ?? ""
        if name.contains("patch") || name.contains("write") || name.contains("edit") { return (.typing, "writing code") }
        if name.contains("search") || name.contains("web") { return (.searching, "searching") }
        if name.contains("agent") || name.contains("spawn") { return (.delegating, "running helpers") }
        let args = (payload["arguments"] as? String).flatMap { $0.data(using: .utf8) }
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let cmd = ((args["cmd"] as? String) ?? (args["command"] as? [String])?.joined(separator: " ") ?? "")
            .trimmingCharacters(in: .whitespaces)
        let readers = ["cat ", "sed ", "rg ", "grep ", "ls", "find ", "head ", "tail ", "nl ", "wc ", "git diff", "git log", "git show", "git status"]
        if readers.contains(where: { cmd.hasPrefix($0) }) { return (.reading, "reading files") }
        return (.typing, "running commands")
    }

    /// The rollout file a Codex process has open (via lsof), or the newest recent one as a fallback.
    static func logPath(for pids: Set<pid_t>) -> String? {
        let list = pids.map(String.init).joined(separator: ",")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        process.arguments = ["-Fn", "-a", "-p", list]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        if (try? process.run()) != nil {
            let out = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            process.waitUntilExit()
            if let line = out.split(separator: "\n").first(where: { $0.hasPrefix("n") && $0.contains("/.codex/sessions/") && $0.hasSuffix(".jsonl") }) {
                return String(line.dropFirst())
            }
        }
        return newestRollout(within: 600)
    }

    static func newestRollout(within seconds: TimeInterval) -> String? {
        let root = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".codex/sessions")
        guard let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.contentModificationDateKey]) else { return nil }
        var best: (Date, URL)?
        let cutoff = Date().addingTimeInterval(-seconds)
        for case let url as URL in walker where url.pathExtension == "jsonl" {
            let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            if date > cutoff && date > (best?.0 ?? .distantPast) { best = (date, url) }
        }
        return best?.1.path
    }
}

// MARK: - Claude transcript tokens

/// Running token totals per Claude transcript, parsed incrementally so huge transcripts stay cheap.
final class TranscriptTokens {
    private var cache: [String: (offset: UInt64, outputByMessage: [String: Int], context: Int)] = [:]

    func usage(_ path: String) -> TokenUsage? {
        guard !path.isEmpty, let handle = FileHandle(forReadingAtPath: path) else { return nil }
        defer { handle.closeFile() }
        var entry = cache[path] ?? (0, [:], 0)
        let size = handle.seekToEndOfFile()
        if size < entry.offset { entry = (0, [:], 0) }
        handle.seek(toFileOffset: entry.offset)
        let data = handle.readDataToEndOfFile()
        // Only consume complete lines; a partial last line is read next time.
        guard let lastNewline = data.lastIndex(of: UInt8(ascii: "\n")) else { return TokenUsage(output: entry.outputByMessage.values.reduce(0, +), context: entry.context) }
        for line in data[data.startIndex...lastNewline].split(separator: UInt8(ascii: "\n")) {
            guard let r = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any], r["type"] as? String == "assistant",
                  let message = r["message"] as? [String: Any], let usage = message["usage"] as? [String: Any] else { continue }
            // Streamed messages repeat the same id; keep the latest count for each.
            let id = message["id"] as? String ?? UUID().uuidString
            entry.outputByMessage[id] = usage["output_tokens"] as? Int ?? 0
            entry.context = (usage["input_tokens"] as? Int ?? 0) + (usage["cache_read_input_tokens"] as? Int ?? 0)
                + (usage["cache_creation_input_tokens"] as? Int ?? 0)
        }
        entry.offset += UInt64(data.distance(from: data.startIndex, to: lastNewline) + 1)
        cache[path] = entry
        return TokenUsage(output: entry.outputByMessage.values.reduce(0, +), context: entry.context)
    }
}

// MARK: - Kiro hooks

/// Adds DeskPet hooks to Kiro CLI agents (~/.kiro/agents/*.json). Those files are regenerated by
/// tools like `aim`, so the app re-applies the hooks periodically while Kiro hooks are enabled.
enum KiroHooks {
    static var agentsDir = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".kiro/agents")
    private static let events = ["agentSpawn", "userPromptSubmit", "preToolUse", "postToolUse", "stop"]

    /// The event is passed explicitly in case Kiro's hook input doesn't name it.
    private static func command(_ event: String) -> String { "\"\(Bundle.main.executablePath ?? "")\" hook --agent kiro --event \(event)" }
    private static func isOurs(_ entry: Any) -> Bool { ((entry as? [String: Any])?["command"] as? String ?? "").contains(" hook --agent kiro --event ") }

    static func agentFiles() -> [URL] {
        ((try? FileManager.default.contentsOfDirectory(at: agentsDir, includingPropertiesForKeys: nil)) ?? []).filter { $0.pathExtension == "json" }
    }

    static func installed() -> Bool {
        agentFiles().contains { url in
            let hooks = (try? Data(contentsOf: url)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }?["hooks"] as? [String: Any] ?? [:]
            return hooks.values.contains { ($0 as? [Any] ?? []).contains(where: isOurs) }
        }
    }

    /// Returns how many agent files changed.
    @discardableResult
    static func apply(_ install: Bool) -> Int {
        var changed = 0
        for url in agentFiles() {
            guard let data = try? Data(contentsOf: url),
                  var agent = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
            var hooks = agent["hooks"] as? [String: Any] ?? [:]
            let before = NSDictionary(dictionary: hooks)
            for event in events {
                var entries = (hooks[event] as? [Any] ?? []).filter { !isOurs($0) }
                if install {
                    var entry: [String: Any] = ["command": command(event), "timeout_ms": 3000]
                    if event.hasSuffix("ToolUse") { entry["matcher"] = "*" }
                    entries.append(entry)
                }
                hooks[event] = entries.isEmpty ? nil : entries
            }
            guard !before.isEqual(to: hooks) else { continue }
            agent["hooks"] = hooks
            if let out = try? JSONSerialization.data(withJSONObject: agent, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]) {
                try? out.write(to: url, options: .atomic)
                changed += 1
            }
        }
        return changed
    }
}
