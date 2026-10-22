// DeskPet for Windows (and anywhere Electron runs). A port of App.swift from the macOS app.
//
// The main process owns all behavior: agent detection, moods, walking, throwing, resizing, and menus.
// The renderer only draws the pose it's sent and reports where the pet is for hit testing.
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, powerMonitor, ipcMain, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const { AgentMonitor, PRIORITY } = require('./agents');
const { paths, Settings, loadConfig, readJSON } = require('./settings');
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
    this.say(`hi ${this.config.ownerName}! 👋`, 4);
    this.timer = setInterval(() => this.tick(), 1000 / 30);
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
      webPreferences: { preload: path.join(__dirname, 'preload.js'), backgroundThrottling: false },
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
    }
    const top = this.topSession;
    if (idle > 240 && (!top || top.activity === 'idle')) this.wasAsleep = true;

    if (idle > 300) this.streakStart = t;
    else if (t - this.streakStart > 50 * 60) {
      this.streakStart = t;
      this.say('50 minutes straight — stretch break? 🙆', 6);
    }

    const hour = new Date().getHours();
    this.night = hour >= 23 || hour < 6;
    if (this.night && idle < 5 && t - this.lastNightNag > 3600) {
      this.lastNightNag = t;
      this.say(`it's late, ${this.config.ownerName}… bedtime soon? 🌙`, 5);
    }

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
      if (s.activity === 'done') this.say(`${s.name} is done! ✨`, 4);
      else if (s.activity === 'needsYou') this.say(`${s.name} needs you! 🙋`, 5);
      else if (s.activity === 'error') this.say(`uh oh, ${s.name} hit an error 😵`, 4);
      else if (s.activity === 'idle' && !s.precise && t - (this.busySince.get(s.id) || t) > 15) {
        this.say(`${s.name} looks done ✨`, 4);
        this.transient = { mood: 'done', until: t + 3 };
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
    if (this.speech && this.speech.until > t) p.bubble = this.speech.text;
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
    const target = random(wa.x - 40, wa.x + wa.width - this.size.width + 40);
    if (Math.abs(target - this.win.getBounds().x) > 80) this.walkTarget = target;
  }

  move(dt, t) {
    if (this.velocity) return this.simulateThrow(dt, t);
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
    const floor = wa.y + wa.height;
    const ceiling = wa.y + GROUND + body.height; // smallest allowed window bottom
    const bounciness = 0.72;

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
    this.savePosition();
    if (this.bounces >= 3) {
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
    if (!remarks.length || t - this.lastRemark < 45 || Math.random() > 0.4 || (top && top.activity !== 'idle')) return;
    this.lastRemark = t;
    this.say(pick(remarks), 3);
  }

  tapped() {
    const t = now();
    this.walkTarget = null;
    const top = this.topSession;
    if (top && top.activity !== 'idle' && top.activity !== 'done') {
      this.transient = { mood: 'petted', until: t + 1 };
      this.say(top.activity === 'needsYou' ? `go check on ${top.name}! 👉` : `shh, ${top.name} is working 🤫`, 2.5);
    } else {
      this.transient = { mood: 'petted', until: t + 2.2 };
      this.say(pick(['purr~ 💕', 'hehe', 'more pets pls', '♥︎', `you're the best, ${this.config.ownerName}!`]), 2.2);
    }
  }

  dragBegan() {
    this.walkTarget = null;
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
    try {
      files = fs.readdirSync(dir)
        .filter((f) => /\.(png|gif|webp|jpe?g)$/i.test(f))
        .map((f) => ({ name: f, data: fs.readFileSync(path.join(dir, f)) }));
    } catch (_) { /* missing folder: the renderer reports "no idle image" */ }
    this.pendingAnnounce = announce;
    this.pack = { name, height: Math.min(220, Math.max(40, options.height || 120)) };
    this.layoutWindow();
    this.win.webContents.send('pack', { name, options, files });
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
    const agentItems = this.sessions.length
      ? [...this.sessions].sort((a, b) => PRIORITY.indexOf(b.activity) - PRIORITY.indexOf(a.activity)).map((s) => ({
        label: `${s.activity === 'idle' ? '○' : '●'} ${s.name}${s.project ? ` (${s.project})` : ''} — ${s.detail}${s.precise ? '' : ' · guessed from CPU'}`,
        enabled: false,
      }))
      : [{ label: 'No AI agents running', enabled: false }];
    const packs = listPacks();
    const template = [
      { label: `${this.config.petName} — ${this.mood}`, enabled: false },
      { type: 'separator' },
      ...agentItems,
      { type: 'separator' },
      { label: 'Wander around', type: 'checkbox', checked: this.wander, click: () => { this.wander = !this.wander; this.walkTarget = null; } },
      { label: 'Gravity', type: 'checkbox', checked: this.gravity, click: () => { this.gravity = !this.gravity; } },
      { label: `Bring ${this.config.petName} here`, click: () => this.bringHere() },
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
          { label: 'Preview poses', click: () => this.previewPoses() },
          { label: 'Reload sprites', click: () => this.loadSprites(true) },
          { label: 'Open sprites folder', click: () => shell.openPath(paths.sprites) },
        ],
      },
      { label: this.win.isVisible() ? `Hide ${this.config.petName}` : `Show ${this.config.petName}`, click: () => this.toggleVisible() },
      { type: 'separator' },
    ];
    if (isWindows) {
      const installed = hooks.installed();
      template.push(
        { label: 'Claude Code hooks', type: 'checkbox', checked: installed, click: () => this.toggleHooks(!installed) },
        { label: 'Start with Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin, click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
        { type: 'separator' },
      );
    }
    template.push({ label: 'Quit DeskPet', click: () => app.quit() });
    return Menu.buildFromTemplate(template);
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

  toggleHooks(install) {
    try {
      hooks.setInstalled(install);
      this.say(install ? 'hooks installed! restart Claude Code 🔌' : 'hooks removed', 4);
    } catch (e) {
      dialog.showErrorBox('DeskPet', `Couldn't update ${hooks.SETTINGS}:\n${e.message}`);
    }
  }
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
    pet.start();
    // `--self-test`: run normally for a few seconds, print what was detected, then quit.
    if (process.argv.includes('--self-test')) {
      setTimeout(() => {
        console.log(JSON.stringify({
          mood: pet.mood, size: pet.size, bounds: pet.win.getBounds(), geometry: pet.geometry,
          sessions: pet.sessions.map((s) => `${s.name}: ${s.detail} [${s.precise ? 'hooks' : 'cpu'}]`),
          scans: pet.agents.scanCount, pack: pet.pack && pet.pack.name, menuItems: pet.buildMenu().items.length,
        }, null, 2));
        app.quit();
      }, 7000);
    }
  });
  app.on('window-all-closed', (e) => e.preventDefault());
  app.on('before-quit', () => {
    if (!pet) return;
    pet.agents.stop();
    pet.settings.flush();
  });
}
