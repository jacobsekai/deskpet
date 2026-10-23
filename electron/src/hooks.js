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

const isOurs = (group) => (group.hooks || []).some((h) => /deskpet/i.test(h.command || '') && /hook\.(ps1|js)/i.test(h.command || ''));
/** Any DeskPet hook, including the macOS app's. */
const isAnyDeskPet = (group) => (group.hooks || []).some((h) => /deskpet/i.test(h.command || ''));

const HOOK_JS = path.join(paths.realRoot, 'hook.js');

/** Finds `node` on PATH, so hooks start fast; otherwise DeskPet itself runs the script as Node. */
function nodeBinary() {
  for (const dir of (process.env.PATH || '').split(path.delimiter).concat(['/usr/bin', '/usr/local/bin'])) {
    const p = path.join(dir, 'node');
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* keep looking */ }
  }
  return null;
}

/** The shell command an agent runs for each event. */
function hookCommand(agent, event) {
  if (process.platform === 'win32') {
    // Forward slashes work in both cmd and Git Bash, whichever runs the hook.
    const script = paths.hookScript.replace(/\\/g, '/');
    return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}" -Agent ${agent}${event ? ` -Event ${event}` : ''}`;
  }
  const node = nodeBinary();
  const runner = node ? `"${node}"` : `ELECTRON_RUN_AS_NODE=1 "${process.env.APPIMAGE || process.execPath}"`;
  return `${runner} "${HOOK_JS}" --agent ${agent}${event ? ` --event ${event}` : ''}`;
}

/** Copies the hook script out of the app bundle (or AppImage) to ~/.deskpet, where agents can run it. */
function installScripts() {
  fs.mkdirSync(paths.realRoot, { recursive: true });
  // Read+write rather than copyFile: the source sits inside the app's asar archive.
  if (process.platform === 'win32') fs.writeFileSync(paths.hookScript, fs.readFileSync(path.join(__dirname, 'hook.ps1')));
  else fs.writeFileSync(HOOK_JS, fs.readFileSync(path.join(__dirname, 'hook.js')));
}

function command() { return hookCommand('claude'); }

function installed() {
  const settings = readJSON(SETTINGS, {});
  const match = process.platform === 'darwin' ? isAnyDeskPet : isOurs;
  return Object.values(settings.hooks || {}).some((groups) => (groups || []).some(match));
}

/** @param {boolean} install false removes DeskPet's hooks */
function setInstalled(install) {
  if (process.platform === 'darwin') throw new Error('On macOS, use the native DeskPet app to connect Claude Code');
  if (install) installScripts();

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

/** Paths quoted in a hook command ("…/node" "…/hook.js", or -File "…/hook.ps1"). */
const quotedPaths = (cmd) => [...String(cmd).matchAll(/"([^"]+)"/g)].map((m) => m[1]);

/**
 * Launch-time repair: if DeskPet's Claude Code hooks point at a program or script that no longer exists
 * (the AppImage moved, Node was uninstalled…), rewrite them to the current command. Only broken hooks are
 * touched, so a different-but-working Node on PATH doesn't cause churn. Returns how many were fixed.
 */
function heal(settingsFile = SETTINGS, { platform = process.platform } = {}) {
  if (platform === 'darwin') return 0; // the native macOS app owns hooks there
  const settings = readJSON(settingsFile, null);
  if (!settings || !settings.hooks) return 0;
  let fixed = 0;
  for (const groups of Object.values(settings.hooks)) {
    for (const g of groups || []) {
      if (!isOurs(g)) continue;
      for (const h of g.hooks || []) {
        const m = / --agent (\w+)| -Agent (\w+)/.exec(h.command || '');
        if (!m || !/deskpet/i.test(h.command || '')) continue;
        const broken = quotedPaths(h.command).some((p) => !fs.existsSync(p));
        const wanted = hookCommand(m[1] || m[2]);
        if (broken && h.command !== wanted) { h.command = wanted; fixed++; }
      }
    }
  }
  if (!fixed) return 0;
  installScripts();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(settingsFile, `${settingsFile}.deskpet-backup-${stamp}`);
  const tmp = `${settingsFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(tmp, settingsFile);
  return fixed;
}

module.exports = { installed, setInstalled, SETTINGS, hookCommand, installScripts, heal };
