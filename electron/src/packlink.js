// Importing a sprite pack from a Google Drive share link, same rules as PackLink.swift. No sign-in needed: Drive
// serves files shared with "Anyone with the link" to anyone. Only .zip packs, checked before unzipping since the
// link may come from anyone.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_BYTES = 50 * 1024 * 1024;
const NOT_SHARED = 'that file isn\'t shared yet: in Google Drive, choose Share → General access → "Anyone with the link"';

/** { id } for a Drive file link, { folder: true } for a folder link, null for anything else. */
function driveFileID(link) {
  let url;
  try { url = new URL(String(link).trim()); } catch (_) { return null; }
  if (url.protocol !== 'https:' || !['drive.google.com', 'docs.google.com', 'drive.usercontent.google.com'].includes(url.hostname)) return null;
  if (/\/folders\//.test(url.pathname)) return { folder: true };
  const m = /\/d\/([\w-]+)/.exec(url.pathname);
  const id = m ? m[1] : url.searchParams.get('id');
  return id && /^[\w-]{10,}$/.test(id) ? { id } : null;
}

/** Throws unless buf is a zip whose entries all stay inside the folder it's unpacked into. */
function checkZip(buf) {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new Error("that link isn't a .zip sprite pack");
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('that .zip looks damaged');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('that .zip looks damaged');
    const nameLength = buf.readUInt16LE(p + 28);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength).replace(/\\/g, '/');
    if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..') || (mode & 0o170000) === 0o120000) {
      throw new Error(`that .zip has an unsafe file in it (${name})`);
    }
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
}

/** The pack name from Drive's Content-Disposition, safe to use as a folder name. */
function zipName(disposition) {
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition || ''), plain = /filename="?([^";]+)"?/i.exec(disposition || '');
  let name = 'drive-pack';
  try { name = star ? decodeURIComponent(star[1]) : plain ? plain[1] : name; } catch (_) { /* bad escape */ }
  name = path.posix.basename(name.replace(/\\/g, '/')).replace(/\.zip$/i, '').replace(/[^\p{L}\p{N} ._-]/gu, '-').replace(/^[.\s]+/, '').trim();
  return name || 'drive-pack';
}

/** Downloads the linked .zip into a new temp folder and returns its path; the caller imports it and removes the folder. */
async function downloadDriveZip(link, fetcher = fetch) {
  const ref = driveFileID(link);
  if (!ref) throw new Error('paste a Google Drive share link to a sprite pack .zip');
  if (ref.folder) throw new Error("that's a folder link: share the pack's .zip file instead");
  let res;
  try {
    res = await fetcher(`https://drive.usercontent.google.com/download?id=${ref.id}&export=download&confirm=t`, { headers: { 'User-Agent': 'DeskPet' } });
  } catch (_) {
    throw new Error("can't reach Google Drive right now");
  }
  if (res.status === 401 || res.status === 403) throw new Error(NOT_SHARED);
  if (!res.ok) throw new Error(res.status === 404 ? "couldn't find that file on Google Drive: check the link, and that it's shared with \"Anyone with the link\"" : `Google Drive said HTTP ${res.status}`);
  // A private file comes back as Google's sign-in page.
  if (/text\/html/i.test(res.headers.get('content-type') || '')) throw new Error(NOT_SHARED);
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('that pack is over 50 MB');
    chunks.push(Buffer.from(chunk));
  }
  const buf = Buffer.concat(chunks);
  checkZip(buf);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deskpet-link-'));
  const file = path.join(dir, `${zipName(res.headers.get('content-disposition'))}.zip`);
  fs.writeFileSync(file, buf);
  return file;
}

module.exports = { driveFileID, checkZip, zipName, downloadDriveZip };
