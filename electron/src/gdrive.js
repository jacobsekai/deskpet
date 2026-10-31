// Google Drive sync, same behavior as GoogleDrive.swift. Signing in uses Google's desktop flow (the browser, a
// one-time loopback redirect, PKCE). A local folder laid out like a cloud sync folder is mirrored to DeskPet's
// private app-data space in your Drive, so Sync works on it unchanged; only DeskPet can see those files.
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILES = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const MAX_BYTES = 5 * 1024 * 1024; // Drive's limit for single-request uploads
const SIGN_IN_TIMEOUT = 5 * 60 * 1000;
const SKIP = /(^|\/)\.|\.tmp$/;

const md5 = (data) => crypto.createHash('md5').update(data).digest('hex');
const b64url = (data) => Buffer.from(data).toString('base64url');

/** The "Desktop app" OAuth client from Google Cloud, as downloaded. Kept out of git; CI adds it at build time. */
function loadClient(file = path.join(__dirname, 'google-oauth.json')) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf8'));
    const c = o.installed || o;
    return c.client_id && c.client_secret ? { id: c.client_id, secret: c.client_secret } : null;
  } catch (_) { return null; }
}

/** Files under dir as { 'devices/x.json': md5 }, leaving out dotfiles and half-written .tmp files. */
function scan(dir) {
  const out = {};
  const walk = (rel) => {
    let entries;
    try { entries = fs.readdirSync(rel ? path.join(dir, rel) : dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (SKIP.test(name)) continue;
      if (e.isDirectory()) walk(name);
      else if (e.isFile()) out[name] = md5(fs.readFileSync(path.join(dir, name)));
    }
  };
  walk('');
  return out;
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, data);
  fs.renameSync(`${file}.tmp`, file);
}

function removeLocal(dir, name) {
  fs.rmSync(path.join(dir, name), { force: true });
  // A sprite pack removed on another device leaves empty folders behind.
  for (let d = path.dirname(name); d !== '.'; d = path.dirname(d)) {
    try { fs.rmdirSync(path.join(dir, d)); } catch (_) { break; }
  }
}

/**
 * One round of two-way mirroring between dir and Drive. state is each file's md5 as of the last round, so whichever
 * side changed since then wins; when both did, this device's own file goes up and everything else comes down.
 */
async function mirror({ dir, api, state, own }) {
  const remote = new Map();
  for (const f of await api.list()) {
    const seen = remote.get(f.name);
    if (!seen) { remote.set(f.name, f); continue; }
    // Two devices uploaded the same new file at once: keep the newer copy.
    const [keep, drop] = seen.modifiedTime >= f.modifiedTime ? [seen, f] : [f, seen];
    remote.set(f.name, keep);
    await api.remove(drop.id);
  }
  const local = scan(dir);
  const next = {};
  const skipped = [];
  for (const name of new Set([...Object.keys(local), ...remote.keys(), ...Object.keys(state)])) {
    const base = state[name] || null, mine = local[name] || null, file = remote.get(name) || null;
    const theirs = file ? file.md5Checksum : null;
    if (mine === theirs) {
      if (mine) next[name] = mine;
      continue;
    }
    const localChanged = mine !== base, remoteChanged = theirs !== base;
    const push = localChanged && remoteChanged ? !!mine && (!theirs || name === own) : localChanged;
    if (push && !mine) {
      await api.remove(file.id);
    } else if (push) {
      const data = fs.readFileSync(path.join(dir, name));
      if (data.length > MAX_BYTES) {
        skipped.push(name);
        if (base) next[name] = base;
        continue;
      }
      if (file) await api.update(file.id, data); else await api.create(name, data);
      next[name] = mine;
    } else if (!file) {
      removeLocal(dir, name);
    } else {
      writeAtomic(path.join(dir, name), await api.download(file.id));
      next[name] = theirs;
    }
  }
  return { state: next, skipped };
}

/** Drive v3 calls limited to the appDataFolder space. */
class DriveAPI {
  constructor(token, fetcher) { this.token = token; this.fetch = fetcher; }

  async request(url, opts = {}, allowMissing = false) {
    const res = await this.fetch(url, { ...opts, headers: { Authorization: `Bearer ${await this.token()}`, ...opts.headers } });
    if (res.ok || (allowMissing && res.status === 404)) return res;
    const body = await res.json().catch(() => ({}));
    throw new Error(`Google Drive: ${(body.error && body.error.message) || `HTTP ${res.status}`}`);
  }

  async list() {
    const files = [];
    let page = '';
    do {
      const q = new URLSearchParams({ spaces: 'appDataFolder', pageSize: '1000', fields: 'nextPageToken,files(id,name,md5Checksum,modifiedTime)' });
      if (page) q.set('pageToken', page);
      const o = await (await this.request(`${FILES}?${q}`)).json();
      files.push(...(o.files || []));
      page = o.nextPageToken;
    } while (page);
    return files;
  }

  async download(id) { return Buffer.from(await (await this.request(`${FILES}/${id}?alt=media`)).arrayBuffer()); }

  async create(name, data) {
    const boundary = `deskpet-${crypto.randomBytes(8).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: ['appDataFolder'] })}\r\n`
        + `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`),
      data, Buffer.from(`\r\n--${boundary}--`),
    ]);
    await this.request(`${UPLOAD}?uploadType=multipart&fields=id`, { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
  }

  async update(id, data) {
    await this.request(`${UPLOAD}/${id}?uploadType=media&fields=id`, { method: 'PATCH', headers: { 'Content-Type': 'application/octet-stream' }, body: data });
  }

  async remove(id) { await this.request(`${FILES}/${id}`, { method: 'DELETE' }, true); }
}

const donePage = (text) => `<!doctype html><meta charset="utf-8"><title>DeskPet</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;background:#fdf6ee;color:#3a2d25">
<div style="text-align:center"><div style="font-size:56px">🐾</div><h2>${text}</h2><p>You can close this tab and go back to DeskPet.</p></div>`;

/** Signs in, keeps the account in `vault` ({ read, write, clear }), and mirrors `dir` to Drive. */
class GoogleDrive {
  constructor({ dir, deviceID, vault, fetcher = fetch, client = loadClient() }) {
    this.dir = dir;
    this.own = `devices/${deviceID}.json`;
    this.vault = vault;
    this.fetch = fetcher;
    this.client = client;
    try { this.account = JSON.parse(vault.read()); } catch (_) { this.account = null; }
    this.access = null;
    this.running = null;
    this.error = null;
    this.lastSync = null;
    this.pendingSignIn = null;
    this.api = new DriveAPI(() => this.accessToken(), fetcher);
  }

  get available() { return !!this.client; }
  get signedIn() { return !!this.account; }
  get email() { return this.account ? this.account.email : null; }
  /** The folder Sync uses; files live in its DeskPet/ like any cloud folder. */
  get folder() { return this.dir; }
  get root() { return path.join(this.dir, 'DeskPet'); }
  get statePath() { return path.join(this.dir, 'state.json'); }

  async tokenRequest(params) {
    const res = await this.fetch(TOKEN_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.client.id, client_secret: this.client.secret, ...params }),
    });
    const o = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(o.error_description || o.error || `HTTP ${res.status}`), { code: o.error });
    return o;
  }

  async accessToken() {
    if (this.access && this.access.expires > Date.now() + 60000) return this.access.token;
    if (!this.account) throw new Error('Signed out of Google. Sign in again.');
    let t;
    try {
      t = await this.tokenRequest({ grant_type: 'refresh_token', refresh_token: this.account.refreshToken });
    } catch (e) {
      if (e.code !== 'invalid_grant') throw e;
      this.forget();
      throw new Error('Google sign-in expired or was removed. Sign in again.');
    }
    this.access = { token: t.access_token, expires: Date.now() + t.expires_in * 1000 };
    return this.access.token;
  }

  /** Opens Google's sign-in page and waits for the browser to come back to a loopback port with the code. */
  authorize(openURL) {
    this.cancelSignIn();
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(16));
    return new Promise((resolve, reject) => {
      let redirect = '';
      let done = false;
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== '/' || url.searchParams.get('state') !== state) {
          res.writeHead(404, { Connection: 'close' });
          res.end();
          return;
        }
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
        res.end(donePage(code ? "You're signed in!" : 'Sign-in was cancelled.'));
        finish(code ? null : new Error(error === 'access_denied' ? 'Sign-in was cancelled.' : `Google sign-in failed (${error}).`), code);
      });
      const timer = setTimeout(() => finish(new Error('Sign-in timed out. Try again.')), SIGN_IN_TIMEOUT);
      const finish = (err, code) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        server.close();
        this.pendingSignIn = null;
        if (err) reject(err); else resolve({ code, redirect, verifier });
      };
      this.pendingSignIn = () => finish(new Error('Sign-in was cancelled.'));
      server.on('error', (e) => finish(e));
      server.listen(0, '127.0.0.1', () => {
        redirect = `http://127.0.0.1:${server.address().port}`;
        const q = new URLSearchParams({
          client_id: this.client.id, redirect_uri: redirect, response_type: 'code', scope: `openid email ${SCOPE}`, state,
          code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
          access_type: 'offline', prompt: 'consent',
        });
        Promise.resolve(openURL(`https://accounts.google.com/o/oauth2/v2/auth?${q}`)).catch((e) => finish(e));
      });
    });
  }

  cancelSignIn() { if (this.pendingSignIn) this.pendingSignIn(); }

  /** Signs in (unless already signed in) and downloads what other devices have, ready for Sync to join. */
  async signIn(openURL) {
    if (!this.client) return { ok: false, error: "Google sign-in isn't set up in this build of DeskPet." };
    if (!this.account) {
      try {
        const { code, redirect, verifier } = await this.authorize(openURL);
        const t = await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier });
        // Google lets people untick individual permissions on the consent screen.
        if (!(t.scope || '').split(' ').includes(SCOPE)) return { ok: false, error: 'DeskPet needs permission to keep its sync files in your Google Drive. Sign in again and leave that box ticked.' };
        if (!t.refresh_token) return { ok: false, error: "Google didn't send a sign-in token. Try again." };
        let email = null;
        // Straight from Google's token endpoint over HTTPS, and only shown in the panel.
        try { email = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url')).email || null; } catch (_) { /* no email scope */ }
        fs.rmSync(this.dir, { recursive: true, force: true });
        this.account = { refreshToken: t.refresh_token, email };
        this.access = { token: t.access_token, expires: Date.now() + t.expires_in * 1000 };
        this.vault.write(JSON.stringify(this.account));
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    await this.tick();
    return this.error ? { ok: false, error: this.error } : { ok: true, path: this.dir, email: this.email };
  }

  /** One mirror round; overlapping calls wait for the one already running. */
  tick() {
    if (!this.running) this.running = this.mirrorOnce().finally(() => { this.running = null; });
    return this.running;
  }

  async mirrorOnce() {
    if (!this.account) { this.error = 'Signed out of Google. Sign in again.'; return; }
    try {
      let state = {};
      try { state = JSON.parse(fs.readFileSync(this.statePath, 'utf8')); } catch (_) { /* first round */ }
      fs.mkdirSync(this.root, { recursive: true });
      const r = await mirror({ dir: this.root, api: this.api, state, own: this.own });
      writeAtomic(this.statePath, JSON.stringify(r.state));
      this.lastSync = Date.now();
      this.error = r.skipped.length ? `Not synced (over 5 MB): ${r.skipped.join(', ')}` : null;
    } catch (e) {
      this.error = e instanceof TypeError ? "Can't reach Google Drive right now. DeskPet will keep trying." : e.message;
    }
  }

  /** Before signing out: copy sprite packs that only exist in the mirror into the local sprites folder. */
  bringPacksHome(localSprites) {
    const synced = path.join(this.root, 'sprites');
    for (const name of fs.existsSync(synced) ? fs.readdirSync(synced) : []) {
      const target = path.join(localSprites, name);
      if (!name.startsWith('.') && !fs.existsSync(target)) fs.cpSync(path.join(synced, name), target, { recursive: true });
    }
  }

  /** Forgets the account here (Drive keeps the files for other devices) and revokes this device's access. */
  async signOut() {
    this.cancelSignIn();
    const account = this.account;
    this.forget();
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.error = null;
    this.lastSync = null;
    if (!account) return;
    try {
      await this.fetch('https://oauth2.googleapis.com/revoke', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: account.refreshToken }),
      });
    } catch (_) { /* offline: the token is already gone from this device */ }
  }

  forget() {
    this.account = null;
    this.access = null;
    this.vault.clear();
  }
}

module.exports = { GoogleDrive, DriveAPI, mirror, scan, loadClient, SCOPE };
