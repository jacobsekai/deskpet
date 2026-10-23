// MAS-style gifts: files named after the gift, ending in .gift, in ~/.deskpet/gifts. Given gifts move to given/.
// Same rules as Gifts.swift; the companion engine decides how the pet reacts.
const fs = require('fs');
const path = require('path');
const { paths } = require('./settings');

const folder = path.join(paths.realRoot || paths.root, 'gifts');

const NOTE = `Give your pet a gift:
1. Make a file named after the gift, ending in .gift (for example salmon_bento.gift or Haruka Merch.gift).
   An empty file is fine. The control center (Companion → Gifts) can make one for you.
2. Talk to your pet → "I'd like to give you a gift" → choose the file (or drop it onto the pet).
Gifts unlock once you're friends; some need a closer bond. Given gifts move to the "given" folder.
`;

function ensureFolder(dir = folder) {
  fs.mkdirSync(path.join(dir, 'given'), { recursive: true });
  const note = path.join(dir, 'How to give gifts.txt');
  if (!fs.existsSync(note)) fs.writeFileSync(note, NOTE);
  return dir;
}

/** "salmon bento" → a new empty "salmon bento.gift" (or "salmon bento 2.gift" if it exists). */
function make(raw, dir = folder) {
  const name = String(raw || '').replace(/\.gift$/i, '').replace(/[^\p{L}\p{N} _-]/gu, '').trim();
  if (!name) return null;
  ensureFolder(dir);
  let file = path.join(dir, `${name}.gift`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${name} ${n}.gift`);
  fs.writeFileSync(file, '');
  return file;
}

/** Moves a given gift into given/ (like MAS deleting it). */
function consume(file, dir = folder) {
  ensureFolder(dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(dir, 'given', `${path.basename(file, path.extname(file))} ${stamp}.gift`);
  try { fs.renameSync(file, dest); } catch (_) {
    try { fs.copyFileSync(file, dest); fs.unlinkSync(file); } catch (__) { /* already gone */ }
  }
  return dest;
}

/** A safe topic id for the talk window: letters, digits, and underscores. */
const topicID = (file) => path.basename(file, path.extname(file)).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

module.exports = { folder, ensureFolder, make, consume, topicID };
