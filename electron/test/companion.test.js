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
  'affection', 'remember', 'forget', 'farewell', 'action', 'random', 'pick', 'pool', 'game', 'text', 'askPool', 'inputPool', 'max', 'ranges', 'prefix', 'suffix', 'log', 'journal']);
const CHOICE_KEYS = new Set(['label', 'value', 'say', 'steps', 'affection', 'remember', 'mood', 'when', 'farewell', 'checkin']);
const MOODS = new Set(['happy', 'love', 'excited', 'proud', 'thinking', 'sleepy', 'surprised', 'nervous', 'sad', 'worried', 'reading', 'idle', 'dizzy', 'typing']);

function lint(steps, where) {
  for (const s of [].concat(steps || [])) {
    if (typeof s === 'string') { assert(!/\{(?!owner|pet|name|mem:|timeOfDay|weekday|tier|value|hours|tasks|focus|time|places|count|host|home|sips|sipsText|today|todayText|breaks|other|title|emoji|unit|valueText|minutes)[^}]*\}/.test(s), `${where}: unknown placeholder in "${s}"`); continue; }
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
    if (s.ranges) s.ranges.forEach((r) => lint(r.steps, where));
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
    else if (node.kind === 'input') r = e.ui('input', { value: node.input.kind === 'date' ? '10-22' : node.input.kind === 'number' ? String([0, 2, 7, 30][pick]) : 'pizza' });
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
    // Trip talks need the trip's details; they're played below through the event that starts them.
    if (t.category === 'trip') continue;
    for (const pick of [0, 1, 2, 3]) {
      const fresh = make(id, { affection: 600 }).e;
      const end = play(fresh, fresh._run(t.id), pick);
      assert(end.kind === 'menu' || (end.kind === 'end' && (end.quit || end.close)), `${id}/${t.id} ends in a menu or a goodbye`);
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

// Trips: leaving, coming home, the "how was your day?" talk, the trip log, and visiting other computers.
for (const id of Object.keys(personalities)) {
  for (const pick of [0, 1, 2, 3, 4, 5]) {
    const { e } = make(id, { affection: 60 });
    e.event('launch');
    const leave = e.event('tripLeave');
    assert(leave.some((f) => f.type === 'say' && f.text), `${id}: trip leave line`);
    const back = e.event('tripReturn', { minutes: 200, visits: ["Sam's PC", "Sam's PC"], id: `trip-${pick}` });
    const xp = back.find((f) => f.type === 'xp');
    assert(xp && xp.amount === 11, `${id}: trip XP (${xp && xp.amount})`);
    assert(back.some((f) => f.type === 'say' && f.text.includes("Sam's PC")), `${id}: back line names the place`);
    assert(e.hasOffer(), `${id}: trip talk offered`);
    const first = e.ui('open', { topic: 'offer' }).result;
    assert(/3 hours|Sam's PC/.test(first.text), `${id}: trip talk knows the trip: ${first.text}`);
    let inputs = 0;
    let node = first;
    for (let i = 0; i < 40 && node.kind !== 'menu'; i++) {
      assert(!/\{[a-z]+(:\w+)?\}/i.test(node.text || ''), `${id}: unfilled placeholder: ${node.text}`);
      if (node.kind === 'ask') node = e.ui('choose', { index: Math.min(pick, node.choices.length - 1) }).result;
      else if (node.kind === 'input') { inputs++; node = e.ui('input', { value: 'we got bubble tea' }).result; }
      else node = e.ui('next').result;
    }
    assert.strictEqual(node.kind, 'menu', `${id}: trip talk ends in the menu`);
    const trips = e.summary().trips;
    assert.strictEqual(trips.length, 1, `${id}: trip logged`);
    assert.deepStrictEqual(trips[0].places, ["Sam's PC"]);
    assert.strictEqual(trips[0].minutes, 200);
    assert(trips[0].mood && trips[0].activity, `${id}: trip log has mood and activity`);
    assert.strictEqual(trips[0].moment, 'we got bubble tea', `${id}: trip moment`);
    // A rough day asks about it once; the "one thing that happened" question isn't repeated.
    assert(inputs <= 2, `${id}: asked ${inputs} times`);
    const arrive = e.event('tripArrive', { host: 'Library PC', homeName: 'MacBook', first: true });
    assert(arrive.some((f) => f.type === 'say' && f.text.includes('Library PC')) || arrive.some((f) => f.type === 'say'), `${id}: arrive line`);
    for (const ev of ['tripCalledHome', 'tripLuggage', 'movedIn', 'movingOut']) assert(e.event(ev).some((f) => f.type === 'say' && f.text), `${id}: ${ev} line`);
    checks++;
  }
  // "Come with me!" in the goodbye menu asks the host to start a trip.
  const { e } = make(id);
  const bye = e._run('bye_trip');
  let n = bye;
  let effects = [];
  for (let i = 0; i < 5 && n.kind !== 'end'; i++) { const r = e.ui('next'); n = r.result; effects = effects.concat(r.effects); }
  assert(n.kind === 'end' && n.close && effects.some((f) => f.type === 'trip'), `${id}: bye_trip starts a trip`);
  checks++;
}
{
  // Trip logs merge by id across devices.
  const a = make('friend').e;
  const b = make('friend').e;
  a.mergeData({ trips: [{ id: 'x', day: '2026-10-20', minutes: 30, places: [] }] });
  b.mergeData({ trips: [{ id: 'x', day: '2026-10-20', minutes: 30, places: [] }, { id: 'y', day: '2026-10-21', minutes: 5, places: [] }] });
  a.mergeData(b.exportData());
  assert.deepStrictEqual(a.summary().trips.map((t) => t.id), ['y', 'x']);
  checks++;
}

{
  // State tangled by the old macOS bridge (one shared object for memory, milestones, and a day) heals on load,
  // and JSON text works as well as objects.
  const shared = { greeted: true, birthday: { value: '01-01', label: 'birthday', at: 1 } };
  const e = Companion.create({ personalities: JSON.stringify(personalities), personality: 'friend', state: JSON.stringify({ memory: shared, milestones: shared, seen: shared, days: { '2026-10-23': shared } }) });
  const st = e._state();
  assert.deepStrictEqual(Object.keys(st.memory), ['birthday']);
  assert.deepStrictEqual(st.milestones, {});
  assert.deepStrictEqual(st.seen, {});
  assert.deepStrictEqual(st.days['2026-10-23'], { greeted: true });
  e.mergeData(JSON.stringify({ memory: { hobby: { value: 'drawing', label: 'hobby', at: 2 } } }));
  assert(e._state().memory.hobby, 'merge from JSON text');
  checks++;
}

{
  // Playtime throws never hurt the bond; rough throws past the limit do. The games menu starts playtime.
  for (const id of Object.keys(personalities)) {
    const { e } = make(id, { affection: 20 });
    for (let i = 0; i < 40; i++) e.event('thrown', { playful: true });
    assert(e.summary().affection.value >= 20, `${id}: playful throws keep affection`);
    for (let i = 0; i < 20; i++) e.event('thrown');
    assert(e.summary().affection.value < 24, `${id}: rough throws still count`);
    assert(e._state().days[Object.keys(e._state().days)[0]].throws === 20, `${id}: playtime throws aren't counted as rough`);
    e.ui('open', {});
    const r = e.ui('menu', { id: 'playtime' });
    assert(r.result.kind === 'end' && r.effects.some((f) => f.type === 'playtime' && f.minutes === 10), `${id}: playtime from the games menu`);
    for (const ev of ['playtimeStart', 'playtimeEnd']) assert(e.event(ev).some((f) => f.type === 'say'), `${id}: ${ev} line`);
    checks++;
  }
}

{
  // Time-together milestones: existing time doesn't trigger a burst; each new milestone is celebrated once.
  for (const id of Object.keys(personalities)) {
    const { e } = make(id);
    e.tick({ togetherMinutes: 700, idle: 999 });
    assert.strictEqual(e._state().counters.together, 2, `${id}: existing hours count as celebrated`);
    const said = e.tick({ togetherMinutes: 1500, idle: 999 }).concat(e.tick({ togetherMinutes: 1500, idle: 999 })).concat(e.tick({ togetherMinutes: 1500, idle: 999 })).filter((f) => f.type === 'say');
    assert(said.length === 1 && /24 hours/.test(said[0].text), `${id}: 24 hours milestone: ${said.map((f) => f.text)}`);
    assert.strictEqual(e._state().counters.together, 3);
    checks++;
  }
}

{
  // Water breaks: the sip count picks the reaction, adds up, and the reminder offers the log.
  for (const id of Object.keys(personalities)) {
    const { e } = make(id);
    const seen = {};
    for (const [typed, pool] of [['0', 'zero'], ['I took 1 sip', 'few'], ['four', 'some'], ['8', 'good'], ['15', 'lots'], ['40', 'fish'], ['lots!', 'skip']]) {
      const first = e._run('water_log');
      let n = first;
      while (n.kind !== 'input') n = e.ui('next').result;
      assert.strictEqual(n.input.prefix, 'I took');
      assert.strictEqual(n.input.suffix, 'sips of water this water break');
      const r = e.ui('input', { value: typed }).result;
      const patterns = e._persona().pools[`water.sips.${pool}`].map((l) => new RegExp(`^${l.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '.+?')}$`, 'u'));
      assert(patterns.some((re) => re.test(r.text)), `${id}: "${typed}" → ${pool}: ${r.text}`);
      assert(!/\{[a-z]+\}/i.test(r.text), `${id}: unfilled: ${r.text}`);
      seen[pool] = true;
    }
    const w = e.summary().water;
    assert.strictEqual(w.today, 0 + 1 + 4 + 8 + 15 + 40, `${id}: sips today ${w.today}`);
    assert.strictEqual(w.breaks, 6);
    checks++;
  }
}

{
  // Check-ins: built-ins off by default, custom ones added; due reminders offer a talk; logs add up.
  for (const id of Object.keys(personalities)) {
    let t0 = Date.now();
    const real = Date.now;
    Date.now = () => t0;
    try {
      const { e } = make(id, { settings: { water: 0, breaks: 0, motivation: false, recap: false, chatter: 'off', lateNight: false, journal: false } });
      assert(e.summary().checkins.every((c) => !c.enabled), `${id}: built-ins off`);
      e.ui('checkinSet', { id: 'eyes', patch: { enabled: true, every: 20 } });
      e.ui('checkinAdd', { emoji: '🧘', title: 'Breathe', kind: 'count', sentence: 'I took __ deep breaths', unit: 'breaths', target: 5, every: 30 });
      const custom = e.summary().checkins.find((c) => c.title === 'Breathe');
      assert(custom && custom.enabled, `${id}: custom check-in`);
      let offered = false;
      for (let i = 0; i < 400 && !offered; i++) { t0 += 5000; offered = e.tick({ idle: 5 }).some((f) => f.type === 'offer'); }
      assert(offered && e.hasOffer(), `${id}: eye break offered`);
      let n = e.ui('open', { topic: 'offer' }).result;
      assert(n.kind === 'ask' && n.choices[0] === 'Done ✅', `${id}: done check-in asks: ${n.text}`);
      n = e.ui('choose', { index: 0 }).result;
      assert(!/\{[a-z]+\}/i.test(n.text), `${id}: ${n.text}`);
      // The count check-in through the Tell menu.
      e.ui('open', {});
      const tell = e.ui('menu', { id: 'cat:tell' }).result;
      assert(tell.menu.items.some((i) => i.id === 'checkins'), `${id}: check-in entry in Tell`);
      const list = e.ui('menu', { id: 'checkins' }).result;
      const breathe = list.menu.items.find((i) => i.label.includes('Breathe'));
      n = e.ui('menu', { id: breathe.id }).result;
      assert(n.kind === 'input' && n.input.prefix === 'I took' && n.input.suffix === 'deep breaths', `${id}: fill-in sentence`);
      n = e.ui('input', { value: '6' }).result;
      assert(/6 breaths/.test(n.text), `${id}: met reply uses the unit: ${n.text}`);
      const cs = e.summary().checkins;
      assert.strictEqual(cs.find((c) => c.id === 'eyes').todayCount, 1);
      assert.strictEqual(cs.find((c) => c.title === 'Breathe').today, 6);
      e.ui('checkinRemove', { id: custom.id });
      assert(!e.summary().checkins.some((c) => c.title === 'Breathe'), `${id}: removed`);
    } finally { Date.now = real; }
    checks++;
  }
}
{
  // Journal: evening offer, mood + note saved; next morning after a rough day, a check-up.
  for (const id of Object.keys(personalities)) {
    const RealDate = Date;
    let t0 = new RealDate(2026, 9, 23, 19, 30).getTime();
    global.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [t0])); } static now() { return t0; } };
    try {
      const { e } = make(id, { settings: { water: 0, breaks: 0, motivation: false, recap: false, chatter: 'off', lateNight: false } });
      let offered = false;
      for (let i = 0; i < 400 && !offered; i++) { t0 += 5000; offered = e.tick({ idle: 5 }).some((f) => f.type === 'offer'); }
      assert(offered, `${id}: journal offered in the evening`);
      let n = e.ui('open', { topic: 'offer' }).result;
      assert.strictEqual(n.choices.length, 5);
      n = e.ui('choose', { index: 4 }).result;
      while (n.kind !== 'input') n = e.ui('next').result;
      e.ui('input', { value: 'missed the bus' });
      const j = e.summary().journal['2026-10-23'];
      assert(j && j.mood === 'rough' && j.note === 'missed the bus', `${id}: journal saved ${JSON.stringify(j)}`);
      t0 = new RealDate(2026, 9, 24, 9, 0).getTime();
      e.event('launch');
      let said = [];
      for (let i = 0; i < 4; i++) { t0 += 5000; said = said.concat(e.tick({ idle: 999 })); }
      assert(e.hasOffer(), `${id}: morning check-up offered`);
      n = e.ui('open', { topic: 'offer' }).result;
      n = e.ui('choose', { index: 0 }).result;
      assert.strictEqual(e.summary().journal['2026-10-23'].followUp, 'better');
      assert(e.summary().days.some((d) => d.mood === 'rough'), `${id}: days carry the mood`);
    } finally { global.Date = RealDate; }
    checks++;
  }
}
{
  // Needs: off by default; coins from XP; treats; decay and breaks.
  for (const id of Object.keys(personalities)) {
    const { e } = make(id);
    assert.strictEqual(e.summary().needs.enabled, false);
    e.ui('setting', { key: 'needs', value: true });
    e.event('xp', { amount: 57 });
    assert.strictEqual(e.summary().needs.coins, 5);
    e.event('xp', { amount: 3 });
    assert.strictEqual(e.summary().needs.coins, 6);
    const before = e.summary().needs.energy;
    const r = e.ui('buyTreat', { id: 'cookie' });
    assert.strictEqual(r.result.needs.coins, 1);
    assert(r.result.needs.energy >= Math.min(100, before + 29), `${id}: cookie energy`);
    assert(r.effects.some((f) => f.type === 'say'), `${id}: treat line`);
    const poor = e.ui('buyTreat', { id: 'toy' });
    assert(poor.result.needs.coins === 1 && poor.effects.some((f) => f.type === 'say'), `${id}: not enough coins`);
    for (const ev of [['playdate', { other: 'Biscuit', first: true }], ['eventStart', { id: 'halloween', title: 'Halloween' }], ['eventEarned', { id: 'halloween', title: 'Witch hat' }], ['meetingSoon', { title: 'Standup', minutes: 5 }], ['meetingNow', { title: 'Standup' }]]) {
      const out = e.event(ev[0], ev[1]).filter((f) => f.type === 'say');
      assert(out.length && !/\{[a-z]+\}/i.test(out[0].text), `${id}: ${ev[0]}: ${out.map((f) => f.text)}`);
    }
    checks++;
  }
}

console.log(`companion: ${checks} checks passed`);
