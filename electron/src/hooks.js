// Installs DeskPet's Claude Code hooks into ~/.claude/settings.json (Windows build).
// Existing hooks are left alone; a timestamped backup is written first.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { paths, readJSON } = require('./settings');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const EVENTS = {
  SessionStart: '', UserPromptSubmit: '', PreToolUse: '', PostToolUse: '', PostToolUseFailure: '',
  PermissionRequest: '', Notification: 'permission_prompt', SubagentStart: '', SubagentStop: '', Stop: '',
  StopFailure: '', PreCompact: '', SessionEnd: '',
};

const isOurs = (group) => (group.hooks || []).some((h) => /deskpet/i.test(h.command || '') && /hook\.ps1/i.test(h.command || ''));
/** Any DeskPet hook, including the macOS app's. */
const isAnyDeskPet = (group) => (group.hooks || []).some((h) => /deskpet/i.test(h.command || ''));

function command() {
  // Forward slashes work in both cmd and Git Bash, whichever runs the hook.
  const script = paths.hookScript.replace(/\\/g, '/');
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}" -Agent claude`;
}

function installed() {
  const settings = readJSON(SETTINGS, {});
  const match = process.platform === 'win32' ? isOurs : isAnyDeskPet;
  return Object.values(settings.hooks || {}).some((groups) => (groups || []).some(match));
}

/** @param {boolean} install false removes DeskPet's hooks */
function setInstalled(install) {
  if (process.platform !== 'win32') throw new Error('On macOS, use the native DeskPet app to connect Claude Code');
  fs.mkdirSync(paths.root, { recursive: true });
  // Read+write rather than copyFile: the source sits inside the app's asar archive.
  if (install) fs.writeFileSync(paths.hookScript, fs.readFileSync(path.join(__dirname, 'hook.ps1')));

  let settings = {};
  if (fs.existsSync(SETTINGS)) {
    settings = readJSON(SETTINGS, null);
    if (!settings) throw new Error(`${SETTINGS} isn't valid JSON, so it was left unchanged`);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(SETTINGS, `${SETTINGS}.deskpet-backup-${stamp}`);
  } else {
    fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  }

  const hooks = settings.hooks || {};
  for (const [event, matcher] of Object.entries(EVENTS)) {
    const groups = (hooks[event] || []).filter((g) => !isOurs(g));
    if (install) groups.push({ matcher, hooks: [{ type: 'command', command: command(), timeout: 5 }] });
    if (groups.length) hooks[event] = groups; else delete hooks[event];
  }
  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;

  const tmp = `${SETTINGS}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, SETTINGS);
}

module.exports = { installed, setInstalled, SETTINGS };
