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

  static xpNeeded(level) {
    // Level n → n+1 costs 100 + 15n, so level 100 takes about 84,000 XP; Prestige Master levels cost 2,000 each.
    const n = Math.min(level, 100) - 1;
    return 100 * n + (15 * n * (n + 1)) / 2 + Math.max(0, level - 100) * 2000;
  }
  /** The 1.0–1.5 curve (level 100 at about 7,900 XP), only for moving people to the new one. */
  static oldLevel(xp) { let n = 1; while (n < 100 && 30 * n + (n * (n + 1)) / 2 <= xp) n++; return n; }
  static levelFor(xp, cap = 100) { let n = 1; while (n < cap && Stats.xpNeeded(n + 1) <= xp) n++; return n; }
  static dayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // Other devices' progress (cloud sync). Totals include it; this device's file never does.
  get remote() { return this._remote || (this._remote = { xp: 0, days: {}, prestige: null }); }
  get xp() { return this.data.xp + this.remote.xp; }
  get localXP() { return this.data.xp; }
  get prestige() { return this.remote.prestige ? this.remote.prestige.rank : this.data.prestige || 0; }
  get prestigeBase() { return this.remote.prestige ? this.remote.prestige.base : this.data.prestigeBase || 0; }
  /** XP earned since the last prestige. */
  get levelXP() { return this.xp - this.prestigeBase; }
  get maxLevel() { return this.prestige >= 10 ? 1000 : 100; }
  get level() { return Stats.levelFor(this.levelXP, this.maxLevel); }
  get atMax() { return this.level >= this.maxLevel; }
  get canPrestige() { return this.level >= 100 && this.prestige < 10; }
  get progress() {
    if (this.atMax) return 1;
    const lo = Stats.xpNeeded(this.level), hi = Stats.xpNeeded(this.level + 1);
    return (this.levelXP - lo) / Math.max(1, hi - lo);
  }
  get xpToNext() { return this.atMax ? 0 : Stats.xpNeeded(this.level + 1) - this.levelXP; }
  get rankTitle() { return this.prestige ? `${PRESTIGE.title(this.prestige)} · Lv ${this.level}` : `Lv ${this.level}`; }

  /** Lifetime minutes you've been active with the pet open, on every synced device (pruned days included). */
  get togetherMinutes() {
    let m = this.data.archivedMinutes || 0;
    for (const d of Object.values(this.data.days)) m += d.activeMinutes || 0;
    for (const d of Object.values(this.remote.days)) m += d.activeMinutes || 0;
    return m;
  }

  /** The last `count` days (oldest first) across all synced devices, for the Insights charts. */
  history(count = 14) {
    const { addDays } = require('./sync');
    const out = [];
    const d = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i);
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      const v = addDays(this.data.days[key], this.remote.days[key]) || {};
      out.push({ day: key, activeMinutes: v.activeMinutes || 0, agentMinutes: v.agentMinutes || 0, tasks: v.tasks || 0,
        focusSessions: v.focusSessions || 0, pets: v.pets || 0, openMinutes: v.openMinutes || 0 });
    }
    return out;
  }

  /** This device's contribution, for its sync file. */
  get deviceExport() { return { xp: this.data.xp, days: this.data.days }; }

  /** Everything combined, for transfer keys. */
  get exported() {
    const days = { ...this.data.days };
    const { addDays } = require('./sync');
    for (const [k, d] of Object.entries(this.remote.days)) days[k] = addDays(days[k], d);
    return { xp: this.xp, days, prestige: this.prestige, prestigeBase: this.prestigeBase, archivedMinutes: this.data.archivedMinutes || 0 };
  }

  /** "Use synced progress": this device starts from zero (a backup is kept) and adds onto the others. */
  resetLocal() {
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
    this.data.xp = 0;
    this.data.days = {};
    this.dirty = true;
    this.saveIfNeeded();
  }

  /** Keeping a removed device's progress: its XP and days move onto this device. */
  absorbDevice(stats) {
    const { addDays } = require('./sync');
    this.data.xp += (stats && stats.xp) || 0;
    for (const [k, d] of Object.entries((stats && stats.days) || {})) this.data.days[k] = addDays(this.data.days[k], d);
    this.dirty = true;
    this.saveIfNeeded();
  }

  /** Leaving sync: keep the shared prestige and current level progress on this device alone. */
  leaveSync() {
    const p = this.remote.prestige;
    if (p) {
      const progress = this.xp - p.base;
      this.data.prestige = p.rank;
      this.data.prestigeBase = this.data.xp - progress;
    }
    this._remote = { xp: 0, days: {}, prestige: null };
    this.dirty = true;
    this.saveIfNeeded();
  }

  doPrestige() {
    if (!this.canPrestige) return;
    const xp = this.xp;
    this.data.prestige = this.prestige + 1;
    this.data.prestigeBase = xp;
    if (this.remote.prestige) this.remote.prestige = { rank: this.data.prestige, base: xp };
    this.dirty = true;
    this.saveIfNeeded();
  }

  get localToday() {
    return { activeMinutes: 0, agentMinutes: 0, tasks: 0, pets: 0, throwsCount: 0, focusSessions: 0, openMinutes: 0, playXP: 0, greeted: false, blocked: 0, ...(this.data.days[Stats.dayKey()] || {}) };
  }
  /** Today across all synced devices. */
  get today() { return require('./sync').addDays(this.localToday, this.remote.days[Stats.dayKey()]); }

  /** Updates today's counters; returns the new level if this XP gain leveled up. */
  record(xp = 0, change = () => {}) {
    const key = Stats.dayKey();
    const day = this.localToday;
    // Counters that cap across devices (play XP, daily hello) are checked against today's total.
    const totalBefore = this.today;
    const combined = { ...totalBefore };
    change(combined);
    for (const [k, v] of Object.entries(combined)) {
      if (typeof v === 'number') day[k] = (day[k] || 0) + v - (totalBefore[k] || 0);
      else if (v === true) day[k] = true;
    }
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
    // About a year of history; older days still count toward the time-together total.
    for (const k of keys.slice(0, Math.max(0, keys.length - 400))) {
      this.data.archivedMinutes = (this.data.archivedMinutes || 0) + (this.data.days[k].activeMinutes || 0);
      delete this.data.days[k];
    }
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

const STALL_MS = 60 * 1000;

/** Streams url into file, reporting progress (0–1); gives up when no data arrives for a minute. */
async function downloadTo(url, file, onProgress = () => {}, fetcher = fetch, stallMs = STALL_MS) {
  const controller = new AbortController();
  let timer = null;
  const poke = () => { clearTimeout(timer); timer = setTimeout(() => controller.abort(), stallMs); };
  poke();
  try {
    const res = await fetcher(url, { headers: { 'User-Agent': 'DeskPet' }, signal: controller.signal });
    if (!res.ok) throw new Error(`download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const out = fs.createWriteStream(file);
    let got = 0;
    try {
      for await (const chunk of res.body) {
        poke();
        got += chunk.length;
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
        if (total) onProgress(got / total);
      }
    } finally {
      await new Promise((resolve) => out.end(resolve));
    }
    if (total && got !== total) throw new Error('the download was cut short');
  } catch (e) {
    throw controller.signal.aborted ? new Error('the download stalled; check your connection and try again') : e;
  } finally {
    clearTimeout(timer);
  }
}

/** PowerShell that swaps in the new Windows app once every DeskPet process from `exe` has exited, logging each step. */
function swapScript({ exe, zip, work, log, relaunch = true }) {
  const appDir = path.dirname(exe), x = path.join(work, 'x');
  return `
    function Log($m) { Add-Content -Path ${psQuote(log)} -Value "$(Get-Date -Format s) $m" }
    $deadline = (Get-Date).AddSeconds(60)
    while ((Get-Process DeskPet -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${psQuote(exe)} }) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
    Log 'DeskPet exited, unpacking'
    New-Item -ItemType Directory -Force -Path ${psQuote(x)} | Out-Null
    # Windows' own tar unzips far faster than Expand-Archive; older Windows falls back.
    tar.exe -xf ${psQuote(zip)} -C ${psQuote(x)} 2>&1 | Out-Null
    if (-not (Get-ChildItem ${psQuote(x)} -Recurse -Filter DeskPet.exe)) {
      Log "tar didn't work (exit code $LASTEXITCODE), using Expand-Archive"
      try { Expand-Archive -Force -Path ${psQuote(zip)} -DestinationPath ${psQuote(x)} } catch { Log "Expand-Archive failed: $_" }
    }
    $src = Get-ChildItem ${psQuote(x)} -Recurse -Filter DeskPet.exe | Select-Object -First 1
    if ($src) {
      # Copy over, never mirror: the folder may hold more than DeskPet.
      robocopy $src.DirectoryName ${psQuote(appDir)} /E /R:10 /W:1 /NFL /NDL /NJH /NJS | Out-Null
      if ($LASTEXITCODE -lt 8) { Log 'copied the new version' } else { Log "copying failed (robocopy exit code $LASTEXITCODE)" }
    } else {
      Log 'no DeskPet.exe in the update'
    }
    ${relaunch ? `Start-Process ${psQuote(exe)}` : ''}
    Log 'done'
    Remove-Item -Recurse -Force ${psQuote(work)} -ErrorAction SilentlyContinue`;
}

class Updater {
  constructor(currentVersion) { this.current = currentVersion; this.available = null; this.installing = false; this.progress = 0; }

  async check() {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DeskPet' } });
      const release = await res.json();
      const version = String(release.tag_name || '').replace(/^v/, '');
      const wanted = process.platform === 'linux' ? `DeskPet-linux-${process.arch}.AppImage` : 'DeskPet-win32-x64.zip';
      const asset = (release.assets || []).find((a) => a.name === wanted);
      this.available = asset && isNewer(version, this.current) ? { version, url: asset.browser_download_url, page: release.html_url } : null;
    } catch (_) { this.available = null; }
    return !!this.available;
  }

  /** Downloads the zip and swaps the app folder once DeskPet exits, then relaunches. */
  async install(app, shell, onProgress = () => {}) {
    const update = this.available;
    if (!update) return 'no update';
    if (this.installing) return 'already updating';
    if (process.platform === 'linux' && process.env.APPIMAGE) return this.installAppImage(app, update, onProgress);
    if (!isWindows || !app.isPackaged) { shell.openExternal(update.page); return 'opened the release page'; }
    this.installing = true;
    this.progress = 0;
    try {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-update-'));
      const zip = path.join(work, 'update.zip');
      await downloadTo(update.url, zip, (f) => { this.progress = f; onProgress(f); });
      const log = path.join(paths.realRoot, 'update.log');
      fs.writeFileSync(log, `${new Date().toISOString()} updating ${this.current} to ${update.version} in ${path.dirname(process.execPath)}\n`);
      powershell(swapScript({ exe: process.execPath, zip, work, log }), { detached: true }).unref();
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

Updater.prototype.installAppImage = async function installAppImage(app, update, onProgress) {
  // An AppImage is one file: download the new one beside it, swap it in, and start it.
  this.installing = true;
  this.progress = 0;
  try {
    const target = process.env.APPIMAGE;
    await downloadTo(update.url, `${target}.new`, (f) => { this.progress = f; onProgress(f); });
    fs.chmodSync(`${target}.new`, 0o755);
    fs.renameSync(`${target}.new`, target);
    spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
    app.quit();
    setTimeout(() => app.exit(0), 1500).unref();
    return 'updating';
  } catch (e) {
    this.installing = false;
    return `update failed: ${e.message}`;
  }
};

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

/** Runs a tool; `missing` is set when it isn't installed. */
function run(cmd, args, options = {}) {
  return new Promise((resolve) => execFile(cmd, args, options, (e) => resolve({ code: e ? (typeof e.code === 'number' ? e.code : 1) : 0, missing: !!e && e.code === 'ENOENT' })));
}

async function importPack(items, currentPack) {
  const zip = items.find((p) => /\.zip$/i.test(p));
  let dir;
  if (zip) {
    dir = uniqueDir(path.basename(zip, path.extname(zip)));
    fs.mkdirSync(dir, { recursive: true });
    const result = isWindows
      ? await runPowerShell(`Expand-Archive -Force -Path ${psQuote(zip)} -DestinationPath ${psQuote(dir)}`)
      : process.platform === 'darwin'
        ? await run('/usr/bin/ditto', ['-x', '-k', zip, dir])
        : await run('unzip', ['-o', '-q', zip, '-d', dir]);
    if (result.missing) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error("unzipping needs the 'unzip' command (install it with your package manager)"); }
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
    : process.platform === 'darwin'
      ? await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', dir, zip])
      : await run('zip', ['-r', '-q', zip, name], { cwd: path.dirname(dir) });
  if (result.missing) throw new Error("zipping needs the 'zip' command (install it with your package manager)");
  if (result.code !== 0) throw new Error("couldn't create the zip");
}

// MARK: - Kiro CLI hooks (~/.kiro/agents/*.json)

const KIRO_AGENTS = path.join(os.homedir(), '.kiro', 'agents');
const KIRO_EVENTS = ['agentSpawn', 'userPromptSubmit', 'preToolUse', 'postToolUse', 'stop'];
const isKiroOurs = (entry) => /(-Agent kiro -Event |--agent kiro --event )/.test((entry && entry.command) || '');

function kiroCommand(event) { return require('./hooks').hookCommand('kiro', event); }

function kiroFiles() {
  try { return fs.readdirSync(KIRO_AGENTS).filter((f) => f.endsWith('.json')).map((f) => path.join(KIRO_AGENTS, f)); } catch (_) { return []; }
}

const kiroHooks = {
  installed() {
    return kiroFiles().some((f) => Object.values((readJSON(f, {}) || {}).hooks || {}).some((list) => (list || []).some(isKiroOurs)));
  },
  /** Returns how many agent files changed. */
  apply(install) {
    if (process.platform === 'darwin') return 0;
    if (install) require('./hooks').installScripts();
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
  if (!pid) return false;
  const chain = [];
  for (let p = pid; p > 4 && chain.length < 16; p = parents.get(p) || 0) chain.push(p);
  if (process.platform === 'linux') return jumpLinux(chain);
  if (!isWindows) return false;
  const { code } = await runPowerShell(`$s = New-Object -ComObject WScript.Shell; foreach ($p in @(${chain.join(',')})) { if ($s.AppActivate([int]$p)) { exit 0 } }; exit 1`);
  return code === 0;
}

/** X11: activate the window whose process is the agent or one of its ancestors (needs wmctrl). */
function jumpLinux(chain) {
  return new Promise((resolve) => {
    execFile('wmctrl', ['-lp'], (err, out) => {
      if (err) return resolve(false);
      const windows = String(out).split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length > 2);
      for (const pid of chain) {
        const w = windows.find((p) => Number(p[2]) === pid);
        if (w) return execFile('wmctrl', ['-i', '-a', w[0]], (e) => resolve(!e));
      }
      resolve(false);
    });
  });
}

// MARK: - Start at login (Linux has no login-item API: use an XDG autostart entry)

const AUTOSTART = path.join(os.homedir(), '.config', 'autostart', 'deskpet.desktop');
const loginItem = {
  get(app) {
    if (process.platform !== 'linux') return app.getLoginItemSettings().openAtLogin;
    return fs.existsSync(AUTOSTART);
  },
  set(app, on) {
    if (process.platform !== 'linux') return app.setLoginItemSettings({ openAtLogin: on });
    if (!on) return fs.rmSync(AUTOSTART, { force: true });
    fs.mkdirSync(path.dirname(AUTOSTART), { recursive: true });
    const exec = process.env.APPIMAGE || process.execPath;
    fs.writeFileSync(AUTOSTART, `[Desktop Entry]\nType=Application\nName=DeskPet\nComment=A desktop pet that keeps an eye on your AI agents\nExec="${exec}"\nX-GNOME-Autostart-enabled=true\n`);
  },
};

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

// MARK: - Focus blocklist (Windows: matched against the browser's window title)

const BLOCK_DEFAULTS = ['youtube.com', 'reddit.com', 'x.com', 'twitter.com', 'instagram.com', 'tiktok.com', 'facebook.com', 'netflix.com', 'twitch.tv'];
const BROWSERS = /^(chrome|msedge|firefox|brave|opera|vivaldi|arc|librewolf|waterfox|google-chrome|chromium|chromium-browser|brave-browser|microsoft-edge|vivaldi-stable|zen|floorp)$/i;
// Window titles show page titles, not addresses, so each domain maps to words its titles contain.
const TITLE_WORDS = { 'x.com': [' / x'], 'twitter.com': ['twitter'], 'youtube.com': ['youtube'] };

function parseBlocklist(text) {
  const seen = new Set();
  return String(text).split(/[\s,]+/).map((raw) => {
    let s = raw.trim().toLowerCase();
    try { s = new URL(s.includes('://') ? s : `https://${s}`).hostname; } catch (_) { /* keep as typed */ }
    return s.replace(/^www\./, '');
  }).filter((s) => s.includes('.') && !seen.has(s) && seen.add(s));
}

/** The blocklisted domain a browser window title points to, if any. */
function matchTitle(title, list) {
  const t = ` ${String(title).toLowerCase()} `;
  for (const domain of list) {
    const label = domain.split('.').slice(-2, -1)[0] || domain;
    const words = TITLE_WORDS[domain] || [domain, ...(label.length >= 4 ? [label] : [])];
    if (words.some((w) => t.includes(w))) return domain;
  }
  return null;
}

/** Strict mode: close the tab with Ctrl+W if the foreground window still shows the blocked site. */
function closeBlockedTab(word) {
  if (!isWindows) return;
  runPowerShell(`Add-Type -Namespace DP -Name W -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);'
    $b = New-Object System.Text.StringBuilder 512; [void][DP.W]::GetWindowText([DP.W]::GetForegroundWindow(), $b, 512)
    if ($b.ToString().ToLower().Contains(${psQuote(word)})) { (New-Object -ComObject WScript.Shell).SendKeys('^w') }`);
}

// MARK: - Transfer key ("DESKPET-1:" + base64url(raw DEFLATE(JSON)), same as the macOS app)

const zlib = require('zlib');
const TRANSFER_PREFIX = 'DESKPET-1:';
const TRANSFER_SETTINGS = ['spritePack', 'themeColor', 'thoughtBubble', 'wander', 'gravity', 'walkOnWindows', 'quietInCalls', 'notifications', 'sounds', 'autoUpdate', 'blocklist', 'strictBlock',
  'hat', 'trail', 'auraStyle', 'companion', 'goldenFur', 'showPrestigeBadge', 'blockDuringFocus', 'eventRewards', 'quietHours', 'typeAlong', 'panicKey', 'keptRewards', 'stay'];

const transferKey = {
  encode(payload) {
    return TRANSFER_PREFIX + zlib.deflateRawSync(Buffer.from(JSON.stringify(payload))).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(key) {
    const clean = String(key).replace(/\s+/g, '');
    if (!clean.startsWith(TRANSFER_PREFIX)) throw new Error("that doesn't look like a DeskPet transfer key");
    try {
      const b64 = clean.slice(TRANSFER_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(zlib.inflateRawSync(Buffer.from(b64, 'base64')).toString('utf8'));
      if (payload.app !== 'deskpet') throw new Error('wrong app');
      return payload;
    } catch (_) {
      throw new Error('the key is incomplete or mistyped; copy it again');
    }
  },
  summary(payload) {
    const st = payload.stats || {};
    const xp = st.xp || 0;
    const prestige = st.prestige || 0;
    const level = Stats.levelFor(xp - (st.prestigeBase || 0), prestige >= 10 ? 1000 : 100);
    const rank = prestige ? `${PRESTIGE.title(prestige)} · ` : '';
    const days = Object.keys((payload.stats && payload.stats.days) || {}).length;
    return `${(payload.config && payload.config.petName) || 'Mochi'} · ${rank}Lv ${level} (${xp} XP) · ${days} day${days === 1 ? '' : 's'} of stats`;
  },
};

/**
 * A trip came home: add what the pet earned while away (the trip's stats minus the snapshot taken when it
 * left), floored at zero. If it prestiged on the trip, keep that rank and the level progress it had.
 * Returns the new level if this leveled up.
 */
const DAY_FIELDS = ['activeMinutes', 'agentMinutes', 'tasks', 'pets', 'throwsCount', 'focusSessions', 'openMinutes', 'playXP', 'blocked'];

Stats.prototype.absorb = function absorb(trip, departure) {
  trip = trip || {};
  departure = departure || {};
  const before = this.level;
  const xpBefore = this.xp;
  const gained = Math.max(0, (trip.xp || 0) - (departure.xp || 0));
  this.data.xp += gained;
  this.data.archivedMinutes = (this.data.archivedMinutes || 0) + Math.max(0, (trip.archivedMinutes || 0) - (departure.archivedMinutes || 0));
  for (const [key, day] of Object.entries(trip.days || {})) {
    const dep = (departure.days || {})[key] || {};
    const local = { ...(this.data.days[key] || {}) };
    let changed = false;
    for (const f of DAY_FIELDS) {
      const d = Math.max(0, (day[f] || 0) - (dep[f] || 0));
      if (d) { local[f] = (local[f] || 0) + d; changed = true; }
    }
    if (day.greeted && !dep.greeted && !local.greeted) { local.greeted = true; changed = true; }
    if (changed) this.data.days[key] = local;
  }
  if ((trip.prestige || 0) > this.prestige) {
    const progress = Math.max(0, (trip.xp || 0) - (trip.prestigeBase || 0));
    const base = xpBefore + gained - progress;
    this.data.prestige = trip.prestige;
    this.data.prestigeBase = this.data.xp - progress;
    if (this.remote.prestige) this.remote.prestige = { rank: trip.prestige, base };
  }
  this.dirty = true;
  this.saveIfNeeded();
  return this.level > before ? this.level : null;
};

Stats.prototype.replace = function replace(data) {
  if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`);
  this.data = { xp: data.xp || 0, days: data.days || {}, prestige: data.prestige || 0, prestigeBase: data.prestigeBase || 0, archivedMinutes: data.archivedMinutes || 0 };
  this.dirty = true;
  this.saveIfNeeded();
};

// MARK: - Level rewards and prestige (same as Rewards.swift)

const SLOTS = [
  { id: 'hat', title: 'Hats', key: 'hat' }, { id: 'trail', title: 'Trails', key: 'trail' },
  { id: 'aura', title: 'Auras', key: 'auraStyle' }, { id: 'companion', title: 'Companions', key: 'companion' },
  { id: 'golden', title: 'Finish', key: 'goldenFur' },
];
const REWARDS = [
  ['bow', 2, '🎀 Bow', 'hat', 'bow'], ['sparkleTrail', 3, '✨ Sparkle trail', 'trail', 'sparkle'],
  ['partyHat', 5, '🎉 Party hat', 'hat', 'partyHat'], ['balloon', 8, '🎈 Balloon', 'companion', 'balloon'],
  ['petalTrail', 10, '🌸 Petal trail', 'trail', 'petal'], ['cap', 12, '🧢 Cap', 'hat', 'cap'],
  ['goldenAura', 15, '🌟 Golden aura', 'aura', 'golden'], ['crown', 20, '👑 Crown', 'hat', 'crown'],
  ['butterfly', 25, '🦋 Butterfly', 'companion', 'butterfly'], ['fireTrail', 30, '🔥 Fire trail', 'trail', 'fire'],
  ['purpleAura', 35, '💜 Purple aura', 'aura', 'purple'], ['topHat', 40, '🎩 Top hat', 'hat', 'topHat'],
  ['starBuddy', 45, '⭐ Star buddy', 'companion', 'star'], ['rainbowTrail', 50, '🌈 Rainbow trail', 'trail', 'rainbow'],
  ['halo', 60, '😇 Halo', 'hat', 'halo'], ['snowAura', 70, '❄️ Snow aura', 'aura', 'snow'],
  ['planets', 80, '🪐 Orbiting planets', 'companion', 'planets'], ['diamondCrown', 90, '💎 Diamond crown', 'hat', 'diamondCrown'],
  ['golden', 100, '🏆 Golden shimmer', 'golden', true],
  // Seasonal event rewards: earned by spending an hour together during the event (see seasons.js).
  ['witchHat', 0, '🧙 Witch hat', 'hat', 'witchHat', 'halloween'], ['pumpkin', 0, '🎃 Pumpkin buddy', 'companion', 'pumpkin', 'halloween'],
  ['santaHat', 0, '🎅 Santa hat', 'hat', 'santaHat', 'winter'], ['snowman', 0, '⛄ Snowman', 'companion', 'snowman', 'winter'],
  ['heartAura', 0, '💗 Heart aura', 'aura', 'hearts', 'valentine'],
].map(([id, level, title, slot, value, event]) => ({ id, level, title, slot, key: SLOTS.find((s) => s.id === slot).key, value, event: event || null }));

/** Call of Duty style: max level 100, prestige back to 1 (rewards stay), Prestige 10 levels to 1000. */
const PRESTIGE = {
  maxRank: 10, levelCap: 100, masterCap: 1000,
  emblem: (r) => (r >= 10 ? '💎' : r >= 7 ? '🥇' : r >= 4 ? '🥈' : r >= 1 ? '🥉' : ''),
  title: (r) => (r >= 10 ? '💎 Prestige Master' : r > 0 ? `${PRESTIGE.emblem(r)} Prestige ${r}` : ''),
};

module.exports = {
  REWARDS, SLOTS, PRESTIGE,
  Stats, FocusTimer, Updater, downloadTo, swapScript, importPack, exportPack, kiroHooks, jumpTo, WindowPlatforms, isNewer,
  loginItem, BLOCK_DEFAULTS, BROWSERS, TITLE_WORDS, parseBlocklist, matchTitle, closeBlockedTab, transferKey, TRANSFER_SETTINGS,
};
