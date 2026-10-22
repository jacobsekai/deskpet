// Plays through every conversation in every built-in personality, plus reputation, reminders, games, and sync.
// Run: node test/companion.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Companion = require('../src/companion/engine');

const dir = path.join(__dirname, '..', 'src', 'companion', 'personalities');
const personalities = {};
for (const f of fs.readdirSync(dir)) personalities[path.basename(f, '.json')] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

const STEP_KEYS = new Set(['say', 'mood', 'ask', 'choices', 'key', 'label', 'input', 'placeholder', 'kind', 'then', 'skip', 'when', 'else', 'steps',
  'affection', 'remember', 'forget', 'farewell', 'action', 'random', 'pick', 'pool', 'game', 'text']);
const CHOICE_KEYS = new Set(['label', 'value', 'say', 'steps', 'affection', 'remember', 'mood', 'when', 'farewell']);
const MOODS = new Set(['happy', 'love', 'excited', 'proud', 'thinking', 'sleepy', 'surprised', 'nervous', 'sad', 'worried', 'reading', 'idle', 'dizzy', 'typing']);

function lint(steps, where) {
  for (const s of [].concat(steps || [])) {
    if (typeof s === 'string') { assert(!/\{(?!owner|pet|name|mem:|timeOfDay|weekday|tier|value|hours|tasks|focus)[^}]*\}/.test(s), `${where}: unknown placeholder in "${s}"`); continue; }
    if (Array.isArray(s)) { lint(s, where); continue; }
    for (const k of Object.keys(s)) assert(STEP_KEYS.has(k), `${where}: unknown step key "${k}"`);
    if (s.mood) assert(MOODS.has(s.mood), `${where}: unknown mood ${s.mood}`);
    if (s.ask !== undefined) {
      assert(s.ask, `${where}: empty question`);
      assert(s.choices && s.choices.length, `${where}: question without choices`);
      for (const c of s.choices) {
        for (const k of Object.keys(c)) assert(CHOICE_KEYS.has(k), `${where}: unknown choice key "${k}"`);
        if (c.mood) assert(MOODS.has(c.mood), `${where}: unknown mood ${c.mood}`);
        lint(c.steps, where);
      }
    }
    lint(s.then, where); lint(s.skip, where); lint(s.else, where); lint(s.steps, where);
    if (s.random) s.random.forEach((r) => lint(r, where));
    if (s.game) assert(Companion.GAMES.some((g) => g.id === s.game), `${where}: unknown game ${s.game}`);
  }
}

function make(personality, state) {
  let saved = null;
  const e = Companion.create({ personalities, personality, state, host: { save: (json) => { saved = json; }, platform: 'mac' } });
  e.setNames('Luna', 'Mochi');
  return { e, saved: () => saved };
}

/** Plays a conversation to the end, answering with `pick` (index → choice). */
function play(e, first, pick = 0) {
  let node = first;
  for (let i = 0; i < 80; i++) {
    assert(node && node.kind, 'node has a kind');
    if (node.text != null) assert(!/\{[a-z]+(:\w+)?\}/i.test(node.text), `unfilled placeholder: ${node.text}`);
    if (node.kind === 'menu' || node.kind === 'end') return node;
    let r;
    if (node.kind === 'ask') r = e.ui('choose', { index: Math.min(pick, node.choices.length - 1) });
    else if (node.kind === 'input') r = e.ui('input', { value: node.input.kind === 'date' ? '10-22' : 'pizza' });
    else if (node.kind === 'game') r = e.ui('game', { game: node.game, outcome: 'win' });
    else r = e.ui('next');
    node = r.result;
    // After a game, "Again?" → pick "Something else".
    if (node && node.kind === 'ask' && node.choices[0] === 'Again! 🔁') node = e.ui('choose', { index: 1 }).result;
  }
  throw new Error('conversation never ended');
}

let checks = 0;
for (const id of Object.keys(personalities)) {
  const { e } = make(id);
  const persona = e._persona();
  assert(persona.topics.length > 20, `${id} has topics`);
  const ids = new Set();
  for (const t of persona.topics) {
    assert(!ids.has(t.id), `${id}: duplicate topic ${t.id}`); ids.add(t.id);
    assert(t.category, `${id}/${t.id}: category`);
    if (t.category === 'milestone') assert(['friends', 'good', 'close', 'best', 'soul'].includes(t.tier), `${id}/${t.id}: milestone tier`);
    lint(t.steps, `${id}/${t.id}`);
    for (const pick of [0, 1, 2, 3]) {
      const fresh = make(id, { affection: 600 }).e;
      const end = play(fresh, fresh._run(t.id), pick);
      assert(end.kind === 'menu' || (end.kind === 'end' && end.quit), `${id}/${t.id} ends in a menu or a goodbye`);
      checks++;
    }
  }
  for (const [k, lines] of Object.entries(persona.pools)) for (const l of lines) lint([l], `${id} pool ${k}`);
  // Every menu opens.
  const m = e.ui('open', {}).result;
  assert(m.kind === 'menu' && m.menu.items.length >= 6, `${id}: main menu`);
  for (const item of m.menu.items) {
    const r = e.ui('menu', { id: item.id }).result;
    assert(r, `${id}: menu ${item.id}`);
    play(e, r);
  }
  console.log(`✓ ${id}: ${persona.topics.length} topics, ${Object.keys(persona.pools).length} pools`);
}

// Reputation: affection grows (capped per day), drops when unkind, and tiers unlock milestones.
{
  const { e } = make('minori');
  e.event('launch');
  for (let i = 0; i < 100; i++) e.event('petted');
  assert(e.summary().affection.value <= 12.01, 'daily cap');
  const st = e._state();
  st.gained = { day: '', amount: 0 };
  st.affection = 14.9;
  const fx = e.event('petted');
  // Reaching "friends" offers the milestone conversation.
  e.tick({ idle: 0 });
  assert(e.summary().affection.tier === 'Supporter', `minori tier name: ${e.summary().affection.tier}`);
  assert(e.hasOffer(), 'milestone offered');
  const ms = e.ui('open', { topic: 'offer' }).result;
  assert(/embarrassing/.test(ms.text), `milestone text: ${ms.text}`);
  play(e, ms);
  assert(e.ui('open', {}).result.menu.items.some((i) => i.id === 'memories'), 'special moments menu');
  // Being mean costs affection and can make the pet upset.
  st.affection = 2;
  play(e, e._run('tell_mean'));
  assert(e.summary().affection.upset, 'upset after being mean');
  assert(/…|Um|Yes/.test(e.ui('open', {}).result.text), 'upset menu line');
  play(e, e._run('tell_apology'));
  assert(e.summary().affection.value > -2, 'apology helps');
  fx.length;
  checks++;
}

// Throwing too much, long absences, and quitting without goodbye.
{
  const { e } = make('cat');
  for (let i = 0; i < 20; i++) e.event('thrown');
  assert(e.summary().affection.value < 0, 'throwing too much hurts');
  const st = e._state();
  st.affection = 50; st.lastSeen = Date.now() - 10 * 86400 * 1000; st.cleanExit = false;
  e.event('launch');
  assert(e.summary().affection.value === 47.5, `absence costs affection (${e.summary().affection.value})`);
  checks++;
}

// Nickname from the "close" milestone shows up as {owner} sometimes.
{
  const { e } = make('friend', { affection: 200 });
  play(e, e._run('ms_close'));
  assert.strictEqual(e._state().memory.nickname.value, 'pizza');
  const greetings = new Set(Array.from({ length: 40 }, () => e.line('greeting.back')));
  assert([...greetings].some((g) => g.includes('pizza')) && [...greetings].some((g) => g.includes('Luna')), 'nickname mixes in');
  checks++;
}

// Memory from questions, recall, and birthday as a date.
{
  const { e } = make('friend', { affection: 10 });
  play(e, e._run('q_birthday'));
  assert.strictEqual(e._state().memory.birthday.value, '10-22');
  const recall = play(e, e.ui('menu', { id: 'recall' }).result);
  assert(recall.kind === 'menu');
  // A null choice value doesn't remember the label.
  play(e, e._run('q_color'), 8);
  assert.strictEqual(e._state().memory.favoriteColor.value, 'pizza');
  checks++;
}

// Ambient reminders: water after 90 minutes of activity, and only when you're around.
{
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    const { e } = make('cat');
    e.ui('setting', { key: 'breaks', value: 0 });
    e.ui('setting', { key: 'chatter', value: 'off' });
    e.ui('setting', { key: 'motivation', value: false });
    e.ui('setting', { key: 'lateNight', value: false });
    e.ui('setting', { key: 'recap', value: false });
    const said = [];
    for (let i = 0; i < 95 * 12; i++) { t += 5000; for (const f of e.tick({ idle: 3 })) if (f.type === 'say') said.push(f.text); }
    assert(said.some((s) => /water|sip|hydrat/i.test(s)), `water reminder: ${said.join(' | ')}`);
    const before = said.length;
    for (let i = 0; i < 100 * 12; i++) { t += 5000; e.tick({ idle: 3, focus: 'focus' }); }
    for (let i = 0; i < 12; i++) { t += 5000; for (const f of e.tick({ idle: 3, quiet: true })) if (f.type === 'say') said.push(f.text); }
    assert.strictEqual(said.length, before, 'quiet during focus and calls');
  } finally { Date.now = realNow; }
  checks++;
}

// App comments and categories.
assert.strictEqual(Companion.categorize('Google Chrome', 'Lofi beats - YouTube'), 'video');
assert.strictEqual(Companion.categorize('Code'), 'code');
assert.strictEqual(Companion.categorize('Spotify'), 'music');
assert.strictEqual(Companion.categorize('Discord'), 'chat');
assert.strictEqual(Companion.categorize('Figma'), 'design');
assert.strictEqual(Companion.categorize('Finder'), 'other');

// Sync merges; transfer replaces.
{
  const a = make('friend').e, b = make('friend').e;
  a._state().affection = 80;
  a.ui('remember', { key: 'favoriteFood', value: 'ramen', label: 'favorite food' });
  b.ui('remember', { key: 'hobby', value: 'drawing', label: 'hobby' });
  b.mergeData(JSON.parse(JSON.stringify(a.exportData())));
  assert.strictEqual(b.summary().affection.value, 80);
  assert.deepStrictEqual(b.summary().memories.map((m) => m.key).sort(), ['favoriteFood', 'hobby']);
  b.replaceData({ affection: 5, memory: {} });
  assert.strictEqual(b.summary().memories.length, 0);
  checks++;
}

// Custom packs can extend a personality and rename tiers.
{
  const e = Companion.create({ personalities, personality: { extends: 'cat', name: 'Tama', tierNames: { soul: 'Soulmates' }, pools: { petted: ['nya!'] } } });
  assert.strictEqual(e.line('petted'), 'nya!');
  assert(e.summary().tiers.some((t) => t.name === 'Soulmates'));
  checks++;
}

console.log(`companion: ${checks} checks passed`);
