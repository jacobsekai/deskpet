// DeskPet for Windows (and anywhere Electron runs). A port of App.swift from the macOS app.
//
// The main process owns all behavior: agent detection, moods, walking, throwing, resizing, and menus.
// The renderer only draws the pose it's sent and reports where the pet is for hit testing.
const { app, BrowserWindow, Tray, Menu, nativeImage, screen, powerMonitor, ipcMain, shell, dialog, Notification, clipboard, globalShortcut } = require('electron');

/** Emergency-hide shortcuts (same choices as PanicKey.swift). */
const PANIC_KEYS = [
  { id: 'ctrl-alt-h', label: 'Ctrl+Alt+H', accelerator: 'Control+Alt+H' },
  { id: 'ctrl-alt-p', label: 'Ctrl+Alt+P', accelerator: 'Control+Alt+P' },
  { id: 'ctrl-shift-space', label: 'Ctrl+Shift+Space', accelerator: 'Control+Shift+Space' },
  { id: 'ctrl-alt-shift-h', label: 'Ctrl+Alt+Shift+H', accelerator: 'Control+Alt+Shift+H' },
];
const fs = require('fs');
const path = require('path');
const { AgentMonitor, PRIORITY, TranscriptTokens, codexState } = require('./agents');
const gifts = require('./gifts');
const {
  REWARDS, SLOTS, PRESTIGE, Stats, FocusTimer, Updater, importPack, exportPack, kiroHooks, jumpTo, WindowPlatforms, loginItem,
  BLOCK_DEFAULTS, BROWSERS, TITLE_WORDS, parseBlocklist, matchTitle, closeBlockedTab, transferKey, TRANSFER_SETTINGS,
} = require('./extras');
const { paths, Settings, loadConfig, saveConfig, hooksLive, readJSON, setSpritesOverride } = require('./settings');
const { Sync } = require('./sync');
const hooks = require('./hooks');
const { createCompanion, personalityFor } = require('./companion-host');
const trips = require('./trips');
const { sessionSummary } = require('./summary');
const seasons = require('./seasons');
const { CalendarWatcher } = require('./calendar');
const presence = require('./presence');
const gallery = require('./gallery');
const { spawn } = require('child_process');

// Visitor mode (a pet on a trip, docs/trips-and-moving.md) keeps Chromium's profile in the trip's temp folder,
// which also gives it its own single-instance lock, separate from this computer's own DeskPet.
if (paths.trip) app.setPath('userData', path.join(paths.root, 'electron'));

const GROUND = 34;

if (process.platform === 'linux') {
  // Transparent windows on X11 and most Wayland compositors (through XWayland).
  app.commandLine.appendSwitch('enable-transparent-visuals');
  app.disableHardwareAcceleration();
  // AppImages can't ship Chromium's setuid sandbox helper, and Ubuntu 24.04+ blocks the user-namespace
  // sandbox for unconfined apps, so AppImage builds run without it. DeskPet only loads its own local pages.
  if (process.env.APPIMAGE) app.commandLine.appendSwitch('no-sandbox');
}
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
    this.companion = createCompanion(isWindows ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux');
    this.companion.setNames(this.config.ownerName, this.config.petName);
    this.setPersonality();
    this.lastCompanionTick = 0;
    this.lastTap = 0;
    this.talk = null;
    this.sync = new Sync(this.settings);
    this.lastSyncTick = 0;
    if (this.settings.get('syncPacks', false) && this.sync.enabled) setSpritesOverride(this.sync.spritesFolder);
    // Trips. A visitor's own settings are temporary, so "this computer" is the id in the real ~/.deskpet.
    this.visitor = !!paths.trip;
    this.deviceID = this.visitor ? (readJSON(path.join(paths.realRoot, 'electron-settings.json'), {}) || {}).syncDeviceID || null : this.sync.deviceID;
    this.visit = null;
    this.drives = [];
    this.drivesAt = 0;
    this.lastTripWatch = 0;
    this.tripChecked = false;
    this.visitorsAtDoor = [];
    this.announcedDoors = new Set();
    this.letOut = new Set();
    // 1.5: agent summaries, calendar, playdates, seasonal events.
    this.summaries = new Map();
    this.calendar = new CalendarWatcher();
    this.calendarNotified = new Set();
    this.meetingLink = null;
    this.lastCalendarTick = -15;
    this.lastPresence = 0;
    this.playdate = null;
    this.metPets = new Set();
    this.nextPlaydateAt = 0;
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
  /** While you type, the pet types on its laptop too (otherwise it just bobs along). */
  get typeAlong() { return this.settings.get('typeAlong', true); }
  get autoUpdate() { return this.settings.get('autoUpdate', true); }
  get kiroHooksOn() { return this.settings.get('kiroHooks', false); }
  get blocklist() { return this.settings.get('blocklist', BLOCK_DEFAULTS); }
  get blockDuringFocus() { return this.settings.get('blockDuringFocus', true); }
  get strictBlock() { return this.settings.get('strictBlock', false); }
  toggle(key, fallback) { this.settings.set(key, !this.settings.get(key, fallback)); }
  /** On a call: no sounds and no chatty remarks. */
  get quiet() { return (this.quietInCalls && this.agents.inCall) || this.panicHidden || this.quietHoursOn; }

  // Quiet hours: a weekly schedule with no remarks or sounds (notifications optional).
  get quietHours() { return seasons.quietSettings(this.settings.get('quietHours', null)); }
  get quietHoursOn() { return seasons.quietHoursActive(this.quietHours); }

  /** Calendar heads-up settings: { source: 'off'|'system'|'ics', icsUrl, lead }. */
  get calendarCfg() {
    const c = this.settings.get('calendar', null) || {};
    const source = ['off', 'system', 'ics'].includes(c.source) ? c.source : 'off';
    return { source: this.visitor ? 'off' : source, icsUrl: String(c.icsUrl || ''), lead: [1, 2, 5, 10, 15].includes(Number(c.lead)) ? Number(c.lead) : 5 };
  }

  // Emergency hide: one global shortcut hides the pet and everything it shows, and silences it, until pressed again.
  get panicKeyID() { return this.settings.get('panicKey', 'ctrl-alt-h'); }
  get panicKeyLabel() { const k = PANIC_KEYS.find((x) => x.id === this.panicKeyID); return k ? k.label : null; }

  /** Registers the chosen shortcut ("off" turns it off). False if another app already owns it (or on Wayland). */
  registerPanicKey() {
    if (this.panicAccelerator) globalShortcut.unregister(this.panicAccelerator);
    this.panicAccelerator = null;
    const k = PANIC_KEYS.find((x) => x.id === this.panicKeyID);
    if (!k) return (this.panicKeyOK = this.panicKeyID === 'off');
    try { this.panicKeyOK = globalShortcut.register(k.accelerator, () => this.togglePanic()); } catch (_) { this.panicKeyOK = false; }
    if (this.panicKeyOK) this.panicAccelerator = k.accelerator;
    return this.panicKeyOK;
  }

  togglePanic() {
    this.panicHidden = !this.panicHidden;
    if (this.panicHidden) {
      this.win.hide();
      this.hideCard();
      for (const w of [this.talk, this.panel, this.wizard]) if (w && !w.isDestroyed()) w.close();
      this.speech = null;
    } else if (!this.away) {
      this.win.showInactive();
    }
    this.updateTray();
  }

  get topSession() {
    return this.sessions.reduce((best, s) => (!best || PRIORITY.indexOf(s.activity) > PRIORITY.indexOf(best.activity) ? s : best), null);
  }

  // MARK: Lifecycle

  /** Returns false when DeskPet is quitting right away (a visitor that can't visit here). */
  start() {
    if (this.visitor && !this.visitAllowed()) return false;
    fs.mkdirSync(paths.sprites, { recursive: true });
    this.createWindow();
    this.createTray();
    this.agents.onForeground = (name) => this.appActivated(name);
    this.agents.start();
    powerMonitor.on('resume', () => this.welcomeBack());
    powerMonitor.on('unlock-screen', () => this.welcomeBack());
    this.timer = setInterval(() => this.tick(), 1000 / 30);
    if (isWindows) app.setAppUserModelId('local.deskpet');
    this.platforms.start();
    this.createCard();
    if (this.visitor) {
      // A guest: no setup, hooks, updates, or login items on someone else's computer.
      this.startVisit();
      this.updateTray();
      return true;
    }
    if (this.away) this.updateTray(); // the pet stays hidden until the trip comes home
    else if (this.settings.get('setupComplete', false)) this.applyCompanion(this.companion.event('launch'));
    else this.openWizard();

    if (process.platform !== 'darwin') {
      // Hooks that point at a moved AppImage or a missing Node get rewritten.
      try { if (hooks.heal()) console.log('repaired Claude Code hooks'); } catch (_) { /* best effort */ }
      // Keep installed hook scripts current after updates.
      if (hooks.installed() || this.kiroHooksOn) {
        try { hooks.installScripts(); } catch (_) { /* best effort */ }
      }
    }
    if (this.kiroHooksOn) kiroHooks.apply(true); // also repoints Kiro hooks at the current command
    setTimeout(() => this.wearEarnedRewardsOnce(), 6000);
    if (this.autoUpdate) setTimeout(() => this.checkForUpdates(false), 20000);
    setInterval(() => { if (this.autoUpdate) this.checkForUpdates(false); }, 6 * 3600 * 1000);
    return true;
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
      if (!this.away) this.win.showInactive();
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
    if (this.win.isDestroyed()) return clearInterval(this.timer); // quitting
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
      this.applyCompanion(this.companion.event('wake'));
      this.playSound('wake');
    }
    const top = this.topSession;
    if (idle > 240 && (!top || top.activity === 'idle')) this.wasAsleep = true;

    const hour = new Date().getHours();
    this.night = hour >= 23 || hour < 6;
    // Greetings, reminders (water, breaks, bedtime), remarks about your day, and conversations it starts.
    if (t - this.lastCompanionTick >= 5 && !this.panicHidden) {
      this.lastCompanionTick = t;
      this.tickCompanion(t, idle);
    }

    if (this.playUntil && this.playUntil <= Date.now()) this.endPlaytime();
    const finished = this.focus.tick();
    if (finished === 'focus') {
      this.transient = { mood: 'done', until: t + 3 };
      this.say(this.companion.line('focus.done', 'focus session done! take a break ☕'), 5);
      this.playSound('focus-done');
      this.notify('Focus session done', `Take a ${Math.max(5, Math.round(this.focus.minutes / 5))} minute break ☕`, 0);
      this.gainXP(15, false, (d) => { d.focusSessions++; });
    } else if (finished === 'rest') {
      this.say(this.companion.line('focus.over', "break's over! ready for another round? 💪"), 5);
      this.notify("Break's over", 'Ready for another focus session?', 0);
    }
    if (this.focus.phase === 'focus' && this.blockDuringFocus && this.blocklist.length && t - this.lastBrowserCheck > 2) {
      this.lastBrowserCheck = t;
      this.checkForDistraction(t);
    }
    if (this.sync.enabled && t - this.lastSyncTick > 5) {
      this.lastSyncTick = t;
      this.syncTick();
    }
    if (t - this.lastTripWatch >= 3) {
      this.lastTripWatch = t;
      this.tripWatch();
    }
    if (t - this.lastMinute >= 60 && this.away) this.lastMinute = t; // no hanging-out XP while the pet is away
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
      this.eventTick(idle < 60);
    }
    if (!this.stats.today.greeted && !this.away) {
      this.gainXP(10, false, (d) => { d.greeted = true; });
    }
    if (t - this.lastStatsSave > 30) { this.lastStatsSave = t; this.stats.saveIfNeeded(); }
    if (this.kiroHooksOn && t - this.lastKiroCheck > 600) {
      this.lastKiroCheck = t;
      kiroHooks.apply(true); // tools like `aim` regenerate Kiro agent files
    }
    if (this.perch && !this.walkOnWindows) this.dropFromPerch();

    this.mood = this.resolveMood(t, idle, sinceKey);
    if (t - this.lastPresence >= 1) {
      this.lastPresence = t;
      this.presenceTick(t);
    }
    if (t - this.lastCalendarTick >= 15) {
      this.lastCalendarTick = t;
      this.calendarTick();
    }
    if (this.mood === 'idle' && this.wander && this.win.isVisible() && t > this.nextWalkAt && !this.velocity && !this.resizing && !this.talkOpen && !this.playdate) this.startWalk(t);
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
    // The pose stays up through short pauses, so the laptop doesn't flicker in and out.
    if (sinceKey < 1.2) this.typingAlongUntil = t + 2;
    if (t < (this.typingAlongUntil || 0)) return this.typeAlong ? 'typing' : 'userTyping';
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
        this.taskFinished(s, project);
      } else if (s.activity === 'needsYou') {
        this.say(`${s.name} needs you! 🙋`, 5);
        this.playSound('needs-you');
        this.notifyUnlessWatching(s, `${s.name} needs you`, `${project}: ${s.detail}`);
      } else if (s.activity === 'error') {
        this.say(`uh oh, ${s.name} hit an error 😵`, 4);
        this.notifyUnlessWatching(s, `${s.name} hit an error`, project);
      } else if (s.activity === 'idle' && !s.precise && t - (this.busySince.get(s.id) || t) > 15) {
        this.transient = { mood: 'done', until: t + 3 };
        this.taskFinished(s, project, true);
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
    if (!p.caption && this.playing) {
      const left = Math.round((this.playUntil - Date.now()) / 1000);
      p.caption = `🎾 playtime ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      p.captionColor = '#34C759';
    }
    if (this.speech && this.speech.until > t) p.bubble = this.speech.text;
    if (this.xpPopup && t - this.xpPopup.at < 1.4) { p.xpText = `+${this.xpPopup.amount} XP`; p.xpAge = t - this.xpPopup.at; }
    const worn = (slot) => this.worn(slot);
    p.hat = (worn('hat') || {}).value || null;
    p.trail = (worn('trail') || {}).value || null;
    p.aura = (worn('aura') || {}).value || null;
    p.companion = (worn('companion') || {}).value || null;
    p.golden = !!worn('golden');
    p.prestige = this.settings.get('showPrestigeBadge', true) ? this.stats.prestige : 0;
    // During an event its outfit shows in any empty slot, even before it's earned.
    const ev = seasons.activeEvent();
    if (ev) {
      for (const id of ev.rewards) {
        const r = REWARDS.find((x) => x.id === id);
        if (r && !p[r.slot]) p[r.slot] = r.value;
      }
    }
    if (!p.hat && this.birthdayToday()) p.hat = 'partyHat';
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
      this.say(this.companion.line('dizzy', '@_@ the room is spinning…'), 2.5);
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
    this.applyCompanion(this.companion.event('resume'));
  }

  appActivated(name) {
    const category = categorize(name);
    this.accessory = category === 'music' ? 'headphones' : category === 'code' ? 'glasses' : 'none';
    this.applyCompanion(this.companion.event('app', { name, title: this.agents.foregroundTitle }));
  }

  tapped() {
    const t = now();
    this.walkTarget = null;
    // A meeting is about to start (or just did): a click joins it.
    if (this.meetingLink && Date.now() < this.meetingLink.until) {
      const { link, title } = this.meetingLink;
      this.meetingLink = null;
      shell.openExternal(link);
      this.say(`joining ${title} 📅`, 2.5);
      return;
    }
    const top = this.topSession;
    // When an agent wants attention, a click takes you to it.
    if (top && ['needsYou', 'done', 'error', 'oops'].includes(top.activity) && top.pid) {
      this.transient = { mood: 'petted', until: t + 1 };
      this.jump(top.pid).then((ok) => this.say(ok ? `taking you to ${top.name} 👉` : `go check on ${top.name}! 👉`, 2.5));
      return;
    }
    // The pet wants to talk (it said so in a bubble), or a quick double-click: open the talk window.
    if (this.companion.hasOffer()) { this.openTalk('offer'); return; }
    if (t - this.lastTap < 0.45) { this.lastTap = 0; this.openTalk(); return; }
    this.lastTap = t;
    this.playSound('pet');
    this.gainXP(2, true, (d) => { d.pets++; });
    if (top && top.activity !== 'idle' && top.activity !== 'done') {
      this.transient = { mood: 'petted', until: t + 1 };
      this.say(top.activity === 'needsYou' ? `go check on ${top.name}! 👉` : `shh, ${top.name} is working 🤫`, 2.5);
    } else {
      this.transient = { mood: 'petted', until: t + 2.2 };
      this.applyCompanion(this.companion.event('petted'));
    }
  }

  dragBegan() {
    if (this.velocity) {
      this.gainXP(3, true);
      this.say(this.companion.line('caught', 'nice catch! 🙌'), 1.5);
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
    if (speed > 400) {
      this.gainXP(3, true, (d) => { d.throwsCount++; });
      this.applyCompanion(this.companion.event('thrown', { playful: this.playing }));
    }
  }

  /** Playtime: until it ends, throws are a game and never hurt the bond. */
  get playing() { return (this.playUntil || 0) > Date.now(); }

  startPlaytime(minutes = 10) {
    this.playUntil = Date.now() + minutes * 60000;
    this.applyCompanion(this.companion.event('playtimeStart'));
  }

  endPlaytime() {
    this.playUntil = 0;
    this.applyCompanion(this.companion.event('playtimeEnd'));
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
    this.setPersonality();
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

  /** The quick menu (tray and right-click). Everything else lives in the control center. */
  buildMenu() {
    const agentItems = this.sessions.length
      ? [...this.sessions].sort((a, b) => PRIORITY.indexOf(b.activity) - PRIORITY.indexOf(a.activity)).map((s) => ({
        label: `${s.activity === 'idle' ? '○' : '●'} ${s.name}${s.project ? ` (${s.project})` : ''} — ${s.detail}`,
        enabled: !!s.pid && process.platform !== 'darwin',
        click: () => this.jump(s.pid).then((ok) => { if (!ok) this.say("couldn't find that window 🤔", 2.5); }),
      }))
      : [{ label: 'No AI agents running', enabled: false }];
    const pet = this.config.petName;
    const away = this.tripState;
    const tripItems = [];
    if (this.visit) {
      tripItems.push({ label: `🧳 ${pet} is visiting ${trips.deviceName()}`, enabled: false }, { label: '🏠 Go home', click: () => this.goHome() });
    } else if (away) {
      tripItems.push({ label: `🧳 ${pet} is out with you${away.volume ? ` (${away.volume})` : ''}`, enabled: false });
      if (fs.existsSync(path.join(away.path, 'trip.json'))) tripItems.push({ label: `🏠 Welcome ${pet} home`, click: () => this.tripWelcome() });
      tripItems.push({ label: `Call ${pet} home without the drive`, click: () => this.callHome() });
    }
    for (const d of this.doors()) tripItems.push({ label: `🧳 Let ${d.pet} out (visiting from ${d.homeName})`, click: () => this.letVisitorOut(d.path) });
    const template = [
      { label: `${pet} · ${this.stats.rankTitle} — ${away ? 'on a trip' : this.mood}`, enabled: false },
      { label: `Today: ${this.todaySummary()}`, enabled: false },
      ...(this.quietHoursOn ? [{ label: `🌙 Quiet hours until ${this.quietHours.to}`, enabled: false }]
        : this.quiet && !this.panicHidden ? [{ label: '🤫 Quiet: a mic or camera is in use', enabled: false }] : []),
      ...(this.updater.available && !this.visitor ? [{ label: `⬆️ Update to v${this.updater.available.version}`, click: () => this.installUpdate() }] : []),
      ...(tripItems.length ? [{ type: 'separator' }, ...tripItems] : []),
      { type: 'separator' },
      ...agentItems,
      { type: 'separator' },
      ...(away ? [] : [{ label: `💬 Talk to ${pet}…`, click: () => this.openTalk() }]),
      { label: 'Open DeskPet…', accelerator: 'CmdOrCtrl+,', click: () => this.openPanel() },
      this.focus.phase === 'off'
        ? { label: '🍅 Focus for 25 minutes', click: () => this.startFocus(25) }
        : { label: `⏹ Stop focus (${this.focus.label})`, click: () => this.focus.stop() },
      { label: this.playing ? '⏹ Stop playtime' : `🎾 Playtime: throw ${this.config.petName} around (10 min)`, click: () => (this.playing ? this.endPlaytime() : this.startPlaytime(10)) },
      { label: `Rewards (${this.stats.rankTitle})…`, click: () => this.openPanel('rewards') },
      ...(away ? [] : [
        { label: `Bring ${pet} here`, click: () => this.bringHere() },
        ...(this.panicHidden ? [] : [{ label: `🙈 Hide everything now${this.panicKeyLabel ? ` (${this.panicKeyLabel})` : ''}`, click: () => this.togglePanic() }]),
        { label: this.win.isVisible() ? `Hide ${pet}` : `Show ${pet}`, click: () => this.toggleVisible() },
      ]),
      { type: 'separator' },
      { label: this.visitor ? `Quit (${pet} saves the trip first)` : 'Quit DeskPet', click: () => this.quit() },
    ];
    return Menu.buildFromTemplate(template);
  }

  // MARK: Companion (conversations, affection, reminders: src/companion)

  setPersonality() {
    // `--personality minori` (for screenshots) overrides the sprite pack's.
    const forced = process.argv.indexOf('--personality');
    const { personality, source } = forced > 0 ? { personality: process.argv[forced + 1], source: 'command line' } : personalityFor(this.spritePackName);
    this.companion.setPersonality(personality, source);
  }

  tickCompanion(t, idle) {
    const top = this.topSession;
    const today = this.stats.today;
    this.applyCompanion(this.companion.tick({
      idle, owner: this.config.ownerName, pet: this.config.petName, focus: this.focus.phase, quiet: this.quiet,
      speaking: !!(this.speech && this.speech.until > t), talking: this.talkOpen,
      attention: !!(top && ['needsYou', 'error'].includes(top.activity)) || !this.win.isVisible(),
      activeMinutes: today.activeMinutes || 0, tasks: today.tasks || 0, focusSessions: today.focusSessions || 0,
      togetherMinutes: this.stats.togetherMinutes,
    }));
    // Browser tabs change without the app changing, so the title is checked on every tick too.
    if (this.agents.foreground) this.applyCompanion(this.companion.event('app', { name: this.agents.foreground, title: this.agents.foregroundTitle }));
  }

  /** Carries out what the companion engine asks for. */
  applyCompanion(effects) {
    for (const f of effects || []) {
      switch (f.type) {
        case 'say': this.say(f.text, f.seconds || 4); break;
        case 'mood': this.transient = { mood: f.mood, until: now() + (f.seconds || 6) }; break;
        case 'xp': this.gainXP(f.amount, !!f.play); break;
        case 'offer': this.transient = { mood: 'startled', until: now() + 0.8 }; this.playSound('needs-you'); break;
        case 'tier': if (!f.down) this.playSound('level-up'); break;
        case 'openTalk': if (!this.away) this.openTalk(f.topic || null); break;
        case 'trip': if (!this.visitor) this.openPanel('trips'); break;
        case 'consumeGift':
          if (this.pendingGift) gifts.consume(this.pendingGift);
          this.pendingGift = null;
          break;
        case 'playtime': this.startPlaytime(f.minutes || 10); break;
        case 'quit':
          setTimeout(() => {
            if (this.talk && !this.talk.isDestroyed()) this.talk.close();
            this.quit();
          }, f.delay || 500);
          break;
        default: break;
      }
    }
  }

  /** Quit from a menu: the pet counts it as a goodbye. */
  quit() {
    this.companion.event('quit');
    // Tearing down the see-through talk window during quit can stall on some Linux X servers; close it first.
    if (this.talk && !this.talk.isDestroyed()) {
      this.talk.destroy();
      setTimeout(quitApp, 150);
    } else quitApp();
  }

  get talkOpen() { return !!(this.talk && !this.talk.isDestroyed() && this.talk.isVisible()); }

  openTalk(topic) {
    this.walkTarget = null;
    if (this.talk && !this.talk.isDestroyed()) {
      this.talk.show();
      this.talk.focus();
      if (topic) this.talk.webContents.executeJavaScript(`window.__talkOpen(${JSON.stringify(topic)})`);
      return;
    }
    this.talkStart = topic || null;
    const bounds = this.talkBounds(230);
    this.talk = new BrowserWindow({
      ...bounds, frame: false, transparent: true, resizable: false, maximizable: false, minimizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, show: false, backgroundColor: '#00000000', title: `Talk to ${this.config.petName}`,
      webPreferences: { preload: path.join(__dirname, 'preload-talk.js') },
    });
    this.talk.setAlwaysOnTop(true, 'floating');
    this.talk.loadFile(path.join(__dirname, 'companion', 'talk.html'));
    this.talk.once('ready-to-show', () => { this.talk.show(); this.talk.focus(); });
    this.talk.on('closed', () => { this.talk = null; });
    // Face the window while talking.
    this.walkDirection = bounds.x + bounds.width / 2 < this.win.getBounds().x + this.win.getBounds().width / 2 ? -1 : 1;
  }

  /** Beside the pet, bottom-aligned with its feet, on whichever side has room. */
  talkBounds(height) {
    const b = this.win.getBounds();
    const wa = this.display().workArea;
    const width = 460;
    const g = this.geometry && this.geometry.hitRect;
    const left = g ? b.x + g.x : b.x + b.width / 2 - 50;
    const right = g ? b.x + g.x + g.width : b.x + b.width / 2 + 50;
    const roomRight = wa.x + wa.width - right, roomLeft = left - wa.x;
    let x = (roomRight >= width || roomRight > roomLeft) && b.x + b.width / 2 < wa.x + wa.width * 0.6 ? right - 4 : left - width + 4;
    x = Math.max(wa.x, Math.min(wa.x + wa.width - width, x));
    const feet = b.y + b.height - GROUND + 10;
    const y = Math.max(wa.y, Math.min(wa.y + wa.height - height, feet - height));
    return { x: Math.round(x), y: Math.round(y), width, height };
  }

  talkCall(action, payload) {
    payload = payload || {};
    switch (action) {
      case 'init': {
        const start = this.talkStart;
        this.talkStart = null;
        return { theme: this.themeHex || null, start, platform: process.platform };
      }
      case 'resize': {
        if (!this.talk || this.talk.isDestroyed()) return { ok: false };
        const h = Math.round(Math.min(600, Math.max(150, Number(payload.height) || 230)));
        const cur = this.talk.getBounds();
        const wa = screen.getDisplayMatching(cur).workArea;
        // Grow upward, keeping the bottom edge where it was.
        const y = Math.max(wa.y, Math.min(wa.y + wa.height - h, cur.y + cur.height - h));
        this.talk.setBounds({ x: cur.x, y, width: cur.width, height: h });
        return { ok: true };
      }
      case 'close': {
        this.applyCompanion(this.companion.ui('close').effects);
        if (this.talk && !this.talk.isDestroyed()) this.talk.close();
        return { ok: true };
      }
      case 'log': console.error(payload.message); return { ok: true };
      case 'pickGift': return (async () => {
        const r = await dialog.showOpenDialog(this.talk && !this.talk.isDestroyed() ? this.talk : undefined, {
          title: 'Give a gift', defaultPath: gifts.ensureFolder(), buttonLabel: 'Give', properties: ['openFile'],
          filters: [{ name: 'Gifts', extensions: ['gift'] }],
        });
        if (r.canceled || !r.filePaths[0]) return { ok: false };
        this.pendingGift = r.filePaths[0];
        return { ok: true, file: path.basename(r.filePaths[0]) };
      })();
      default: {
        const r = this.companion.ui(action, payload);
        this.applyCompanion(r.effects);
        return r.result;
      }
    }
  }

  // MARK: Control center (shared HTML in src/panel, also used by the macOS app)

  openPanel(page) {
    if (this.panel && !this.panel.isDestroyed()) {
      this.panel.show();
      this.panel.focus();
      if (page) this.panel.webContents.executeJavaScript(`window.__panelShow(${JSON.stringify(page)})`);
      return;
    }
    this.panelPage = page || null;
    this.panel = new BrowserWindow({
      width: 940, height: 640, resizable: false, maximizable: false, fullscreenable: false, frame: false, transparent: true,
      backgroundColor: '#00000000', show: false, title: 'DeskPet', icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      webPreferences: { preload: path.join(__dirname, 'preload-panel.js') },
    });
    this.panel.loadFile(path.join(__dirname, 'panel', 'index.html'));
    this.panel.once('ready-to-show', () => this.panel.show());
    this.panel.on('closed', () => { this.panel = null; });
  }

  panelState() {
    const t = now();
    const st = this.stats;
    const loginSupported = true;
    const card = this.cardModel(t);
    const next = REWARDS.find((r) => r.level > st.level);
    return {
      platform: isWindows ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux', chrome: 'custom', version: app.getVersion(),
      openPage: this.panelPage, names: { petName: this.config.petName, ownerName: this.config.ownerName },
      rank: {
        title: st.rankTitle, level: st.level, progress: st.progress, xpToNext: st.xpToNext, atMax: st.atMax, prestige: st.prestige,
        canPrestige: st.canPrestige, prestigeTitle: PRESTIGE.title(st.prestige), nextPrestigeTitle: PRESTIGE.title(st.prestige + 1),
        emblem: PRESTIGE.emblem(st.prestige), nextEmblem: PRESTIGE.emblem(st.prestige + 1) || '⭐',
        xpToPrestige: Math.max(0, Stats.xpNeeded(100) - st.levelXP),
      },
      nextReward: st.canPrestige ? '⭐ Ready to prestige!' : st.prestige ? '' : next ? `Next reward: ${next.title} at Lv ${next.level}` : '',
      slots: SLOTS.map((x) => ({ id: x.id, title: x.title })),
      rewards: REWARDS.map((r) => ({
        id: r.id, title: r.title, level: r.level, slot: r.slot, value: r.value, unlocked: this.isUnlocked(r), worn: this.isUnlocked(r) && this.wearing(r),
        event: r.event, eventTitle: r.event ? (seasons.EVENTS.find((e) => e.id === r.event) || {}).title || null : null,
      })),
      today: this.stats.today,
      togetherMinutes: this.stats.togetherMinutes,
      history: this.stats.history(14),
      quietHours: { ...this.quietHours, active: this.quietHoursOn },
      calendar: this.calendarState(),
      events: this.eventsState(),
      sessions: card.rows.map((r, i) => ({ ...r, name: r.title.split(' · ')[0], project: r.title.split(' · ')[1] || '', precise: !r.detail.endsWith('(guessed)'), detail: r.detail.replace(' (guessed)', ''), id: i })),
      focus: { phase: this.focus.phase, label: this.focus.label, remaining: this.focus.remaining, total: (this.focus.phase === 'rest' ? Math.max(5, Math.round(this.focus.minutes / 5)) : this.focus.minutes) * 60, minutes: this.focus.minutes },
      blocklist: this.blocklist, blockDuringFocus: this.blockDuringFocus, strictBlock: this.strictBlock,
      look: { packs: listPacks(), spritePack: this.spritePackName, themeColor: this.themeHex, thoughtBubble: this.thoughtBubble, scale: this.scale },
      panicKey: { id: this.panicKeyID, ok: this.panicKeyOK !== false, options: [{ id: 'off', label: 'Off' }, ...PANIC_KEYS.map((k) => ({ id: k.id, label: k.label }))] },
      toggles: {
        wander: this.wander, gravity: this.gravity, walkOnWindows: this.walkOnWindows, quietInCalls: this.quietInCalls, typeAlong: this.typeAlong,
        notifications: this.notificationsOn, sounds: this.soundsOn, autoUpdate: this.autoUpdate,
        startAtLogin: loginSupported && !this.visitor && loginItem.get(app), startAtLoginSupported: loginSupported && !this.visitor,
        showPrestigeBadge: this.settings.get('showPrestigeBadge', true),
        walkOnWindowsSupported: process.platform !== 'linux',
      },
      hooks: { claudeInstalled: hooks.installed(), claudeLive: hooks.installed() && hooksLive(), kiroInstalled: this.kiroHooksOn && kiroHooks.installed(), kiroSupported: process.platform !== 'darwin' },
      update: { available: this.updater.available ? this.updater.available.version : null },
      sync: this.syncState(),
      companion: this.companion.summary(),
      trip: this.tripPanelState(),
      preview: (() => { const p = this.pose(t); return { hat: p.hat, trail: p.trail, aura: p.aura, companion: p.companion, golden: p.golden, prestige: p.prestige }; })(),
    };
  }

  async panelCall(action, payload) {
    payload = payload || {};
    // A visiting pet can't change this computer's setup.
    const hostOnly = ['hooks', 'kiro', 'transferImport', 'syncEnable', 'syncPacks', 'checkUpdates', 'installUpdate', 'openWizard', 'tripTake', 'movingApply', 'tripLetOut',
      'galleryInstall', 'calendarTest'];
    if (this.visitor && (hostOnly.includes(action) || (action === 'set' && payload.key === 'startAtLogin'))) {
      return { ok: false, error: `${this.config.petName} is just visiting this computer` };
    }
    switch (action) {
      case 'state': { const st = this.panelState(); this.panelPage = null; return st; }
      case 'set':
        switch (payload.key) {
          case 'scale': this.setScale(Math.min(4, Math.max(0.25, Number(payload.value) || 1))); this.settings.set(this.scaleKey, this.scale); break;
          case 'blocklist': this.settings.set('blocklist', payload.value ? parseBlocklist(payload.value.join('\n')) : BLOCK_DEFAULTS); break;
          case 'spritePack': this.chooseSprites(payload.value || ''); break;
          case 'startAtLogin': loginItem.set(app, !!payload.value); break;
          case 'panicKey':
            this.settings.set('panicKey', String(payload.value || 'ctrl-alt-h'));
            return { value: this.panicKeyID, ok: this.registerPanicKey() };
          case 'quietHours': this.settings.set('quietHours', seasons.quietSettings(payload.value)); return { ok: true, value: this.quietHours, active: this.quietHoursOn };
          case 'calendar': {
            if (this.visitor) return { ok: false, error: `${this.config.petName} is just visiting this computer` };
            const v = payload.value || {};
            this.settings.set('calendar', { ...this.calendarCfg, ...v });
            this.calendarNotified.clear();
            this.calendar.refresh(this.calendarCfg, { force: true }).catch(() => {});
            return { ok: true, value: this.calendarCfg };
          }
          default:
            this.settings.set(payload.key, payload.value);
            if (payload.key === 'sounds' && payload.value) this.playSound('pet');
            if (payload.key === 'wander') this.walkTarget = null;
        }
        return { ok: true };
      case 'wear': {
        const r = REWARDS.find((x) => x.id === payload.id);
        if (r && this.isUnlocked(r)) this.settings.set(r.key, r.slot === 'golden' ? !this.wearing(r) : (this.wearing(r) ? '' : r.value));
        return { ok: true };
      }
      case 'prestige': this.performPrestige(); return { ok: true };
      case 'focusStart': this.startFocus(payload.minutes || 25); return { ok: true };
      case 'focusStop': this.focus.stop(); return { ok: true };
      case 'jump': return { ok: await this.jump(payload.pid) };
      case 'hooks': this.toggleHooks(!!payload.install); return { ok: true };
      case 'kiro': this.setKiroHooks(!!payload.install); return { ok: true };
      case 'rename': {
        const pet = String(payload.petName || '').trim().slice(0, 20) || this.config.petName;
        const owner = String(payload.ownerName || '').trim().slice(0, 24) || this.config.ownerName;
        this.applyNames(pet, owner);
        return { ok: true };
      }
      case 'transferExport': return this.dialogCall('transfer-export');
      case 'copy': return this.dialogCall('copy', payload);
      case 'saveKey': return this.dialogCall('save-key', payload);
      case 'openKey': return this.dialogCall('open-key');
      case 'transferPreview': return this.dialogCall('transfer-preview', payload);
      case 'transferImport':
        try { return { ok: true, note: this.applyTransfer(transferKey.decode(payload.key)) }; } catch (e) { return { ok: false, error: e.message }; }
      case 'syncInspect': return { ...Sync.inspect(payload.path, this.sync.deviceID), localXP: this.stats.localXP };
      case 'syncChoose': {
        const r = await dialog.showOpenDialog(this.panel, { title: 'Choose a folder your cloud drive syncs', properties: ['openDirectory', 'createDirectory'] });
        return r.canceled || !r.filePaths.length ? {} : { path: r.filePaths[0] };
      }
      case 'syncEnable': this.enableSync(payload.path, payload.mode === 'fresh'); return { ok: true };
      case 'syncDisable': this.disableSync(); return { ok: true };
      case 'syncNow': this.syncTick(); return { ok: true };
      case 'syncPacks': this.setSyncPacks(!!payload.on); return { ok: true };
      case 'pack': return this.wizardCall('pack', payload);
      case 'openSprites': shell.openPath(paths.sprites); return { ok: true };
      case 'importPack': await this.importPackDialog(); return { ok: true };
      case 'exportPack': await this.exportPackDialog(); return { ok: true };
      case 'previewPoses': this.previewPoses(); return { ok: true };
      case 'bringHere': this.bringHere(); return { ok: true };
      case 'resize': this.toggleResizing(); return { ok: true };
      case 'checkUpdates': await this.checkForUpdates(true); return { ok: true };
      case 'installUpdate': this.installUpdate(); return { ok: true };
      case 'openWizard': this.openWizard(); return { ok: true };
      case 'quit': this.quit(); return { ok: true };
      case 'talk': this.openTalk(payload.topic || null); return { ok: true };
      case 'companion': {
        const r = this.companion.ui(String(payload.op || 'summary'), payload);
        this.applyCompanion(r.effects);
        return r.result;
      }
      case 'giftsFolder': shell.openPath(gifts.ensureFolder()); return { ok: true };
      case 'giftMake': {
        const file = gifts.make(payload.name);
        if (!file) return { ok: false, error: 'type a gift name' };
        shell.showItemInFolder(file);
        return { ok: true, file: path.basename(file) };
      }
      case 'tripDrives': return { drives: await this.refreshDrives() };
      case 'tripChooseFolder': {
        const r = await dialog.showOpenDialog(this.panel, { title: 'Choose a drive or folder for the trip', properties: ['openDirectory', 'createDirectory'] });
        return r.canceled || !r.filePaths.length ? null : { path: r.filePaths[0] };
      }
      case 'tripTake': return this.takeTrip(payload.path, !!payload.copyApp);
      case 'tripEject': return { ok: !!this.tripState && await trips.eject(this.tripState.path) };
      case 'tripCallHome': return { ok: this.callHome() };
      case 'tripWelcome': return this.tripWelcome();
      case 'tripLetOut': return { ok: this.letVisitorOut(payload.path) };
      case 'movingPack': return this.movingPackDialog(this.panel);
      case 'movingOpen': return this.movingOpenDialog(this.panel);
      case 'movingApply': return this.movingApply(payload.path);
      case 'calendarTest': {
        await this.calendar.refresh(this.calendarCfg, { force: true });
        const ok = this.calendar.status === 'ok';
        return { ok, events: this.calendar.events.length, next: this.calendar.next(), error: ok ? null : this.calendar.status };
      }
      case 'galleryList':
        try { return { ok: true, packs: await gallery.list(paths.sprites) }; } catch (e) { return { ok: false, packs: [], error: e.message || "couldn't reach the gallery" }; }
      case 'galleryInstall':
        try {
          await gallery.install(String(payload.id || ''), paths.sprites);
          return { ok: true };
        } catch (e) { return { ok: false, error: e.message || "couldn't install that pack" }; }
      case 'close': if (this.panel && !this.panel.isDestroyed()) this.panel.close(); return { ok: true };
      case 'log': console.error('panel:', payload.message); return { ok: true };
      default: return null;
    }
  }

  // MARK: Seasonal events

  birthdayToday() {
    try {
      const b = this.companion._state().memory.birthday;
      return !!b && b.value === seasons.monthDay(new Date());
    } catch (_) { return false; }
  }

  /** Once a minute: announce the event, count minutes together toward its rewards, unlock them at 60. */
  eventTick(active) {
    const ev = seasons.activeEvent();
    if (!ev || this.away) return;
    if (!this.settings.get(`eventSeen.${ev.key}`, false)) {
      this.settings.set(`eventSeen.${ev.key}`, true);
      this.applyCompanion(this.companion.event('eventStart', { id: ev.id, title: ev.title }));
    }
    const earned = this.settings.get('eventRewards', []);
    if (!active || ev.rewards.every((id) => earned.includes(id))) return;
    const minutes = this.settings.get(`event.${ev.key}`, 0) + 1;
    this.settings.set(`event.${ev.key}`, minutes);
    if (minutes < seasons.EVENT_GOAL) return;
    this.settings.set('eventRewards', [...new Set([...earned, ...ev.rewards])]);
    for (const id of ev.rewards) {
      const r = REWARDS.find((x) => x.id === id);
      if (r) this.settings.set(r.key, r.value);
    }
    this.transient = { mood: 'done', until: now() + 3 };
    this.playSound('level-up');
    this.applyCompanion(this.companion.event('eventEarned', { id: ev.id, title: ev.title }));
    const names = ev.rewards.map((id) => (REWARDS.find((x) => x.id === id) || {}).title).filter(Boolean).join(' and ');
    this.notify(`${ev.title} reward!`, `${this.config.petName} earned ${names}. They're yours to keep.`, 0);
  }

  eventsState() {
    const ev = seasons.activeEvent();
    const next = seasons.nextEvent();
    const earned = this.settings.get('eventRewards', []);
    return {
      active: ev ? {
        id: ev.id, title: ev.title, emoji: ev.emoji, until: ev.to, minutes: Math.min(seasons.EVENT_GOAL, this.settings.get(`event.${ev.key}`, 0)),
        goal: seasons.EVENT_GOAL, earned: ev.rewards.every((id) => earned.includes(id)), rewards: ev.rewards,
      } : null,
      next: next ? { id: next.id, title: next.title, from: next.from } : null,
    };
  }

  // MARK: Calendar heads-up

  calendarState() {
    const cfg = this.calendarCfg;
    const next = cfg.source === 'off' ? null : this.calendar.next();
    return {
      system: isWindows, source: cfg.source, icsUrl: cfg.icsUrl, lead: cfg.lead,
      status: cfg.source === 'off' ? 'off' : this.calendar.status, next: next ? { title: next.title, start: next.start, link: next.link } : null,
    };
  }

  /** Every 15 s: refresh when due, then remind `lead` minutes before a meeting and again when it starts. */
  calendarTick() {
    const cfg = this.calendarCfg;
    if (cfg.source === 'off') return;
    this.calendar.refresh(cfg).then(() => this.checkMeetings(cfg)).catch(() => {});
    this.checkMeetings(cfg);
  }

  checkMeetings(cfg) {
    if (this.panicHidden || cfg.source === 'off') return;
    const nowMs = Date.now();
    for (const e of this.calendar.events) {
      const soonKey = `${e.start}|${e.title}|soon`, nowKey = `${e.start}|${e.title}|now`;
      if (nowMs >= e.start - cfg.lead * 60000 && nowMs < e.start && !this.calendarNotified.has(soonKey)) {
        this.calendarNotified.add(soonKey);
        const minutes = Math.max(1, Math.round((e.start - nowMs) / 60000));
        this.transient = { mood: 'startled', until: now() + 1.2 };
        this.applyCompanion(this.companion.event('meetingSoon', { title: e.title, minutes }));
        this.notify(`📅 ${e.title} in ${minutes} minute${minutes === 1 ? '' : 's'}`, e.link ? `Click ${this.config.petName} to join` : 'Heads up!', 0);
        if (e.link) this.meetingLink = { link: e.link, title: e.title, until: e.start + 10 * 60000 };
      } else if (nowMs >= e.start && nowMs < e.start + 2 * 60000 && !this.calendarNotified.has(nowKey)) {
        this.calendarNotified.add(soonKey);
        this.calendarNotified.add(nowKey);
        this.transient = { mood: 'needsYou', until: now() + 3 };
        this.applyCompanion(this.companion.event('meetingNow', { title: e.title }));
        if (e.link) this.meetingLink = { link: e.link, title: e.title, until: e.start + 10 * 60000 };
      }
    }
  }

  // MARK: Playdates

  /** Every second: say where this pet is; if another pet is around, go say hi now and then. */
  presenceTick(t) {
    const visible = this.win.isVisible() && !this.away && !this.panicHidden;
    if (!visible) { presence.remove(); this.playdate = null; return; }
    const b = this.win.getBounds();
    const body = this.geometry ? this.geometry.bodyExtent : { halfWidth: 46, height: 84 };
    presence.write({ pet: this.config.petName, x: b.x + b.width / 2, y: b.y + b.height, width: body.halfWidth * 2, height: body.height, mood: this.mood, visitor: this.visitor });
    const myX = b.x + b.width / 2;
    const other = presence.others().sort((p, q) => Math.abs(p.x - myX) - Math.abs(q.x - myX))[0] || null;
    const top = this.topSession;
    const step = presence.playdateStep({
      me: { x: myX, halfWidth: body.halfWidth, mood: this.mood, busy: !!(top && top.activity !== 'idle' && top.activity !== 'done'), blocked: !!(this.velocity || this.press || this.resizing || this.talkOpen) },
      other, state: this.playdate, met: this.metPets, t, nextAt: this.nextPlaydateAt,
    });
    this.playdate = step.state;
    if (step.action === 'play') {
      // Close enough: face each other and play.
      this.walkTarget = null;
      this.walkDirection = step.direction;
      this.transient = { mood: 'petted', until: t + 4 };
      this.metPets.add(other.pid);
      this.applyCompanion(this.companion.event('playdate', { other: other.pet, first: step.first }));
      this.nextPlaydateAt = t + 180;
      this.savePosition();
    } else if (step.action === 'giveUp') {
      this.nextPlaydateAt = t + 60;
    } else if (step.action === 'walk') {
      // Walk to a spot just beside the other pet (both walk, so they meet in the middle).
      const wa = this.display().workArea;
      this.walkTarget = Math.max(wa.x - 40, Math.min(wa.x + wa.width - this.size.width + 40, step.center - this.size.width / 2));
    }
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
    if (this.visitor || this.panicHidden || !this.notificationsOn || !Notification.isSupported()) return;
    if (this.quietHoursOn && !this.quietHours.notifications) return;
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

  /** An agent finished: say what it did (from its last reply in the session log) and notify. */
  taskFinished(s, project, guessed = false) {
    this.playSound('done');
    this.gainXP(10, false, (d) => { d.tasks++; });
    // The final reply lands in the log a moment after the turn ends.
    setTimeout(() => {
      const summary = sessionSummary(s);
      if (summary) this.summaries.set(s.id, summary);
      this.say(summary ? `${s.name}: ${summary} ✓` : guessed ? `${s.name} looks done ✨` : `${s.name} is done! ✨`, summary ? 6 : 4);
      this.notifyUnlessWatching(s, `${s.name} is done ✨`, summary || project);
    }, 900);
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
      // Needs meters: XP earns coins for treats.
      this.applyCompanion(this.companion.event('xp', { amount: xp }));
    }
    this.levelUp(level);
  }

  levelUp(level) {
    if (!level) return;
    this.transient = { mood: 'done', until: now() + 3 };
    this.playSound('level-up');
    if (this.stats.prestige >= PRESTIGE.maxRank) {
      const big = level % 100 === 0;
      this.say(big ? `Prestige Master level ${level}! 💎` : `level ${level}! 💎`, big ? 5 : 3);
      if (big) this.notify(`Level ${level}!`, `${this.config.petName} is a level ${level} Prestige Master 💎`, 0);
      return;
    }
    if (this.stats.canPrestige) {
      this.say('MAX LEVEL! prestige from the tray menu → Rewards ⭐', 6);
      this.notify('Level 100!', `${this.config.petName} can prestige now: tray menu → Rewards → Prestige`, 0);
      return;
    }
    // First time through, new rewards are worn right away so you see them.
    const fresh = this.stats.prestige === 0 ? REWARDS.filter((r) => r.level === level) : [];
    for (const r of fresh) this.settings.set(r.key, r.value);
    if (fresh.length) {
      this.say(`level ${level}! unlocked ${fresh[0].title} ✨`, 5);
      this.notify(`Level ${level}!`, `${this.config.petName} unlocked ${fresh[0].title}. Change rewards in the tray menu.`, 0);
    } else {
      this.say(`level up! ${this.stats.rankTitle} ✨`, 4);
    }
  }

  /** Rewards stay unlocked forever once you've prestiged. */
  isUnlocked(r) {
    if (r.event) return this.settings.get('eventRewards', []).includes(r.id);
    return this.stats.prestige > 0 || this.stats.level >= r.level;
  }
  wearing(r) { return r.slot === 'golden' ? this.settings.get(r.key, false) === true : this.settings.get(r.key, '') === r.value; }
  worn(slot) { return REWARDS.find((r) => r.slot === slot && this.isUnlocked(r) && this.wearing(r)); }

  /** One-time setup when the reward track changes: carry over what you wore, then point at the menu. */
  wearEarnedRewardsOnce() {
    if (this.settings.get('aura', false) === true && !this.settings.get('auraStyle', '')) this.settings.set('auraStyle', 'golden');
    if (this.settings.get('rewardsVersion', 0) >= 2) return;
    this.settings.set('rewardsVersion', 2);
    const earned = REWARDS.filter((r) => this.isUnlocked(r));
    if (!earned.length) return;
    for (const slot of ['hat', 'trail', 'companion']) {
      if (this.worn(slot)) continue;
      const best = [...earned].reverse().find((r) => r.slot === slot);
      if (best) this.settings.set(best.key, best.value);
    }
    this.say(`${earned.length} reward${earned.length === 1 ? '' : 's'} unlocked so far! see the tray menu → Rewards ✨`, 5);
  }

  async prestigeNow() {
    if (!this.stats.canPrestige) return;
    const next = this.stats.prestige + 1;
    const { response } = await dialog.showMessageBox({
      type: 'question', buttons: ['Prestige', 'Not yet'], defaultId: 0, cancelId: 1,
      message: `Enter ${PRESTIGE.title(next)}?`,
      detail: next === PRESTIGE.maxRank
        ? `${this.config.petName} goes back to level 1 as a Prestige Master and can then level all the way to 1000. Every reward stays unlocked.`
        : `${this.config.petName} goes back to level 1 and earns a ${PRESTIGE.emblem(next)} prestige badge. Every reward stays unlocked.`,
    });
    if (response !== 0) return;
    this.performPrestige();
  }

  performPrestige() {
    if (!this.stats.canPrestige) return;
    const next = this.stats.prestige + 1;
    this.stats.doPrestige();
    this.transient = { mood: 'done', until: now() + 4 };
    this.playSound('level-up');
    this.say(`${PRESTIGE.title(next).toUpperCase()}! back to level 1 ⭐`, 6);
    this.notify(PRESTIGE.title(next), `${this.config.petName} prestiged! Every reward stays unlocked.`, 0);
  }

  rewardsMenu() {
    const st = this.stats;
    const items = [{ label: st.rankTitle + (st.atMax ? ' · max' : ` · ${st.xpToNext} XP to next level`), enabled: false }];
    if (st.canPrestige) items.push({ label: `⭐ Prestige now → ${PRESTIGE.title(st.prestige + 1)}`, click: () => this.prestigeNow() });
    else if (st.prestige === 0) {
      const next = REWARDS.find((r) => r.level > st.level);
      if (next) items.push({ label: `Next: ${next.title} at Lv ${next.level} (${Stats.xpNeeded(next.level) - st.levelXP} XP to go)`, enabled: false });
    } else if (st.prestige < PRESTIGE.maxRank) {
      items.push({ label: `Reach level 100 to prestige (${Stats.xpNeeded(100) - st.levelXP} XP to go)`, enabled: false });
    }
    for (const slot of SLOTS) {
      items.push({ type: 'separator' }, { label: slot.title, enabled: false });
      for (const r of REWARDS.filter((x) => x.slot === slot.id)) {
        const unlocked = this.isUnlocked(r);
        const ev = r.event && seasons.EVENTS.find((e) => e.id === r.event);
        items.push({
          label: unlocked ? r.title : `🔒 ${r.title} · ${ev ? `${ev.title} event` : `Lv ${r.level}`}`, type: 'checkbox', enabled: unlocked, checked: unlocked && this.wearing(r),
          click: () => this.settings.set(r.key, r.slot === 'golden' ? !this.wearing(r) : (this.wearing(r) ? '' : r.value)),
        });
      }
      if (slot.id !== 'golden') items.push({ label: 'None', type: 'checkbox', checked: !this.worn(slot.id), click: () => this.settings.set(slot.key, '') });
    }
    if (st.prestige > 0) {
      items.push({ type: 'separator' }, {
        label: 'Show prestige badge', type: 'checkbox', checked: this.settings.get('showPrestigeBadge', true),
        click: () => this.toggle('showPrestigeBadge', true),
      });
    }
    return items;
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
      together: (() => { const m = this.stats.togetherMinutes; return `⏱ ${m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`} together`; })(),
      rank: this.stats.rankTitle, atMax: this.stats.atMax,
      quietHours: this.quietHoursOn ? `🌙 Quiet hours until ${this.quietHours.to}` : '',
      needs: (() => {
        const n = this.companion.summary().needs;
        return n && n.enabled !== false && typeof n.energy === 'number' ? `⚡ ${Math.round(n.energy)} energy · 🎈 ${Math.round(n.fun)} fun · 🪙 ${n.coins || 0}` : '';
      })(),
      nextReward: this.stats.canPrestige ? '⭐ Ready to prestige! (tray menu → Rewards)'
        : this.stats.prestige ? '' : (() => { const n = REWARDS.find((r) => r.level > this.stats.level); return n ? `Next reward: ${n.title} at Lv ${n.level}` : ''; })(),
      accent: this.themeHex || '#FF9500',
      rows: [...this.sessions].sort((a, b) => PRIORITY.indexOf(b.activity) - PRIORITY.indexOf(a.activity)).map((s) => {
        const secs = Math.round(t - (this.busySince.get(s.id) || t));
        const usage = s.isCodex ? (codexState(s.logPath, true) || {}).tokens : this.tokens.usage(s.logPath);
        return {
          title: s.name + (s.project ? ` · ${s.project}` : ''), detail: s.detail + (s.precise ? '' : ' (guessed)'),
          color: STATUS_COLORS[s.activity], elapsed: s.activity === 'idle' ? 'idle' : secs >= 60 ? `${Math.floor(secs / 60)}m` : `${secs}s`,
          tokens: usage ? `${compact(usage.output)} out · ${compact(usage.context)} context` : '', pid: s.pid || 0,
          summary: this.summaries.get(s.id) || '',
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
    // A .gift file dropped on the pet: open the talk and give it.
    const gift = (files || []).find((f) => /\.gift$/i.test(f));
    if (gift) { this.pendingGift = gift; return this.openTalk(`gift:${gifts.topicID(gift)}`); }
    const home = (files || []).find((f) => /\.(chr|deskpet)$/i.test(f));
    if (home) return this.openMovingFile(home);
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

  // MARK: Cloud sync

  syncProfile() {
    const settings = {};
    for (const key of TRANSFER_SETTINGS) if (key in this.settings.values) settings[key] = this.settings.values[key];
    return {
      names: { petName: this.config.petName, ownerName: this.config.ownerName }, settings, prestige: this.stats.prestige, prestigeBase: this.stats.prestigeBase,
      companion: this.companion.exportData(),
    };
  }

  syncTick() {
    const levelBefore = this.stats.level;
    const remote = this.stats.remote;
    if (!remote.prestige) remote.prestige = { rank: this.stats.prestige, base: this.stats.prestigeBase };
    let result;
    try { result = this.sync.sync(this.stats.deviceExport, this.syncProfile()); } catch (e) { this.sync.error = e.message; return; }
    if (!result) return;
    remote.xp = result.remoteXP;
    remote.days = result.remoteDays;
    if (result.newerProfile) this.applySyncProfile(result.newerProfile);
    if (this.stats.level > levelBefore) this.levelUp(this.stats.level);
  }

  /** Another device changed names, settings, or prestige more recently: follow it. */
  applySyncProfile(p) {
    const packBefore = this.spritePackName;
    const names = p.names || {};
    if ((names.petName && names.petName !== this.config.petName) || (names.ownerName && names.ownerName !== this.config.ownerName)) {
      const petName = names.petName || this.config.petName, ownerName = names.ownerName || this.config.ownerName;
      saveConfig({ petName, ownerName });
      this.config = { ...this.config, petName, ownerName };
    }
    for (const [k, v] of Object.entries(p.settings || {})) if (TRANSFER_SETTINGS.includes(k) && v !== null) this.settings.set(k, v);
    if (typeof p.prestige === 'number' && typeof p.prestigeBase === 'number') this.stats.remote.prestige = { rank: p.prestige, base: p.prestigeBase };
    if (p.companion) this.companion.mergeData(p.companion);
    if (this.spritePackName !== packBefore) this.loadSprites(false);
    this.sync.accept(this.syncProfile());
  }

  syncState() {
    const ago = (ms) => { const s = Math.round((Date.now() - ms) / 1000); return s < 60 ? `${s} sec. ago` : s < 3600 ? `${Math.round(s / 60)} min. ago` : `${Math.round(s / 3600)} hr. ago`; };
    return {
      enabled: this.sync.enabled, folder: this.sync.folder, folderName: this.sync.folder ? path.basename(this.sync.folder) : null,
      devices: this.sync.devices.map((d) => ({ name: d.name, platform: d.platform, me: d.id === this.sync.deviceID, xp: d.xp, updated: ago(d.updated * 1000) })),
      lastSync: this.sync.lastSync ? ago(this.sync.lastSync) : null, error: this.sync.error,
      syncPacks: this.settings.get('syncPacks', false), candidates: Sync.candidates(), deviceName: this.sync.deviceName,
    };
  }

  enableSync(folder, fresh) {
    if (fresh) this.stats.resetLocal();
    const first = Sync.inspect(folder, this.sync.deviceID).devices === 0;
    this.sync.folder = folder;
    this.stats.remote.prestige = { rank: this.stats.prestige, base: this.stats.prestigeBase };
    this.sync.prepareJoin(this.syncProfile(), first);
    this.syncTick();
    this.say(fresh ? 'synced! picking up where you left off ☁️' : 'sync is on: progress adds up across devices ☁️', 4);
  }

  disableSync() {
    this.stats.leaveSync();
    this.sync.disable();
    if (this.settings.get('syncPacks', false)) this.setSyncPacks(false);
    this.say('sync is off ☁️', 2.5);
  }

  /** Moving packs into the sync folder copies the local ones there first. */
  setSyncPacks(on) {
    if (on && this.sync.spritesFolder) {
      fs.mkdirSync(this.sync.spritesFolder, { recursive: true });
      for (const name of fs.existsSync(paths.localSprites) ? fs.readdirSync(paths.localSprites) : []) {
        const target = path.join(this.sync.spritesFolder, name);
        if (!name.startsWith('.') && !fs.existsSync(target)) fs.cpSync(path.join(paths.localSprites, name), target, { recursive: true });
      }
    }
    this.settings.set('syncPacks', on);
    setSpritesOverride(on ? this.sync.spritesFolder : null);
    this.loadSprites(false);
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
      config: { ownerName: this.config.ownerName, petName: this.config.petName }, settings, stats: this.stats.exported,
      companion: this.companion.exportData(),
    };
  }

  /** Applies an imported key; returns a note about anything that didn't come along. `quiet` skips the welcome line. */
  applyTransfer(payload, { quiet = false } = {}) {
    const c = payload.config || {};
    const ownerName = c.ownerName || this.config.ownerName, petName = c.petName || this.config.petName;
    saveConfig({ ownerName, petName });
    this.config = { ...this.config, ownerName, petName };
    const s = payload.settings || {};
    for (const key of TRANSFER_SETTINGS) if (key in s && s[key] !== null) this.settings.set(key, s[key]);
    for (const [name, value] of Object.entries(s.scales || {})) this.settings.set(`scale.${name}`, value);
    if (payload.stats) this.stats.replace(payload.stats);
    if (payload.companion) this.companion.replaceData(payload.companion);
    this.settings.set('setupComplete', true);
    let note = '';
    if (this.spritePackName && !listPacks().includes(this.spritePackName)) {
      note = `the ${this.spritePackName} sprite pack isn't on this device: export it as a zip and drop it on me`;
      this.spritePackName = '';
    }
    this.loadSprites(false);
    this.transient = { mood: 'done', until: now() + 3 };
    if (!quiet || note) this.say(note || `welcome home, ${ownerName}! everything's here ✨`, 5);
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
    if (this.panicHidden) this.togglePanic();
    if (this.away) return;
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
    if (this.panicHidden) return this.togglePanic();
    if (this.away) return;
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
    const loginSupported = true;
    switch (action) {
      case 'state':
        return {
          platform: isWindows ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux',
          chrome: 'custom',
          ownerName: this.config.ownerName,
          petName: this.config.petName,
          packs: listPacks(),
          spritePack: this.spritePackName,
          themeColor: this.themeHex,
          thoughtBubble: this.thoughtBubble,
          wander: this.wander,
          gravity: this.gravity,
          startAtLogin: loginSupported && loginItem.get(app),
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
            loginItem.set(app, !!payload.value);
            return { value: loginItem.get(app) };
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
      case 'moving-open': return this.movingOpenDialog(this.wizard);
      case 'moving-apply': return this.movingApply(payload.path);
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

  // MARK: Trips (docs/trips-and-moving.md)

  /** `{ id, path, volume, leftAt, sawGone }` while this computer's pet is away on a trip. */
  get tripState() { return this.visitor ? null : this.settings.get('trip', null); }
  get away() { return !!this.tripState; }

  tripHome() { return { device: this.deviceID, name: trips.deviceName(), os: trips.OS_NAME }; }

  async refreshDrives() {
    this.drivesAt = Date.now();
    try { this.drives = await trips.listDrives(); } catch (_) { this.drives = []; }
    return this.drives;
  }

  /** Someone else's pets waiting on a plugged-in drive (not yet let out). */
  doors() { return this.visitor ? [] : this.visitorsAtDoor.filter((d) => !this.letOut.has(d.id)); }

  updateTray() {
    if (!this.tray) return;
    const pet = this.config.petName;
    const tip = this.panicHidden ? `DeskPet · 🙈 hidden${this.panicKeyLabel ? ` (${this.panicKeyLabel} to show)` : ''}`
      : this.visitor ? `DeskPet · 🧳 ${pet} is visiting` : this.away ? `DeskPet · 🧳 ${pet} is out with you` : 'DeskPet';
    this.tray.setToolTip(tip);
    if (process.platform === 'darwin') this.tray.setTitle(this.visitor || this.away ? '🧳' : '');
  }

  hidePet() {
    this.walkTarget = null;
    this.velocity = null;
    this.hideCard();
    if (this.talk && !this.talk.isDestroyed()) this.talk.close();
    if (!this.win.isDestroyed()) this.win.hide();
  }

  showPet() {
    if (!this.win.isDestroyed()) this.win.showInactive();
    this.transient = { mood: 'done', until: now() + 3 };
    this.updateTray();
  }

  /** Every ~3 s: the trip coming home, luggage from an earlier trip, or someone else's pet at the door. */
  tripWatch() {
    if (this.visitor) {
      // The drive went away under us: nothing left to save to.
      if (this.visit && !fs.existsSync(path.join(this.visit.folder, 'trip.json'))) { this.visit.gone = true; quitApp(); }
      return;
    }
    const state = this.tripState;
    const first = !this.tripChecked;
    this.tripChecked = true;
    const found = trips.findTrips(state ? [state.path] : []);
    const decision = trips.watchDecision({ state, found, deviceID: this.deviceID, first });
    if (decision.sawGone) this.settings.set('trip', { ...state, sawGone: true });
    if (decision.comeHome) this.returnHome(decision.comeHome.folder, decision.comeHome.trip);
    for (const f of decision.luggage) this.absorbLuggage(f.folder, f.trip);
    const doors = decision.doors;
    this.visitorsAtDoor = doors;
    for (const d of doors) {
      if (this.announcedDoors.has(d.id)) continue;
      this.announcedDoors.add(d.id);
      if (!this.away) this.say(`🧳 ${d.pet} is visiting from ${d.homeName}! let them out from the menu`, 6);
      this.notify(`${d.pet} is visiting! 🧳`, `${d.pet} came along from ${d.homeName}. Choose "Let ${d.pet} out" in the DeskPet menu.`, 0);
    }
  }

  /** Brings back what the pet did on a trip: XP and stats, memories and affection, any new names. */
  absorbTrip(folder, trip) {
    const profile = trip.profile || {};
    const level = this.stats.absorb(profile.stats, (trip.departure || {}).stats);
    if (profile.companion) this.companion.mergeData(profile.companion);
    const c = profile.config || {};
    if ((c.petName && c.petName !== this.config.petName) || (c.ownerName && c.ownerName !== this.config.ownerName)) {
      const petName = c.petName || this.config.petName, ownerName = c.ownerName || this.config.ownerName;
      saveConfig({ petName, ownerName });
      this.config = { ...this.config, petName, ownerName };
      this.companion.setNames(ownerName, petName);
    }
    try { trips.markHome(folder, trip); } catch (_) { /* read-only drive: it's absorbed here either way */ }
    return level;
  }

  returnHome(folder, trip) {
    const state = this.tripState;
    const leftAt = state ? state.leftAt : Date.parse(trip.leftAt) || Date.now();
    const level = this.absorbTrip(folder, trip);
    this.settings.set('trip', null);
    this.settings.flush();
    this.showPet();
    this.levelUp(level);
    this.applyCompanion(this.companion.event('tripReturn', { minutes: Math.max(0, Math.round((Date.now() - leftAt) / 60000)), visits: (trip.visits || []).map((v) => v.device) }));
  }

  absorbLuggage(folder, trip) {
    this.levelUp(this.absorbTrip(folder, trip));
    this.applyCompanion(this.companion.event('tripLuggage'));
  }

  async takeTrip(base, copyApp) {
    const pet = this.config.petName;
    if (this.visitor) return { ok: false, error: `${pet} is just visiting: trips start from home` };
    if (this.away) return { ok: false, error: `${pet} is already on a trip` };
    if (!base) return { ok: false, error: 'choose a drive or a folder first' };
    let folder;
    try {
      const pack = this.spritePackName;
      const made = trips.createTrip({ base, profile: this.transferPayload(), home: this.tripHome(), pack, packDir: pack ? path.join(paths.sprites, pack) : null });
      folder = made.folder;
      if (copyApp) await trips.copyApp(trips.appCopyInfo({ packaged: app.isPackaged }), folder);
      const drive = trips.driveOf(folder);
      const known = drive && (this.drives || []).find((d) => path.resolve(d.path) === path.resolve(drive));
      this.settings.set('trip', { id: made.trip.id, path: folder, volume: known ? known.name : path.basename(drive || base), leftAt: Date.now(), sawGone: false });
      this.settings.flush();
      this.applyCompanion(this.companion.event('tripLeave'));
      setTimeout(() => { if (this.away) this.hidePet(); }, 3500);
      this.updateTray();
      return { ok: true, ejectable: !!drive };
    } catch (e) {
      // Don't leave a half-packed trip behind to be found later as "luggage".
      if (folder && !this.away) fs.rmSync(path.join(folder, 'trip.json'), { force: true });
      return { ok: false, error: e.code === 'ENOSPC' ? 'the drive is full' : e.message };
    }
  }

  /** Comes home without the drive; whatever happened on the trip comes back later as luggage. */
  callHome() {
    if (!this.away) return false;
    this.settings.set('trip', null);
    this.showPet();
    this.applyCompanion(this.companion.event('tripCalledHome'));
    return true;
  }

  tripWelcome() {
    const state = this.tripState;
    if (!state) return { ok: false, error: 'no one is away' };
    const mine = trips.findTrips([state.path]).find((f) => f.trip.id === state.id && f.trip.status === 'away');
    if (!mine) return { ok: false, error: `can't find ${this.config.petName}'s trip folder: plug the drive in first` };
    this.returnHome(mine.folder, mine.trip);
    return { ok: true };
  }

  /** Starts a second DeskPet for a visiting pet (its own temp profile; this computer's pet stays as it is). */
  letVisitorOut(folder) {
    const trip = folder && trips.readTrip(folder);
    if (this.visitor || !trip || trip.status !== 'away' || (trip.home && trip.home.device === this.deviceID)) return false;
    const exe = process.env.APPIMAGE || process.execPath;
    const args = app.isPackaged ? ['--trip', folder] : [app.getAppPath(), '--trip', folder];
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    try { spawn(exe, args, { detached: true, stdio: 'ignore', env }).unref(); } catch (e) { this.say(`couldn't let ${trip.pet} out: ${e.message}`, 4); return false; }
    this.letOut.add(trip.id);
    if (!this.away) this.say(`come on in, ${trip.pet}! 👋`, 3);
    return true;
  }

  // Visitor side

  visitAllowed() {
    const msg = trips.visitCheck(trips.readTrip(paths.trip.folder), this.deviceID);
    if (!msg) return true;
    console.log(`visitor: ${msg}`);
    if (!process.argv.includes('--self-test')) dialog.showMessageBoxSync({ type: 'info', message: 'DeskPet', detail: msg, buttons: ['OK'] });
    quitApp();
    return false;
  }

  startVisit() {
    const folder = paths.trip.folder;
    const trip = trips.readTrip(folder);
    this.applyTransfer(trip.profile || {}, { quiet: true });
    trip.visits = trip.visits || [];
    trip.visits.push({ device: trips.deviceName(), os: trips.OS_NAME, at: new Date().toISOString(), minutes: 0 });
    this.visit = { folder, id: trip.id, homeName: (trip.home && trip.home.name) || 'home', index: trip.visits.length - 1, arrivedAt: Date.now() };
    try { trips.writeTrip(folder, trip); } catch (_) { /* read-only drive: progress stays here until quit */ }
    try {
      fs.mkdirSync(paths.visitors, { recursive: true });
      fs.writeFileSync(path.join(paths.visitors, String(process.pid)), trip.id);
    } catch (_) { /* marker is only a hint for the macOS app */ }
    this.applyCompanion(this.companion.event('tripArrive', { host: trips.deviceName(), homeName: this.visit.homeName, first: trip.visits.length === 1 }));
    setInterval(() => this.saveVisit(), 20000);
  }

  /** Writes the visitor's progress back to the drive. */
  saveVisit() {
    if (!this.visit || this.visit.gone) return false;
    const trip = trips.readTrip(this.visit.folder);
    if (!trip || trip.id !== this.visit.id) return false;
    trip.profile = this.transferPayload();
    const v = (trip.visits || [])[this.visit.index];
    if (v) v.minutes = Math.round((Date.now() - this.visit.arrivedAt) / 60000);
    try { trips.writeTrip(this.visit.folder, trip); return true; } catch (_) { return false; }
  }

  goHome() {
    this.say(this.companion.line('trip.goHome', 'see you at home! 🏠'), 2);
    this.saveVisit();
    setTimeout(() => this.quit(), 1600);
  }

  // MARK: Moving homes (<Pet>.chr files)

  movingSummary(obj) {
    return transferKey.summary(obj.profile) + (obj.pack && obj.pack.name ? ` · brings the ${obj.pack.name} look` : '');
  }

  async movingPackDialog(parent) {
    const r = await dialog.showSaveDialog(parent && !parent.isDestroyed() ? parent : undefined, {
      title: `Pack up ${this.config.petName}`, defaultPath: `${this.config.petName}.chr`, filters: [{ name: 'DeskPet moving-homes file', extensions: ['chr'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false };
    try {
      const pack = this.spritePackName;
      const { json, note } = trips.packMovingFile({ profile: this.transferPayload(), packName: pack, packDir: pack ? path.join(paths.sprites, pack) : null });
      fs.writeFileSync(r.filePath, json);
      const fx = this.companion.event('movingOut');
      this.applyCompanion(fx);
      if (!fx.some((f) => f.type === 'say')) this.say('all packed! 📦', 3);
      return { ok: true, path: r.filePath, note };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  async movingOpenDialog(parent) {
    const r = await dialog.showOpenDialog(parent && !parent.isDestroyed() ? parent : undefined, {
      title: 'Move in from a file', properties: ['openFile'], filters: [{ name: 'DeskPet moving-homes file', extensions: ['chr', 'deskpet'] }],
    });
    if (r.canceled || !r.filePaths.length) return { ok: false };
    try { return { ok: true, path: r.filePaths[0], summary: this.movingSummary(trips.readMovingFile(r.filePaths[0])) }; } catch (e) { return { ok: false, error: e.message }; }
  }

  movingApply(file) {
    if (this.visitor) return { ok: false, error: `${this.config.petName} is just visiting this computer` };
    try {
      const obj = trips.readMovingFile(file);
      trips.unpackMovingPack(obj, paths.sprites);
      const note = this.applyTransfer(obj.profile, { quiet: true });
      const fx = this.companion.event('movedIn');
      this.applyCompanion(fx);
      if (!note && !fx.some((f) => f.type === 'say')) this.say(`new home! everything's here, ${this.config.ownerName} ✨`, 5);
      return { ok: true, note };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  /** Opened from a drop, the command line, or the OS: preview, confirm, move in. */
  async openMovingFile(file) {
    if (this.visitor) { this.say("I'm just visiting! move in at home 🧳", 3); return; }
    let obj;
    try { obj = trips.readMovingFile(file); } catch (e) { this.say(`hmm: ${e.message}`, 4); return; }
    const { response } = await dialog.showMessageBox({
      type: 'question', buttons: ['Move in', 'Cancel'], defaultId: 0, cancelId: 1,
      message: `Move ${this.movingSummary(obj)} in?`,
      detail: 'This replaces the names, level, stats, and settings on this computer (a backup of the stats is kept).',
    });
    if (response !== 0) return;
    const r = this.movingApply(file);
    if (!r.ok) this.say(`hmm: ${r.error}`, 4);
  }

  tripPanelState() {
    const state = this.tripState;
    if (!this.visitor && Date.now() - this.drivesAt > 5000) this.refreshDrives();
    const copy = trips.appCopyInfo({ packaged: app.isPackaged });
    return {
      mode: this.visitor ? 'visiting' : state ? 'away' : 'home',
      drives: this.drives || [],
      away: state ? { volume: state.volume, leftAt: state.leftAt, minutes: Math.round((Date.now() - state.leftAt) / 60000), present: fs.existsSync(path.join(state.path, 'trip.json')) } : null,
      visiting: this.visit ? { host: trips.deviceName(), homeName: this.visit.homeName } : null,
      visitors: this.doors().map(({ path: p, pet, homeName }) => ({ path: p, pet, homeName })),
      appCopy: { possible: copy.possible, size: copy.size },
    };
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
  exitWatchdog(5);
  app.quit();
  setTimeout(() => exitNow(0), 1500).unref();
}

/** Quits without cleanup handlers (snapshots, tests, and when a normal quit stalls). */
function exitNow(code) {
  exitWatchdog(2);
  presence.remove();
  for (const w of BrowserWindow.getAllWindows()) { try { w.destroy(); } catch (_) { /* already gone */ } }
  app.exit(code);
}

/** On some Linux X servers Electron blocks while tearing down transparent windows, so a helper makes sure we go. */
let watchdogStarted = false;
function exitWatchdog(seconds) {
  if (process.platform !== 'linux' || watchdogStarted) return;
  watchdogStarted = true;
  try {
    spawn('sh', ['-c', `sleep ${seconds}; kill -9 ${process.pid} 2>/dev/null`], { detached: true, stdio: 'ignore' }).unref();
  } catch (_) { /* no shell */ }
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
  win.webContents.on('console-message', (e) => console.log('renderer:', e.message));
  win.webContents.on('render-process-gone', (_e, d) => { console.error('renderer gone:', d.reason); exitNow(3); });
  setTimeout(() => { console.error('snapshot timed out'); exitNow(2); }, 45000);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { query: { snapshot: '1' } });
  ipcMain.once('snapshot-done', (_e, dataURL) => {
    if (process.argv.includes('--make-gallery-packs')) {
      const index = require('../scripts/gallery-packs').write(JSON.parse(dataURL), path.join(__dirname, '..', '..', 'packs'));
      console.log(`wrote ${index.length} gallery packs`);
      return exitNow(0);
    }
    const out = path.join(__dirname, '..', 'test-output');
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, packName ? `snapshot-${packName}.png` : 'snapshot.png');
    fs.writeFileSync(file, Buffer.from(dataURL.split(',')[1], 'base64'));
    console.log(`wrote ${file}`);
    exitNow(0);
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
    if (process.argv.includes('--make-gallery-packs')) {
      win.webContents.send('snapshot', { gallery: require('../scripts/gallery-packs').request() });
      return;
    }
    win.webContents.send('snapshot', { pack: source, ownerName: loadConfig().ownerName });
  });
}

// MARK: - Startup

if (process.argv.includes('--snapshot') || process.argv.includes('--make-gallery-packs')) {
  app.whenReady().then(runSnapshot);
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (process.platform === 'darwin') app.dock.hide();
  if (paths.trip) {
    // A fresh profile for every visit: it's filled from trip.json, and the drive keeps the real copy.
    fs.rmSync(paths.root, { recursive: true, force: true });
    fs.mkdirSync(paths.root, { recursive: true });
  }
  let pet;
  // A .chr moving-homes file passed on the command line (Windows "Open with", Linux file managers) or by macOS.
  const movingArg = (argv) => (argv || []).find((a) => /\.(chr|deskpet)$/i.test(a) && fs.existsSync(a));
  let pendingMoving = movingArg(process.argv);
  app.on('open-file', (e, file) => {
    e.preventDefault();
    if (!/\.(chr|deskpet)$/i.test(file)) return;
    if (pet && pet.win) pet.openMovingFile(file); else pendingMoving = file;
  });
  app.on('second-instance', (_e, argv) => {
    const file = movingArg(argv);
    if (pet && file) pet.openMovingFile(file);
    else if (pet) pet.openPanel();
  });
  const selfTest = process.argv.includes('--self-test');
  if (selfTest) {
    // Make startup failures visible (and fatal) when testing.
    const fail = (e) => { console.error('self-test failed:', e && e.stack ? e.stack : e); exitNow(1); };
    process.on('uncaughtException', fail);
    process.on('unhandledRejection', fail);
    setTimeout(() => { console.error('self-test timed out'); exitNow(2); }, ((Number(process.argv[process.argv.indexOf('--self-test-seconds') + 1]) || 7) + 23) * 1000);
  }
  app.whenReady().then(() => {
    pet = new Pet();
    pet.registerPanicKey();
    app.on('will-quit', () => globalShortcut.unregisterAll());
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
    ipcMain.handle('panel', (_e, action, payload) => pet.panelCall(action, payload));
    ipcMain.handle('talk', (_e, action, payload) => pet.talkCall(action, payload));
    ipcMain.on('drop-files', (_e, files) => pet.onDropFiles(files));
    ipcMain.on('drag-hover', () => { pet.transient = { mood: 'startled', until: now() + 1 }; pet.say("ooh, what's that? 👀", 1.5); });
    ipcMain.on('card-size', (_e, size) => { pet.cardSize = size; if (pet.card.isVisible()) pet.positionCard(); });
    ipcMain.on('card-jump', (_e, pid) => pet.jump(pid));
    if (!pet.start()) return;
    if (pendingMoving) setTimeout(() => pet.openMovingFile(pendingMoving), 1500);
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
        quitApp();
      });
    }
    // `--panel-snapshot`: screenshot every control center page to test-output/, then quit.
    if (process.argv.includes('--panel-snapshot')) {
      setTimeout(() => { console.error('panel snapshot timed out'); exitNow(2); }, 60000);
      pet.openPanel();
      pet.panel.webContents.on('console-message', (e) => console.log('panel:', e.message));
      pet.panel.webContents.once('did-finish-load', async () => {
        const out = path.join(__dirname, '..', 'test-output');
        fs.mkdirSync(out, { recursive: true });
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await wait(1500);
        for (const page of ['home', 'insights', 'companion', 'rewards', 'look', 'focus', 'agents', 'behavior', 'trips', 'account', 'about']) {
          await pet.panel.webContents.executeJavaScript(`window.__panelShow('${page}')`);
          await wait(page === 'look' || page === 'rewards' ? 1800 : 900);
          fs.writeFileSync(path.join(out, `panel-${page}.png`), (await pet.panel.webContents.capturePage()).toPNG());
          if (['insights', 'companion', 'behavior', 'look'].includes(page)) {
            await pet.panel.webContents.executeJavaScript("document.getElementById('content').scrollTop = 99999");
            await wait(400);
            fs.writeFileSync(path.join(out, `panel-${page}-end.png`), (await pet.panel.webContents.capturePage()).toPNG());
          }
        }
        console.log('panel screenshots written');
        quitApp(); // the same path as Quit in the control center
      });
    }
    // `--talk-snapshot`: screenshot the talk window (menu, a conversation, each game) to test-output/, then quit.
    if (process.argv.includes('--talk-snapshot')) {
      setTimeout(() => { console.error('talk snapshot timed out'); exitNow(2); }, 60000);
      setTimeout(() => {
        pet.openTalk();
        pet.talk.webContents.on('console-message', (e) => console.log('talk:', e.message));
        pet.talk.webContents.once('did-finish-load', async () => {
          const out = path.join(__dirname, '..', 'test-output');
          fs.mkdirSync(out, { recursive: true });
          const wait = (ms) => new Promise((r) => setTimeout(r, ms));
          const shot = async (name) => fs.writeFileSync(path.join(out, `talk-${name}.png`), (await pet.talk.webContents.capturePage()).toPNG());
          const demo = (action, payload) => pet.talk.webContents.executeJavaScript(`window.__talkDemo(${JSON.stringify(action)}, ${JSON.stringify(payload || {})})`);
          await wait(1500); await shot('menu');
          await demo('menu', { id: 'cats' }); await wait(900); await shot('ask-about');
          await demo('menu', { id: 'topic:q_chronotype' }); await wait(1600); await shot('question');
          await demo('menu', { id: 'cat:feeling' }); await wait(900); await shot('feelings');
          await demo('menu', { id: 'topic:water_log' }); await wait(900); await demo('next'); await wait(900); await shot('water');
          await demo('input', { value: '8' }); await wait(900); await shot('water-reply');
          await demo('menu', { id: 'gift' }); await wait(1200); await shot('gift-ask');
          await demo('gift', { file: 'Haruka Merch.gift' }); await wait(1400); await shot('gift-reply');
          for (const g of ['rps', 'ttt', 'words', 'pong']) { await demo('menu', { id: `game:${g}` }); await wait(1400); await shot(`game-${g}`); }
          console.log('talk screenshots written');
          pet.quit(); // the same path as Quit in the menu
        });
      }, 2500);
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
        quitApp();
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
          trip: pet.tripPanelState(), visitorSaved: pet.visitor ? pet.saveVisit() : undefined, root: paths.root,
          playdates: [...pet.metPets], calendar: pet.calendarState(), meetingLink: pet.meetingLink, reminded: [...pet.calendarNotified],
          quietHours: pet.quietHours, quietNow: pet.quietHoursOn, events: pet.eventsState(), historyDays: pet.stats.history(14).length,
          summaries: [...pet.summaries.values()],
        }, null, 2));
        quitApp();
      }, (Number(process.argv[process.argv.indexOf('--self-test-seconds') + 1]) || 7) * 1000);
    }
  });
  app.on('window-all-closed', (e) => e.preventDefault());
  app.on('before-quit', () => {
    presence.remove();
    if (!pet) return;
    if (pet.visitor) {
      pet.saveVisit();
      try { fs.rmSync(path.join(paths.visitors, String(process.pid)), { force: true }); } catch (_) { /* gone already */ }
    }
    pet.agents.stop();
    pet.platforms.stop();
    pet.stats.saveIfNeeded();
    pet.settings.flush();
    pet.companion.flush();
  });
}
