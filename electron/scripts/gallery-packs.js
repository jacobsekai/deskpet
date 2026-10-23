// The seed packs for the sprite gallery: original recolors of the built-in cat, rendered frame by frame.
// Regenerate with: npm run gallery-packs   (writes ../packs/<id>/ and ../packs/index.json)
const fs = require('fs');
const path = require('path');

const PALETTES = [
  { id: 'midnight', name: 'Midnight', description: 'A sleek black cat for late-night coding.', fur: { base: '#4B4B5E', light: '#8A8AA0' } },
  { id: 'snowball', name: 'Snowball', description: 'A fluffy white cat, soft as fresh snow.', fur: { base: '#F2F1F6', light: '#FFFFFF' } },
  { id: 'ginger', name: 'Ginger', description: 'An orange tabby with stripes and attitude.', fur: { base: '#F39A45', light: '#FFE0BD', stripes: '#C9661F' } },
];

// Times are picked from the cat's animation cycles (eyes open, paws mid-tap, walk-cycle quarters).
const FRAMES = [
  ['idle_1.png', 'idle', 0.6], ['idle_2.png', 'idle', 0.05], ['typing_1.png', 'typing', 0.3], ['typing_2.png', 'typing', 0.42],
  ['thinking.png', 'thinking', 0.6], ['needs-you.png', 'needsYou', 0.6], ['done.png', 'done', 0.6], ['petted.png', 'petted', 0.6],
  ['sleeping.png', 'sleeping', 0.6], ['sleepy.png', 'sleepy', 0.6], ['dragged.png', 'dragged', 0.6], ['startled.png', 'startled', 0.6],
  ['reading.png', 'reading', 0.6], ['searching.png', 'searching', 0.6], ['oops.png', 'oops', 0.6], ['error.png', 'error', 0.6],
  ['walking_1.png', 'walking', 0], ['walking_2.png', 'walking', 0.131], ['walking_3.png', 'walking', 0.262], ['walking_4.png', 'walking', 0.393],
  ['flying.png', 'flying', 0.6, { spin: 0.5 }], ['dizzy.png', 'dizzy', 0.6], ['tidying.png', 'tidying', 0.6], ['delegating.png', 'delegating', 0.6],
].map(([name, mood, t, extra]) => ({ name, t, pose: { mood, ...(extra || {}) } }));

const PACK_JSON = {
  height: 92, fps: 6, facing: 'right', personality: 'cat', bounce: true,
  moods: { idle: { durations: [3.5, 0.15] }, typing: { fps: 8 }, walking: { fps: 8 } },
};

function request() {
  return { palettes: PALETTES.map(({ id, fur }) => ({ id, fur })), frames: FRAMES, scale: 1.5 };
}

/** Writes the rendered frames ({ 'id/file': dataURL }) as packs plus the gallery index. */
function write(rendered, outDir) {
  const index = [];
  for (const p of PALETTES) {
    const dir = path.join(outDir, p.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (const f of FRAMES) {
      const data = rendered[`${p.id}/${f.name}`];
      if (!data) throw new Error(`missing frame ${p.id}/${f.name}`);
      fs.writeFileSync(path.join(dir, f.name), Buffer.from(data.split(',')[1], 'base64'));
      files.push(f.name);
    }
    fs.copyFileSync(path.join(dir, 'idle_1.png'), path.join(dir, 'preview.png'));
    fs.writeFileSync(path.join(dir, 'pack.json'), `${JSON.stringify({ ...PACK_JSON, name: p.name }, null, 2)}\n`);
    files.push('preview.png', 'pack.json');
    index.push({ id: p.id, name: p.name, author: 'DeskPet', description: p.description, preview: 'preview.png', license: 'MIT, original DeskPet art', files });
  }
  fs.writeFileSync(path.join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

module.exports = { request, write, PALETTES, FRAMES };
