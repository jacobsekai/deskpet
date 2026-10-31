// Cloud-folder sync: devices add up, and removing a device keeps or drops its XP without counting anything twice.
// Run: node test/sync.test.js (uses a throwaway folder).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-sync-'));
process.env.HOME = tmp;
process.env.USERPROFILE = tmp;
const { Sync } = require('../src/sync');

const settings = () => { const v = {}; return { get: (k, d) => (k in v ? v[k] : d), set: (k, x) => { v[k] = x; } }; };
const device = (name) => { const s = new Sync(settings()); s.deviceName = name; s.folder = path.join(tmp, 'cloud'); return s; };
const stats = (xp) => ({ xp, days: { '2026-10-31': { tasks: xp } } });

let checks = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { checks++; console.log(`ok - ${name}`); });

(async () => {
  const mac = device('Mac'), pc = device('PC'), old = device('Old laptop');
  for (const d of [mac, pc, old]) d.prepareJoin({}, false);

  await ok('devices add up', () => {
    old.sync(stats(30), {});
    pc.sync(stats(20), {});
    assert.strictEqual(mac.sync(stats(10), {}).remoteXP, 50);
    mac.sync(stats(10), {});
    assert.strictEqual(mac.devices.length, 3);
  });

  await ok("remove: returns its stats, leaves a marker, and drops it from everyone's totals", () => {
    const kept = mac.remove(old.deviceID, true);
    assert.deepStrictEqual(kept, stats(30));
    assert(!mac.devices.some((d) => d.id === old.deviceID));
    assert.strictEqual(mac.sync(stats(40), {}).remoteXP, 20, 'Mac now holds the 30 itself');
    assert.strictEqual(pc.sync(stats(20), {}).remoteXP, 40);
  });

  await ok('the removed device turns its own sync off, even after writing once more', () => {
    fs.writeFileSync(path.join(mac.root, 'devices', `${old.deviceID}.json`), JSON.stringify({ format: 1, device: { id: old.deviceID, name: 'Old laptop' }, stats: stats(30), profile: {} }));
    assert.strictEqual(pc.sync(stats(20), {}).remoteXP, 40, 'late write ignored');
    assert(!fs.existsSync(path.join(mac.root, 'devices', `${old.deviceID}.json`)), 'and cleaned up');
    assert.deepStrictEqual(old.sync(stats(30), {}), { removedBy: 'Mac' });
  });

  await ok('rejoining clears the marker and warns that its XP was kept elsewhere', () => {
    assert.strictEqual(Sync.inspect(old.folder, old.deviceID).keptBy, 'Mac');
    assert.strictEqual(Sync.inspect(old.folder, mac.deviceID).devices, 1, 'removed devices are not counted when joining');
    old.prepareJoin({}, false);
    assert.strictEqual(Sync.inspect(old.folder, old.deviceID).keptBy, null);
    assert.strictEqual(old.sync(stats(0), {}).remoteXP, 60);
  });

  console.log(`\n${checks} checks passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
