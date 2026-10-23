// Trips, moving-homes files, hook self-heal, and sprite-pack zips, in a throwaway home folder.
// Run: node test/trips.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Everything below reads ~/… through os.homedir(), so point it at a temp folder before loading any module.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-trips-test-'));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
assert.strictEqual(os.homedir(), HOME, 'test must run against a throwaway home');

const { paths } = require('../src/settings');
const trips = require('../src/trips');
const hooks = require('../src/hooks');
const { Stats, importPack, exportPack } = require('../src/extras');

let passed = 0;
const check = (name, fn) => Promise.resolve().then(fn).then(() => { passed++; console.log(`ok - ${name}`); });

async function main() {
  assert(paths.realRoot.startsWith(HOME) && paths.root.startsWith(HOME) && paths.trip === null);

  // MARK: Moving-homes files

  const packDir = path.join(paths.sprites, 'testpack');
  fs.mkdirSync(path.join(packDir, 'sounds'), { recursive: true });
  fs.mkdirSync(path.join(packDir, 'sliced'), { recursive: true });
  const sheet = Buffer.from(Array.from({ length: 5000 }, (_, i) => (i * 37) % 256));
  fs.writeFileSync(path.join(packDir, 'pack.json'), '{"height":130}');
  fs.writeFileSync(path.join(packDir, 'sheet.png'), sheet);
  fs.writeFileSync(path.join(packDir, 'sounds', 'pet.wav'), Buffer.from([1, 2, 3]));
  fs.writeFileSync(path.join(packDir, 'sliced', 'idle.png'), Buffer.from([9]));
  fs.writeFileSync(path.join(packDir, '.DS_Store'), Buffer.from([9]));
  const profile = { app: 'deskpet', v: 1, config: { petName: 'Minori', ownerName: 'Luna' }, settings: { spritePack: 'testpack' }, stats: { xp: 100, days: { '2026-10-20': { tasks: 1, pets: 2 } } }, companion: { affection: 20 } };

  await check('moving file round trip keeps nested pack files and skips sliced/ and dotfiles', () => {
    const { json, note } = trips.packMovingFile({ profile, packName: 'testpack', packDir });
    assert.strictEqual(note, '');
    const file = path.join(HOME, 'Minori.deskpet');
    fs.writeFileSync(file, json);
    const obj = trips.readMovingFile(file);
    assert.strictEqual(obj.kind, 'home');
    assert.deepStrictEqual(obj.profile, profile);
    assert.deepStrictEqual(Object.keys(obj.pack.files).sort(), ['pack.json', 'sheet.png', 'sounds/pet.wav']);
    const elsewhere = path.join(HOME, 'other-sprites');
    assert.strictEqual(trips.unpackMovingPack(obj, elsewhere), 'testpack');
    assert(fs.readFileSync(path.join(elsewhere, 'testpack', 'sheet.png')).equals(sheet));
    assert(fs.readFileSync(path.join(elsewhere, 'testpack', 'sounds', 'pet.wav')).equals(Buffer.from([1, 2, 3])));
  });

  await check('packs over the size limit stay behind with a note', () => {
    const { json, note } = trips.packMovingFile({ profile, packName: 'testpack', packDir, limit: 100 });
    assert.strictEqual(JSON.parse(json).pack, null);
    assert(/stayed behind/.test(note), note);
  });

  await check('bad moving files are rejected and ../ paths are ignored', () => {
    const bad = path.join(HOME, 'bad.deskpet');
    fs.writeFileSync(bad, 'DESKPET-1:abc');
    assert.throws(() => trips.readMovingFile(bad), /moving-homes file/);
    fs.writeFileSync(bad, JSON.stringify({ app: 'deskpet', kind: 'trip', profile }));
    assert.throws(() => trips.readMovingFile(bad), /moving-homes file/);
    const evil = { pack: { name: 'evil', files: { '../../escaped.txt': Buffer.from('x').toString('base64'), 'ok.png': 'AA==' } } };
    const dir = path.join(HOME, 'evil-sprites');
    trips.unpackMovingPack(evil, dir);
    assert(!fs.existsSync(path.join(HOME, 'escaped.txt')) && !fs.existsSync(path.join(dir, '..', 'escaped.txt')));
    assert(fs.existsSync(path.join(dir, 'evil', 'ok.png')));
  });

  // MARK: Trips (a temp folder stands in for the USB drive)

  const ME = 'device-home', OTHER = 'device-friend';
  const drive = path.join(HOME, 'USBDRIVE');
  fs.mkdirSync(drive);
  const home = { device: ME, name: 'Luna-PC', os: trips.OS_NAME };
  const { folder, trip } = trips.createTrip({ base: drive, profile, home, pack: 'testpack', packDir });

  await check('taking a trip writes trip.json, the pack, and a read-me', () => {
    assert.strictEqual(folder, path.join(drive, 'DeskPet Trip'));
    const t = trips.readTrip(folder);
    assert.strictEqual(t.status, 'away');
    assert.strictEqual(t.pet, 'Minori');
    assert.deepStrictEqual(t.departure.stats, profile.stats);
    assert(fs.existsSync(path.join(folder, 'sprites', 'testpack', 'sheet.png')));
    assert(!fs.existsSync(path.join(folder, 'sprites', 'testpack', 'sliced')));
    assert(fs.readFileSync(path.join(folder, 'Read me.txt'), 'utf8').includes('Luna-PC'));
    assert.strictEqual(trips.tripFolderFor(folder), folder);
  });

  let state = { id: trip.id, path: folder, volume: 'USBDRIVE', leftAt: Date.now(), sawGone: false };
  const look = () => trips.findTrips([state.path]);

  await check('the trip does not come home while the drive is still plugged in after leaving', () => {
    const d = trips.watchDecision({ state, found: look(), deviceID: ME, first: true });
    assert(!d.comeHome && !d.sawGone && !d.luggage.length && !d.doors.length);
  });

  await check('unplugging marks the drive gone; plugging back in brings the pet home', () => {
    fs.renameSync(drive, `${drive}-ejected`);
    let d = trips.watchDecision({ state, found: look(), deviceID: ME, first: false });
    assert.strictEqual(d.sawGone, true);
    state = { ...state, sawGone: true };
    d = trips.watchDecision({ state, found: look(), deviceID: ME, first: false });
    assert(!d.sawGone && !d.comeHome, 'reported gone only once');
    fs.renameSync(`${drive}-ejected`, drive);
    d = trips.watchDecision({ state, found: look(), deviceID: ME, first: false });
    assert(d.comeHome && d.comeHome.trip.id === trip.id);
  });

  await check('after a relaunch, a trip found more than 10 minutes after leaving comes home', () => {
    const relaunch = { ...state, sawGone: false, leftAt: Date.now() - 11 * 60000 };
    assert(trips.watchDecision({ state: relaunch, found: look(), deviceID: ME, first: true }).comeHome);
    assert(!trips.watchDecision({ state: relaunch, found: look(), deviceID: ME, first: false }).comeHome);
  });

  await check('a visit elsewhere, then coming home, adds only what was earned on the trip', () => {
    // On the friend's computer: the visitor gained 50 XP, 2 tasks today and played on a new day.
    const t = trips.readTrip(folder);
    t.profile = { ...t.profile, stats: { xp: 150, days: { '2026-10-20': { tasks: 3, pets: 2 }, '2026-10-21': { pets: 4, greeted: true } } } };
    t.visits.push({ device: 'Sams-Laptop', os: 'Windows', at: new Date().toISOString(), minutes: 42 });
    trips.writeTrip(folder, t);
    // Meanwhile at home: 20 more XP than at departure.
    const stats = new Stats();
    stats.replace({ xp: 120, days: { '2026-10-20': { tasks: 1, pets: 2 } } });
    const fresh = trips.readTrip(folder);
    stats.absorb(fresh.profile.stats, fresh.departure.stats);
    assert.strictEqual(stats.xp, 170);
    assert.strictEqual(stats.data.days['2026-10-20'].tasks, 3);
    assert.strictEqual(stats.data.days['2026-10-20'].pets, 2);
    assert.strictEqual(stats.data.days['2026-10-21'].pets, 4);
    assert.strictEqual(stats.data.days['2026-10-21'].greeted, true);
    trips.markHome(folder, fresh);
    assert.strictEqual(trips.readTrip(folder).status, 'home');
    assert(trips.readTrip(folder).returnedAt);
    // Once home, it is neither a return, luggage, nor a visitor.
    const d = trips.watchDecision({ state: null, found: look(), deviceID: ME, first: false });
    assert(!d.comeHome && !d.luggage.length && !d.doors.length);
  });

  await check('prestige earned on a trip carries over with its level progress', () => {
    const stats = new Stats();
    stats.replace({ xp: 9000, days: {} });
    stats.absorb({ xp: 9100, prestige: 1, prestigeBase: 9050, days: {} }, { xp: 9000, days: {} });
    assert.strictEqual(stats.prestige, 1);
    assert.strictEqual(stats.levelXP, 50);
  });

  await check('an older trip of mine is luggage; someone else\'s is a visitor at the door', () => {
    const d2 = path.join(HOME, 'SECOND');
    const old = trips.createTrip({ base: d2, profile, home, pack: '', packDir: null });
    const d3 = path.join(HOME, 'THIRD');
    const guest = trips.createTrip({ base: d3, profile: { ...profile, config: { petName: 'Mochi' } }, home: { device: OTHER, name: 'Sams-Laptop', os: 'Windows' } });
    const found = trips.findTrips([old.folder, guest.folder, folder]);
    const d = trips.watchDecision({ state: null, found, deviceID: ME, first: false });
    assert.deepStrictEqual(d.luggage.map((f) => f.trip.id), [old.trip.id]);
    assert.deepStrictEqual(d.doors.map((x) => [x.id, x.pet, x.homeName]), [[guest.trip.id, 'Mochi', 'Sams-Laptop']]);
    // While away on the current trip, that trip is not luggage.
    const awayState = { id: old.trip.id, path: old.folder, leftAt: Date.now(), sawGone: false };
    assert.strictEqual(trips.watchDecision({ state: awayState, found, deviceID: ME, first: false }).luggage.length, 0);
  });

  await check('a visitor refuses to come out at home or after the trip ended', () => {
    const t = { app: 'deskpet', kind: 'trip', id: 'x', status: 'away', pet: 'Minori', home: { device: ME } };
    assert(/lives on this computer/.test(trips.visitCheck(t, ME)));
    assert.strictEqual(trips.visitCheck(t, OTHER), '');
    assert(/already went home/.test(trips.visitCheck({ ...t, status: 'home' }, OTHER)));
    assert(/can't be read/.test(trips.visitCheck(null, OTHER)));
  });

  await check('the portable copy is offered only for packaged builds', () => {
    assert.strictEqual(trips.appCopyInfo({ packaged: false }).possible, false);
    if (process.platform === 'win32') {
      const fake = path.join(HOME, 'FakeApp');
      fs.mkdirSync(fake);
      fs.writeFileSync(path.join(fake, 'DeskPet.exe'), Buffer.alloc(2000));
      const info = trips.appCopyInfo({ packaged: true, execPath: path.join(fake, 'DeskPet.exe') });
      assert(info.possible && info.target === 'DeskPet-Windows');
    } else if (process.platform === 'linux') {
      const fake = path.join(HOME, 'DeskPet.AppImage');
      fs.writeFileSync(fake, Buffer.alloc(2000));
      const info = trips.appCopyInfo({ packaged: true, appImage: fake });
      assert(info.possible && info.target === 'DeskPet-Linux.AppImage');
      return trips.copyApp(info, folder).then(() => assert(fs.existsSync(path.join(folder, 'DeskPet-Linux.AppImage'))));
    }
    return null;
  });

  // MARK: Hook self-heal

  await check('broken DeskPet hooks are rewritten, working and foreign hooks are left alone', () => {
    const settingsFile = path.join(HOME, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    const gone = path.join(HOME, 'gone');
    const broken = `"${path.join(gone, 'node')}" "${path.join(gone, '.deskpet', 'hook.js')}" --agent claude`;
    fs.mkdirSync(paths.realRoot, { recursive: true });
    const live = path.join(paths.realRoot, 'hook.js');
    fs.writeFileSync(live, '// stub');
    const working = `"${process.execPath}" "${live}" --agent claude`;
    const foreign = 'thatpet-hook --event stop';
    fs.writeFileSync(settingsFile, JSON.stringify({ hooks: {
      Stop: [{ matcher: '', hooks: [{ type: 'command', command: broken }] }, { matcher: '', hooks: [{ type: 'command', command: foreign }] }],
      PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: working }] }],
    } }));
    const fixed = hooks.heal(settingsFile, { platform: 'linux' });
    assert.strictEqual(fixed, 1);
    const after = JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks;
    assert.strictEqual(after.Stop[0].hooks[0].command, hooks.hookCommand('claude'));
    assert.strictEqual(after.Stop[1].hooks[0].command, foreign);
    assert.strictEqual(after.PreToolUse[0].hooks[0].command, working);
    assert(fs.readdirSync(path.dirname(settingsFile)).some((f) => f.startsWith('settings.json.deskpet-backup-')));
    assert.strictEqual(hooks.heal(settingsFile, { platform: 'linux' }), 0, 'nothing left to fix');
    assert.strictEqual(hooks.heal(settingsFile, { platform: 'darwin' }), 0, 'the native app owns hooks on macOS');
  });

  // MARK: Sprite pack zips (ditto on macOS, zip/unzip on Linux, PowerShell on Windows)

  await check('sprite packs export to a zip and import back', async () => {
    const zip = path.join(HOME, 'testpack.zip');
    await exportPack('testpack', zip);
    assert(fs.statSync(zip).size > 0);
    const name = await importPack([zip], '');
    assert.notStrictEqual(name, 'testpack', 'imports into a new folder');
    assert(fs.readFileSync(path.join(paths.sprites, name, 'sheet.png')).equals(sheet));
  });

  console.log(`\n${passed} checks passed`);
}

main().then(() => fs.rmSync(HOME, { recursive: true, force: true }), (e) => {
  console.error(e);
  process.exitCode = 1;
});
