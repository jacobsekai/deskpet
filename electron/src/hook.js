#!/usr/bin/env node
// Agent hook for DeskPet on Linux (and macOS dev builds): records the session's latest event in
// ~/.deskpet/sessions/<agent>-<session>.json. Same format as Hook.swift and hook.ps1.
// Must stay silent and always exit 0 (stdout from some hooks is fed back to the agent).
// Runs with any Node, or with the DeskPet executable itself via ELECTRON_RUN_AS_NODE=1.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

function main() {
  const args = process.argv.slice(2);
  const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
  const agent = arg('--agent') || 'claude';

  let payload = {};
  try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_) { /* not JSON */ }
  let event = payload.hook_event_name || payload.hookEventName || arg('--event');
  if (!event) return;
  event = event[0].toUpperCase() + event.slice(1);

  const dir = path.join(os.homedir(), '.deskpet', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  const agentPid = findAncestor(agent);
  const sid = String(payload.session_id || payload.sessionId || `pid${agentPid}`).replace(/[^A-Za-z0-9-]/g, '');
  const file = path.join(dir, `${agent}-${sid}.json`);

  if (event === 'SessionEnd') { try { fs.unlinkSync(file); } catch (_) { /* already gone */ } return; }

  let previous = {};
  try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { /* first event */ }
  let subagents = previous.subagents || 0;
  if (event === 'SubagentStart') subagents++;
  if (event === 'SubagentStop') subagents = Math.max(0, subagents - 1);
  if (event === 'SessionStart') subagents = 0;

  const state = { agent, event, ts: Date.now() / 1000, subagents, pid: agentPid };
  const tool = payload.tool_name || payload.toolName;
  if (tool) state.tool = tool;
  if (payload.cwd) state.cwd = payload.cwd;
  if (payload.transcript_path) state.transcript = payload.transcript_path;
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(state));
  fs.renameSync(`${file}.tmp`, file);
}

/** Process name and parent of a pid (/proc on Linux, ps elsewhere). */
function proc(pid) {
  try {
    if (process.platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '); } catch (_) { /* gone */ }
      return { name, ppid, cmd };
    }
    const out = execFileSync('/bin/ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    const m = /^(\d+)\s+(.*)$/.exec(out);
    return m ? { ppid: Number(m[1]), name: path.basename(m[2]), cmd: m[2] } : null;
  } catch (_) {
    return null;
  }
}

/** The agent process that ran this hook, so the pet can match it to a live process. */
function findAncestor(agent) {
  let pid = process.ppid;
  for (let i = 0; i < 10 && pid > 1; i++) {
    const p = proc(pid);
    if (!p) break;
    if (p.name === agent || p.name.startsWith(`${agent}-`) || (p.name === 'node' && p.cmd.includes(agent))) return pid;
    pid = p.ppid;
  }
  return process.ppid;
}

try { main(); } catch (_) { /* never fail the agent */ }
process.exit(0);
