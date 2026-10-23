// Paths and persisted settings, shared with the macOS app where it makes sense
// (config.json, sprite packs, and hook state all live in ~/.deskpet).
const fs = require('fs');
const os = require('os');
const path = require('path');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return fallback; }
}

const TRIP_DIR = 'DeskPet Trip';

/**
 * Visitor mode (docs/trips-and-moving.md): `--trip <folder>`, or this executable is the portable copy inside a
 * "DeskPet Trip" folder on a drive. Returns { folder, id } or null.
 */
function detectTrip() {
  const i = process.argv.indexOf('--trip');
  const candidates = [];
  if (i > 0 && process.argv[i + 1]) candidates.push(path.resolve(process.argv[i + 1]));
  else {
    // Windows: <trip>/DeskPet-Windows/DeskPet.exe. Linux: <trip>/DeskPet-Linux.AppImage.
    if (process.env.APPIMAGE) candidates.push(path.dirname(process.env.APPIMAGE));
    candidates.push(path.dirname(path.dirname(process.execPath)));
  }
  for (const folder of candidates) {
    const trip = readJSON(path.join(folder, 'trip.json'), null);
    if (trip && trip.app === 'deskpet' && trip.kind === 'trip' && trip.id) return { folder, id: String(trip.id).replace(/[^\w-]/g, '') };
  }
  return null;
}

const realRoot = path.join(os.homedir(), '.deskpet');
const trip = detectTrip();
// A visitor keeps its profile in a fresh temp folder; the drive only holds trip.json and the sprites.
const root = trip ? path.join(os.tmpdir(), `DeskPet-trip-${trip.id}`) : realRoot;
let spritesOverride = null;
const paths = {
  root,
  /** Always the real ~/.deskpet, even for a visitor (hooks, the device id, visitor markers). */
  realRoot,
  /** { folder, id } when running as a visitor, else null. */
  trip,
  tripDir: TRIP_DIR,
  visitors: path.join(realRoot, 'visitors'),
  /** Agent hooks on this machine write here, so a visitor sees the host's agents too. */
  sessions: path.join(realRoot, 'sessions'),
  /** ~/.deskpet/sprites, the sync folder's sprites when "sync sprite packs" is on, or the trip's. */
  get sprites() { return spritesOverride || (trip ? path.join(trip.folder, 'sprites') : path.join(root, 'sprites')); },
  localSprites: path.join(root, 'sprites'),
  config: path.join(root, 'config.json'),
  settings: path.join(root, 'electron-settings.json'),
  hookScript: path.join(realRoot, 'hook.ps1'),
};

/** Small JSON-file key/value store (the Electron equivalent of UserDefaults). */
class Settings {
  constructor() {
    this.values = readJSON(paths.settings, {});
    this.timer = null;
  }

  get(key, fallback) { return key in this.values ? this.values[key] : fallback; }

  set(key, value) {
    this.values[key] = value;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 300);
  }

  flush() {
    clearTimeout(this.timer);
    fs.mkdirSync(paths.root, { recursive: true });
    const tmp = `${paths.settings}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.values, null, 2));
    fs.renameSync(tmp, paths.settings);
  }
}

function loadConfig() {
  const o = readJSON(paths.config, {});
  const first = (os.userInfo().username || 'friend').split(/[ .]/)[0];
  return {
    ownerName: o.ownerName || first,
    petName: o.petName || 'Mochi',
    spritePack: o.spritePack || '',
    themeColor: o.themeColor || '',
  };
}

/** Merges `changes` into config.json (shared with the macOS app). */
function saveConfig(changes) {
  const o = { ...readJSON(paths.config, {}), ...changes };
  fs.mkdirSync(paths.root, { recursive: true });
  fs.writeFileSync(paths.config, `${JSON.stringify(o, null, 2)}\n`);
}

/** Hooks are "live" once any agent has written session state recently. */
function hooksLive() {
  try {
    const cutoff = Date.now() - 10 * 60 * 1000;
    return fs.readdirSync(paths.sessions).some((f) => f.endsWith('.json') && fs.statSync(path.join(paths.sessions, f)).mtimeMs > cutoff);
  } catch (_) { return false; }
}

function setSpritesOverride(dir) { spritesOverride = dir || null; }

module.exports = { paths, Settings, loadConfig, saveConfig, hooksLive, readJSON, setSpritesOverride };
