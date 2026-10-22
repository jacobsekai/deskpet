// Stats, focus timer, updates, sprite pack zips, Kiro hooks, jumping to sessions, and window
// platforms for the Windows app. Ports of Extras.swift / AgentLogs.swift / HoverCard.swift.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { paths, readJSON } = require('./settings');

const isWindows = process.platform === 'win32';

function powershell(script, { detached = false } = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true, detached, stdio: detached ? 'ignore' : 'pipe' });
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    const child = powershell(script);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

// MARK: - Stats & levels (~/.deskpet/stats.json, same format as the macOS app)

class Stats {
  constructor() {
    this.file = path.join(paths.root, 'stats.json');
    this.data = readJSON(this.file, { xp: 0, days: {} });
    this.dirty = false;
  }

  static xpNeeded(level) { return 25 * level * (level - 1); }
  static levelFor(xp) { let n = 1; while (Stats.xpNeeded(n + 1) <= xp) n++; return n; }
  static dayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  get xp() { return this.data.xp; }
  get level() { return Stats.levelFor(this.data.xp); }
  get progress() {
    const lo = Stats.xpNeeded(this.level), hi = Stats.xpNeeded(this.level + 1);
    return (this.data.xp - lo) / Math.max(1, hi - lo);
  }
  get xpToNext() { return Stats.xpNeeded(this.level + 1) - this.data.xp; }
  get today() {
    return { activeMinutes: 0, agentMinutes: 0, tasks: 0, pets: 0, throwsCount: 0, focusSessions: 0, openMinutes: 0, playXP: 0, greeted: false, ...(this.data.days[Stats.dayKey()] || {}) };
  }

  /** Updates today's counters; returns the new level if this XP gain leveled up. */
  record(xp = 0, change = () => {}) {
    const key = Stats.dayKey();
    const day = this.today;
    change(day);
    this.data.days[key] = day;
    const before = this.level;
    this.data.xp += xp;
    this.dirty = true;
    return this.level > before ? this.level : null;
  }

  saveIfNeeded() {
    if (!this.dirty) return;
    this.dirty = false;
    const keys = Object.keys(this.data.days).sort();
    for (const k of keys.slice(0, Math.max(0, keys.length - 400))) delete this.data.days[k];
    fs.mkdirSync(paths.root, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data));
  }
}

// MARK: - Focus timer

class FocusTimer {
  constructor() { this.phase = 'off'; this.endsAt = 0; this.minutes = 25; }
  get remaining() { return Math.max(0, (this.endsAt - Date.now()) / 1000); }
  get label() {
    const r = Math.ceil(this.remaining);
    const clock = `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
    return this.phase === 'focus' ? `🍅 focus · ${clock}` : this.phase === 'rest' ? `☕ break · ${clock}` : '';
  }
  start(minutes) { this.minutes = minutes; this.phase = 'focus'; this.endsAt = Date.now() + minutes * 60000; }
  stop() { this.phase = 'off'; }
  /** Advances phases; returns what just finished. */
  tick() {
    if (this.phase === 'off' || this.remaining > 0) return null;
    const finished = this.phase;
    if (this.phase === 'focus') {
      this.phase = 'rest';
      this.endsAt = Date.now() + Math.max(5, Math.round(this.minutes / 5)) * 60000;
    } else {
      this.phase = 'off';
    }
    return finished;
  }
}

// MARK: - Updates from GitHub Releases

const REPO = 'jacobsekai/deskpet';

function isNewer(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

class Updater {
  constructor(currentVersion) { this.current = currentVersion; this.available = null; this.installing = false; }

  async check() {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DeskPet' } });
      const release = await res.json();
      const version = String(release.tag_name || '').replace(/^v/, '');
      const asset = (release.assets || []).find((a) => a.name === 'DeskPet-win32-x64.zip');
      this.available = asset && isNewer(version, this.current) ? { version, url: asset.browser_download_url, page: release.html_url } : null;
    } catch (_) { this.available = null; }
    return !!this.available;
  }

  /** Downloads the zip and swaps the app folder once DeskPet exits, then relaunches. */
  async install(app, shell) {
    const update = this.available;
    if (!update || this.installing) return 'no update';
    if (!isWindows || !app.isPackaged) { shell.openExternal(update.page); return 'opened the release page'; }
    this.installing = true;
    try {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-update-'));
      const zip = path.join(work, 'update.zip');
      const res = await fetch(update.url, { headers: { 'User-Agent': 'DeskPet' } });
      fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
      const appDir = path.dirname(process.execPath);
      const script = `
        while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Milliseconds 200 }
        Expand-Archive -Force -Path ${psQuote(zip)} -DestinationPath ${psQuote(path.join(work, 'x'))}
        $src = Get-ChildItem ${psQuote(path.join(work, 'x'))} -Recurse -Filter DeskPet.exe | Select-Object -First 1
        if ($src) {
          robocopy $src.DirectoryName ${psQuote(appDir)} /MIR /NFL /NDL /NJH /NJS | Out-Null
          Start-Process ${psQuote(path.join(appDir, 'DeskPet.exe'))}
        }`;
      powershell(script, { detached: true }).unref();
      // The swap waits for this process to exit, so make sure it does.
      app.quit();
      setTimeout(() => app.exit(0), 1500).unref();
      return 'updating';
    } catch (e) {
      this.installing = false;
      return `update failed: ${e.message}`;
    }
  }
}

// MARK: - Sprite pack zips

const IMAGE = /\.(png|gif|webp|jpe?g)$/i;
const MOODS = /^(idle|walking|walk|sleepy|sleeping|sleep|petted|happy|dragged|flying|thrown|dizzy|startled|surprised|user-?typing|thinking|typing|working|reading|searching|delegating|needs-?you|attention|done|celebrate|oops|error|tidying)([_-]?\d+)?$/i;

function uniqueDir(base) {
  const clean = base.replace(/[\\/:*?"<>|]/g, '-');
  let dir = path.join(paths.sprites, clean);
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(paths.sprites, `${clean} ${n}`);
  return dir;
}

/** Zips often wrap everything in one folder (plus __MACOSX); move its contents up. */
function flatten(dir) {
  fs.rmSync(path.join(dir, '__MACOSX'), { recursive: true, force: true });
  const items = fs.readdirSync(dir, { withFileTypes: true });
  if (items.length !== 1 || !items[0].isDirectory()) return;
  const inner = path.join(dir, items[0].name);
  for (const child of fs.readdirSync(inner)) fs.renameSync(path.join(inner, child), path.join(dir, child));
  fs.rmdirSync(inner);
}

function looksLikePack(dir) {
  const files = fs.readdirSync(dir);
  const options = readJSON(path.join(dir, 'pack.json'), {});
  return files.some((f) => /^idle([_-]?\d+)?\.(png|gif|webp|jpe?g)$/i.test(f) || /^sheet\./i.test(f)) || !!(options.sheet || options.sheets);
}

async function importPack(items, currentPack) {
  const zip = items.find((p) => /\.zip$/i.test(p));
  let dir;
  if (zip) {
    dir = uniqueDir(path.basename(zip, path.extname(zip)));
    fs.mkdirSync(dir, { recursive: true });
    const result = isWindows
      ? await runPowerShell(`Expand-Archive -Force -Path ${psQuote(zip)} -DestinationPath ${psQuote(dir)}`)
      : await new Promise((r) => execFile('/usr/bin/ditto', ['-x', '-k', zip, dir], (e) => r({ code: e ? 1 : 0 })));
    if (result.code !== 0) throw new Error("couldn't unzip that");
    flatten(dir);
  } else if (items.length === 1 && fs.statSync(items[0]).isDirectory()) {
    dir = uniqueDir(path.basename(items[0]));
    fs.cpSync(items[0], dir, { recursive: true });
  } else {
    const images = items.filter((p) => IMAGE.test(p));
    if (!images.length) throw new Error('drop a .zip, a folder, or images');
    dir = currentPack ? path.join(paths.sprites, currentPack) : uniqueDir('my-pack');
    fs.mkdirSync(dir, { recursive: true });
    for (const image of images) {
      const base = path.basename(image, path.extname(image));
      // A lone big image is most likely a spritesheet.
      const name = MOODS.test(base) ? path.basename(image) : `sheet${path.extname(image).toLowerCase()}`;
      fs.copyFileSync(image, path.join(dir, name));
    }
  }
  if (!looksLikePack(dir)) {
    if (zip) fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`no idle image found in ${path.basename(dir)}`);
  }
  return path.basename(dir);
}

async function exportPack(name, zip) {
  const dir = path.join(paths.sprites, name);
  fs.rmSync(zip, { force: true });
  const result = isWindows
    ? await runPowerShell(`Compress-Archive -Path ${psQuote(dir)} -DestinationPath ${psQuote(zip)}`)
    : await new Promise((r) => execFile('/usr/bin/ditto', ['-c', '-k', '--keepParent', dir, zip], (e) => r({ code: e ? 1 : 0 })));
  if (result.code !== 0) throw new Error("couldn't create the zip");
}

// MARK: - Kiro CLI hooks (~/.kiro/agents/*.json)

const KIRO_AGENTS = path.join(os.homedir(), '.kiro', 'agents');
const KIRO_EVENTS = ['agentSpawn', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop'];
const isKiroOurs = (entry) => /-Agent kiro -Event /.test((entry && entry.command) || '');

function kiroCommand(event) {
  const script = paths.hookScript.replace(/\\/g, '/');
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${script}" -Agent kiro -Event ${event}`;
}

function kiroFiles() {
  try { return fs.readdirSync(KIRO_AGENTS).filter((f) => f.endsWith('.json')).map((f) => path.join(KIRO_AGENTS, f)); } catch (_) { return []; }
}

const kiroHooks = {
  installed() {
    return kiroFiles().some((f) => Object.values((readJSON(f, {}) || {}).hooks || {}).some((list) => (list || []).some(isKiroOurs)));
  },
  /** Returns how many agent files changed. */
  apply(install) {
    if (!isWindows) return 0;
    if (install) fs.writeFileSync(paths.hookScript, fs.readFileSync(path.join(__dirname, 'hook.ps1')));
    let changed = 0;
    for (const file of kiroFiles()) {
      const agent = readJSON(file, null);
      if (!agent) continue;
      const before = JSON.stringify(agent.hooks || {});
      const hooks = agent.hooks || {};
      for (const event of KIRO_EVENTS) {
        const entries = (hooks[event] || []).filter((e) => !isKiroOurs(e));
        if (install) entries.push({ command: kiroCommand(event), timeout_ms: 5000, ...(event.endsWith('ToolUse') ? { matcher: '*' } : {}) });
        if (entries.length) hooks[event] = entries; else delete hooks[event];
      }
      if (JSON.stringify(hooks) === before) continue;
      agent.hooks = hooks;
      fs.writeFileSync(file, `${JSON.stringify(agent, null, 2)}\n`);
      changed++;
    }
    return changed;
  },
};

// MARK: - Jump to a session's window (Windows)

/** Activates the first window owned by the agent process or one of its ancestors (the terminal or IDE). */
async function jumpTo(pid, parents) {
  if (!isWindows || !pid) return false;
  const chain = [];
  for (let p = pid; p > 4 && chain.length < 16; p = parents.get(p) || 0) chain.push(p);
  const { code } = await runPowerShell(`$s = New-Object -ComObject WScript.Shell; foreach ($p in @(${chain.join(',')})) { if ($s.AppActivate([int]$p)) { exit 0 } }; exit 1`);
  return code === 0;
}

// MARK: - Window platforms (walk on windows)

class WindowPlatforms {
  constructor(screen) {
    this.screen = screen;
    this.platforms = [];
  }

  start() {
    if (!isWindows) return;
    const script = fs.readFileSync(path.join(__dirname, 'windows-rects.ps1'), 'utf8').replace('__SKIP_PID__', String(process.pid));
    this.helper = powershell(script);
    let buffer = '';
    this.helper.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        try {
          // Physical pixels -> DIP (Windows only API).
          this.platforms = JSON.parse(line).map(([id, x, y, width, height]) => ({ id, rect: this.screen.screenToDipRect(null, { x, y, width, height }) }));
        } catch (_) { /* partial line */ }
      }
    });
    this.helper.on('exit', () => { this.helper = null; setTimeout(() => this.start(), 5000); });
  }

  stop() { if (this.helper) { this.helper.removeAllListeners('exit'); this.helper.kill(); } }

  /** The highest visible window top at or below `feetY` (screen y grows downward) under `x`. */
  landing(feetY, x, workArea, headroom) {
    let best = null;
    this.platforms.forEach((p, i) => {
      const top = p.rect.y;
      if (x <= p.rect.x + 12 || x >= p.rect.x + p.rect.width - 12 || top < feetY - 1) return;
      if (top >= workArea.y + workArea.height - 4 || top - headroom <= workArea.y) return;
      // An edge covered by a window in front of it isn't somewhere to stand.
      const covered = this.platforms.slice(0, i).some((q) => x >= q.rect.x && x <= q.rect.x + q.rect.width && top + 2 >= q.rect.y && top + 2 <= q.rect.y + q.rect.height);
      if (!covered && (!best || top < best.rect.y)) best = p;
    });
    return best;
  }
}

module.exports = { Stats, FocusTimer, Updater, importPack, exportPack, kiroHooks, jumpTo, WindowPlatforms, isNewer };
