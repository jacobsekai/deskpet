// Importing a sprite pack from a Google Drive link: link parsing, zip safety checks, and a full download + install.
// Run: node test/packlink.test.js (uses a throwaway home folder).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-packlink-'));
process.env.HOME = home;
process.env.USERPROFILE = home;

const { driveFileID, checkZip, zipName, downloadDriveZip } = require('../src/packlink');
const { importPack } = require('../src/extras');

/** A stored (uncompressed) zip; `mode` sets the Unix file type, e.g. 0o120777 for a symlink. */
function makeZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data = Buffer.from('x'), mode = 0o100644 } of entries) {
    const n = Buffer.from(name), crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x031e, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, n, data);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const response = (body, headers = {}, status = 200) => ({
  ok: status < 400, status,
  headers: { get: (k) => headers[k.toLowerCase()] || null },
  body: (async function* () { for (let i = 0; i < body.length; i += 1000) yield body.subarray(i, i + 1000); })(),
});

let checks = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { checks++; console.log(`ok - ${name}`); });

(async () => {
  await ok('links: every Drive file link shape works, folders and other sites are told apart', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUv';
    for (const link of [`https://drive.google.com/file/d/${id}/view?usp=sharing`, `https://drive.google.com/open?id=${id}`,
      `https://drive.google.com/uc?export=download&id=${id}`, ` https://drive.usercontent.google.com/download?id=${id} `]) {
      assert.deepStrictEqual(driveFileID(link), { id }, link);
    }
    assert.deepStrictEqual(driveFileID('https://drive.google.com/drive/folders/1xyzxyzxyzxyz'), { folder: true });
    assert.strictEqual(driveFileID(`https://evil.example/file/d/${id}`), null);
    assert.strictEqual(driveFileID(`http://drive.google.com/file/d/${id}`), null, 'https only');
    assert.strictEqual(driveFileID('not a link'), null);
  });

  await ok('zips: entries that escape the pack folder or are symlinks are refused', () => {
    checkZip(makeZip([{ name: 'minori/idle.png' }, { name: 'minori/walk_1.png' }]));
    for (const name of ['../evil.png', 'a/../../evil.png', '/etc/evil', 'C:/evil.png', 'a\\..\\..\\evil.png']) {
      assert.throws(() => checkZip(makeZip([{ name }])), /unsafe/, name);
    }
    assert.throws(() => checkZip(makeZip([{ name: 'link', mode: 0o120777 }])), /unsafe/, 'symlink');
    assert.throws(() => checkZip(Buffer.from('<html>sign in</html>')), /isn't a .zip/);
  });

  await ok('names: taken from Content-Disposition and made safe for a folder', () => {
    assert.strictEqual(zipName('attachment; filename="Minori Pack.zip"'), 'Minori Pack');
    assert.strictEqual(zipName("attachment; filename=\"x.zip\"; filename*=UTF-8''%E3%81%BF%E3%81%AE%E3%82%8A.zip"), 'みのり');
    assert.strictEqual(zipName('attachment; filename="../../evil.zip"'), 'evil');
    assert.strictEqual(zipName('attachment; filename="..zip"'), 'drive-pack');
    assert.strictEqual(zipName(null), 'drive-pack');
  });

  await ok('download: private files, folders, and huge files fail with a clear reason', async () => {
    const link = 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view';
    await assert.rejects(downloadDriveZip(link, async () => response(Buffer.from('<html>'), { 'content-type': 'text/html; charset=utf-8' })), /Anyone with the link/);
    await assert.rejects(downloadDriveZip(link, async () => response(Buffer.alloc(0), {}, 404)), /couldn't find/);
    await assert.rejects(downloadDriveZip(link, async () => { throw new TypeError('fetch failed'); }), /can't reach/);
    await assert.rejects(downloadDriveZip('https://drive.google.com/drive/folders/1xyzxyzxyzxyz'), /folder link/);
    await assert.rejects(downloadDriveZip(link, async () => response(Buffer.alloc(50 * 1024 * 1024 + 1))), /over 50 MB/);
  });

  await ok('download + import: the linked pack is installed under its own name', async () => {
    let asked = '';
    const zip = makeZip([{ name: 'minori/idle.png', data: Buffer.from('png') }, { name: 'minori/walk_1.png', data: Buffer.from('png2') }]);
    const file = await downloadDriveZip('https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUv/view?usp=sharing', async (url) => {
      asked = url;
      return response(zip, { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="Minori.zip"' });
    });
    assert.strictEqual(asked, 'https://drive.usercontent.google.com/download?id=1AbCdEfGhIjKlMnOpQrStUv&export=download&confirm=t');
    const name = await importPack([file], '');
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
    assert.strictEqual(name, 'Minori');
    assert.strictEqual(fs.readFileSync(path.join(home, '.deskpet', 'sprites', 'Minori', 'idle.png'), 'utf8'), 'png');
  });

  console.log(`\n${checks} checks passed`);
  fs.rmSync(home, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
