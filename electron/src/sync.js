// Cloud-folder sync, same format as Sync.swift: each device writes only DeskPet/devices/<id>.json in a folder
// your cloud drive syncs. XP and daily stats add up across devices; names, settings, worn rewards, and
// prestige follow whichever device changed them last. Nothing goes through a server.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readJSON } = require('./settings');

const PLATFORM = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
const DAY_FIELDS = ['activeMinutes', 'agentMinutes', 'tasks', 'pets', 'throwsCount', 'focusSessions', 'openMinutes', 'playXP', 'blocked'];

/** Adds two days of stats (counters sum, the daily hello is shared). */
function addDays(a = {}, b = {}) {
  const d = { greeted: !!(a.greeted || b.greeted) };
  for (const f of DAY_FIELDS) d[f] = (a[f] || 0) + (b[f] || 0);
  return d;
}

const stable = (value) => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));

class Sync {
  constructor(settings) {
    this.settings = settings;
    this.devices = [];
    this.lastSync = null;
    this.error = null;
    this.lastWritten = '';
    this.lastProfileJSON = '';
    this.deviceID = settings.get('syncDeviceID', null);
    if (!this.deviceID) {
      this.deviceID = crypto.randomUUID();
      settings.set('syncDeviceID', this.deviceID);
    }
    this.deviceName = os.hostname().replace(/\.local$/, '');
  }

  get folder() { return this.settings.get('syncFolder', null); }
  set folder(v) { this.settings.set('syncFolder', v); this.lastWritten = ''; this.devices = []; this.error = null; }
  get enabled() { return !!this.folder; }
  get root() { return this.folder ? path.join(this.folder, 'DeskPet') : null; }
  get spritesFolder() { return this.root ? path.join(this.root, 'sprites') : null; }

  /** Cloud folders found on this machine, for one-click setup. */
  static candidates() {
    const home = os.homedir();
    const found = [];
    const add = (name, p) => { try { if (fs.statSync(p).isDirectory() && !found.some((f) => f.path === p)) found.push({ name, path: p }); } catch (_) { /* missing */ } };
    if (process.platform === 'win32') {
      for (const e of fs.readdirSync(home)) if (/^OneDrive/i.test(e)) add('OneDrive', path.join(home, e));
      add('iCloud Drive', path.join(home, 'iCloudDrive'));
      add('Dropbox', path.join(home, 'Dropbox'));
      add('Google Drive', path.join(home, 'Google Drive'));
      for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') add('Google Drive', `${letter}:\\My Drive`);
    } else if (process.platform === 'darwin') {
      add('iCloud Drive', path.join(home, 'Library/Mobile Documents/com~apple~CloudDocs'));
      const cs = path.join(home, 'Library/CloudStorage');
      try {
        for (const e of fs.readdirSync(cs)) {
          if (e.startsWith('OneDrive')) add('OneDrive', path.join(cs, e));
          else if (e.startsWith('Dropbox')) add('Dropbox', path.join(cs, e));
          else if (e.startsWith('GoogleDrive')) add('Google Drive', fs.existsSync(path.join(cs, e, 'My Drive')) ? path.join(cs, e, 'My Drive') : path.join(cs, e));
        }
      } catch (_) { /* no cloud storage */ }
      add('Dropbox', path.join(home, 'Dropbox'));
    } else {
      for (const [name, dir] of [['Dropbox', 'Dropbox'], ['OneDrive', 'OneDrive'], ['Nextcloud', 'Nextcloud'], ['ownCloud', 'ownCloud'],
        ['Insync', 'Insync'], ['Syncthing', 'Sync'], ['pCloud', 'pCloudDrive'], ['MEGA', 'MEGA'], ['Google Drive', 'GoogleDrive']]) add(name, path.join(home, dir));
    }
    return found;
  }

  /** Other devices' totals already in a folder (before turning sync on). */
  static inspect(folder, excludeID) {
    const dir = path.join(folder, 'DeskPet', 'devices');
    let devices = 0, xp = 0;
    const names = [];
    try {
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const o = readJSON(path.join(dir, f), null);
        if (!o || !o.device || o.device.id === excludeID) continue;
        devices++;
        xp += (o.stats && o.stats.xp) || 0;
        names.push(o.device.name || 'another device');
      }
    } catch (_) { /* empty folder */ }
    return { devices, xp, names };
  }

  /** Writes this device's file and reads everyone else's. */
  sync(localStats, profile) {
    const dir = this.root && path.join(this.root, 'devices');
    if (!dir) return null;
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { this.error = "can't write to the sync folder"; return null; }

    // Profile changes made on this device get a fresh timestamp so other devices pick them up.
    const profileJSON = stable(profile);
    let updatedAt = this.settings.get('syncProfileUpdatedAt', 0);
    if (profileJSON !== this.lastProfileJSON) {
      if (this.lastProfileJSON || !updatedAt) { updatedAt = Date.now() / 1000; this.settings.set('syncProfileUpdatedAt', updatedAt); }
      this.lastProfileJSON = profileJSON;
    }

    const result = { remoteXP: 0, remoteDays: {}, newerProfile: null };
    const seen = [];
    let newest = null;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const o = readJSON(path.join(dir, f), null);
      if (!o || !o.device || !o.device.id) continue;
      const stats = o.stats || {};
      seen.push({ id: o.device.id, name: o.device.name || 'Device', platform: o.device.platform || '', updated: o.updated || 0, xp: stats.xp || 0 });
      if (o.device.id === this.deviceID) continue;
      result.remoteXP += stats.xp || 0;
      for (const [k, day] of Object.entries(stats.days || {})) result.remoteDays[k] = addDays(result.remoteDays[k], day);
      const p = o.profile;
      if (p && p.updatedAt && (!newest || p.updatedAt > newest.updatedAt)) newest = p;
    }
    const lastApplied = this.settings.get('syncLastAppliedRemote', 0);
    if (newest && newest.updatedAt > updatedAt && newest.updatedAt > lastApplied) {
      this.settings.set('syncLastAppliedRemote', newest.updatedAt);
      result.newerProfile = newest;
    }

    const file = {
      format: 1, device: { id: this.deviceID, name: this.deviceName, platform: PLATFORM },
      stats: localStats, profile: { ...profile, updatedAt },
    };
    // Only rewrite when something changed, so cloud apps don't sync a new copy every few seconds.
    const comparable = stable(file);
    if (comparable !== this.lastWritten) {
      this.lastWritten = comparable;
      const target = path.join(dir, `${this.deviceID}.json`);
      fs.writeFileSync(`${target}.tmp`, JSON.stringify({ ...file, updated: Date.now() / 1000 }));
      fs.renameSync(`${target}.tmp`, target);
    }
    this.devices = seen.sort((a, b) => b.updated - a.updated);
    this.lastSync = Date.now();
    this.error = null;
    return result;
  }

  /** After applying another device's profile, remember it as ours without bumping its timestamp. */
  accept(profile) {
    this.lastProfileJSON = stable(profile);
    this.settings.set('syncProfileUpdatedAt', this.settings.get('syncLastAppliedRemote', 0));
  }

  /** Joining: whatever the other devices already have wins over this device's current settings.
   *  The first device in a folder owns the settings until someone changes them. */
  prepareJoin(profile, first) {
    this.lastProfileJSON = stable(profile);
    this.settings.set('syncProfileUpdatedAt', first ? Date.now() / 1000 : 1);
    this.settings.set('syncLastAppliedRemote', 0);
  }

  disable() {
    this.folder = null;
    this.lastProfileJSON = '';
  }
}

module.exports = { Sync, addDays, PLATFORM };
