// Node side of the companion (src/companion/engine.js): where its memory lives and which personality
// the current character uses. The macOS app does the same in Companion.swift.
const fs = require('fs');
const path = require('path');
const Companion = require('./companion/engine');
const { paths, readJSON } = require('./settings');

const PERSONALITIES = path.join(__dirname, 'companion', 'personalities');

function loadPersonalities() {
  const out = {};
  for (const f of fs.readdirSync(PERSONALITIES)) {
    if (f.endsWith('.json')) out[path.basename(f, '.json')] = readJSON(path.join(PERSONALITIES, f), null);
  }
  return out;
}

/**
 * The built-in cat talks like a cat. A sprite pack can ship its own dialogue.json (which extends a built-in
 * personality), or name one in pack.json ("personality": "minori"); packs named Minori get hers.
 */
function personalityFor(packName) {
  if (!packName) return { personality: 'cat', source: 'built-in cat' };
  const dir = path.join(paths.sprites, packName);
  const custom = readJSON(path.join(dir, 'dialogue.json'), null);
  if (custom && typeof custom === 'object' && !Array.isArray(custom)) {
    return { personality: { extends: 'friend', name: packName, ...custom }, source: `${packName}/dialogue.json` };
  }
  const options = readJSON(path.join(dir, 'pack.json'), {});
  if (typeof options.personality === 'string') return { personality: options.personality, source: `${packName}/pack.json` };
  return /minori/i.test(packName) ? { personality: 'minori', source: 'matched by name' } : { personality: 'friend', source: 'default' };
}

function createCompanion(platform) {
  const file = path.join(paths.root, 'companion.json');
  return Companion.create({
    personalities: loadPersonalities(),
    state: readJSON(file, null),
    host: {
      platform,
      save(json) {
        fs.mkdirSync(paths.root, { recursive: true });
        fs.writeFileSync(`${file}.tmp`, json);
        fs.renameSync(`${file}.tmp`, file);
      },
    },
  });
}

module.exports = { createCompanion, personalityFor };
