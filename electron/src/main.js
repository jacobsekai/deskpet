// DeskPet for Windows (and anywhere Electron runs). A port of App.swift from the macOS app.
//
// The main process owns all behavior: agent detection, moods, walking, throwing, resizing, and menus.
// The renderer only draws the pose it's sent and reports where the pet is for hit testing.
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, powerMonitor, ipcMain, shell, dialog, Notification, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');
const { AgentMonitor, PRIORITY, TranscriptTokens, codexState } = require('./agents');
const {
  REWARDS, Stats, FocusTimer, Updater, importPack, exportPack, kiroHooks, jumpTo, WindowPlatforms,
  BLOCK_DEFAULTS, BROWSERS, TITLE_WORDS, parseBlocklist, matchTitle, closeBlockedTab, transferKey, TRANSFER_SETTINGS,
} = require('./extras');
const { paths, Settings, loadConfig, saveConfig, hooksLive, readJSON } = require('./settings');
const hooks = require('./hooks');

const GROUND = 34;
const SCALE_RANGE = [0.25, 4];
const isWindows = process.platform === 'win32';
const now = () => performance.now() / 1000;
const random = (lo, hi) => lo + Math.random() * (hi - lo);
const pick = (list) => list[Math.floor(Math.random() * list.length)];

const STATUS_COLORS = {
  needsYou: '#FF9500', error: '#FF3B30', oops: '#FF3B30', done: '#34C759', thinking: '#AF52DE', typing: '#007AFF',
  reading: '#30B0C7', searching: '#30B0C7', delegating: '#5856D6', tidying: '#8E8E93', idle: '#8E8E93',
};

/** What the foreground app says about what you're doing. */
function categorize(appName) {
  const s = String(appName || '').toLowerCase();
  const has = (keys) => keys.some((k) => s.includes(k));
  if (has(['spotify', 'music', 'tidal', 'deezer', 'soundcloud', 'podcasts'])) return 'music';
  if (has(['zoom', 'webex', 'facetime'])) return 'meeting';
  if (has(['code', 'terminal', 'powershell', 'cmd', 'iterm', 'kiro', 't3', 'devenv', 'idea', 'pycharm', 'jetbrains', 'cursor',
    'ghostty', 'warp', 'zed', 'sublime', 'alacritty', 'wezterm', 'xcode'])) return 'code';
  if (has(['chrome', 'msedge', 'firefox', 'brave', 'opera', 'safari', 'arc'])) return 'browser';
  if (has(['slack', 'chime', 'outlook', 'olk', 'teams', 'discord', 'mail', 'whatsapp', 'telegram'])) return 'chat';
  return 'other';
}

const REMARKS = {
  music: ['🎵 ooh, tunes!', 'dance break? 💃', 'turn it up! 🎶'],
  code: ["let's build something! 💻", 'coding time ⌨️', 'go go go! 🚀'],
  browser: ['whatcha looking up? 🔎', 'find anything cool?'],
  chat: ['say hi for me 👋', 'ooh, gossip? 👀'],
  meeting: ["🤫 I'll be quiet", 'good luck in your meeting!'],
  other: [],
};

const ACTIVITY_MOOD = {
  idle: 'idle', done: 'done', tidying: 'tidying', thinking: 'thinking', reading: 'reading', searching: 'searching',
  delegating: 'delegating', typing: 'typing', oops: 'oops', error: 'error', needsYou: 'needsYou',
};

class Pet {
  constructor() {
    this.settings = new Settings();
    this.config = loadConfig();
    this.agents = new AgentMonitor();
    this.size = { width: 260, height: 220 };
    this.scale = 1;
    this.mood = 'idle';
    this.sessions = [];
    this.known = new Map();
    this.busySince = new Map();
    this.transient = null;
    this.speech = null;
    this.accessory = 'none';
    this.night = false;
    this.walkTarget = null;
    this.walkDirection = 1;
    this.nextWalkAt = now() + 25;
    this.velocity = null;
    this.spin = 0;
    this.bounces = 0;
    this.lastBumpRemark = 0;
    this.wasAsleep = false;
    this.lastRemark = 0;
    this.lastNightNag = -10000;
    this.streakStart = now();
    this.lastLogic = 0;
    this.lastTick = now();
    this.geometry = null;
    this.press = null;
    this.resizeDrag = null;
    this.resizing = false;
    this.ignoringMouse = true;
    this.cursor = screen.getCursorScreenPoint();
    this.lastCursorMove = now();
    this.pack = null; // { name, height } once the renderer has loaded a sprite pack
    this.packFingerprint = 0;
    this.lastPackCheck = 0;

    this.stats = new Stats();
    this.focus = new FocusTimer();
    this.updater = new Updater(app.getVersion());
    this.tokens = new TranscriptTokens();
    this.platforms = new WindowPlatforms(screen);
    this.perch = null; // { id, rect } of the window the pet stands on
    this.hoverBegan = null;
    this.hoverLeftAt = null;
    this.cardSize = { width: 282, height: 160 };
    this.lastMinute = now();
    this.lastStatsSave = 0;
    this.lastKiroCheck = 0;
    this.updateAnnounced = false;
    this.xpPopup = null;
    this.lastBrowserCheck = 0;
    this.lastBlockNag = 0;
  }

  // MARK: Settings

  get wander() { return this.settings.get('wander', true); }
  set wander(v) { this.settings.set('wander', v); }
  get gravity() { return this.settings.get('gravity', true); }
  set gravity(v) { this.settings.set('gravity', v); }
  get spritePackName() { return this.settings.get('spritePack', this.config.spritePack); }
  set spritePackName(v) { this.settings.set('spritePack', v); }
  get themeHex() { return this.settings.get('themeColor', this.config.themeColor); }
  set themeHex(v) { this.settings.set('themeColor', v); }
  get thoughtBubble() { return this.settings.get('thoughtBubble', 'large'); }
  set thoughtBubble(v) { this.settings.set('thoughtBubble', v); }
  get scaleKey() { return `scale.${this.spritePackName || 'cat'}`; }
  get notificationsOn() { return this.settings.get('notifications', true); }
  get soundsOn() { return this.settings.get('sounds', true); }
  get walkOnWindows() { return this.settings.get('walkOnWindows', true); }
  get quietInCalls() { return this.settings.get('quietInCalls', true); }
  get autoUpdate() { return this.settings.get('autoUpdate', true); }
  get kiroHooksOn() { return this.settings.get('kiroHooks', false); }
  get blocklist() { return this.settings.get('blocklist', BLOCK_DEFAULTS); }
  get blockDuringFocus() { return this.settings.get('blockDuringFocus', true); }
  get strictBlock() { return this.settings.get('strictBlock', false); }
  toggle(key, fallback) { this.settings.set(key, !this.settings.get(key, fallback)); }
  /** On a call: no sounds and no chatty remarks. */
  get quiet() { return this.quietInCalls && this.agents.inCall; }

  get topSession() {
    return this.sessions.reduce((best, s) => (!best || PRIORITY.indexOf(s.activity) > PRIORITY.indexOf(best.activity) ? s : best), null);
  }

  // MARK: Lifecycle

  start() {
    fs.mkdirSync(paths.sprites, { recursive: true });
    this.createWindow();
    this.createTray();
    this.agents.onForeground = (name) => this.appActivated(name);
    this.agents.start();
    powerMonitor.on('resume', () => this.welcomeBack());
    powerMonitor.on('unlock-screen', () => this.welcomeBack());
    this.timer = setInterval(() => this.tick(), 1000 / 30);
    if (this.settings.get('setupComplete', false)) this.say(`hi ${this.config.ownerName}! 👋`, 4);
    else this.openWizard();

    if (isWindows) app.setAppUserModelId('local.deskpet');
    this.platforms.start();
    this.createCard();
    // Keep installed hook scripts current after updates.
    if (isWindows && (hooks.installed() || this.kiroHooksOn)) {
      try { fs.writeFileSync(paths.hookScript, fs.readFileSync(path.join(__dirname, 'hook.ps1'))); } catch (_) { /* best effort */ }
    }
    if (this.kiroHooksOn) kiroHooks.apply(true);
    setTimeout(() => this.wearEarnedRewardsOnce(), 6000);
    if (this.autoUpdate) setTimeout(() => this.checkForUpdates(false), 20000);
    setInterval(() => { if (this.autoUpdate) this.checkForUpdates(false); }, 6 * 3600 * 1000);
  }

  createWindow() {
    const saved = this.settings.get('position', null);
    const wa = screen.getPrimaryDisplay().workArea;
    let x = wa.x + wa.width - this.size.width - 60;
    let y = wa.y + wa.height - this.size.height;
    if (saved && screen.getAllDisplays().some((d) => pointIn(d.bounds, saved.x + this.size.width / 2, saved.y + this.size.height - GROUND))) {
      ({ x, y } = saved);
    }
    this.win = new BrowserWindow({
      x, y, width: this.size.width, height: this.size.height,
      transparent: true, frame: false, resizable: false, movable: false, hasShadow: false, skipTaskbar: true,
      alwaysOnTop: true, focusable: false, fullscreenable: false, show: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' },
    });
    this.win.setAlwaysOnTop(true, 'floating');
    if (!isWindows) this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setIgnoreMouseEvents(true);
    this.win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
    this.win.once('ready-to-show', () => {
      this.win.showInactive();
      this.loadSprites(false);
    });
    this.pos = { x, bottom: y + this.size.height };
  }

  createTray() {
    const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'tray.png'));
    this.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
    this.tray.setToolTip('DeskPet');
    const open = () => this.tray.popUpContextMenu(this.buildMenu());
    this.tray.on('click', open);
    this.tray.on('right-click', open);
  }

  // MARK: Main loop

  tick() {
    const t = now();
    const dt = Math.min(0.1, t - this.lastTick);
    this.lastTick = t;

    const c = screen.getCursorScreenPoint();
    if (c.x !== this.cursor.x || c.y !== this.cursor.y) this.lastCursorMove = t;
    this.cursor = c;

    if (t - this.lastLogic >= 0.25) {
      this.lastLogic = t;
      this.think(t);
    }
    this.handlePointer(t);
    this.move(dt, t);
    this.updateMousePassThrough();
    this.updateCard(t);
    if (!this.win.isDestroyed()) this.win.webContents.send('pose', this.pose(t));
  }

  think(t) {
    if (this.spritePackName && t - this.lastPackCheck > 2) {
      this.lastPackCheck = t;
      if (packFingerprint(this.spritePackName) !== this.packFingerprint) this.loadSprites(true);
    }
    this.sessions = this.agents.sessions();
    if (this.agents.scanCount > 0) this.handleAgentChanges(t);

    const idle = powerMonitor.getSystemIdleTime();
    // There's no cross-platform keyboard API without extra permissions: input in the last
    // second while the mouse sat still is almost certainly typing.
    const sinceKey = idle < 1 && t - this.lastCursorMove > 1 ? 0 : 99;

    if (this.wasAsleep && idle < 1) {
      this.wasAsleep = false;
      this.transient = { mood: 'startled', until: t + 1.2 };
      this.say('huh?! oh, hi! 😳', 3);
      this.playSound('wake');
    }
    const top = this.topSession;
    if (idle > 240 && (!top || top.activity === 'idle')) this.wasAsleep = true;

    if (idle > 300) this.streakStart = t;
    else if (t - this.streakStart > 50 * 60) {
      this.streakStart = t;
      if (!this.quiet && this.focus.phase === 'off') this.say('50 minutes straight — stretch break? 🙆', 6);
    }

    const hour = new Date().getHours();
    this.night = hour >= 23 || hour < 6;
    if (this.night && idle < 5 && t - this.lastNightNag > 3600 && !this.quiet) {
      this.lastNightNag = t;
      this.say(`it's late, ${this.config.ownerName}… bedtime soon? 🌙`, 5);
    }

    const finished = this.focus.tick();
    if (finished === 'focus') {
      this.transient = { mood: 'done', until: t + 3 };
      this.say('focus session done! take a break ☕', 5);
      this.playSound('focus-done');
      this.notify('Focus session done', `Take a ${Math.max(5, Math.round(this.focus.minutes / 5))} minute break ☕`, 0);
      this.gainXP(15, false, (d) => { d.focusSessions++; });
    } else if (finished === 'rest') {
      this.say("break's over! ready for another round? 💪", 5);
      this.notify("Break's over", 'Ready for another focus session?', 0);
    }
    if (this.focus.phase === 'focus' && this.blockDuringFocus && this.blocklist.length && t - this.lastBrowserCheck > 2) {
      this.lastBrowserCheck = t;
      this.checkForDistraction(t);
    }
    if (t - this.lastMinute >= 60) {
      this.lastMinute = t;
      const busy = this.sessions.some((s) => s.activity !== 'idle' && s.activity !== 'done');
      // Hanging out counts too: +1 XP for every 5 minutes the pet is open.
      const openMinutes = (this.stats.today.openMinutes || 0) + 1;
      this.gainXP((busy ? 1 : 0) + (openMinutes % 5 === 0 ? 1 : 0), false, (d) => {
        d.openMinutes = openMinutes;
        if (idle < 60) d.activeMinutes++;
        if (busy) d.agentMinutes++;
      });
    }
    if (!this.stats.today.greeted) {
      this.gainXP(10, false, (d) => { d.greeted = true; });
      this.say('daily hello! +10 XP ☀️', 3);
    }
    if (t - this.lastStatsSave > 30) { this.lastStatsSave = t; this.stats.saveIfNeeded(); }
    if (this.kiroHooksOn && t - this.lastKiroCheck > 600) {
      this.lastKiroCheck = t;
      kiroHooks.apply(true); // tools like `aim` regenerate Kiro agent files
    }
    if (this.perch && !this.walkOnWindows) this.dropFromPerch();

    this.mood = this.resolveMood(t, idle, sinceKey);
    if (this.mood === 'idle' && this.wander && this.win.isVisible() && t > this.nextWalkAt && !this.velocity && !this.resizing) this.startWalk(t);
  }

  resolveMood(t, idle, sinceKey) {
    if (this.resizing) return this.press && this.press.dragging ? 'dragged' : 'idle';
    if (this.press && this.press.dragging) return 'dragged';
    if (this.velocity) return 'flying';
    if (this.transient && this.transient.until > t) return this.transient.mood;
    const top = this.topSession;
    if (top && top.activity !== 'idle') return ACTIVITY_MOOD[top.activity];
    if (idle > 240) return 'sleeping';
    if (idle > 75) return 'sleepy';
    if (this.walkTarget !== null) return 'walking';
    if (sinceKey < 1.2) return 'userTyping';
    return 'idle';
  }

  handleAgentChanges(t) {
    const firstPass = this.known.size === 0 && this.busySince.size === 0 && !this.agentsSeen;
    this.agentsSeen = true;
    const current = new Map();
    for (const s of this.sessions) {
      current.set(s.id, { name: s.name, activity: s.activity });
      const previous = this.known.get(s.id);
      const wasBusy = previous ? previous.activity !== 'idle' : false;
      if (s.activity !== 'idle' && !wasBusy) this.busySince.set(s.id, t);
      if (firstPass) continue;
      if (!previous) { this.say(`${s.name} showed up 👀`, 3.5); continue; }
      if (previous.activity === s.activity) continue;
      const project = s.project || s.name;
      if (s.activity === 'done') {
        this.say(`${s.name} is done! ✨`, 4);
        this.taskFinished(s, project);
      } else if (s.activity === 'needsYou') {
        this.say(`${s.name} needs you! 🙋`, 5);
        this.playSound('needs-you');
        this.notifyUnlessWatching(s, `${s.name} needs you`, `${project}: ${s.detail}`);
      } else if (s.activity === 'error') {
        this.say(`uh oh, ${s.name} hit an error 😵`, 4);
        this.notifyUnlessWatching(s, `${s.name} hit an error`, project);
      } else if (s.activity === 'idle' && !s.precise && t - (this.busySince.get(s.id) || t) > 15) {
        this.say(`${s.name} looks done ✨`, 4);
        this.transient = { mood: 'done', until: t + 3 };
        this.taskFinished(s, project);
      }
    }
    if (!firstPass) for (const [id, old] of this.known) if (!current.has(id)) this.say(`bye, ${old.name}! 👋`, 3);
    for (const id of this.busySince.keys()) if (!current.has(id)) this.busySince.delete(id);
    this.known = current;
  }

  pose(t) {
    const p = {
      mood: this.mood, accessory: this.accessory, nightcap: this.night, facingLeft: this.walkDirection < 0,
      look: this.lookVector(), spin: this.spin, subagents: 0, scale: this.scale, resizing: this.resizing,
      theme: this.themeHex || null, thoughtBubble: this.thoughtBubble, caption: null, captionColor: null, bubble: null,
    };
    const top = this.topSession;
    if (top && top.activity !== 'idle') {
      const others = this.sessions.filter((s) => s.activity !== 'idle').length - 1;
      p.caption = `${top.name}: ${top.detail}${others > 0 ? `  +${others}` : ''}`;
      p.captionColor = STATUS_COLORS[top.activity];
      p.subagents = top.subagents;
    }
    if (!p.caption && this.focus.phase !== 'off') {
      p.caption = this.focus.label;
      p.captionColor = this.focus.phase === 'focus' ? '#FF3B30' : '#A2845E';
    }
    if (this.speech && this.speech.until > t) p.bubble = this.speech.text;
    if (this.xpPopup && t - this.xpPopup.at < 1.4) { p.xpText = `+${this.xpPopup.amount} XP`; p.xpAge = t - this.xpPopup.at; }
    for (const r of REWARDS) {
      if (this.stats.level < r.level || !this.wearing(r)) continue;
      if (r.key === 'hat') p.hat = r.value;
      else if (r.key === 'trail') p.trail = r.value;
      else p[r.key] = true;
    }
    return p;
  }

  lookVector() {
    if (!this.geometry) return { x: 0, y: 0 };
    const b = this.win.getBounds();
    const eye = { x: b.x + this.geometry.eye.x, y: b.y + b.height - this.geometry.eye.y };
    const dx = this.cursor.x - eye.x, dy = eye.y - this.cursor.y; // y-up
    const d = Math.hypot(dx, dy);
    if (d < 1) return { x: 0, y: 0 };
    const f = Math.min(1, d / 150);
    return { x: (dx / d) * f, y: (dy / d) * f };
  }

  /** Cursor position in window coordinates with y up (the renderer's space). */
  localCursor() {
    const b = this.win.getBounds();
    return { x: this.cursor.x - b.x, y: b.height - (this.cursor.y - b.y) };
  }

  /** Clicks only land on the pet itself; the rest of the window is click-through. */
  updateMousePassThrough() {
    if (!this.geometry) return;
    const p = this.localCursor();
    const r = this.geometry.hitRect;
    const over = !!this.press || !!this.resizeDrag || (p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height);
    if (over === this.ignoringMouse) {
      this.ignoringMouse = !over;
      this.win.setIgnoreMouseEvents(!over);
    }
  }

  // MARK: Pointer (the renderer reports press/release; the cursor is polled here)

  onPress() {
    const b = this.win.getBounds();
    this.press = { cursor: { ...this.cursor }, origin: { x: b.x, y: b.y }, dragging: false, samples: [] };
  }

  onRelease() {
    if (this.resizeDrag) {
      this.resizeDrag = null;
      this.settings.set(this.scaleKey, this.scale);
      return;
    }
    const press = this.press;
    this.press = null;
    if (!press) return;
    if (press.dragging) this.dragEnded(this.releaseVelocity(press.samples));
    else this.tapped();
  }

  onResizeStart() {
    const b = this.win.getBounds();
    // Scale by how far the handle moves from the feet, which stay put.
    const anchor = { x: b.x + b.width / 2, y: b.y + b.height - GROUND };
    this.resizeDrag = { anchor, startDistance: Math.max(10, Math.hypot(this.cursor.x - anchor.x, this.cursor.y - anchor.y)), startScale: this.scale };
  }

  handlePointer(t) {
    if (this.resizeDrag) {
      const r = this.resizeDrag;
      const raw = (r.startScale * Math.hypot(this.cursor.x - r.anchor.x, this.cursor.y - r.anchor.y)) / r.startDistance;
      const s = Math.min(SCALE_RANGE[1], Math.max(SCALE_RANGE[0], Math.round(raw * 100) / 100));
      if (s !== this.scale) this.setScale(s);
      return;
    }
    const press = this.press;
    if (!press) return;
    const dx = this.cursor.x - press.cursor.x, dy = this.cursor.y - press.cursor.y;
    if (!press.dragging && Math.hypot(dx, dy) > 3) {
      press.dragging = true;
      this.dragBegan();
    }
    if (press.dragging) {
      const b = this.win.getBounds();
      this.win.setPosition(Math.round(press.origin.x + dx), Math.round(press.origin.y + dy));
      this.pos = { x: press.origin.x + dx, bottom: press.origin.y + dy + b.height };
      const last = press.samples[press.samples.length - 1];
      if (!last || last.x !== this.cursor.x || last.y !== this.cursor.y) press.samples.push({ t, x: this.cursor.x, y: this.cursor.y });
      press.samples = press.samples.filter((s) => t - s.t <= 0.12);
    }
  }

  /** Mouse speed over the last ~0.1s of the drag (y-up); zero if the mouse had stopped before release. */
  releaseVelocity(samples) {
    const first = samples[0], last = samples[samples.length - 1];
    if (!first || !last || last.t - first.t < 0.01 || now() - last.t > 0.08) return { x: 0, y: 0 };
    const dt = last.t - first.t;
    return { x: (last.x - first.x) / dt, y: -(last.y - first.y) / dt };
  }

  // MARK: Movement

  display() {
    const b = this.win.getBounds();
    return screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height - GROUND - 40) });
  }

  startWalk(t) {
    this.nextWalkAt = t + random(20, 60);
    const wa = this.display().workArea;
    let lo = wa.x - 40, hi = wa.x + wa.width - this.size.width + 40;
    if (this.perch) {
      // Stay on the window we're standing on.
      lo = this.perch.rect.x + 24 - this.size.width / 2;
      hi = this.perch.rect.x + this.perch.rect.width - 24 - this.size.width / 2;
      if (hi - lo < 60) return;
    }
    const target = random(lo, hi);
    if (Math.abs(target - this.win.getBounds().x) > 60) this.walkTarget = target;
  }

  /** Follows the window we're standing on, and falls when it closes, minimizes, or slides away. */
  followPerch() {
    if (!this.perch || this.velocity || this.press) return;
    const w = this.platforms.platforms.find((p) => p.id === this.perch.id);
    if (!w) return this.dropFromPerch();
    const dx = w.rect.x - this.perch.rect.x;
    const bottom = w.rect.y + GROUND;
    if (dx !== 0 || Math.abs(this.pos.bottom - bottom) > 0.5) {
      this.pos.x += dx;
      this.pos.bottom = bottom;
      if (this.walkTarget !== null) this.walkTarget += dx;
      this.applyPosition();
    }
    this.perch = { id: w.id, rect: w.rect };
    const center = this.pos.x + this.size.width / 2;
    if (center < w.rect.x + 4 || center > w.rect.x + w.rect.width - 4) this.dropFromPerch();
  }

  dropFromPerch() {
    this.perch = null;
    this.walkTarget = null;
    if (this.gravity) this.velocity = { x: 0, y: 0 };
  }

  move(dt, t) {
    if (this.velocity) return this.simulateThrow(dt, t);
    this.followPerch();
    if (this.walkTarget === null) return;
    if ((this.mood !== 'walking' && this.mood !== 'idle') || this.press) { this.walkTarget = null; return; }
    this.walkDirection = this.walkTarget > this.pos.x ? 1 : -1;
    const step = 45 * dt;
    if (Math.abs(this.walkTarget - this.pos.x) <= step) {
      this.pos.x = this.walkTarget;
      this.walkTarget = null;
    } else {
      this.pos.x += this.walkDirection * step;
    }
    this.applyPosition();
    if (this.walkTarget === null) this.savePosition();
  }

  /** One physics step: gravity (optional), air drag, and bounces off the edges of the screen. */
  simulateThrow(dt, t) {
    const v = this.velocity;
    const wa = this.display().workArea;
    const body = this.geometry ? this.geometry.bodyExtent : { halfWidth: 46, height: 84 };
    const w = this.size.width;
    const minX = wa.x - (w / 2 - body.halfWidth);
    const maxX = wa.x + wa.width - (w / 2 + body.halfWidth);
    let floor = wa.y + wa.height;
    const ceiling = wa.y + GROUND + body.height; // smallest allowed window bottom
    const bounciness = 0.72;
    // Window tops count as floors when walking on windows is on.
    let landing = null;
    if (this.gravity && this.walkOnWindows) {
      landing = this.platforms.landing(this.pos.bottom - GROUND, this.pos.x + w / 2, wa, body.height);
      if (landing) floor = Math.min(floor, landing.rect.y + GROUND);
    }

    if (this.gravity) v.y -= 2000 * dt;
    const drag = Math.pow(this.gravity ? 0.9 : 0.45, dt);
    v.x *= drag;
    if (!this.gravity) v.y *= drag;
    this.pos.x += v.x * dt;
    this.pos.bottom -= v.y * dt;

    let impact = 0;
    let onFloor = false;
    if (this.pos.x < minX) { this.pos.x = minX; impact = Math.max(impact, Math.abs(v.x)); v.x = Math.abs(v.x) * bounciness; }
    if (this.pos.x > maxX) { this.pos.x = maxX; impact = Math.max(impact, Math.abs(v.x)); v.x = -Math.abs(v.x) * bounciness; }
    if (this.pos.bottom < ceiling) { this.pos.bottom = ceiling; impact = Math.max(impact, Math.abs(v.y)); v.y = -Math.abs(v.y) * bounciness; }
    if (this.pos.bottom > floor) {
      this.pos.bottom = floor;
      onFloor = true;
      impact = Math.max(impact, Math.abs(v.y));
      v.y = Math.abs(v.y) * bounciness;
      if (v.y < 140) v.y = 0; // too weak to bounce again: slide to a stop
      v.x *= 0.8;
    }
    if (impact > 300) this.playSound('bounce');
    if (impact > 700) {
      this.bounces++;
      if (t - this.lastBumpRemark > 0.7) {
        this.lastBumpRemark = t;
        this.say(pick(['boing!', 'oof!', 'whoa!', 'wheee!', 'ow ow ow']), 0.9);
      }
    }
    this.spin -= (v.x * dt) / 40;
    this.applyPosition();

    const resting = this.gravity ? onFloor && v.y === 0 && Math.abs(v.x) < 15 : Math.hypot(v.x, v.y) < 20;
    if (!resting) return;
    this.velocity = null;
    this.spin = 0;
    this.perch = landing && Math.abs(this.pos.bottom - floor) < 1 ? { id: landing.id, rect: landing.rect } : null;
    this.savePosition();
    if (this.perch) this.gainXP(2, true);
    if (this.bounces >= 3) {
      this.gainXP(5, true);
      this.transient = { mood: 'dizzy', until: t + 2.5 };
      this.say(pick(['@_@ the room is spinning…', 'again! again!', 'I saw stars 💫']), 2.5);
    } else {
      this.transient = { mood: 'startled', until: t + 0.6 };
    }
    this.bounces = 0;
  }

  applyPosition() {
    this.win.setPosition(Math.round(this.pos.x), Math.round(this.pos.bottom - this.size.height));
  }

  savePosition() {
    const b = this.win.getBounds();
    this.pos = { x: b.x, bottom: b.y + b.height };
    this.settings.set('position', { x: b.x, y: b.y });
  }

  // MARK: Reactions

  say(text, seconds) { this.speech = { text, until: now() + seconds }; }

  welcomeBack() {
    this.transient = { mood: 'startled', until: now() + 1.2 };
    this.say('welcome back! ☀️', 4);
  }

  appActivated(name) {
    const category = categorize(name);
    this.accessory = category === 'music' ? 'headphones' : category === 'code' ? 'glasses' : 'none';
    const t = now();
    const top = this.topSession;
    const remarks = REMARKS[category];
    if (this.quiet || this.focus.phase !== 'off' || !remarks.length || t - this.lastRemark < 45 || Math.random() > 0.4 || (top && top.activity !== 'idle')) return;
    this.lastRemark = t;
    this.say(pick(remarks), 3);
  }

  tapped() {
    const t = now();
    this.walkTarget = null;
    const top = this.topSession;
    // When an agent wants attention, a click takes you to it.
    if (top && ['needsYou', 'done', 'error', 'oops'].includes(top.activity) && top.pid) {
      this.transient = { mood: 'petted', until: t + 1 };
      this.jump(top.pid).then((ok) => this.say(ok ? `taking you to ${top.name} 👉` : `go check on ${top.name}! 👉`, 2.5));
      return;
    }
    this.playSound('pet');
    this.gainXP(2, true, (d) => { d.pets++; });
    if (top && top.activity !== 'idle' && top.activity !== 'done') {
      this.transient = { mood: 'petted', until: t + 1 };
      this.say(top.activity === 'needsYou' ? `go check on ${top.name}! 👉` : `shh, ${top.name} is working 🤫`, 2.5);
    } else {
      this.transient = { mood: 'petted', until: t + 2.2 };
      this.say(pick(['purr~ 💕', 'hehe', 'more pets pls', '♥︎', `you're the best, ${this.config.ownerName}!`]), 2.2);
    }
  }

  dragBegan() {
    if (this.velocity) {
      this.gainXP(3, true);
      this.say('nice catch! 🙌', 1.5);
    }
    this.walkTarget = null;
    this.perch = null;
    this.hideCard();
    this.velocity = null;
    this.spin = 0;
    this.bounces = 0;
    if (!this.resizing) this.say('wheee!', 1.5);
  }

  dragEnded(v) {
    if (this.resizing) return this.savePosition();
    const speed = Math.hypot(v.x, v.y);
    const b = this.win.getBounds();
    const floor = this.display().workArea.y + this.display().workArea.height;
    this.pos = { x: b.x, bottom: b.y + b.height };
    if (speed <= 60 && !(this.gravity && this.pos.bottom < floor - 2)) return this.savePosition();
    const limit = 4000;
    const k = speed > limit ? limit / speed : 1;
    this.velocity = { x: v.x * k, y: v.y * k };
    if (speed > 1200) this.say('yeeeet! 🚀', 1.2);
    if (speed > 400) this.gainXP(3, true, (d) => { d.throwsCount++; });
  }

  // MARK: Size & sprites

  setScale(s) {
    this.scale = s;
    this.layoutWindow();
  }

  /** Sizes the window for the character and scale, keeping the pet's feet where they were. */
  layoutWindow() {
    const k = this.pack ? Math.min(1.8, Math.max(0.7, this.pack.height / 82)) : 1;
    const base = { width: Math.max(260, 2 * 95 * k + 20), height: Math.max(220, GROUND + 140 * k + 14) };
    const s = this.scale;
    const width = Math.round(Math.max(250, base.width * s));
    const height = Math.round(GROUND + (base.height - GROUND) * s + 40);
    const b = this.win.getBounds();
    const centerX = b.x + b.width / 2, bottom = b.y + b.height;
    this.size = { width, height };
    this.win.setBounds({ x: Math.round(centerX - width / 2), y: Math.round(bottom - height), width, height });
    this.pos = { x: centerX - width / 2, bottom };
  }

  loadSprites(announce) {
    const name = this.spritePackName;
    this.scale = this.settings.get(this.scaleKey, 1);
    if (!name) {
      this.pack = null;
      this.packFingerprint = 0;
      this.win.webContents.send('pack', null);
      this.layoutWindow();
      return;
    }
    const dir = path.join(paths.sprites, name);
    this.packFingerprint = packFingerprint(name);
    const options = readJSON(path.join(dir, 'pack.json'), {});
    let files = [];
    let sounds = [];
    try {
      files = fs.readdirSync(dir)
        .filter((f) => /\.(png|gif|webp|jpe?g)$/i.test(f))
        .map((f) => ({ name: f, data: fs.readFileSync(path.join(dir, f)) }));
      const soundDir = path.join(dir, 'sounds');
      if (fs.existsSync(soundDir)) {
        sounds = fs.readdirSync(soundDir).filter((f) => /\.(wav|mp3|ogg|m4a)$/i.test(f))
          .map((f) => ({ event: path.basename(f, path.extname(f)), data: fs.readFileSync(path.join(soundDir, f)) }));
      }
    } catch (_) { /* missing folder: the renderer reports "no idle image" */ }
    this.pendingAnnounce = announce;
    this.pack = { name, height: Math.min(220, Math.max(40, options.height || 120)) };
    this.layoutWindow();
    this.win.webContents.send('pack', { name, options, files, sounds });
  }

  onPackLoaded(result) {
    if (result.ok) {
      if (this.pendingAnnounce) this.say('new look! ✨', 2);
    } else {
      this.pack = null;
      this.layoutWindow();
      this.say(`couldn't load sprites: ${result.error}`, 6);
    }
  }

  // MARK: Menu

  buildMenu() {
    const pct = Math.round(this.scale * 100);
    const today = this.todaySummary();
    const agentItems = this.sessions.length
      ? [...this.sessions].sort((a, b) => PRIORITY.indexOf(b.activity) - PRIORITY.indexOf(a.activity)).map((s) => ({
        label: `${s.activity === 'idle' ? '○' : '●'} ${s.name}${s.project ? ` (${s.project})` : ''} — ${s.detail}${s.precise ? '' : ' · guessed from CPU'}`,
        enabled: !!s.pid && isWindows,
        click: () => this.jump(s.pid).then((ok) => { if (!ok) this.say("couldn't find that window 🤔", 2.5); }),
      }))
      : [{ label: 'No AI agents running', enabled: false }];
    const packs = listPacks();
    const check = (label, key, fallback, after) => ({
      label, type: 'checkbox', checked: this.settings.get(key, fallback),
      click: () => { this.toggle(key, fallback); if (after) after(); },
    });
    const template = [
      { label: `${this.config.petName} · Lv ${this.stats.level} — ${this.mood}`, enabled: false },
      { label: `Today: ${today}`, enabled: false },
      ...(this.quiet ? [{ label: '🤫 Quiet: a mic or camera is in use', enabled: false }] : []),
      { type: 'separator' },
      ...agentItems,
      { type: 'separator' },
      {
        label: this.focus.phase === 'off' ? 'Focus timer' : this.focus.label,
        submenu: [
          ...[15, 25, 50].map((m) => ({ label: `Focus for ${m} minutes`, click: () => this.startFocus(m) })),
          ...(this.focus.phase !== 'off' ? [{ label: 'Stop timer', click: () => this.focus.stop() }] : []),
          { type: 'separator' },
          check('Block distracting sites', 'blockDuringFocus', true),
          check('Strict: close blocked tabs', 'strictBlock', false),
          { label: `Edit blocklist… (${this.blocklist.length})`, click: () => this.openDialog('blocklist.html', {}, { width: 420, height: 440 }) },
        ],
      },
      { label: `Bring ${this.config.petName} here`, click: () => this.bringHere() },
      { label: 'Rename…', click: () => this.openDialog('rename.html', {}, { width: 360, height: 270 }) },
      { label: `Rewards (Lv ${this.stats.level})`, submenu: this.rewardsMenu() },
      {
        label: `Size (${pct}%)`,
        submenu: [
          { label: this.resizing ? 'Finish resizing' : 'Resize…', click: () => this.toggleResizing() },
          { type: 'separator' },
          ...[50, 75, 100, 125, 150, 200, 300].map((p) => ({
            label: `${p}%`, type: 'checkbox', checked: pct === p,
            click: () => { this.setScale(p / 100); this.settings.set(this.scaleKey, this.scale); },
          })),
        ],
      },
      {
        label: 'Thought bubble',
        submenu: [['Large', 'large'], ['Small', 'small'], ['Off', 'off']].map(([label, value]) => ({
          label, type: 'checkbox', checked: this.thoughtBubble === value, click: () => { this.thoughtBubble = value; },
        })),
      },
      { label: this.themeHex ? `Theme color (${this.themeHex})…` : 'Theme color…', click: () => this.chooseTheme() },
      {
        label: 'Sprites',
        submenu: [
          { label: 'Built-in cat', type: 'checkbox', checked: !this.spritePackName, click: () => this.chooseSprites('') },
          ...packs.map((p) => ({ label: p, type: 'checkbox', checked: this.spritePackName === p, click: () => this.chooseSprites(p) })),
          { type: 'separator' },
          { label: 'Import pack…', click: () => this.importPackDialog() },
          ...(this.spritePackName ? [{ label: `Export ${this.spritePackName}…`, click: () => this.exportPackDialog() }] : []),
          { label: 'Preview poses', click: () => this.previewPoses() },
          { label: 'Reload sprites', click: () => this.loadSprites(true) },
          { label: 'Open sprites folder', click: () => shell.openPath(paths.sprites) },
        ],
      },
      {
        label: 'Behavior',
        submenu: [
          check('Wander around', 'wander', true, () => { this.walkTarget = null; }),
          check('Gravity', 'gravity', true),
          check('Walk on windows', 'walkOnWindows', true),
          check('Quiet during calls', 'quietInCalls', true),
          { type: 'separator' },
          check('Notifications', 'notifications', true),
          check('Sounds', 'sounds', true),
        ],
      },
      {
        label: 'Agents',
        submenu: [
          ...(isWindows ? [{ label: 'Claude Code hooks', type: 'checkbox', checked: hooks.installed(), click: () => this.toggleHooks(!hooks.installed()) }] : []),
          ...(isWindows ? [{ label: 'Kiro CLI hooks', type: 'checkbox', checked: this.kiroHooksOn, click: () => this.setKiroHooks(!this.kiroHooksOn) }] : []),
          { label: 'Codex: automatic (reads its session log)', enabled: false },
        ],
      },
      { type: 'separator' },
      { label: this.win.isVisible() ? `Hide ${this.config.petName}` : `Show ${this.config.petName}`, click: () => this.toggleVisible() },
      { label: 'Setup…', click: () => this.openWizard() },
      {
        label: 'Move to another device',
        submenu: [
          { label: 'Export transfer key…', click: () => this.openDialog('transfer.html', { tab: 'export' }) },
          { label: 'Import transfer key…', click: () => this.openDialog('transfer.html', { tab: 'import' }) },
        ],
      },
      this.updater.available
        ? { label: `Update to v${this.updater.available.version}…`, click: () => this.installUpdate() }
        : { label: 'Check for updates…', click: () => this.checkForUpdates(true) },
      check('Automatic updates', 'autoUpdate', true),
    ];
    if (isWindows) {
      template.push({ label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) });
    }
    template.push({ type: 'separator' }, { label: 'Quit DeskPet', click: () => quitApp() });
    return Menu.buildFromTemplate(template);
  }

  // MARK: Attention, sounds, stats

  playSound(event) {
    if (this.soundsOn && !this.quiet && !this.win.isDestroyed()) this.win.webContents.send('sound', event);
  }

  jump(pid) {
    this.hideCard();
    return jumpTo(pid, this.agents.parents);
  }

  notify(title, body, pid) {
    if (!this.notificationsOn || !Notification.isSupported()) return;
    const n = new Notification({ title, body, silent: true, icon: path.join(__dirname, '..', 'assets', 'icon.png') });
    if (pid) n.on('click', () => this.jump(pid));
    n.show();
  }

  /** Notifies unless you're already looking at the app the agent runs in. */
  notifyUnlessWatching(s, title, body) {
    const fg = this.agents.foregroundPid;
    for (let p = s.pid; p > 4 && fg; p = this.agents.parents.get(p) || 0) if (p === fg) return;
    this.notify(title, body, s.pid);
  }

  taskFinished(s, project) {
    this.playSound('done');
    this.notifyUnlessWatching(s, `${s.name} is done ✨`, project);
    this.gainXP(10, false, (d) => { d.tasks++; });
  }

  /** Awards XP (play XP is capped per day), shows "+N XP", and celebrates level-ups. */
  gainXP(amount, play = false, change = () => {}) {
    const xp = play ? Math.max(0, Math.min(amount, 100 - (this.stats.today.playXP || 0))) : amount;
    const level = this.stats.record(xp, (d) => {
      change(d);
      if (play) d.playXP = (d.playXP || 0) + xp;
    });
    if (xp > 0) {
      const t = now();
      const pending = this.xpPopup && t - this.xpPopup.at < 1.2 ? this.xpPopup.amount : 0;
      this.xpPopup = { amount: pending + xp, at: t };
    }
    this.levelUp(level);
  }

  levelUp(level) {
    if (!level) return;
    this.transient = { mood: 'done', until: now() + 3 };
    this.playSound('level-up');
    // New rewards are worn right away, so you see them.
    const fresh = REWARDS.filter((r) => r.level === level);
    for (const r of fresh) this.settings.set(r.key, r.value);
    if (fresh.length) {
      this.say(`level ${level}! unlocked ${fresh[0].title} ✨`, 5);
      this.notify(`Level ${level}!`, `${this.config.petName} unlocked ${fresh[0].title}. Change rewards in the tray menu.`, 0);
    } else {
      this.say(`level up! I'm level ${level} now ✨`, 4);
    }
  }

  wearing(r) { return this.settings.get(r.key, r.key === 'hat' || r.key === 'trail' ? '' : false) === r.value; }

  /** Wears rewards already earned before rewards existed, once. */
  wearEarnedRewardsOnce() {
    if (this.settings.get('rewardsIntroduced', false)) return;
    this.settings.set('rewardsIntroduced', true);
    const earned = REWARDS.filter((r) => r.level <= this.stats.level);
    if (!earned.length) return;
    const last = (key) => [...earned].reverse().find((r) => r.key === key);
    if (!this.settings.get('hat', '') && last('hat')) this.settings.set('hat', last('hat').value);
    if (!this.settings.get('trail', '') && last('trail')) this.settings.set('trail', last('trail').value);
    this.say(`you've unlocked ${earned.length} reward${earned.length === 1 ? '' : 's'}! see the tray menu → Rewards ✨`, 5);
  }

  rewardsMenu() {
    const level = this.stats.level;
    const next = REWARDS.find((r) => r.level > level);
    return [
      { label: next ? `Next: ${next.title} at Lv ${next.level} (${Stats.xpNeeded(next.level) - this.stats.xp} XP to go)` : 'Every reward unlocked! 🏆', enabled: false },
      ...(this.pack ? [{ label: 'Hats, scarf, and fur show on the built-in cat', enabled: false }] : []),
      { type: 'separator' },
      ...REWARDS.map((r) => ({
        label: level >= r.level ? r.title : `🔒 ${r.title} · Lv ${r.level}`, type: 'checkbox', enabled: level >= r.level,
        checked: level >= r.level && this.wearing(r),
        click: () => this.settings.set(r.key, typeof r.value === 'boolean' ? !this.wearing(r) : (this.wearing(r) ? '' : r.value)),
      })),
      { type: 'separator' },
      { label: 'No hat', type: 'checkbox', checked: !this.settings.get('hat', ''), click: () => this.settings.set('hat', '') },
      { label: 'No trail', type: 'checkbox', checked: !this.settings.get('trail', ''), click: () => this.settings.set('trail', '') },
    ];
  }

  applyNames(petName, ownerName) {
    const renamed = petName !== this.config.petName;
    saveConfig({ petName, ownerName });
    this.config = { ...this.config, petName, ownerName };
    this.transient = { mood: 'petted', until: now() + 2.5 };
    this.say(renamed ? `${petName}? I love it! 💕` : `got it, ${ownerName}! 👋`, 3);
  }

  todaySummary() {
    const d = this.stats.today;
    const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);
    const blocked = d.blocked ? ` · 🍅 ${d.blocked} blocked` : '';
    return `⌨️ ${hm(d.activeMinutes)} you · 🤖 ${hm(d.agentMinutes)} agents · ✅ ${d.tasks} task${d.tasks === 1 ? '' : 's'}${blocked}`;
  }

  // MARK: Hover card

  createCard() {
    this.card = new BrowserWindow({
      width: this.cardSize.width, height: this.cardSize.height, transparent: true, frame: false, resizable: false,
      skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false, hasShadow: false, backgroundColor: '#00000000',
      webPreferences: { preload: path.join(__dirname, 'preload-card.js') },
    });
    this.card.setAlwaysOnTop(true, 'floating');
    this.card.loadFile(path.join(__dirname, 'card', 'card.html'));
  }

  hideCard() {
    if (this.card && !this.card.isDestroyed() && this.card.isVisible()) this.card.hide();
  }

  cardModel(t) {
    const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);
    return {
      petName: this.config.petName, level: this.stats.level, progress: this.stats.progress, xpToNext: this.stats.xpToNext,
      today: this.todaySummary(), focus: this.focus.phase === 'off' ? '' : this.focus.label, quiet: this.quiet,
      nextReward: (() => { const n = REWARDS.find((r) => r.level > this.stats.level); return n ? `Next reward: ${n.title} at Lv ${n.level}` : '🏆 Every reward unlocked'; })(),
      accent: this.themeHex || '#FF9500',
      rows: [...this.sessions].sort((a, b) => PRIORITY.indexOf(b.activity) - PRIORITY.indexOf(a.activity)).map((s) => {
        const secs = Math.round(t - (this.busySince.get(s.id) || t));
        const usage = s.isCodex ? (codexState(s.logPath, true) || {}).tokens : this.tokens.usage(s.logPath);
        return {
          title: s.name + (s.project ? ` · ${s.project}` : ''), detail: s.detail + (s.precise ? '' : ' (guessed)'),
          color: STATUS_COLORS[s.activity], elapsed: s.activity === 'idle' ? 'idle' : secs >= 60 ? `${Math.floor(secs / 60)}m` : `${secs}s`,
          tokens: usage ? `${compact(usage.output)} out · ${compact(usage.context)} context` : '', pid: s.pid || 0,
        };
      }),
    };
  }

  /** Shows the card after hovering the pet for a moment; keeps it while the mouse is on the pet or the card. */
  updateCard(t) {
    if (!this.card || this.card.isDestroyed() || !this.geometry) return;
    const p = this.localCursor();
    const r = this.geometry.hitRect;
    const overPet = p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height && !this.press && !this.resizing && !this.velocity;
    const cb = this.card.getBounds();
    const overCard = this.card.isVisible() && this.cursor.x >= cb.x - 8 && this.cursor.x <= cb.x + cb.width + 8 && this.cursor.y >= cb.y - 8 && this.cursor.y <= cb.y + cb.height + 8;
    if (overPet || overCard) {
      this.hoverLeftAt = null;
      if (this.hoverBegan === null) this.hoverBegan = t;
      if (!this.card.isVisible() && t - this.hoverBegan > 0.6) {
        this.card.webContents.send('card', this.cardModel(t));
        this.positionCard();
        this.card.showInactive();
      }
    } else {
      this.hoverBegan = null;
      if (this.card.isVisible()) {
        if (this.hoverLeftAt === null) this.hoverLeftAt = t;
        if (t - this.hoverLeftAt > 0.35) this.card.hide();
      }
    }
    if (this.card.isVisible() && Math.floor(t * 4) !== Math.floor((t - 1 / 30) * 4)) this.card.webContents.send('card', this.cardModel(t));
  }

  positionCard() {
    const b = this.win.getBounds();
    const r = this.geometry.hitRect;
    const pet = { x: b.x + r.x, y: b.y + b.height - (r.y + r.height), width: r.width, height: r.height };
    const wa = screen.getDisplayNearestPoint({ x: Math.round(pet.x), y: Math.round(pet.y) }).workArea;
    const { width, height } = this.cardSize;
    let x = Math.round(pet.x + pet.width / 2 - width / 2);
    x = Math.min(Math.max(wa.x + 4, x), wa.x + wa.width - width - 4);
    let y = Math.round(pet.y - height);
    if (y < wa.y) y = Math.round(pet.y + pet.height);
    this.card.setBounds({ x, y, width, height });
  }

  // MARK: Updates

  async checkForUpdates(manual) {
    const found = await this.updater.check();
    if (found && (manual || !this.updateAnnounced)) {
      this.updateAnnounced = true;
      this.say(`update available: v${this.updater.available.version}! ✨ (tray menu)`, 6);
    } else if (!found && manual) {
      this.say(`I'm up to date! (v${app.getVersion()})`, 3);
    }
  }

  async installUpdate() {
    this.say('updating… see you in a sec! 🔄', 4);
    const result = await this.updater.install(app, shell);
    if (result !== 'updating') this.say(result, 4);
  }

  // MARK: Sprite pack files

  async onDropFiles(files) {
    try {
      const name = await importPack(files, this.spritePackName);
      this.chooseSprites(name);
      this.transient = { mood: 'done', until: now() + 2.5 };
      this.say(`new look: ${name}! ✨`, 3);
    } catch (e) {
      this.say(`hmm: ${e.message}`, 4);
    }
  }

  async importPackDialog() {
    const result = await dialog.showOpenDialog({
      title: 'Import a sprite pack', properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: 'Sprite packs and images', extensions: ['zip', 'png', 'gif', 'webp', 'jpg', 'jpeg'] }],
    });
    if (!result.canceled && result.filePaths.length) this.onDropFiles(result.filePaths);
  }

  async exportPackDialog() {
    const result = await dialog.showSaveDialog({ title: 'Export sprite pack', defaultPath: `${this.spritePackName}.zip`, filters: [{ name: 'Zip', extensions: ['zip'] }] });
    if (result.canceled || !result.filePath) return;
    try {
      await exportPack(this.spritePackName, result.filePath);
      this.say('packed up! 📦', 2);
    } catch (e) {
      this.say(`couldn't export: ${e.message}`, 4);
    }
  }

  // MARK: Focus blocklist

  checkForDistraction(t) {
    if (!BROWSERS.test(this.agents.foreground || '')) return;
    const domain = matchTitle(this.agents.foregroundTitle, this.blocklist);
    if (!domain) return;
    if (this.strictBlock) {
      const label = domain.split('.').slice(-2, -1)[0] || domain;
      closeBlockedTab((TITLE_WORDS[domain] || [label.length >= 4 ? label : domain])[0]);
      this.say(`closed ${domain}. focus! 🍅`, 3);
    } else if (t - this.lastBlockNag > 15) {
      this.lastBlockNag = t;
      this.say(`🍅 ${domain} is on your blocklist!`, 4);
    } else {
      return;
    }
    this.transient = { mood: 'startled', until: t + 1.2 };
    this.playSound('needs-you');
    this.stats.record(0, (d) => { d.blocked = (d.blocked || 0) + 1; });
  }

  startFocus(minutes) {
    this.focus.start(minutes);
    const blocking = this.blockDuringFocus && this.blocklist.length ? `, blocking ${this.blocklist.length} sites` : '';
    this.say(`focus mode: ${minutes} minutes${blocking}. you got this! 🍅`, 3.5);
  }

  // MARK: Small dialog windows

  openDialog(page, query = {}, size = { width: 420, height: 420 }) {
    if (this.dialogWin && !this.dialogWin.isDestroyed()) this.dialogWin.close();
    this.dialogWin = new BrowserWindow({
      ...size, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true, autoHideMenuBar: true,
      icon: path.join(__dirname, '..', 'assets', 'icon.png'), webPreferences: { preload: path.join(__dirname, 'preload-dialog.js') },
    });
    this.dialogWin.loadFile(path.join(__dirname, 'dialogs', page), { query });
  }

  closeDialog() {
    if (this.dialogWin && !this.dialogWin.isDestroyed()) this.dialogWin.close();
  }

  // MARK: Transfer key

  transferPayload() {
    const settings = {};
    for (const key of TRANSFER_SETTINGS) if (key in this.settings.values) settings[key] = this.settings.values[key];
    settings.scales = Object.fromEntries(Object.entries(this.settings.values).filter(([k]) => k.startsWith('scale.')).map(([k, v]) => [k.slice(6), v]));
    return {
      app: 'deskpet', v: 1, exported: new Date().toISOString(), from: isWindows ? 'Windows' : process.platform,
      config: { ownerName: this.config.ownerName, petName: this.config.petName }, settings, stats: this.stats.data,
    };
  }

  /** Applies an imported key; returns a note about anything that didn't come along. */
  applyTransfer(payload) {
    const c = payload.config || {};
    const ownerName = c.ownerName || this.config.ownerName, petName = c.petName || this.config.petName;
    saveConfig({ ownerName, petName });
    this.config = { ...this.config, ownerName, petName };
    const s = payload.settings || {};
    for (const key of TRANSFER_SETTINGS) if (key in s && s[key] !== null) this.settings.set(key, s[key]);
    for (const [name, value] of Object.entries(s.scales || {})) this.settings.set(`scale.${name}`, value);
    if (payload.stats) this.stats.replace(payload.stats);
    this.settings.set('setupComplete', true);
    let note = '';
    if (this.spritePackName && !listPacks().includes(this.spritePackName)) {
      note = `the ${this.spritePackName} sprite pack isn't on this device: export it as a zip and drop it on me`;
      this.spritePackName = '';
    }
    this.loadSprites(false);
    this.transient = { mood: 'done', until: now() + 3 };
    this.say(note || `welcome home, ${ownerName}! everything's here ✨`, 5);
    return note;
  }

  async dialogCall(action, payload) {
    switch (action) {
      case 'names-get':
        return { petName: this.config.petName, ownerName: this.config.ownerName };
      case 'names-save': {
        const pet = String(payload.petName || '').trim().slice(0, 20) || this.config.petName;
        const owner = String(payload.ownerName || '').trim().slice(0, 24) || this.config.ownerName;
        this.applyNames(pet, owner);
        this.closeDialog();
        return { ok: true };
      }
      case 'blocklist-get':
        return { list: this.blocklist, enabled: this.blockDuringFocus, strict: this.strictBlock, defaults: BLOCK_DEFAULTS };
      case 'blocklist-save': {
        const list = parseBlocklist(payload.text);
        this.settings.set('blocklist', list);
        this.settings.set('blockDuringFocus', !!payload.enabled);
        this.settings.set('strictBlock', !!payload.strict);
        this.say(`blocklist saved: ${list.length} site${list.length === 1 ? '' : 's'} 🍅`, 2.5);
        this.closeDialog();
        return { ok: true };
      }
      case 'transfer-export': return { key: transferKey.encode(this.transferPayload()) };
      case 'copy':
        clipboard.writeText(payload.text || '');
        this.say('transfer key copied! 📋', 2.5);
        return { ok: true };
      case 'save-key': {
        const r = await dialog.showSaveDialog(this.dialogWin, { defaultPath: 'DeskPet transfer key.txt', filters: [{ name: 'Text', extensions: ['txt'] }] });
        if (r.canceled || !r.filePath) return { ok: false };
        fs.writeFileSync(r.filePath, payload.key);
        return { ok: true };
      }
      case 'open-key': {
        const r = await dialog.showOpenDialog(this.dialogWin, { filters: [{ name: 'Text', extensions: ['txt'] }], properties: ['openFile'] });
        return r.canceled || !r.filePaths.length ? {} : { key: fs.readFileSync(r.filePaths[0], 'utf8') };
      }
      case 'transfer-preview':
        try { return { ok: true, summary: transferKey.summary(transferKey.decode(payload.key)) }; } catch (e) { return { ok: false, error: e.message }; }
      case 'transfer-import':
        try {
          this.applyTransfer(transferKey.decode(payload.key));
          this.closeDialog();
          return { ok: true };
        } catch (e) { return { ok: false, error: e.message }; }
      case 'close':
        this.closeDialog();
        return { ok: true };
      default:
        return null;
    }
  }

  setKiroHooks(on) {
    this.settings.set('kiroHooks', on);
    const changed = kiroHooks.apply(on);
    this.say(on ? (changed ? `Kiro connected (${changed} agents)! 🔌` : 'no Kiro agents found in ~/.kiro/agents') : 'Kiro hooks removed', 4);
    return changed;
  }

  bringHere() {
    const display = screen.getDisplayNearestPoint(this.cursor);
    const wa = display.workArea;
    this.walkTarget = null;
    this.velocity = null;
    this.pos = { x: this.cursor.x - this.size.width / 2, bottom: wa.y + wa.height };
    this.applyPosition();
    this.win.showInactive();
    this.savePosition();
    this.say('here I am! 🐾', 2);
  }

  toggleVisible() {
    if (this.win.isVisible()) this.win.hide(); else this.win.showInactive();
  }

  toggleResizing() {
    if (this.resizing) return this.finishResizing();
    this.walkTarget = null;
    this.velocity = null;
    this.resizing = true;
    if (!this.win.isVisible()) this.win.showInactive();
  }

  finishResizing() {
    this.resizing = false;
    this.resizeDrag = null;
    this.settings.set(this.scaleKey, this.scale);
    this.savePosition();
    this.say(`${Math.round(this.scale * 100)}% it is! ✨`, 2);
  }

  chooseSprites(name) {
    this.spritePackName = name;
    this.loadSprites(true);
  }

  previewPoses() {
    const poses = [['idle', 'idle'], ['typing', 'typing'], ['thinking', 'thinking'], ['needs-you', 'needsYou'], ['done', 'done'],
      ['petted', 'petted'], ['sleeping', 'sleeping'], ['sleepy', 'sleepy'], ['dragged', 'dragged'], ['startled', 'startled'],
      ['reading', 'reading'], ['searching', 'searching'], ['oops', 'oops'], ['error', 'error'], ['walking', 'walking'],
      ['flying', 'flying'], ['dizzy', 'dizzy']];
    poses.forEach(([label, mood], i) => setTimeout(() => {
      this.transient = { mood, until: now() + 2 };
      this.say(label, 2);
    }, i * 2000));
  }

  chooseTheme() {
    if (this.themeWindow && !this.themeWindow.isDestroyed()) return this.themeWindow.focus();
    this.themeWindow = new BrowserWindow({
      width: 380, height: 260, resizable: false, minimizable: false, maximizable: false, alwaysOnTop: true,
      title: 'Theme color', autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    });
    this.themeWindow.loadFile(path.join(__dirname, 'theme.html'), { query: { hex: this.themeHex || '' } });
  }

  onThemeResult({ action, hex }) {
    if (this.themeWindow && !this.themeWindow.isDestroyed()) this.themeWindow.close();
    if (action === 'apply') {
      this.themeHex = hex;
      this.say(`ooh, ${hex}! 🎨`, 2.5);
    } else if (action === 'default') {
      this.themeHex = '';
      this.say('back to classic 🐾', 2);
    }
  }

  // MARK: Setup wizard (shared HTML in src/wizard, also used by the macOS app)

  openWizard() {
    if (this.wizard && !this.wizard.isDestroyed()) return this.wizard.focus();
    this.wizard = new BrowserWindow({
      width: 780, height: 540, resizable: false, maximizable: false, fullscreenable: false, frame: false,
      transparent: true, backgroundColor: '#00000000', show: false, title: 'Welcome to DeskPet',
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload-wizard.js') },
    });
    this.wizard.loadFile(path.join(__dirname, 'wizard', 'index.html'));
    this.wizard.once('ready-to-show', () => this.wizard.show());
    this.wizard.on('closed', () => {
      this.wizard = null;
      this.settings.set('setupComplete', true);
    });
  }

  closeWizard() {
    if (this.wizard && !this.wizard.isDestroyed()) this.wizard.close();
  }

  wizardStatus() {
    return {
      hooksInstalled: hooks.installed(),
      hooksLive: hooks.installed() && hooksLive(),
      running: [...new Set(this.agents.procSessions.map((s) => s.name))],
    };
  }

  wizardCall(action, payload) {
    const loginSupported = isWindows || process.platform === 'darwin';
    switch (action) {
      case 'state':
        return {
          platform: isWindows ? 'windows' : process.platform === 'darwin' ? 'mac' : 'other',
          chrome: 'custom',
          ownerName: this.config.ownerName,
          petName: this.config.petName,
          packs: listPacks(),
          spritePack: this.spritePackName,
          themeColor: this.themeHex,
          thoughtBubble: this.thoughtBubble,
          wander: this.wander,
          gravity: this.gravity,
          startAtLogin: loginSupported && app.getLoginItemSettings().openAtLogin,
          startAtLoginSupported: loginSupported,
          notifications: this.notificationsOn, sounds: this.soundsOn, walkOnWindows: this.walkOnWindows,
          quietInCalls: this.quietInCalls, autoUpdate: this.autoUpdate, kiroInstalled: this.kiroHooksOn && kiroHooks.installed(),
          ...this.wizardStatus(),
        };
      case 'status':
        return this.wizardStatus();
      case 'pack': {
        const dir = path.join(paths.sprites, payload.name);
        return {
          name: payload.name,
          options: readJSON(path.join(dir, 'pack.json'), {}),
          files: fs.readdirSync(dir).filter((f) => /\.(png|gif|webp|jpe?g)$/i.test(f)).map((f) => ({ name: f, data: fs.readFileSync(path.join(dir, f)) })),
        };
      }
      case 'save':
        saveConfig({ ownerName: payload.ownerName, petName: payload.petName });
        this.config = { ...this.config, ownerName: payload.ownerName, petName: payload.petName };
        return { ok: true };
      case 'set':
        switch (payload.key) {
          case 'spritePack': this.chooseSprites(payload.value); break;
          case 'themeColor': this.themeHex = payload.value; break;
          case 'thoughtBubble': this.thoughtBubble = payload.value; break;
          case 'wander': this.wander = !!payload.value; this.walkTarget = null; break;
          case 'gravity': this.gravity = !!payload.value; break;
          case 'startAtLogin':
            app.setLoginItemSettings({ openAtLogin: !!payload.value });
            return { value: app.getLoginItemSettings().openAtLogin };
          case 'notifications': case 'sounds': case 'walkOnWindows': case 'quietInCalls': case 'autoUpdate':
            this.settings.set(payload.key, !!payload.value);
            if (payload.key === 'sounds' && payload.value) this.playSound('pet');
            break;
        }
        return { value: payload.value };
      case 'hooks':
        try {
          hooks.setInstalled(!!payload.install);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      case 'openSprites':
        shell.openPath(paths.sprites);
        return { ok: true };
      case 'transfer-import':
        try {
          const p = transferKey.decode(payload.key);
          const note = this.applyTransfer(p);
          return { ok: true, summary: transferKey.summary(p), note };
        } catch (e) { return { ok: false, error: e.message }; }
      case 'kiro': {
        const changed = this.setKiroHooks(!!payload.install);
        return { ok: !payload.install || changed > 0 || kiroHooks.installed(), changed };
      }
      case 'finish':
        if (payload.ownerName) this.wizardCall('save', payload);
        this.settings.set('setupComplete', true);
        this.closeWizard();
        this.say(`hi ${this.config.ownerName}! I'm ${this.config.petName} 🐾`, 4);
        this.transient = { mood: 'done', until: now() + 2.5 };
        return { ok: true };
      case 'close':
        this.closeWizard();
        return { ok: true };
      default:
        return null;
    }
  }

  toggleHooks(install) {
    try {
      hooks.setInstalled(install);
      this.say(install ? 'hooks installed! restart Claude Code 🔌' : 'hooks removed', 4);
    } catch (e) {
      dialog.showErrorBox('DeskPet', `Couldn't update ${hooks.SETTINGS}:\n${e.message}`);
    }
  }
}

/** Quits, forcing the exit if a window or helper holds shutdown up (seen on Windows). */
function quitApp() {
  app.quit();
  setTimeout(() => app.exit(0), 1500).unref();
}

function pointIn(r, x, y) { return x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height; }

function listPacks() {
  try {
    return fs.readdirSync(paths.sprites, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  } catch (_) { return []; }
}

/** Latest modification time in the pack, used to hot-reload while you iterate on art. */
function packFingerprint(name) {
  const dir = path.join(paths.sprites, name);
  try {
    return Math.max(0, ...fs.readdirSync(dir).map((f) => fs.statSync(path.join(dir, f)).mtimeMs));
  } catch (_) { return 0; }
}

// MARK: - Snapshot mode (`npm run snapshot`): renders poses to test-output/ for checking the art.

function runSnapshot() {
  const packIndex = process.argv.indexOf('--pack');
  const packName = packIndex > 0 ? process.argv[packIndex + 1] : null;
  const win = new BrowserWindow({
    width: 1200, height: 900, show: false, transparent: true, frame: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), offscreen: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { snapshot: '1' } });
  ipcMain.once('snapshot-done', (_e, dataURL) => {
    const out = path.join(__dirname, '..', 'test-output');
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, packName ? `snapshot-${packName}.png` : 'snapshot.png');
    fs.writeFileSync(file, Buffer.from(dataURL.split(',')[1], 'base64'));
    console.log(`wrote ${file}`);
    app.quit();
  });
  win.webContents.on('did-finish-load', () => {
    let source = null;
    if (packName) {
      const dir = path.join(paths.sprites, packName);
      source = {
        name: packName,
        options: readJSON(path.join(dir, 'pack.json'), {}),
        files: fs.readdirSync(dir).filter((f) => /\.(png|gif|webp|jpe?g)$/i.test(f)).map((f) => ({ name: f, data: fs.readFileSync(path.join(dir, f)) })),
      };
    }
    win.webContents.send('snapshot', { pack: source, ownerName: loadConfig().ownerName });
  });
}

// MARK: - Startup

if (process.argv.includes('--snapshot')) {
  app.whenReady().then(runSnapshot);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (process.platform === 'darwin') app.dock.hide();
  let pet;
  const selfTest = process.argv.includes('--self-test');
  if (selfTest) {
    // Make startup failures visible (and fatal) when testing.
    const fail = (e) => { console.error('self-test failed:', e && e.stack ? e.stack : e); app.exit(1); };
    process.on('uncaughtException', fail);
    process.on('unhandledRejection', fail);
    setTimeout(() => { console.error('self-test timed out'); app.exit(2); }, 30000);
  }
  app.whenReady().then(() => {
    pet = new Pet();
    ipcMain.on('press', () => pet.onPress());
    ipcMain.on('release', () => pet.onRelease());
    ipcMain.on('resize-start', () => pet.onResizeStart());
    ipcMain.on('resize-finish', () => pet.finishResizing());
    ipcMain.on('menu', () => pet.buildMenu().popup({ window: pet.win }));
    ipcMain.on('geometry', (_e, g) => { pet.geometry = g; });
    ipcMain.on('pack-loaded', (_e, result) => pet.onPackLoaded(result));
    ipcMain.on('theme-result', (_e, result) => pet.onThemeResult(result));
    ipcMain.handle('wizard', (_e, action, payload) => pet.wizardCall(action, payload));
    ipcMain.handle('dialog', (_e, action, payload) => pet.dialogCall(action, payload));
    ipcMain.on('drop-files', (_e, files) => pet.onDropFiles(files));
    ipcMain.on('drag-hover', () => { pet.transient = { mood: 'startled', until: now() + 1 }; pet.say("ooh, what's that? 👀", 1.5); });
    ipcMain.on('card-size', (_e, size) => { pet.cardSize = size; if (pet.card.isVisible()) pet.positionCard(); });
    ipcMain.on('card-jump', (_e, pid) => pet.jump(pid));
    pet.start();
    // `--wizard-snapshot`: screenshot every setup step to test-output/, then quit.
    if (process.argv.includes('--wizard-snapshot')) {
      pet.openWizard();
      pet.wizard.webContents.once('did-finish-load', async () => {
        const out = path.join(__dirname, '..', 'test-output');
        fs.mkdirSync(out, { recursive: true });
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await wait(1200);
        for (let i = 0; i < 6; i++) {
          await pet.wizard.webContents.executeJavaScript(`window.__wizardGo(${i})`);
          await wait(i === 5 ? 700 : 1100);
          const image = await pet.wizard.webContents.capturePage();
          fs.writeFileSync(path.join(out, `wizard-${i}.png`), image.toPNG());
        }
        console.log('wizard screenshots written');
        app.quit();
      });
    }
    // `--card-snapshot`: render the hover card to test-output/card.png, then quit.
    if (process.argv.includes('--card-snapshot')) {
      setTimeout(async () => {
        const model = pet.cardModel(now());
        model.focus = '🍅 focus · 18:42';
        pet.card.webContents.send('card', model);
        await new Promise((r) => setTimeout(r, 600));
        pet.card.setBounds({ x: 100, y: 100, ...pet.cardSize });
        pet.card.showInactive();
        await new Promise((r) => setTimeout(r, 500));
        const image = await pet.card.webContents.capturePage();
        fs.mkdirSync(path.join(__dirname, '..', 'test-output'), { recursive: true });
        fs.writeFileSync(path.join(__dirname, '..', 'test-output', 'card.png'), image.toPNG());
        console.log('card written', pet.cardSize);
        app.quit();
      }, 5000);
    }
    // `--self-test`: run normally for a few seconds, print what was detected, then quit.
    if (process.argv.includes('--self-test')) {
      setTimeout(() => {
        console.log(JSON.stringify({
          mood: pet.mood, size: pet.size, bounds: pet.win.getBounds(), geometry: pet.geometry,
          sessions: pet.sessions.map((s) => `${s.name}: ${s.detail} [${s.precise ? 'hooks' : 'cpu'}]`),
          scans: pet.agents.scanCount, pack: pet.pack && pet.pack.name, menuItems: pet.buildMenu().items.length,
          windowsToStandOn: pet.platforms.platforms.length, inCall: pet.agents.inCall, version: app.getVersion(),
        }, null, 2));
        app.exit(0);
      }, 7000);
    }
  });
  app.on('window-all-closed', (e) => e.preventDefault());
  app.on('before-quit', () => {
    if (!pet) return;
    pet.agents.stop();
    pet.platforms.stop();
    pet.stats.saveIfNeeded();
    pet.settings.flush();
  });
}
