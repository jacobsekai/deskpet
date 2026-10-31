// Google Drive sync: two-way mirroring against an in-memory Drive, and the sign-in flow against a fake Google.
// Run: node test/gdrive.test.js (uses a throwaway folder).
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { GoogleDrive, mirror, SCOPE } = require('../src/gdrive');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-gdrive-'));
const md5 = (d) => crypto.createHash('md5').update(d).digest('hex');

class FakeDrive {
  constructor() { this.files = new Map(); this.n = 0; this.clock = 0; this.calls = []; }
  async list() { return [...this.files.entries()].map(([id, f]) => ({ id, name: f.name, md5Checksum: md5(f.data), modifiedTime: f.modifiedTime })); }
  async download(id) { this.calls.push(['download', this.files.get(id).name]); return this.files.get(id).data; }
  async create(name, data) { this.calls.push(['create', name]); this.files.set(`id${++this.n}`, { name, data: Buffer.from(data), modifiedTime: this.time() }); }
  async update(id, data) { this.calls.push(['update', this.files.get(id).name]); Object.assign(this.files.get(id), { data: Buffer.from(data), modifiedTime: this.time() }); }
  async remove(id) { this.calls.push(['remove', (this.files.get(id) || {}).name]); this.files.delete(id); }
  time() { return `2026-10-31T00:00:${String(++this.clock).padStart(2, '0')}Z`; }
  names() { return [...this.files.values()].map((f) => f.name).sort(); }
  text(name) { return [...this.files.values()].find((f) => f.name === name).data.toString(); }
}

/** A device: its mirror folder plus the state it keeps between rounds. */
const device = (id, drive) => {
  const dir = path.join(tmp, id);
  fs.mkdirSync(dir, { recursive: true });
  const d = { dir, state: {}, own: `devices/${id}.json` };
  d.write = (name, text) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
  d.read = (name) => { try { return fs.readFileSync(path.join(dir, name), 'utf8'); } catch (_) { return null; } };
  d.round = async () => { const r = await mirror({ dir, api: drive, state: d.state, own: d.own }); d.state = r.state; return r; };
  return d;
};

let checks = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(() => { checks++; console.log(`ok - ${name}`); });

(async () => {
  await ok('mirror: devices and sprite packs travel both ways, nothing re-uploads when unchanged', async () => {
    const drive = new FakeDrive();
    const a = device('a', drive), b = device('b', drive);
    a.write('devices/a.json', '{"xp":10}');
    a.write('sprites/minori/idle.png', 'png-a');
    a.write('.DS_Store', 'junk');
    a.write('devices/a.json.tmp', 'half');
    await a.round();
    assert.deepStrictEqual(drive.names(), ['devices/a.json', 'sprites/minori/idle.png']);
    await b.round();
    assert.strictEqual(b.read('sprites/minori/idle.png'), 'png-a');
    b.write('devices/b.json', '{"xp":5}');
    await b.round();
    await a.round();
    assert.strictEqual(a.read('devices/b.json'), '{"xp":5}');
    drive.calls = [];
    await a.round();
    await b.round();
    assert.deepStrictEqual(drive.calls, [], 'a quiet round makes no uploads or downloads');
  });

  await ok('mirror: deletions follow, and a removed pack leaves no empty folders', async () => {
    const drive = new FakeDrive();
    const a = device('a2', drive), b = device('b2', drive);
    a.write('sprites/old/idle.png', 'x');
    await a.round();
    await b.round();
    fs.rmSync(path.join(a.dir, 'sprites/old'), { recursive: true });
    await a.round();
    assert.deepStrictEqual(drive.names(), []);
    await b.round();
    assert(!fs.existsSync(path.join(b.dir, 'sprites/old')), 'pack folder removed on the other device');
    assert(fs.existsSync(path.join(b.dir)), 'mirror folder itself stays');
  });

  await ok('mirror: on a conflict this device keeps its own file and takes everyone else\'s', async () => {
    const drive = new FakeDrive();
    const a = device('a3', drive), b = device('b3', drive);
    a.write('devices/a3.json', 'a v1');
    a.write('sprites/p/idle.png', 'v1');
    await a.round();
    await b.round();
    a.write('sprites/p/idle.png', 'from a');
    await a.round();
    b.write('sprites/p/idle.png', 'from b');
    await b.round();
    assert.strictEqual(b.read('sprites/p/idle.png'), 'from a', 'shared file: Drive wins');
    await drive.update([...drive.files.keys()].find((id) => drive.files.get(id).name === 'devices/a3.json'), Buffer.from('stale copy'));
    a.write('devices/a3.json', 'a v2');
    await a.round();
    assert.strictEqual(drive.text('devices/a3.json'), 'a v2', 'own device file: this device wins');
  });

  await ok('mirror: duplicate uploads collapse to the newest, big files are skipped and reported', async () => {
    const drive = new FakeDrive();
    await drive.create('sprites/p/walk.png', Buffer.from('older'));
    await drive.create('sprites/p/walk.png', Buffer.from('newer'));
    const a = device('a4', drive);
    a.write('sprites/p/huge.png', Buffer.alloc(5 * 1024 * 1024 + 1));
    const r = await a.round();
    assert.deepStrictEqual(drive.names(), ['sprites/p/walk.png']);
    assert.strictEqual(a.read('sprites/p/walk.png'), 'newer');
    assert.deepStrictEqual(r.skipped, ['sprites/p/huge.png']);
  });

  await ok('sign-in: loopback redirect, state and PKCE checked, account saved, Drive pulled', async () => {
    const saved = { value: null };
    const vault = { read: () => saved.value, write: (v) => { saved.value = v; }, clear: () => { saved.value = null; } };
    const posts = [];
    const idToken = `x.${Buffer.from(JSON.stringify({ email: 'luna@example.com' })).toString('base64url')}.y`;
    const fetcher = async (url, opts = {}) => {
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        posts.push(Object.fromEntries(new URLSearchParams(opts.body.toString())));
        return { ok: true, json: async () => ({ access_token: 'at', expires_in: 3600, refresh_token: 'rt', scope: `openid ${SCOPE} email`, id_token: idToken }) };
      }
      assert.strictEqual(opts.headers.Authorization, 'Bearer at');
      return { ok: true, json: async () => ({ files: [] }) };
    };
    const g = new GoogleDrive({ dir: path.join(tmp, 'g'), deviceID: 'me', vault, fetcher, client: { id: 'cid', secret: 'cs' } });
    const get = (url) => new Promise((resolve, reject) => http.get(url, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject));
    let challenge = '';
    const result = await g.signIn(async (authURL) => {
      const q = new URL(authURL).searchParams;
      assert.strictEqual(q.get('client_id'), 'cid');
      assert(q.get('scope').includes(SCOPE));
      assert.strictEqual(q.get('code_challenge_method'), 'S256');
      challenge = q.get('code_challenge');
      const redirect = new URL(q.get('redirect_uri'));
      assert.strictEqual(redirect.hostname, '127.0.0.1', 'listens on loopback only');
      assert.strictEqual(await get(`${redirect.origin}/?code=forged&state=wrong`), 404, 'a wrong state is ignored');
      assert.strictEqual(await get(`${redirect.origin}/?code=abc&state=${q.get('state')}`), 200);
    });
    assert.deepStrictEqual(result, { ok: true, path: path.join(tmp, 'g'), email: 'luna@example.com' });
    assert.strictEqual(posts[0].code, 'abc');
    assert.strictEqual(crypto.createHash('sha256').update(posts[0].code_verifier).digest('base64url'), challenge, 'verifier matches the challenge');
    assert.deepStrictEqual(JSON.parse(saved.value), { refreshToken: 'rt', email: 'luna@example.com' });
  });

  await ok('sign-in: unticked Drive permission, cancel, and an expired token all fail cleanly', async () => {
    const vault = { value: null, read() { return this.value; }, write(v) { this.value = v; }, clear() { this.value = null; } };
    let grant = { scope: 'openid email' };
    const fetcher = async () => ({ ok: !grant.error, json: async () => ({ access_token: 'at', expires_in: 3600, refresh_token: 'rt', ...grant }) });
    const g = new GoogleDrive({ dir: path.join(tmp, 'g2'), deviceID: 'me', vault, fetcher, client: { id: 'cid', secret: 'cs' } });
    const approve = (url) => new Promise((resolve) => {
      const q = new URL(url).searchParams;
      http.get(`${q.get('redirect_uri')}/?code=abc&state=${q.get('state')}`, (res) => { res.resume(); res.on('end', resolve); });
    });
    const unticked = await g.signIn(approve);
    assert(!unticked.ok && /permission/.test(unticked.error), unticked.error);
    assert.strictEqual(vault.value, null);

    const cancelled = await g.signIn(() => g.cancelSignIn());
    assert.deepStrictEqual(cancelled, { ok: false, error: 'Sign-in was cancelled.' });

    vault.value = JSON.stringify({ refreshToken: 'old' });
    const expired = new GoogleDrive({ dir: path.join(tmp, 'g3'), deviceID: 'me', vault, fetcher, client: { id: 'cid', secret: 'cs' } });
    grant = { error: 'invalid_grant' };
    await expired.tick();
    assert(/expired/.test(expired.error), expired.error);
    assert(!expired.signedIn && vault.value === null, 'forgets the dead token');
  });

  await ok('sign-out: packs come home, the mirror and account are removed, access is revoked', async () => {
    const vault = { value: JSON.stringify({ refreshToken: 'rt' }), read() { return this.value; }, write(v) { this.value = v; }, clear() { this.value = null; } };
    const revoked = [];
    const fetcher = async (url, opts) => { revoked.push([url, opts.body.toString()]); return { ok: true }; };
    const g = new GoogleDrive({ dir: path.join(tmp, 'g4'), deviceID: 'me', vault, fetcher, client: { id: 'cid', secret: 'cs' } });
    fs.mkdirSync(path.join(g.root, 'sprites', 'synced-only'), { recursive: true });
    fs.writeFileSync(path.join(g.root, 'sprites', 'synced-only', 'idle.png'), 'p');
    const local = path.join(tmp, 'local-sprites');
    fs.mkdirSync(local);
    g.bringPacksHome(local);
    await g.signOut();
    assert(fs.existsSync(path.join(local, 'synced-only', 'idle.png')));
    assert(!fs.existsSync(g.dir) && vault.value === null && !g.signedIn);
    assert.deepStrictEqual(revoked, [['https://oauth2.googleapis.com/revoke', 'token=rt']]);
  });

  console.log(`\n${checks} checks passed`);
  fs.rmSync(tmp, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });
