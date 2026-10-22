// Paths and persisted settings, shared with the macOS app where it makes sense
// (config.json, sprite packs, and hook state all live in ~/.deskpet).
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.join(os.homedir(), '.deskpet');
let spritesOverride = null;
const paths = {
  root,
  sessions: path.join(root, 'sessions'),
  /** ~/.deskpet/sprites, or the sync folder's sprites when "sync sprite packs" is on. */
  get sprites() { return spritesOverride || path.join(root, 'sprites'); },
  localSprites: path.join(root, 'sprites'),
  config: path.join(root, 'config.json'),
  settings: path.join(root, 'electron-settings.json'),
  hookScript: path.join(root, 'hook.ps1'),
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch (_) { return fallback; }
}

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
