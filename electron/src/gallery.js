// Sprite pack gallery: original packs listed in the repo's packs/index.json, installed into the sprites folder.
const fs = require('fs');
const path = require('path');

const BASE = 'https://raw.githubusercontent.com/jacobsekai/deskpet/main/packs/';
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** A plain relative path inside the pack ("walking_1.png", "sounds/purr.mp3"); null otherwise. */
function safeFile(rel) {
  const s = String(rel || '');
  if (!s || s.startsWith('/') || s.includes('\\') || s.length > 120) return null;
  const parts = s.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || !/^[\w .-]+$/.test(p))) return null;
  return s;
}

async function getJSON(url, fetcher) {
  const res = await fetcher(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`the gallery answered ${res.status}`);
  return res.json();
}

/** Packs in the gallery, marked if they're already installed in `spritesDir`. */
async function list(spritesDir, { fetcher = fetch, base = BASE } = {}) {
  const index = await getJSON(`${base}index.json`, fetcher);
  const packs = (Array.isArray(index) ? index : index.packs || []).filter((p) => p && ID.test(p.id || ''));
  return packs.map((p) => ({
    id: p.id, name: String(p.name || p.id), author: String(p.author || ''), description: String(p.description || ''),
    license: String(p.license || ''), preview: safeFile(p.preview) ? `${base}${p.id}/${p.preview}` : null,
    installed: fs.existsSync(path.join(spritesDir, p.id)),
  }));
}

/** Downloads one pack into `spritesDir/<id>` (into a temp folder first, so a failed download leaves nothing behind). */
async function install(id, spritesDir, { fetcher = fetch, base = BASE } = {}) {
  if (!ID.test(String(id || ''))) throw new Error("that isn't a gallery pack");
  const index = await getJSON(`${base}index.json`, fetcher);
  const entry = (Array.isArray(index) ? index : index.packs || []).find((p) => p && p.id === id);
  if (!entry) throw new Error("that pack isn't in the gallery anymore");
  const files = (entry.files || []).map(safeFile).filter(Boolean);
  if (!files.length) throw new Error('that pack has no files');
  const tmp = path.join(spritesDir, `.${id}.download`);
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    for (const rel of files) {
      const res = await fetcher(`${base}${id}/${rel.split('/').map(encodeURIComponent).join('/')}`, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`couldn't download ${rel} (${res.status})`);
      const dest = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    }
    const dir = path.join(spritesDir, id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(tmp, dir);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return id;
}

module.exports = { list, install, safeFile, BASE };
