// Trips (take the pet along on a USB drive) and moving-homes files, for the Windows/Linux app.
// Same formats as the macOS app: see docs/trips-and-moving.md. No Electron APIs here, so tests can run it in Node.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { paths, readJSON } = require('./settings');

const TRIP_DIR = paths.tripDir;
const OS_NAME = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
const PACK_LIMIT = 40 * 1024 * 1024;
const deviceName = () => os.hostname().replace(/\.local$/, '');

function run(cmd, args, options = {}) {
  return new Promise((resolve) => execFile(cmd, args, { windowsHide: true, ...options }, (e, out) => resolve({ code: e ? 1 : 0, out: String(out || ''), missing: !!e && e.code === 'ENOENT' })));
}

function powershell(script) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]);
}

const subdirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() || d.isSymbolicLink()).map((d) => path.join(dir, d.name)); } catch (_) { return []; } };

// MARK: Drives

/** Mounted drives, cheaply (no subprocess): drive letters on Windows, mount folders elsewhere. */
function mountRoots() {
  if (process.platform === 'win32') {
    const out = [];
    for (let c = 68; c <= 90; c++) { // D: … Z:
      const root = `${String.fromCharCode(c)}:\\`;
      try { fs.accessSync(root); out.push(root); } catch (_) { /* no such drive */ }
    }
    return out;
  }
  if (process.platform === 'darwin') {
    let boot = '';
    try { boot = fs.realpathSync('/'); } catch (_) { /* keep empty */ }
    return subdirs('/Volumes').filter((v) => { try { return fs.realpathSync(v) !== boot; } catch (_) { return false; } });
  }
  const user = os.userInfo().username;
  return [...subdirs(path.join('/media', user)), ...subdirs(path.join('/run/media', user)), ...subdirs('/mnt'),
    ...subdirs('/media').filter((d) => path.basename(d) !== user)];
}

/** Removable drives to offer for a trip: [{ path, name }]. */
async function listDrives() {
  if (process.platform !== 'win32') return mountRoots().map((p) => ({ path: p, name: path.basename(p) }));
  const r = await powershell('Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 2 } | ForEach-Object { "$($_.DeviceID)|$($_.VolumeName)" }');
  const drives = r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [id, label] = l.split('|');
    return { path: `${id}\\`, name: label ? `${label} (${id})` : `USB drive (${id})` };
  });
  // Fixed-type USB disks that already carry a trip count too.
  for (const root of mountRoots()) {
    if (!drives.some((d) => d.path.toUpperCase() === root.toUpperCase()) && fs.existsSync(path.join(root, TRIP_DIR, 'trip.json'))) {
      drives.push({ path: root, name: `Drive (${root.slice(0, 2)})` });
    }
  }
  return drives;
}

/** The mount root a folder lives on (the drive to eject). */
function driveOf(folder) {
  if (process.platform === 'win32') return /^[A-Za-z]:\\/.test(folder) ? folder.slice(0, 3) : null;
  const abs = path.resolve(folder);
  return mountRoots().filter((r) => abs === r || abs.startsWith(r + path.sep)).sort((a, b) => b.length - a.length)[0] || null;
}

async function eject(folder) {
  const drive = driveOf(folder);
  if (!drive) return false;
  if (process.platform === 'win32') {
    const r = await powershell(`(New-Object -ComObject Shell.Application).Namespace(17).ParseName('${drive.slice(0, 2)}').InvokeVerb('Eject'); Start-Sleep -Milliseconds 1500; if (Test-Path '${drive}') { exit 1 }`);
    return r.code === 0;
  }
  if (process.platform === 'darwin') return (await run('diskutil', ['eject', drive])).code === 0;
  if ((await run('gio', ['mount', '-e', drive])).code === 0) return true;
  const dev = (await run('findmnt', ['-n', '-o', 'SOURCE', '--target', drive])).out.trim();
  return !!dev && (await run('udisksctl', ['unmount', '-b', dev])).code === 0;
}

// MARK: trip.json

const tripFolderFor = (p) => (path.basename(p) === TRIP_DIR ? p : path.join(p, TRIP_DIR));

function readTrip(folder) {
  const t = readJSON(path.join(folder, 'trip.json'), null);
  return t && t.app === 'deskpet' && t.kind === 'trip' && t.id ? t : null;
}

function writeTrip(folder, trip) {
  trip.updatedAt = new Date().toISOString();
  const file = path.join(folder, 'trip.json');
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(trip, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/** Every trip folder on a mounted drive, plus `extra` folders (where we know a trip went). */
function findTrips(extra = []) {
  const folders = new Set(extra.filter(Boolean));
  for (const root of mountRoots()) folders.add(path.join(root, TRIP_DIR));
  const out = [];
  for (const folder of folders) {
    const trip = readTrip(folder);
    if (trip) out.push({ folder, trip });
  }
  return out;
}

const README = (pet, home) => `${pet} is on a trip! 🧳

This folder belongs to DeskPet (https://github.com/jacobsekai/deskpet).

- On another computer with DeskPet: plug this drive in and choose "Let ${pet} out" from the DeskPet menu.
- No DeskPet there? Open the copy in this folder, if there is one (DeskPet.app, DeskPet-Windows\\DeskPet.exe,
  or DeskPet-Linux.AppImage).
- Going home: plug the drive back into ${home}. ${pet} hops out and asks how your day was.

Please don't delete trip.json while ${pet} is away: it holds everything ${pet} did on the trip.
`;

function copyPack(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, filter: (p) => path.basename(p) !== 'sliced' && !path.basename(p).startsWith('.') || p === src });
}

/**
 * Writes the trip folder: trip.json, the sprite pack, and a read-me. `base` is a drive root or any folder.
 * Returns { folder, trip }.
 */
function createTrip({ base, profile, home, pack, packDir }) {
  const folder = tripFolderFor(base);
  fs.mkdirSync(folder, { recursive: true });
  const trip = {
    app: 'deskpet', kind: 'trip', v: 1, id: crypto.randomUUID(), status: 'away', home,
    pet: (profile.config || {}).petName || 'Mochi', owner: (profile.config || {}).ownerName || '',
    leftAt: new Date().toISOString(), departure: { stats: profile.stats || {} }, profile, pack: pack || '', visits: [],
  };
  if (pack && packDir && fs.existsSync(packDir)) copyPack(packDir, path.join(folder, 'sprites', pack));
  writeTrip(folder, trip);
  fs.writeFileSync(path.join(folder, 'Read me.txt'), README(trip.pet, home.name));
  return { folder, trip };
}

function markHome(folder, trip) {
  trip.status = 'home';
  trip.returnedAt = new Date().toISOString();
  writeTrip(folder, trip);
}

// MARK: Rules (pure, so tests can check them)

/**
 * What the home device should do with the trips it can see. `state` is the away state (or null), `found` is
 * findTrips(), `first` is true on the first check after launch. Returns
 * { sawGone, comeHome: {folder, trip} | null, luggage: [{folder, trip}], doors: [{ id, path, pet, homeName }] }.
 */
function watchDecision({ state, found, deviceID, first, now = Date.now() }) {
  const out = { sawGone: false, comeHome: null, luggage: [], doors: [] };
  if (state) {
    const mine = found.find((f) => f.trip.id === state.id);
    if (!mine) out.sawGone = !state.sawGone;
    else if (mine.trip.status === 'away' && (state.sawGone || (first && now - state.leftAt > 10 * 60000))) out.comeHome = mine;
  }
  for (const f of found) {
    const { trip } = f;
    if (trip.status !== 'away' || f === out.comeHome) continue;
    if (trip.home && trip.home.device && trip.home.device === deviceID) {
      if (!state || trip.id !== state.id) out.luggage.push(f);
    } else {
      out.doors.push({ id: trip.id, path: f.folder, pet: trip.pet || 'a pet', homeName: (trip.home && trip.home.name) || 'another computer' });
    }
  }
  return out;
}

/** Why a visitor can't come out here ('' when it can). */
function visitCheck(trip, deviceID) {
  if (!trip) return "This trip folder can't be read.";
  const pet = trip.pet || 'Your pet';
  if (trip.status !== 'away') return `${pet} already went home from this trip.`;
  if (trip.home && trip.home.device && trip.home.device === deviceID) {
    return `${pet} lives on this computer! Plug the drive in while DeskPet is running here and ${pet} will hop out.`;
  }
  return '';
}

// MARK: Portable copy of the app

function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += dirSize(p); else try { total += fs.statSync(p).size; } catch (_) { /* skip */ }
  }
  return total;
}

let sizeCache = null;
/** What "put DeskPet on the drive too" would copy: { possible, size, source, target }. */
function appCopyInfo({ packaged, execPath = process.execPath, appImage = process.env.APPIMAGE } = {}) {
  if (!packaged) return { possible: false, size: '' };
  let info = null;
  if (process.platform === 'win32') info = { source: path.dirname(execPath), target: 'DeskPet-Windows', dir: true };
  else if (process.platform === 'linux' && appImage) info = { source: appImage, target: 'DeskPet-Linux.AppImage', dir: false };
  if (!info) return { possible: false, size: '' };
  if (!sizeCache || sizeCache.source !== info.source) {
    let bytes = 0;
    try { bytes = info.dir ? dirSize(info.source) : fs.statSync(info.source).size; } catch (_) { /* unknown */ }
    sizeCache = { source: info.source, text: bytes ? `${Math.round(bytes / 1e6)} MB` : '' };
  }
  return { possible: true, size: sizeCache.text, ...info };
}

async function copyApp(info, folder) {
  if (!info || !info.possible) return false;
  const target = path.join(folder, info.target);
  // Running from this very copy (a portable launch)? Nothing to do.
  if (path.resolve(info.source) === path.resolve(target)) return true;
  await fs.promises.rm(target, { recursive: true, force: true });
  await fs.promises.cp(info.source, target, { recursive: true, force: true });
  if (!info.dir) { try { fs.chmodSync(target, 0o755); } catch (_) { /* FAT drives have no modes */ } }
  return true;
}

// MARK: Moving-homes files (<Pet>.deskpet)

function packFiles(dir) {
  const out = {};
  let total = 0;
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.') || (!rel && e.name === 'sliced')) continue;
      const p = path.join(d, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) { const data = fs.readFileSync(p); total += data.length; out[r] = data; }
    }
  };
  walk(dir, '');
  return { files: out, total };
}

/** Builds the file's contents. Returns { json, note }; packs over 40 MB stay behind (with a note). */
function packMovingFile({ profile, packName, packDir, limit = PACK_LIMIT }) {
  let pack = null, note = '';
  if (packName && packDir && fs.existsSync(packDir)) {
    const { files, total } = packFiles(packDir);
    if (total > limit) note = `the ${packName} sprite pack is over ${Math.round(limit / 1e6)} MB, so it stayed behind: export it as a zip`;
    else pack = { name: packName, files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.toString('base64')])) };
  }
  const obj = { app: 'deskpet', kind: 'home', v: 1, packed: new Date().toISOString(), from: OS_NAME, device: deviceName(), profile, pack };
  return { json: JSON.stringify(obj), note };
}

function readMovingFile(file) {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { throw new Error("that file isn't a DeskPet moving-homes file"); }
  if (!obj || obj.app !== 'deskpet' || obj.kind !== 'home' || !obj.profile) throw new Error("that file isn't a DeskPet moving-homes file");
  return obj;
}

const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '').trim().slice(0, 60);

/** Writes the file's sprite pack into `spritesDir`; returns the pack name (or null). */
function unpackMovingPack(obj, spritesDir) {
  if (!obj.pack || !obj.pack.files) return null;
  const name = safeName(obj.pack.name);
  if (!name) return null;
  const dir = path.join(spritesDir, name);
  for (const [rel, b64] of Object.entries(obj.pack.files)) {
    const target = path.resolve(dir, rel);
    if (!target.startsWith(path.resolve(dir) + path.sep)) continue; // no ../ escapes
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(String(b64), 'base64'));
  }
  return name;
}

module.exports = {
  TRIP_DIR, OS_NAME, PACK_LIMIT, deviceName, mountRoots, listDrives, driveOf, eject, tripFolderFor, readTrip, writeTrip, findTrips,
  createTrip, markHome, watchDecision, visitCheck, appCopyInfo, copyApp, packMovingFile, readMovingFile, unpackMovingPack,
};
