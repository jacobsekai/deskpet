// Playdates: every running DeskPet (home and visitors) says where its pet is, so pets can find each other.
// Files live in the real ~/.deskpet/presence/<pid>.json and are refreshed every second.
const fs = require('fs');
const path = require('path');
const { paths } = require('./settings');

const DIR = () => path.join(paths.realRoot, 'presence');
const STALE = 4000;

function write(info) {
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    const file = path.join(DIR(), `${process.pid}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ ...info, pid: process.pid, at: Date.now() }));
    fs.renameSync(`${file}.tmp`, file);
  } catch (_) { /* best effort */ }
}

function remove() {
  try { fs.rmSync(path.join(DIR(), `${process.pid}.json`), { force: true }); } catch (_) { /* gone */ }
}

/** Other pets that reported in the last few seconds. Stale files from crashed instances are cleaned up. */
function others(now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(DIR()); } catch (_) { return []; }
  const out = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name) || name === `${process.pid}.json`) continue;
    const file = path.join(DIR(), name);
    try {
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (now - (p.at || 0) > STALE) {
        if (now - (p.at || 0) > 60000) fs.rmSync(file, { force: true });
        continue;
      }
      out.push(p);
    } catch (_) { /* being written */ }
  }
  return out;
}

/** Moods where a pet is free to play (typing along with you counts; an agent at work doesn't). */
const FREE = ['idle', 'walking', 'typing', 'userTyping'];

/**
 * One second of playdate logic, kept free of windows so it can be tested.
 * In: { me: { x, halfWidth, mood, busy, blocked }, other: { pid, pet, x, width, mood } | null, state: { pid, first, since } | null,
 *       met: Set of pids, t (seconds), nextAt }.
 * Out: { state, action: 'none'|'walk'|'play'|'giveUp', center (where to walk to), direction }.
 */
function playdateStep({ me, other, state, met, t, nextAt }) {
  if (!other) return { state: null, action: 'none' };
  if (state && state.pid !== other.pid) state = null;
  if (!state) {
    const first = !met.has(other.pid);
    if (me.blocked || me.busy || !FREE.includes(me.mood)) return { state: null, action: 'none' };
    if (!first && (t < nextAt || !FREE.includes(other.mood))) return { state: null, action: 'none' };
    state = { pid: other.pid, first, since: t };
  }
  const dx = other.x - me.x;
  const gap = me.halfWidth + (other.width || 92) / 2 + 18;
  if (Math.abs(dx) <= gap + 14) return { state: null, action: 'play', direction: dx >= 0 ? 1 : -1, first: state.first };
  if (t - state.since > 25) return { state: null, action: 'giveUp' };
  return { state, action: 'walk', center: other.x - Math.sign(dx) * gap };
}

module.exports = { write, remove, others, playdateStep };
