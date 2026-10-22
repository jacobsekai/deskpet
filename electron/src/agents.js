// Detects AI agent CLIs and what they're doing. A port of Agents.swift.
//
// Process list: a long-running PowerShell helper on Windows (also reports the foreground app),
// `ps` elsewhere. Precise states come from hook files in ~/.deskpet/sessions.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { paths } = require('./settings');

const KNOWN = {
  claude: 'Claude', codex: 'Codex', 'kiro-cli': 'Kiro', 'kiro-cli-chat': 'Kiro', qchat: 'Amazon Q', q: 'Amazon Q',
  gemini: 'Gemini', 'cursor-agent': 'Cursor', goose: 'Goose', opencode: 'opencode', aider: 'Aider', amp: 'Amp',
};
// npm-installed CLIs run as node.exe; recognize them by command line.
const NODE_AGENTS = [[/claude-code/i, 'Claude'], [/@openai[\\/]codex/i, 'Codex'], [/gemini-cli/i, 'Gemini']];

/** Display priority: when several agents run, the pet shows the highest. */
const PRIORITY = ['idle', 'done', 'tidying', 'thinking', 'reading', 'searching', 'delegating', 'typing', 'oops', 'error', 'needsYou'];

// PowerShell loop that reports processes and the foreground app (see windows-helper.ps1).
const WINDOWS_HELPER = fs.readFileSync(path.join(__dirname, 'windows-helper.ps1'), 'utf8');

function isAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return null; }
}

class AgentMonitor {
  constructor() {
    this.procSessions = [];
    this.scanCount = 0;
    this.foreground = null;
    this.onForeground = null;
    this.previousCPU = new Map();
    this.previousTime = 0;
    this.smoothed = new Map();
  }

  start() {
    if (process.platform === 'win32') this.startWindowsHelper();
    else {
      this.scanUnix();
      this.timer = setInterval(() => this.scanUnix(), 2000);
    }
  }

  stop() {
    clearInterval(this.timer);
    if (this.helper) { this.helper.removeAllListeners('exit'); this.helper.kill(); }
  }

  startWindowsHelper() {
    const encoded = Buffer.from(WINDOWS_HELPER, 'utf16le').toString('base64');
    this.helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
    let buffer = '';
    this.helper.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try { this.handleWindowsSample(JSON.parse(line)); } catch (_) { /* partial or malformed line */ }
      }
    });
    // Restart if PowerShell dies.
    this.helper.on('exit', () => setTimeout(() => this.startWindowsHelper(), 5000));
  }

  handleWindowsSample(sample) {
    const procs = (sample.p || []).map(([pid, ppid, cpu, name]) => ({
      pid, ppid, cpu, base: String(name || '').toLowerCase().replace(/\.exe$/, ''),
    }));
    const args = new Map(Object.entries(sample.c || {}).map(([k, v]) => [Number(k), v || '']));
    this.update(procs, args);
    const fg = sample.fg ? String(sample.fg) : null;
    if (fg !== this.foreground) {
      this.foreground = fg;
      if (this.onForeground) this.onForeground(fg);
    }
  }

  scanUnix() {
    execFile('/bin/ps', ['-axww', '-o', 'pid=,ppid=,time=,comm='], { maxBuffer: 16 * 1024 * 1024 }, (err, out) => {
      if (err) return;
      const procs = out.split('\n').map((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (!m) return null;
        const cpu = m[3].split(':').reduce((acc, part) => acc * 60 + (parseFloat(part) || 0), 0);
        return { pid: +m[1], ppid: +m[2], cpu, base: path.basename(m[4]).toLowerCase() };
      }).filter(Boolean);
      const candidates = procs.filter((p) => KNOWN[p.base]);
      if (!candidates.length) return this.update(procs, new Map());
      execFile('/bin/ps', ['-ww', '-o', 'pid=,args=', '-p', candidates.map((c) => c.pid).join(',')], (e2, out2) => {
        const args = new Map();
        for (const line of (out2 || '').split('\n')) {
          const m = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (m) args.set(+m[1], m[2]);
        }
        this.update(procs, args);
      });
    });
  }

  agentName(proc, args) {
    if (KNOWN[proc.base]) return KNOWN[proc.base];
    if (proc.base === 'node') {
      const cmd = args.get(proc.pid) || '';
      for (const [re, name] of NODE_AGENTS) if (re.test(cmd)) return name;
    }
    return null;
  }

  update(procs, args) {
    const now = Date.now() / 1000;
    const children = new Map();
    for (const p of procs) {
      if (!children.has(p.ppid)) children.set(p.ppid, []);
      children.get(p.ppid).push(p.pid);
    }
    const names = new Map();
    for (const p of procs) {
      const name = this.agentName(p, args);
      if (name && !(args.get(p.pid) || '').includes('__otel-server')) names.set(p.pid, name);
    }
    const cpuByPid = new Map(procs.map((p) => [p.pid, p.cpu]));
    const firstScan = this.previousTime === 0;
    const interval = Math.max(0.5, now - this.previousTime);

    const sessions = [];
    for (const p of procs) {
      const name = names.get(p.pid);
      if (!name || names.get(p.ppid) === name) continue; // inner process of the same session
      const tree = new Set([p.pid]);
      const stack = [p.pid];
      while (stack.length) {
        for (const c of children.get(stack.pop()) || []) if (!tree.has(c)) { tree.add(c); stack.push(c); }
      }
      let cpuSeconds = 0;
      if (!firstScan) {
        for (const pid of tree) {
          const cur = cpuByPid.get(pid) || 0;
          const prev = this.previousCPU.has(pid) ? this.previousCPU.get(pid) : cur;
          cpuSeconds += Math.max(0, cur - prev);
        }
      }
      const usage = 0.5 * (this.smoothed.get(p.pid) || 0) + 0.5 * (cpuSeconds / interval);
      this.smoothed.set(p.pid, usage);
      sessions.push({ pid: p.pid, name, pids: tree, busy: usage > 0.15 });
    }
    this.previousCPU = cpuByPid;
    this.previousTime = now;
    for (const pid of this.smoothed.keys()) if (!sessions.some((s) => s.pid === pid)) this.smoothed.delete(pid);
    this.procSessions = sessions.sort((a, b) => a.pid - b.pid);
    this.scanCount++;
  }

  readHookStates() {
    let files = [];
    try { files = fs.readdirSync(paths.sessions).filter((f) => f.endsWith('.json')); } catch (_) { return []; }
    return files.map((f) => {
      const file = path.join(paths.sessions, f);
      const o = readJSON(file);
      if (!o) return null;
      return {
        file, id: f, event: o.event || '', tool: o.tool || '', ts: +o.ts || 0, subagents: +o.subagents || 0,
        pid: +o.pid || 0, cwd: o.cwd || '', transcript: o.transcript || '',
      };
    }).filter(Boolean);
  }

  sessions() {
    const now = Date.now() / 1000;
    let hooks = this.readHookStates();
    const result = [];
    for (const proc of this.procSessions) {
      const matching = hooks.filter((h) => proc.pids.has(h.pid));
      if (matching.length) {
        const hook = matching.reduce((a, b) => (a.ts > b.ts ? a : b));
        hooks = hooks.filter((h) => !proc.pids.has(h.pid));
        result.push(this.fromHook(hook, `${proc.name}-${proc.pid}`, proc.name, proc.busy, now));
      } else {
        result.push({
          id: `${proc.name}-${proc.pid}`, name: proc.name, project: '', activity: proc.busy ? 'typing' : 'idle',
          detail: proc.busy ? 'working…' : 'ready', subagents: 0, precise: false,
        });
      }
    }
    for (const hook of hooks) {
      if (hook.pid > 0 && !isAlive(hook.pid)) {
        try { fs.unlinkSync(hook.file); } catch (_) { /* already gone */ }
      } else if (now - hook.ts < 3600 && this.scanCount > 0 && hook.pid > 0) {
        result.push(this.fromHook(hook, hook.id, 'Claude', true, now));
      }
    }
    return result;
  }

  /** True when the transcript's last turn finished (a final reply) or was interrupted. */
  turnEnded(file) {
    if (!file) return false;
    let stat;
    try { stat = fs.statSync(file); } catch (_) { return false; }
    this.transcriptCache = this.transcriptCache || new Map();
    const cached = this.transcriptCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.ended;

    let ended = false;
    try {
      const length = Math.min(stat.size, 256 * 1024);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(file, 'r');
      fs.readSync(fd, buffer, 0, length, stat.size - length);
      fs.closeSync(fd);
      // Walk back to the latest user or assistant record; other record types are bookkeeping.
      const lines = buffer.toString('utf8').split('\n').reverse();
      for (const line of lines) {
        let record;
        try { record = JSON.parse(line); } catch (_) { continue; }
        if (record.type !== 'assistant' && record.type !== 'user') continue;
        const message = record.message || {};
        if (record.type === 'assistant') ended = message.stop_reason === 'end_turn';
        else {
          const content = message.content;
          const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.map((c) => c.text || '').join('') : '');
          ended = text.includes('[Request interrupted by user');
        }
        break;
      }
    } catch (_) { /* unreadable transcript: keep the hook's state */ }
    this.transcriptCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ended });
    return ended;
  }

  fromHook(hook, id, name, procBusy, now) {
    const age = now - hook.ts;
    let activity;
    switch (hook.event) {
      case 'UserPromptSubmit': case 'PostToolUse': case 'SubagentStop': activity = 'thinking'; break;
      case 'PreToolUse': activity = activityForTool(hook.tool); break;
      case 'PostToolUseFailure': activity = age < 3 ? 'oops' : 'thinking'; break;
      case 'PermissionRequest': case 'Notification': activity = 'needsYou'; break;
      case 'SubagentStart': activity = 'delegating'; break;
      case 'Stop': activity = age < 5 ? 'done' : 'idle'; break;
      case 'StopFailure': activity = age < 20 ? 'error' : 'idle'; break;
      case 'PreCompact': activity = 'tidying'; break;
      default: activity = 'idle';
    }
    // Interrupting Claude (Esc) sends no hook at all, so check how the transcript ends,
    // and fall back to "no events for a while and a quiet process".
    const working = ['thinking', 'typing', 'reading', 'searching', 'delegating', 'tidying'];
    if (working.includes(activity) && age > 2 && this.turnEnded(hook.transcript)) activity = 'idle';
    if (working.includes(activity) && age > 120 && !procBusy) activity = 'idle';
    if (activity === 'needsYou' && age > 3600) activity = 'idle';
    return {
      id, name, project: path.basename(hook.cwd || ''), activity, detail: detailFor(activity, hook.tool),
      subagents: hook.subagents, precise: true,
    };
  }
}

function activityForTool(tool) {
  switch (tool) {
    case 'Read': case 'Grep': case 'Glob': case 'LS': case 'NotebookRead': return 'reading';
    case 'WebFetch': case 'WebSearch': case 'ToolSearch': return 'searching';
    case 'Agent': case 'Task': case 'Workflow': return 'delegating';
    case 'AskUserQuestion': case 'ExitPlanMode': return 'needsYou';
    default: return tool.startsWith('mcp__') ? 'searching' : 'typing';
  }
}

function detailFor(activity, tool) {
  switch (activity) {
    case 'idle': return 'ready';
    case 'done': return 'all done!';
    case 'tidying': return 'compacting memory';
    case 'thinking': return 'thinking…';
    case 'reading': return 'reading files';
    case 'searching':
      if (tool.startsWith('mcp__')) return `using ${tool.split('_').filter(Boolean)[1] || 'a tool'}`;
      return tool.startsWith('Web') ? 'browsing the web' : 'searching';
    case 'delegating': return 'running helpers';
    case 'typing':
      if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return 'writing code';
      if (['Bash', 'BashOutput', 'PowerShell'].includes(tool)) return 'running commands';
      return tool ? `using ${tool}` : 'working…';
    case 'oops': return 'a tool failed';
    case 'error': return 'hit an error';
    case 'needsYou': return tool === 'AskUserQuestion' ? 'has a question' : 'needs your OK';
    default: return '';
  }
}

module.exports = { AgentMonitor, PRIORITY };
