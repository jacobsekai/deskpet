// DeskPet companion: conversations, affection, memories, reminders, and remarks about your day.
//
// Pure JavaScript with no DOM or Node APIs, so the same file runs in Electron's main process (require)
// and in the macOS app's JavaScriptCore context (as globalThis.DeskPetCompanion). The host feeds it
// context every few seconds and carries out the effects it returns: speech bubbles, moods, XP, quitting.
// What the pet says lives in personalities/*.json (see README → "Talking with your pet").
(function (root) {
  'use strict';

  // Affection works like Monika After Story's: it grows with care, can drop when you're unkind or vanish
  // for a long time, and each tier changes how the pet talks to you. Personalities can rename tiers.
  const TIERS = [
    { id: 'hurt', name: 'Hurt', at: -Infinity },
    { id: 'upset', name: 'Upset', at: -30 },
    { id: 'new', name: 'New friends', at: 0 },
    { id: 'friends', name: 'Friends', at: 15 },
    { id: 'good', name: 'Good friends', at: 50 },
    { id: 'close', name: 'Close friends', at: 120 },
    { id: 'best', name: 'Best friends', at: 250 },
    { id: 'soul', name: 'Inseparable', at: 500 },
  ];
  const BASE_TIER = 2; // "new": where everyone starts
  const MIN_AFFECTION = -100;
  const MAX_AFFECTION = 1000;
  /** More than this many throws a day starts to feel mean. */
  const THROW_LIMIT = 15;
  /** Affection can only grow this much a day, so it reflects time together rather than clicking. */
  const DAILY_GAIN_CAP = 12;
  const MINUTE = 60000;
  /** An unanswered (or snoozed) reminder comes back after this long. */
  const REMIND_AGAIN = 10 * MINUTE;

  const DEFAULT_SETTINGS = { chatter: 'sometimes', water: 90, breaks: 50, lateNight: true, motivation: true, appComments: true, recap: true, journal: true, needs: false, notifyReminders: true, remindUntilDone: true };

  /** Check-ins you can turn on (custom ones are added next to them). `every` = minutes of activity; `at` = a daily time. */
  const BUILTIN_CHECKINS = [
    { id: 'eyes', emoji: '👀', title: '20-20-20 eye break', kind: 'done', every: 20 },
    { id: 'posture', emoji: '🪑', title: 'Posture check', kind: 'done', every: 45 },
    { id: 'stand', emoji: '🧍', title: 'Stand up', kind: 'done', every: 60 },
    { id: 'stretch', emoji: '🙆', title: 'Stretch', kind: 'count', sentence: 'I stretched for __ minutes', unit: 'minutes', target: 3, every: 90 },
    { id: 'meds', emoji: '💊', title: 'Medication', kind: 'done', every: 0, at: '09:00' },
  ];
  const CHECKIN_EVERY = [0, 15, 20, 30, 45, 60, 90, 120];
  const MOOD_IDS = ['amazing', 'good', 'okay', 'tiring', 'rough'];
  const TREATS = [
    { id: 'cookie', emoji: '🍪', title: 'Cookie', cost: 5, energy: 30, fun: 0 },
    { id: 'strawberry', emoji: '🍓', title: 'Strawberry', cost: 8, energy: 20, fun: 20 },
    { id: 'toy', emoji: '🧸', title: 'Toy', cost: 10, energy: 0, fun: 40 },
  ];
  /** Gifts (MAS-style .gift files) unlock at this tier; single gifts can ask for a closer one. */
  const GIFT_TIER = 'friends';
  /** "Haruka Merch.gift", "haruka-merch", "HARUKA_MERCH" → "haruka_merch" */
  const giftId = (s) => String(s || '').replace(/\.gift$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  const giftLabel = (id) => id.replace(/_/g, ' ');
  /** Days of per-day flags kept (Insights shows two weeks). */
  const DAY_HISTORY = 35;
  /** Minutes of activity between conversations the pet starts. */
  const CHATTER = { off: null, sometimes: [45, 90], often: [18, 35] };
  const WATER_CHOICES = [0, 45, 60, 90, 120];
  const BREAK_CHOICES = [0, 30, 50, 60, 90];

  /** Dialogue moods → poses every character has. */
  const MOODS = {
    happy: 'petted', love: 'petted', excited: 'done', proud: 'done', thinking: 'thinking', sleepy: 'sleepy', surprised: 'startled',
    nervous: 'oops', sad: 'oops', worried: 'oops', reading: 'reading', idle: 'idle', dizzy: 'dizzy', typing: 'typing',
  };

  const GAMES = [
    { id: 'rps', title: 'Rock, paper, scissors', icon: '✊' },
    { id: 'ttt', title: 'Tic-tac-toe', icon: '⭕' },
    { id: 'words', title: 'Word guess', icon: '🌸' },
    { id: 'pong', title: 'Pong', icon: '🏓' },
  ];

  const CATEGORY_TITLES = {
    pet: 'About {pet}', life: 'Life', work: 'Work and focus', fun: 'Fun stuff',
    you: 'About me', feeling: "I'm feeling…", tell: 'Tell {pet}…', goodbye: 'Goodbye…',
  };
  /** Categories with their own main-menu entries (the rest are listed under "Ask {pet} about…"). */
  const OWN_ENTRY = ['you', 'feeling', 'tell', 'goodbye', 'special', 'milestone'];
  /** Topics that only come up on their own: holidays, birthdays, relationship milestones, and coming home from a trip. */
  const HIDDEN = ['special', 'milestone', 'trip', 'journal', 'checkin'];
  /** Hours of time together the pet celebrates. */
  const TOGETHER_HOURS = [1, 10, 24, 50, 100, 250, 500, 1000, 2500, 5000];
  /** Trips kept in the log (control center → Trips). */
  const TRIP_LOG = 30;

  /** What you're doing, from the foreground app (and window title, where the platform provides it). */
  const APP_CATEGORIES = [
    ['meeting', /\bzoom\b|webex|facetime|google meet|meet\.google|\bteams\b.*(meeting|call)|\bchime\b.*meeting/],
    ['game', /steam|epic games|minecraft|roblox|league of legends|valorant|genshin|battle\.net|riot client|\bosu!|fortnite|overwatch|hoyoplay|\bitch\.io/],
    ['video', /youtube(?! music)|netflix|twitch|\bhulu\b|disney\+|prime video|crunchyroll|\bvlc\b|\biina\b|quicktime|\bplex\b|\bmpv\b/],
    ['music', /spotify|apple music|^music\b|\btidal\b|deezer|soundcloud|podcasts|youtube music/],
    ['design', /figma|photoshop|illustrator|procreate|krita|\bgimp\b|blender|affinity|\bsketch\b|canva|clip studio|aseprite/],
    ['writing', /\bword\b|\bpages\b|google docs|notion|obsidian|\bbear\b|ulysses|scrivener|onenote|libreoffice|quip/],
    ['code', /\bcode\b|terminal|powershell|cmd\.exe|iterm|kiro|devenv|intellij|\bidea\b|pycharm|webstorm|jetbrains|cursor|ghostty|warp|\bzed\b|sublime|alacritty|wezterm|xcode|konsole|kitty|android studio|\bvim\b|emacs/],
    ['chat', /slack|\bchime\b|outlook|\bolk\b|\bteams\b|discord|\bmail\b|whatsapp|telegram|^messages$|signal/],
    ['browser', /chrome|msedge|\bedge\b|firefox|brave|opera|safari|\barc\b|vivaldi|chromium/],
  ];

  function categorize(name, title) {
    const s = `${name || ''} ${title || ''}`.toLowerCase().trim();
    for (const [id, re] of APP_CATEGORIES) if (re.test(s)) return id;
    return 'other';
  }

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const monthDay = (d = new Date()) => `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  const num = (v, fallback) => (typeof v === 'number' && isFinite(v) ? v : fallback);
  const pickOne = (list) => list[Math.floor(Math.random() * list.length)];
  const between = ([lo, hi]) => (lo + Math.random() * (hi - lo)) * MINUTE;
  const clean = (s, max) => String(s == null ? '' : s).replace(/[{}<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
  /** "🍵 Tea" → "tea": choice labels become remembered values. */
  const plain = (s) => String(s).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').trim().replace(/^./, (c) => c.toLowerCase());

  function displayDate(mmdd) {
    const [m, d] = String(mmdd).split('-').map(Number);
    return m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${MONTHS[m - 1]} ${d}` : String(mmdd);
  }

  /** Hosts may pass JSON text (the macOS bridge does, so empty objects don't come through as one shared object). */
  function parsed(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch (_) { return null; }
  }

  const TIER_IDS = new Set(TIERS.map((t) => t.id));

  function normalize(s) {
    s = isObj(s) ? s : {};
    // Older macOS builds could tangle these maps together; keep only entries of the right shape.
    const memory = {};
    for (const [k, v] of Object.entries(isObj(s.memory) ? s.memory : {})) if (isObj(v) && v.value != null) memory[k] = v;
    const milestones = {};
    for (const [k, v] of Object.entries(isObj(s.milestones) ? s.milestones : {})) if (TIER_IDS.has(k) && typeof v === 'string') milestones[k] = v;
    const seen = {};
    for (const [k, v] of Object.entries(isObj(s.seen) ? s.seen : {})) if (typeof v === 'number') seen[k] = v;
    const days = {};
    for (const [d, flags] of Object.entries(isObj(s.days) ? s.days : {})) {
      if (!isObj(flags)) continue;
      days[d] = {};
      for (const [k, v] of Object.entries(flags)) if (!isObj(v) && !Array.isArray(v)) days[d][k] = v;
    }
    const settings = { ...DEFAULT_SETTINGS };
    for (const [k, v] of Object.entries(isObj(s.settings) ? s.settings : {})) if (k in DEFAULT_SETTINGS && typeof v === typeof DEFAULT_SETTINGS[k]) settings[k] = v;
    return {
      v: 1,
      affection: Math.max(MIN_AFFECTION, Math.min(MAX_AFFECTION, num(s.affection, 0))),
      milestones,
      cleanExit: s.cleanExit !== false,
      gained: isObj(s.gained) && typeof s.gained.day === 'string' ? { day: s.gained.day, amount: num(s.gained.amount, 0) } : { day: '', amount: 0 },
      memory,
      seen,
      settings,
      days,
      counters: { talks: 0, games: 0, wins: 0, ...(isObj(s.counters) ? s.counters : {}) },
      lastSeen: num(s.lastSeen, 0),
      farewell: isObj(s.farewell) ? s.farewell : null,
      firstMet: typeof s.firstMet === 'string' ? s.firstMet : dayKey(),
      trips: Array.isArray(s.trips) ? s.trips.filter((t) => isObj(t) && t.id).slice(-TRIP_LOG) : [],
      checkins: normalizeCheckins(s.checkins),
      gifts: Object.fromEntries(Object.entries(isObj(s.gifts) ? s.gifts : {}).filter(([k, v]) => isObj(v) && giftId(k) === k)
        .map(([k, v]) => [k, { name: clean(v.name, 40) || giftLabel(k), count: Math.max(1, Math.floor(num(v.count, 1))), first: String(v.first || dayKey()) }])),
      journal: normalizeJournal(s.journal),
      needs: {
        energy: clamp(num(isObj(s.needs) && s.needs.energy, 80)), fun: clamp(num(isObj(s.needs) && s.needs.fun, 80)),
        coins: Math.max(0, Math.floor(num(isObj(s.needs) && s.needs.coins, 0))), bank: num(isObj(s.needs) && s.needs.bank, 0),
      },
    };
  }

  const clamp = (v) => Math.max(0, Math.min(100, v));

  /** Built-ins keep your choices (on/off, how often); custom check-ins are kept as they are. */
  function normalizeCheckins(list) {
    const saved = new Map((Array.isArray(list) ? list : []).filter((c) => isObj(c) && c.id).map((c) => [String(c.id), c]));
    const out = BUILTIN_CHECKINS.map((b) => {
      const c = saved.get(b.id) || {};
      return { ...b, builtin: true, enabled: !!c.enabled, every: CHECKIN_EVERY.includes(c.every) ? c.every : b.every, at: typeof c.at === 'string' ? c.at : b.at || '' };
    });
    for (const c of saved.values()) {
      if (BUILTIN_CHECKINS.some((b) => b.id === c.id)) continue;
      out.push({
        id: clean(c.id, 24), emoji: clean(c.emoji, 4) || '✅', title: clean(c.title, 30) || 'Check-in', kind: c.kind === 'count' ? 'count' : 'done',
        sentence: clean(c.sentence, 60), unit: clean(c.unit, 16), target: Math.max(1, Math.floor(num(c.target, 1))),
        every: CHECKIN_EVERY.includes(c.every) ? c.every : 60, at: typeof c.at === 'string' ? c.at : '', enabled: c.enabled !== false, builtin: false,
      });
    }
    return out;
  }

  function normalizeJournal(j) {
    const out = {};
    const days = Object.keys(isObj(j) ? j : {}).sort().slice(-400);
    for (const d of days) {
      const e = j[d];
      if (!isObj(e)) continue;
      out[d] = { mood: MOOD_IDS.includes(e.mood) ? e.mood : null, note: e.note ? clean(e.note, 120) : null };
      if (e.followUp) out[d].followUp = clean(e.followUp, 12);
    }
    return out;
  }

  const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];
  /** "12", "I took 12 sips", "twelve", "none" → 12 / 0; null if there's no number. */
  function parseCount(raw) {
    const s = String(raw == null ? '' : raw).toLowerCase();
    const digits = /\d+/.exec(s);
    if (digits) return Math.min(999, parseInt(digits[0], 10));
    if (/\b(none|nothing|no sips?)\b/.test(s)) return 0;
    const i = NUMBER_WORDS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(s));
    return i >= 0 ? i : null;
  }
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /** "45 minutes", "3 hours", "2 days" */
  function duration(minutes) {
    const m = Math.max(1, Math.round(minutes));
    if (m < 90) return `${m} minute${m === 1 ? '' : 's'}`;
    if (m < 36 * 60) { const h = Math.round(m / 60); return `${h} hour${h === 1 ? '' : 's'}`; }
    const d = Math.round(m / 1440);
    return `${d} day${d === 1 ? '' : 's'}`;
  }

  /** ["Sam's PC"] → "Sam's PC"; ["A", "B", "C"] → "A, B and C" */
  function listNames(names) {
    const list = [...new Set(names.map((n) => clean(n, 40)).filter(Boolean))];
    return list.length <= 1 ? (list[0] || '') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  }

  function create(options) {
    options = options || {};
    const personalities = parsed(options.personalities) || {};
    const host = options.host || {};
    const now = () => Date.now();

    let state = normalize(parsed(options.state));
    let persona = null;
    let personaInfo = { id: 'friend', name: 'Friend', source: 'built-in' };
    let names = { owner: 'friend', pet: 'Mochi' };
    let ctx = { idle: 0 };
    let effects = [];
    let convo = null;
    let offer = null;
    /** The reminder waiting for Done: `{ kind, text, at, offer }` (`at` = when it comes back; `offer` = the chat that logs it). */
    let reminder = null;
    let scheduled = [];
    const recent = new Map();

    const startedAt = now();
    let lastTick = startedAt;
    let lastAmbient = startedAt;
    let lastSave = 0;
    let dirty = false;
    let activeMs = 0;
    let waterMs = 0;
    let chatterMs = 0;
    let chatterDue = 0;
    let encourageMs = 0;
    let encourageDue = between([80, 150]);
    let streakStart = startedAt;
    const checkinMs = {};
    let prevIdle = 0;
    let lastNeedHint = 0;
    let lastPlaydate = 0;
    let treatTimes = [];
    let lastNight = 0;
    let lastGreet = 0;
    let lastCategory = '';
    const appCooldown = {};

    // MARK: Personalities

    /** Merges `extends` chains. A pool a personality defines replaces the base pool and its "+tier" variants. */
    function resolve(p, depth) {
      if (typeof p === 'string') p = personalities[p];
      if (!isObj(p)) return null;
      const base = p.extends && depth < 5 ? resolve(p.extends, depth + 1) : null;
      const pools = base ? { ...base.pools } : {};
      for (const key of Object.keys(p.pools || {})) {
        for (const k of Object.keys(pools)) if (k === key || k.startsWith(`${key}+`)) delete pools[k];
      }
      Object.assign(pools, p.pools || {});
      const topics = new Map(base ? base.topics.map((t) => [t.id, t]) : []);
      for (const t of p.topics || []) {
        if (!t || !t.id) continue;
        if (t.remove) topics.delete(t.id);
        else topics.set(t.id, t);
      }
      return {
        id: p.id || (base && base.id) || 'custom',
        name: p.name || (base && base.name) || 'Custom',
        pools,
        topics: [...topics.values()],
        categories: { ...(base ? base.categories : {}), ...(p.categories || {}) },
        gifts: p.replaceGifts ? { ...(p.gifts || {}) } : { ...(base ? base.gifts : {}), ...(p.gifts || {}) },
      tierNames: { ...(base ? base.tierNames : {}), ...(p.tierNames || {}) },
        words: [...new Set([...(p.replaceWords || !base ? [] : base.words), ...(p.words || [])])],
      };
    }

    function setPersonality(p, source) {
      const resolved = resolve(p, 0) || resolve('friend', 0) || { id: 'none', name: 'None', pools: {}, topics: [], categories: {}, words: [], gifts: {} };
      persona = resolved;
      personaInfo = { id: resolved.id, name: resolved.name, source: source || 'built-in' };
      if (convo) convo = null;
      if (offer && !persona.topics.includes(offer.topic)) offer = null;
    }
    setPersonality(options.personality || 'friend');

    // MARK: Text

    function timeOfDay(h = new Date().getHours()) {
      return h >= 5 && h < 12 ? 'morning' : h >= 12 && h < 17 ? 'afternoon' : h >= 17 && h < 22 ? 'evening' : 'night';
    }

    function fill(text, extra) {
      return String(text).replace(/\{(\w+)(?::(\w+))?(?:\|([^}]*))?\}/g, (m, name, arg, fallback) => {
        if (name === 'owner') return state.memory.nickname && tierIndex() >= BASE_TIER && Math.random() < 0.5 ? state.memory.nickname.value : names.owner;
        if (name === 'name') return names.owner;
        if (name === 'pet') return names.pet;
        if (name === 'mem') { const v = state.memory[arg]; return v ? String(v.display || v.value) : (fallback != null ? fallback : 'that'); }
        if (name === 'timeOfDay') return timeOfDay();
        if (name === 'weekday') return WEEKDAYS[new Date().getDay()];
        if (name === 'tier') return tier().name.toLowerCase();
        const vars = extra || (convo && convo.vars);
        if (vars && name in vars) return String(vars[name]);
        return fallback != null ? fallback : m;
      });
    }

    function poolLines(key) {
      const t = tierIndex();
      // When the pet is upset, "+upset"/"+hurt" lines replace the usual ones.
      if (t < BASE_TIER) {
        const sad = persona.pools[`${key}+${TIERS[t].id}`] || persona.pools[`${key}+upset`];
        if (sad) return [...sad];
      }
      let lines = [...(persona.pools[key] || [])];
      TIERS.forEach((tr, i) => {
        const extra = persona.pools[`${key}+${tr.id}`];
        if (i > BASE_TIER && i <= t && extra) lines = lines.concat(extra, extra); // closer friends hear the warmer lines more often
      });
      return lines;
    }

    /** A random line from a pool (never the same one twice in a row), or the fallback. */
    function line(key, fallback, extra) {
      const lines = poolLines(key);
      if (!lines.length) return fallback == null ? null : fill(fallback, extra);
      let choice = pickOne(lines);
      if (lines.length > 1 && recent.get(key) === choice) choice = lines.find((l) => l !== choice) || choice;
      recent.set(key, choice);
      return fill(choice, extra);
    }

    // MARK: Affection and memory

    function tierIndex(a = state.affection) {
      let i = 0;
      TIERS.forEach((t, j) => { if (a >= t.at) i = j; });
      return i;
    }
    const tierName = (i) => persona.tierNames[TIERS[i].id] || TIERS[i].name;
    const tier = () => ({ ...TIERS[tierIndex()], name: tierName(tierIndex()) });

    function affectionInfo() {
      const i = tierIndex();
      const next = TIERS[i + 1];
      const cur = TIERS[i];
      const from = isFinite(cur.at) ? cur.at : MIN_AFFECTION;
      return {
        value: Math.round(state.affection * 10) / 10, tier: tierName(i), tierId: cur.id, hearts: Math.max(0, i - BASE_TIER), maxHearts: TIERS.length - 1 - BASE_TIER,
        upset: i < BASE_TIER, next: next ? tierName(i + 1) : null, progress: next ? Math.max(0, Math.min(1, (state.affection - from) / (next.at - from))) : 1,
        todayLeft: Math.max(0, Math.round((DAILY_GAIN_CAP - (state.gained.day === dayKey() ? state.gained.amount : 0)) * 10) / 10),
      };
    }

    function changeAffection(amount) {
      if (!amount) return;
      if (amount > 0) {
        const d = dayKey();
        if (state.gained.day !== d) state.gained = { day: d, amount: 0 };
        amount = Math.min(amount, DAILY_GAIN_CAP - state.gained.amount);
        if (amount <= 0) return;
        state.gained.amount += amount;
      }
      const before = tierIndex();
      state.affection = Math.max(MIN_AFFECTION, Math.min(MAX_AFFECTION, state.affection + amount));
      dirty = true;
      const after = tierIndex();
      if (after > before && after > BASE_TIER) {
        effects.push({ type: 'tier', tier: tierName(after) });
        // The first time you reach a tier there may be a milestone conversation waiting.
        const id = TIERS[after].id;
        const milestone = !state.milestones[id] && persona.topics.find((t) => t.category === 'milestone' && t.tier === id);
        state.milestones[id] = state.milestones[id] || dayKey();
        if (milestone) {
          offer = { topic: milestone, until: now() + 60 * MINUTE };
          later(convo ? 2000 : 1500, { type: 'say', text: line('wantsToTalk.milestone', null) || line('wantsToTalk', 'psst… click me! 💬'), seconds: 10 });
          later(convo ? 2000 : 1500, { type: 'offer' });
        } else {
          later(convo ? 0 : 1500, { type: 'say', text: line('tierUp', "We're {tier} now! 💕"), seconds: 6 });
        }
      } else if (after < before) {
        effects.push({ type: 'tier', tier: tierName(after), down: true });
        if (after < BASE_TIER) later(1500, { type: 'say', text: line('tierDown', null) || '…', seconds: 5 });
      }
    }

    function remember(key, value, label, display) {
      key = clean(key, 40);
      if (!key) return;
      const prev = state.memory[key];
      state.memory[key] = { value: clean(value, 120), label: label || (prev && prev.label) || key, at: now() };
      if (display) state.memory[key].display = display;
      dirty = true;
    }

    function forget(key) {
      if (key === '*') state.memory = {};
      else delete state.memory[key];
      dirty = true;
    }

    // MARK: Conditions

    function check(cond) {
      if (!cond) return true;
      if (Array.isArray(cond)) return cond.every(check);
      const d = new Date();
      const h = d.getHours();
      const md = monthDay(d);
      if (cond.flag && !(convo && convo.vars && convo.vars[cond.flag])) return false;
      if (cond.noFlag && convo && convo.vars && convo.vars[cond.noFlag]) return false;
      if (cond.freshMem || cond.noFreshMem) {
        // Answered during this conversation (e.g. the trip talk already heard about your day).
        const fresh = (k) => !!(state.memory[k] && convo && convo.vars && convo.vars.since && state.memory[k].at >= convo.vars.since);
        if (cond.freshMem && !fresh(cond.freshMem)) return false;
        if (cond.noFreshMem && fresh(cond.noFreshMem)) return false;
      }
      if (cond.mem && !state.memory[cond.mem]) return false;
      if (cond.noMem && state.memory[cond.noMem]) return false;
      if (cond.memIs) {
        for (const [k, v] of Object.entries(cond.memIs)) {
          const m = state.memory[k];
          if (!m || ![].concat(v).map((x) => String(x).toLowerCase()).includes(String(m.value).toLowerCase())) return false;
        }
      }
      if (cond.minAffection != null && state.affection < cond.minAffection) return false;
      if (cond.maxAffection != null && state.affection > cond.maxAffection) return false;
      if (cond.tier && tierIndex() < TIERS.findIndex((t) => t.id === cond.tier)) return false;
      if (cond.belowTier && tierIndex() >= TIERS.findIndex((t) => t.id === cond.belowTier)) return false;
      if (cond.upset != null && (tierIndex() < BASE_TIER) !== !!cond.upset) return false;
      if (cond.hours) {
        const [a, b] = cond.hours;
        if (a <= b ? !(h >= a && h < b) : !(h >= a || h < b)) return false;
      }
      if (cond.timeOfDay && ![].concat(cond.timeOfDay).includes(timeOfDay(h))) return false;
      if (cond.date && ![].concat(cond.date).includes(md)) return false;
      if (cond.month && ![].concat(cond.month).includes(d.getMonth() + 1)) return false;
      if (cond.weekday && ![].concat(cond.weekday).includes(d.getDay())) return false;
      if (cond.seen && !state.seen[cond.seen]) return false;
      if (cond.notSeen && state.seen[cond.notSeen]) return false;
      if (cond.birthday && !(state.memory.birthday && state.memory.birthday.value === md)) return false;
      if (cond.anniversary && !(state.firstMet.slice(5) === md && state.firstMet !== dayKey(d))) return false;
      if (cond.platform && cond.platform !== host.platform) return false;
      if (cond.agentsToday && !(ctx.tasks > 0)) return false;
      if (cond.chance != null && Math.random() > cond.chance) return false;
      return true;
    }

    const available = (t) => check(t.when) && (t.minAffection || 0) <= state.affection;

    // MARK: Conversations

    function node(kind, text, mood, extra) {
      if (mood) effects.push({ type: 'mood', mood: MOODS[mood] || mood, seconds: 8 });
      return { kind, speaker: names.pet, text: text == null ? null : String(text), mood: mood || null, affection: affectionInfo(), ...(extra || {}) };
    }

    function startTopic(topic, vars) {
      if (!topic) return menuNode('main', line('talk.allSeen', "I'm out of new things to say for now. Let's play a game?"));
      convo = { topic, queue: [...(topic.steps || [])], pending: null, vars: vars ? { ...vars } : undefined };
      if (topic.confetti) effects.push({ type: 'confetti' });
      const first = advance();
      if (topic.confetti) first.confetti = true;
      return first;
    }

    function advance() {
      while (convo && convo.queue.length) {
        const result = run(convo.queue.shift());
        if (result) return result;
      }
      return finish();
    }

    /** Runs one dialogue step; returns a node when there's something to show. */
    function run(step) {
      if (typeof step === 'string') return node('line', fill(step));
      if (Array.isArray(step)) { convo.queue.unshift(...step); return null; }
      if (!isObj(step)) return null;
      if (step.when && !check(step.when)) {
        if (step.else) convo.queue.unshift(...[].concat(step.else));
        return null;
      }
      if (step.affection) changeAffection(step.affection);
      if (step.remember) for (const [k, v] of Object.entries(step.remember)) remember(k, v, step.label);
      if (step.forget) forget(step.forget);
      if (step.farewell) { state.farewell = { reason: step.farewell, at: now() }; dirty = true; }
      if (step.steps) convo.queue.unshift(...step.steps);
      if (step.action === 'quit') convo.quit = true;
      if (step.action === 'recall') convo.queue.unshift(...recallSteps());
      if (step.action === 'trip') convo.trip = true;
      if (step.action === 'logTrip') logTrip();
      if (step.random) { convo.queue.unshift(pickOne(step.random)); return null; }
      if (step.say) return node('line', fill(step.say), step.mood);
      if (step.pick) return node('line', fill(pickOne(step.pick)), step.mood);
      if (step.pool) return node('line', line(step.pool, '…'), step.mood);
      if (step.ask) {
        const choices = (step.choices || []).filter((c) => check(c.when));
        convo.pending = { type: 'ask', step, choices };
        const text = step.askPool ? line(step.askPool, step.ask) : fill(step.ask);
        return node('ask', text, step.mood, { choices: choices.map((c) => fill(c.label)) });
      }
      if (step.input) {
        convo.pending = { type: 'input', step };
        const text = step.inputPool ? line(step.inputPool, step.input) : fill(step.input);
        return node('input', text, step.mood, { input: {
          placeholder: step.placeholder || '', kind: step.kind || 'text', max: step.max || 40,
          prefix: step.prefix ? fill(step.prefix) : null, suffix: step.suffix ? fill(step.suffix) : null,
        } });
      }
      if (step.game) {
        convo.pending = { type: 'game', step };
        const extra = { game: step.game };
        if (step.game === 'words') extra.words = persona.words.length ? persona.words : ['friend', 'sunshine', 'coffee'];
        return node('game', fill(step.text || line(`game.${step.game}.start`, "Let's play!")), step.mood || 'excited', extra);
      }
      if (step.mood) effects.push({ type: 'mood', mood: MOODS[step.mood] || step.mood, seconds: 8 });
      return null;
    }

    function finish() {
      const c = convo;
      convo = null;
      if (c && c.topic && c.topic.id) {
        state.seen[c.topic.id] = (state.seen[c.topic.id] || 0) + 1;
        state.counters.talks++;
        changeAffection(c.topic.affection != null ? c.topic.affection : 1);
        needsBoost(0, 5);
        dirty = true;
      }
      if (c && c.quit) {
        effects.push({ type: 'quit', delay: 600 });
        return node('end', null, null, { quit: true });
      }
      if (c && c.trip) {
        effects.push({ type: 'trip' });
        return node('end', null, null, { close: true });
      }
      return menuNode('main', line('talk.anything', 'Anything else?'));
    }

    function choose(index) {
      if (!convo || !convo.pending || convo.pending.type !== 'ask') return menuNode('main', line('talk.menu', "What's up?"));
      const { step, choices } = convo.pending;
      const c = choices[index];
      convo.pending = null;
      if (!c) return advance();
      if (c.affection) changeAffection(c.affection);
      if (step.key) {
        const value = 'value' in c ? c.value : plain(c.label);
        if (value !== null && value !== '') remember(step.key, value, step.label);
      }
      if (c.remember) for (const [k, v] of Object.entries(c.remember)) remember(k, v, c.label);
      if (step.journal === 'mood' && MOOD_IDS.includes(c.value)) setJournal({ mood: c.value });
      if (step.journal === 'followUp' && c.value) setJournal({ followUp: c.value }, yesterday());
      if (c.checkin) logCheckin(c.checkin, 1);
      if (c.farewell) { state.farewell = { reason: c.farewell, at: now() }; dirty = true; }
      convo.queue.unshift(...(c.steps || []));
      if (c.say) convo.queue.unshift({ say: c.say, mood: c.mood });
      else if (c.mood) effects.push({ type: 'mood', mood: MOODS[c.mood] || c.mood, seconds: 8 });
      return advance();
    }

    function input(raw) {
      if (!convo || !convo.pending || convo.pending.type !== 'input') return menuNode('main', line('talk.menu', "What's up?"));
      const { step } = convo.pending;
      convo.pending = null;
      if (step.kind === 'number') {
        const n = parseCount(raw);
        if (n == null) {
          convo.queue.unshift(...[].concat(step.skip || [{ pool: 'input.skip' }]));
          return advance();
        }
        convo.vars = { ...(convo.vars || {}), value: n, sips: n, sipsText: plural(n, 'sip', 'sips') };
        if (step.log === 'sips') logSips(n);
        if (String(step.log || '').startsWith('ci:')) logCheckin(step.log.slice(3), n);
        if (convo.vars.unit) convo.vars.valueText = plural(n, convo.vars.unit.replace(/s$/, ''), convo.vars.unit);
        const range = (step.ranges || []).find((r) => r.max == null || n <= r.max);
        convo.queue.unshift(...[].concat(range ? range.steps || [] : [], step.then || []));
        return advance();
      }
      let value = clean(raw, step.max || 40);
      let display = null;
      if (step.kind === 'date') {
        const m = /^(\d{1,2})-(\d{1,2})$/.exec(value);
        value = m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31 ? `${pad(+m[1])}-${pad(+m[2])}` : '';
        display = value ? displayDate(value) : null;
      }
      if (!value) {
        convo.queue.unshift(...[].concat(step.skip || [{ pool: 'input.skip' }]));
        return advance();
      }
      if (step.journal === 'note') setJournal({ note: value });
      if (step.key) remember(step.key, value, step.label, display);
      convo.vars = { ...(convo.vars || {}), value: display || value };
      convo.queue.unshift(...[].concat(step.then || []));
      return advance();
    }

    function gameResult(game, outcome) {
      const known = GAMES.some((g) => g.id === game);
      if (!known || !['win', 'lose', 'draw'].includes(outcome)) return menuNode('main', line('talk.anything', 'Anything else?'));
      state.counters.games++;
      if (outcome === 'win') state.counters.wins++;
      needsBoost(0, 10);
      dirty = true;
      changeAffection(1);
      effects.push({ type: 'xp', amount: outcome === 'win' ? 5 : outcome === 'draw' ? 4 : 3, play: true });
      if (!convo) convo = { topic: null, queue: [], pending: null };
      convo.pending = null;
      // "win" is from your side: you won, so the pet lost.
      const text = line(`game.${game}.${outcome}`, null) || line(`game.${outcome}`, outcome === 'win' ? 'You win! 🏆' : outcome === 'lose' ? 'I win! 😆' : "It's a tie!");
      convo.queue.unshift(
        { say: text, mood: outcome === 'win' ? 'surprised' : outcome === 'lose' ? 'excited' : 'happy' },
        { ask: line('game.again', 'Again?'), choices: [{ label: 'Again! 🔁', steps: [{ game }] }, { label: 'Something else', steps: [] }] },
      );
      return advance();
    }

    // MARK: Water breaks

    /** "I took 6 sips": today's and lifetime totals, a little XP and bond for any sip at all. */
    function logSips(n) {
      const day = dayFlags();
      day.sips = (day.sips || 0) + n;
      day.waterBreaks = (day.waterBreaks || 0) + 1;
      state.counters.sips = (state.counters.sips || 0) + n;
      state.counters.waterBreaks = (state.counters.waterBreaks || 0) + 1;
      convo.vars.today = day.sips;
      convo.vars.todayText = plural(day.sips, 'sip', 'sips');
      convo.vars.breaks = day.waterBreaks;
      waterMs = 0;
      if (n > 0) {
        changeAffection(0.3);
        effects.push({ type: 'xp', amount: 2, play: true });
      }
      dirty = true;
    }

    // MARK: Gifts

    /** Personality gift entry for a file name, by id or alias. */
    function findGift(id) {
      const gifts = persona.gifts || {};
      if (gifts[id]) return { id, gift: gifts[id] };
      for (const [gid, g] of Object.entries(gifts)) if ((g.aliases || []).some((a) => giftId(a) === id)) return { id: gid, gift: g };
      return null;
    }

    function giftAsk() {
      const need = TIERS.findIndex((t) => t.id === GIFT_TIER);
      if (tierIndex() < need) {
        convo = { topic: null, queue: [{ pool: 'gift.locked', mood: 'nervous' }], pending: null, vars: { need: tierName(need) } };
        return advance();
      }
      convo = null;
      // The talk window asks the host for a .gift file, then calls ui('gift', { file }) (or 'giftCancel').
      return node('pickGift', line('gift.ask', 'A gift? For me?! 🎁 Which one?'), 'excited');
    }

    /** Gives the gift named by a .gift file. Consumed (effect) unless it's too soon for this one. */
    function giveGift(file) {
      const raw = giftId(file);
      if (!raw) return menuNode('main');
      const found = findGift(raw);
      const id = found ? found.id : raw;
      const g = found ? found.gift : null;
      const name = (g && g.name) || giftLabel(raw);
      const vars = { gift: name };
      const need = TIERS.findIndex((t) => t.id === ((g && g.tier) || GIFT_TIER));
      if (tierIndex() < need) {
        const reply = g && g.tooSoon ? { say: g.tooSoon, mood: 'nervous' } : { pool: 'gift.tooSoon', mood: 'nervous' };
        convo = { topic: null, queue: [reply], pending: null, vars: { ...vars, need: tierName(need) } };
        return advance();
      }
      effects.push({ type: 'consumeGift', id });
      const prev = state.gifts[id];
      state.gifts[id] = { name, count: (prev ? prev.count : 0) + 1, first: prev ? prev.first : dayKey() };
      dirty = true;
      if (prev) {
        changeAffection(0.5);
        convo = { topic: null, queue: [{ pool: 'gift.again', mood: 'happy' }], pending: null, vars };
        return advance();
      }
      changeAffection(g ? (g.affection != null ? g.affection : 3) : 2);
      needsBoost(10, 15);
      return startTopic({ id: `gift_${id}`, category: 'gift', affection: 0, confetti: true, steps: g ? g.steps || [{ pool: 'gift.known' }] : [{ pool: 'gift.unknown', mood: 'happy' }] }, vars);
    }

    function giftSummary() {
      const need = TIERS.findIndex((t) => t.id === GIFT_TIER);
      const ideas = Object.entries(persona.gifts || {}).filter(([id, g]) => !state.gifts[id] && !g.secret).map(([, g]) => g.name).slice(0, 4);
      return {
        unlocked: tierIndex() >= need, tier: tierName(need), ideas,
        received: Object.entries(state.gifts).map(([id, g]) => ({ id, name: g.name, count: g.count, first: g.first })).sort((a, b) => (a.first < b.first ? 1 : -1)),
      };
    }

    // MARK: Check-ins

    const checkinById = (id) => state.checkins.find((c) => c.id === id);

    /** A check-in becomes a small conversation: a fill-in sentence (count) or "Done ✅ / Not yet". */
    function checkinTopic(c) {
      const vars = { title: c.title, emoji: c.emoji, unit: c.unit || '', target: c.target || 1 };
      let steps;
      if (c.kind === 'count') {
        const [prefix, suffix] = (c.sentence && c.sentence.includes('__') ? c.sentence : `I did __ ${c.unit || 'times'}`).split('__').map((x) => x.trim());
        const target = c.target || 1;
        steps = [{
          input: `${c.emoji} ${c.title}: how did it go?`, inputPool: 'checkin.ask', kind: 'number', max: 3, prefix, suffix, placeholder: '?', log: `ci:${c.id}`,
          ranges: [{ max: 0, steps: [{ pool: 'checkin.zero', mood: 'worried' }] }, { max: target - 1, steps: [{ pool: 'checkin.some', mood: 'happy' }] },
            { max: target * 3 - 1, steps: [{ pool: 'checkin.met', mood: 'proud' }] }, { steps: [{ pool: 'checkin.lots', mood: 'excited' }] }],
          skip: [{ pool: 'checkin.skip' }],
        }];
      } else {
        steps = [{ ask: `${c.emoji} ${c.title}?`, askPool: 'checkin.askDone', choices: [
          { label: 'Done ✅', checkin: c.id, steps: [{ pool: 'checkin.done', mood: 'proud' }] },
          { label: 'Not yet', steps: [{ pool: 'checkin.notYet' }] },
        ] }];
      }
      return { topic: { id: `ci_${c.id}`, category: 'checkin', affection: 0, steps }, vars };
    }

    function logCheckin(id, value) {
      const c = checkinById(id);
      if (!c) return;
      const day = dayFlags();
      day[`ci:${id}`] = (day[`ci:${id}`] || 0) + value;
      day[`ci:${id}:n`] = (day[`ci:${id}:n`] || 0) + 1;
      state.counters[`ci:${id}`] = (state.counters[`ci:${id}`] || 0) + value;
      checkinMs[id] = 0;
      if (value > 0) {
        changeAffection(0.3);
        effects.push({ type: 'xp', amount: 2, play: true });
        needsBoost(10, 0);
      }
      dirty = true;
    }

    /** The next check-in that's due: enough active minutes since the last one, or its daily time has come. */
    function dueCheckin() {
      const day = dayFlags();
      const d = new Date();
      const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      for (const c of state.checkins) {
        if (!c.enabled) continue;
        if (c.at && hm >= c.at && !day[`ci:${c.id}:n`] && !day[`ci:${c.id}:r`]) { day[`ci:${c.id}:r`] = true; return c; }
        if (c.every && (checkinMs[c.id] || 0) >= c.every * MINUTE) { checkinMs[c.id] = 0; return c; }
      }
      return null;
    }

    function checkinSummary() {
      const day = dayFlags();
      return state.checkins.map((c) => ({ ...c, today: day[`ci:${c.id}`] || 0, todayCount: day[`ci:${c.id}:n`] || 0, total: state.counters[`ci:${c.id}`] || 0 }));
    }

    // MARK: Journal

    const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return dayKey(d); };

    function setJournal(patch, day) {
      const d = day || dayKey();
      state.journal[d] = { mood: null, note: null, ...(state.journal[d] || {}), ...patch };
      const keys = Object.keys(state.journal).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - 400))) delete state.journal[k];
      dirty = true;
    }

    // MARK: Needs (energy and fun; off unless turned on, and never punishing)

    function needsBoost(energy, fun) {
      if (!state.settings.needs) return;
      state.needs.energy = clamp(state.needs.energy + energy);
      state.needs.fun = clamp(state.needs.fun + fun);
      dirty = true;
    }

    function needsTick(t, dt) {
      if (!state.settings.needs) return;
      // Coming back from a break (5+ minutes away) is restful.
      if (prevIdle > 300 && ctx.idle < 10) needsBoost(25, 0);
      if (ctx.idle < 120) {
        state.needs.energy = clamp(state.needs.energy - (10 * dt) / (60 * MINUTE));
        state.needs.fun = clamp(state.needs.fun - (8 * dt) / (60 * MINUTE));
      }
      if (t - lastNeedHint > 60 * MINUTE && canSpeak(t, 3 * MINUTE)) {
        if (state.needs.energy < 25) {
          lastNeedHint = t;
          effects.push({ type: 'mood', mood: 'sleepy', seconds: 6 });
          say(line('needs.tired', "I'm getting sleepy… could we take a little break? 😴"), 6);
        } else if (state.needs.fun < 25) {
          lastNeedHint = t;
          say(line('needs.bored', "I'm a little bored… play with me? 🎾"), 6);
        }
      }
    }

    /** Coins never run out, so treats are always there; the pet just gets full if you feed it too fast,
     *  and only the first few treats each day count toward your bond. */
    function buyTreat(id) {
      const treat = TREATS.find((x) => x.id === id);
      if (!treat) return;
      const t = now();
      treatTimes = treatTimes.filter((x) => t - x < 15 * MINUTE);
      if (treatTimes.length >= 3) { say(line('needs.full', "I'm so full! 😵 Maybe later?"), 4); return; }
      treatTimes.push(t);
      state.needs.energy = clamp(state.needs.energy + treat.energy);
      state.needs.fun = clamp(state.needs.fun + treat.fun);
      effects.push({ type: 'mood', mood: 'petted', seconds: 3 });
      say(line(`needs.treat.${id}`, `${treat.emoji} yum! thank you! 💕`), 4);
      const day = dayFlags();
      day.treats = (day.treats || 0) + 1;
      if (day.treats <= 3) changeAffection(0.5);
      dirty = true;
    }

    function needsSummary() {
      return { enabled: !!state.settings.needs, energy: Math.round(state.needs.energy), fun: Math.round(state.needs.fun), coins: null, unlimited: true, treats: TREATS };
    }

    // MARK: Trips

    function logTrip() {
      const v = (convo && convo.vars) || {};
      const tripMood = state.memory.tripDay && state.memory.tripDay.at >= (v.since || 0) ? state.memory.tripDay.value : null;
      const asMood = { amazing: 'amazing', 'pretty good': 'good', okay: 'okay', tiring: 'tiring', rough: 'rough' }[tripMood];
      if (asMood && !(state.journal[dayKey()] && state.journal[dayKey()].mood)) setJournal({ mood: asMood });
      const m = (k) => (state.memory[k] && state.memory[k].at >= (v.since || 0) ? state.memory[k].value : null);
      state.trips.push({
        id: v.tripId || `t${now()}`, day: dayKey(), minutes: v.minutesRaw || 0, places: v.placeList || [],
        mood: m('tripDay'), activity: m('tripActivity'), moment: m('tripMoment'),
      });
      state.trips = state.trips.slice(-TRIP_LOG);
      dirty = true;
    }

    /** Back from a trip: a little XP for coming along, then the "how was your day?" talk. */
    function tripReturned(data) {
      const minutes = Math.max(0, num(data.minutes, 0));
      const places = [].concat(data.visits || []).map(String).filter(Boolean);
      const vars = {
        time: duration(minutes), places: listNames(places), count: new Set(places).size, visited: places.length > 0,
        minutesRaw: Math.round(minutes), placeList: [...new Set(places)].slice(0, 6), tripId: clean(data.id, 60) || `t${now()}`, since: now(),
      };
      changeAffection(2);
      state.cleanExit = true;
      const xp = Math.min(30, 5 + Math.floor(minutes / 30));
      effects.push({ type: 'xp', amount: xp });
      effects.push({ type: 'mood', mood: 'done', seconds: 4 });
      say(line(vars.visited ? 'trip.back.visited' : 'trip.back', "I'm home! 🏠", vars), 5);
      const topic = persona.topics.find((t) => t.id === 'trip.home');
      if (topic) {
        offer = { topic, vars, until: now() + 3 * 60 * MINUTE };
        later(3500, { type: 'openTalk', topic: 'offer' });
      }
      dirty = true;
    }

    function recallSteps() {
      const items = Object.values(state.memory).filter((v) => v && v.label && v.value);
      if (!items.length) return [{ pool: 'recall.empty' }];
      const steps = [{ pool: 'recall.intro' }];
      for (let i = 0; i < items.length; i += 3) {
        steps.push(items.slice(i, i + 3).map((v) => `${v.label.replace(/^./, (c) => c.toUpperCase())}: ${v.display || v.value}`).join('\n'));
      }
      steps.push({ pool: 'recall.outro' });
      return steps;
    }

    // MARK: Menus

    const catTitle = (id) => fill(persona.categories[id] || CATEGORY_TITLES[id] || id.replace(/^./, (c) => c.toUpperCase()));

    function menuItems(id) {
      const topics = persona.topics.filter((t) => t.menu !== false && !HIDDEN.includes(t.category));
      const inCat = (cat) => topics.filter((t) => t.category === cat);
      if (id === 'main') {
        const items = [{ id: 'random', label: '💬 Talk to me', hint: 'You pick something' }];
        if (askCategories().length) items.push({ id: 'cats', label: `❓ Ask ${names.pet} about…` });
        if (inCat('you').some(available)) items.push({ id: 'cat:you', label: '🙋 Ask me about me', hint: `${names.pet} gets to know you` });
        if (inCat('feeling').length) items.push({ id: 'cat:feeling', label: "💭 I'm feeling…" });
        if (inCat('tell').length) items.push({ id: 'cat:tell', label: `💌 Tell ${names.pet}…` });
        items.push({ id: 'games', label: '🎮 Play a game' });
        const giftsOpen = tierIndex() >= TIERS.findIndex((t) => t.id === GIFT_TIER);
        items.push({ id: 'gift', label: "🎁 I'd like to give you a gift", hint: giftsOpen ? null : `🔒 once we're ${tierName(TIERS.findIndex((t) => t.id === GIFT_TIER))}` });
        items.push({ id: 'recall', label: '🧠 What do you know about me?' });
        if (persona.topics.some((t) => t.category === 'milestone' && state.seen[t.id])) items.push({ id: 'memories', label: '📔 Our special moments' });
        if (inCat('goodbye').length) items.push({ id: 'cat:goodbye', label: '👋 Goodbye…' });
        return { items };
      }
      if (id === 'cats') {
        return {
          back: 'main',
          items: askCategories().map((cat) => {
            const list = inCat(cat).filter(available);
            const fresh = list.filter((t) => !state.seen[t.id]).length;
            return { id: `cat:${cat}`, label: catTitle(cat), badge: fresh ? `${fresh} new` : null };
          }),
        };
      }
      if (id === 'memories') {
        return {
          back: 'main', title: 'Our special moments',
          items: persona.topics.filter((t) => t.category === 'milestone' && state.seen[t.id]).map((t) => ({ id: `replay:${t.id}`, label: fill(t.title || t.id), badge: state.milestones[t.tier] || null })),
        };
      }
      if (id === 'checkins') {
        return { back: 'cat:tell', title: 'Check in', items: state.checkins.filter((c) => c.enabled).map((c) => ({ id: `checkin:${c.id}`, label: `${c.emoji} ${c.title}` })) };
      }
      if (id === 'games') {
        const items = GAMES.map((g) => ({ id: `game:${g.id}`, label: `${g.icon} ${g.title}` }));
        items.push({ id: 'playtime', label: '🎾 Throw me around! (playtime)', hint: "10 minutes of throws that don't hurt our bond" });
        return { back: 'main', items };
      }
      if (id.startsWith('cat:')) {
        const cat = id.slice(4);
        const all = inCat(cat);
        const open = all.filter(available);
        const locked = all.filter((t) => check(t.when) && (t.minAffection || 0) > state.affection).length;
        const items = open.map((t) => ({ id: `topic:${t.id}`, label: fill(t.title || t.id), badge: !state.seen[t.id] && cat !== 'goodbye' && cat !== 'tell' && cat !== 'feeling' ? 'new' : null }));
        if (cat === 'tell' && state.checkins.some((c) => c.enabled)) items.splice(1, 0, { id: 'checkins', label: '✅ Check in…' });
        return { back: OWN_ENTRY.includes(cat) ? 'main' : 'cats', items, locked: locked ? `🔒 ${locked} more as you two get closer` : null, title: catTitle(cat) };
      }
      return { items: [] };
    }

    function askCategories() {
      const cats = [];
      for (const t of persona.topics) {
        if (t.menu === false || OWN_ENTRY.includes(t.category) || !t.category || cats.includes(t.category)) continue;
        cats.push(t.category);
      }
      const order = ['pet', ...Object.keys(persona.categories), 'life', 'work', 'fun'];
      return cats.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
    }

    function menuNode(id, text) {
      convo = null;
      const m = menuItems(id);
      const prompt = text || (id === 'games' ? line('game.pick', 'What should we play? 🎮') : id === 'main' ? line('talk.menu', "What's up, {owner}?")
        : id === 'cats' ? line('talk.askAbout', 'Ask me anything! What do you want to know?') : m.title || catTitle(id.replace(/^cat:/, '')));
      return node('menu', prompt, null, { menu: m });
    }

    function pickTopic() {
      const eligible = persona.topics.filter((t) => t.random && !HIDDEN.includes(t.category) && available(t));
      const fresh = eligible.filter((t) => !state.seen[t.id]);
      // Questions you've already answered don't come back on their own.
      const pool = fresh.length ? fresh : eligible.filter((t) => t.repeat !== false && t.category !== 'you');
      if (!pool.length) return null;
      const least = Math.min(...pool.map((t) => state.seen[t.id] || 0));
      return pickOne(pool.filter((t) => (state.seen[t.id] || 0) === least));
    }

    function specialToday() {
      const day = dayFlags();
      return persona.topics.find((t) => t.category === 'special' && check(t.when) && !day[`special:${t.id}`]) || null;
    }

    function selectMenu(id) {
      if (id === 'random') return startTopic(pickTopic());
      if (id === 'gift') return giftAsk();
      if (id.startsWith('gift:')) return giveGift(id.slice(5));
      if (id.startsWith('checkin:')) {
        const c = checkinById(id.slice(8));
        if (c) { const { topic, vars } = checkinTopic(c); return startTopic(topic, vars); }
      }
      if (id === 'playtime') {
        convo = null;
        effects.push({ type: 'playtime', minutes: 10 });
        return node('end', null, null, { close: true });
      }
      if (id === 'recall') { convo = { topic: null, queue: recallSteps(), pending: null }; return advance(); }
      if (id.startsWith('replay:')) return startTopic(persona.topics.find((t) => t.id === id.slice(7) && t.category === 'milestone' && state.seen[t.id]));
      if (id.startsWith('topic:')) return startTopic(persona.topics.find((t) => t.id === id.slice(6) && available(t)));
      if (id.startsWith('game:')) {
        convo = { topic: null, queue: [{ game: id.slice(5) }], pending: null };
        return advance();
      }
      return menuNode(id);
    }

    // MARK: Ambient remarks and reminders

    function dayFlags() {
      const d = dayKey();
      if (!state.days[d]) {
        state.days[d] = {};
        const keys = Object.keys(state.days).sort();
        for (const k of keys.slice(0, Math.max(0, keys.length - DAY_HISTORY))) delete state.days[k];
      }
      return state.days[d];
    }

    function later(ms, effect) { scheduled.push({ at: now() + ms, effect }); }

    /**
     * `remind` marks reminders ('water', 'break', 'bedtime', 'checkin'), which also show as notifications. With
     * "until you answer" on, the notification stays up with Done / Snooze and comes back every 10 minutes until answered.
     */
    function say(text, seconds, remind) {
      if (!text) return false;
      const effect = { type: 'say', text, seconds: seconds || Math.min(9, 3 + text.length / 18) };
      if (remind && state.settings.notifyReminders) { effect.notify = true; effect.reminder = !!state.settings.remindUntilDone; }
      if (remind && state.settings.remindUntilDone) reminder = { kind: remind, text, at: now() + REMIND_AGAIN, offer: null };
      effects.push(effect);
      lastAmbient = now();
      return true;
    }

    /** The reminder was answered: take its notification down. */
    function clearReminder() {
      if (!reminder) return;
      reminder = null;
      effects.push({ type: 'clearReminder' });
    }

    /** Still unanswered: say it again (and notify again), and keep its "click me" chat open. */
    function remindAgain(t) {
      reminder.at = t + REMIND_AGAIN;
      const effect = { type: 'say', text: `${line('remind.again', 'Still waiting… ⏰')} ${reminder.text}`, seconds: 7 };
      if (state.settings.notifyReminders) { effect.notify = true; effect.reminder = true; }
      effects.push(effect);
      lastAmbient = t;
      if (reminder.offer && (!offer || offer === reminder.offer)) {
        offer = reminder.offer;
        offer.until = Math.max(offer.until, t + 20 * MINUTE);
        effects.push({ type: 'offer' });
      }
    }

    /** Done / Snooze / closed, from the reminder's notification. Done on water or a check-in opens the chat that logs it. */
    function answerReminder(answer) {
      const r = reminder;
      if (!r) return;
      const t = now();
      if (answer === 'snooze') {
        r.at = t + REMIND_AGAIN;
        if (r.offer && offer === r.offer) offer.until = Math.max(offer.until, r.at + 20 * MINUTE);
        say(line('remind.snooze', 'Okay, 10 more minutes! ⏰'), 3);
        return;
      }
      reminder = null;
      if (answer !== 'done') return;
      if (r.offer && (!offer || offer === r.offer)) {
        offer = r.offer;
        offer.until = Math.max(offer.until, t + 20 * MINUTE);
        effects.push({ type: 'openTalk', topic: 'offer' });
        return;
      }
      const fallback = { water: 'Yay, hydrated! 💧', break: 'Feels better, right? 🌿', bedtime: 'Goodnight, {owner} 🌙' }[r.kind] || 'Done! Proud of you 💕';
      effects.push({ type: 'mood', mood: 'done', seconds: 3 });
      say(line(`remind.done.${r.kind}`, fallback), 4);
    }

    /** Ambient lines wait for a moment when you're around and nothing more important is on screen. */
    function canSpeak(t, gap) {
      return !ctx.quiet && !ctx.talking && !ctx.speaking && !ctx.attention && ctx.focus !== 'focus' && ctx.idle < 60 && t - lastAmbient > gap;
    }

    /** `stayedOpen`: the pet kept running while you were gone (sleep, a locked screen), so nobody left without a goodbye. */
    function greeting(stayedOpen) {
      const t = now();
      const away = state.lastSeen ? (t - state.lastSeen) / 1000 : null;
      const f = state.farewell;
      const saidBye = state.cleanExit;
      state.farewell = null;
      state.cleanExit = false;
      dirty = true;
      const tod = timeOfDay();
      if (away == null) return line('greeting.first', 'Hi {owner}! 💕');
      // Disappearing for a long time hurts a little; leaving without a goodbye stings a bit too.
      if (away > 30 * 86400) changeAffection(-8);
      else if (away > 7 * 86400) changeAffection(-3);
      if (!saidBye && !f && !stayedOpen && away > 3600) changeAffection(-0.5);
      if (tierIndex() < BASE_TIER) return line('greeting.upset', null) || line(`greeting.${tod}`, 'Oh. Hi, {owner}.');
      if (away < 600) return line('greeting.again', 'hi {owner}! 👋');
      if (f && t - f.at < 20 * 3600 * 1000 && poolLines(`greeting.after.${f.reason}`).length) return line(`greeting.after.${f.reason}`);
      if (away > 14 * 86400) return line('greeting.longGone', null) || line(`greeting.${tod}`, 'Welcome back, {owner}!');
      if (away > 2 * 86400) return line('greeting.missed', null) || line(`greeting.${tod}`, 'Welcome back, {owner}!');
      if (away < 6 * 3600 && dayKey(new Date(state.lastSeen)) === dayKey()) return line('greeting.back', 'Welcome back, {owner}!');
      return line(`greeting.${tod}`, 'Hi {owner}! 👋');
    }

    function greet(stayedOpen) {
      const text = greeting(stayedOpen);
      say(text, 6);
      lastGreet = now();
      // A fresh start: reminders count from now, not from before you left.
      activeMs = 0; waterMs = 0; streakStart = lastGreet;
      const day = dayFlags();
      if (!day.greeted) { day.greeted = true; changeAffection(1); }
      const special = specialToday();
      if (special) {
        offer = { topic: special, until: now() + 30 * MINUTE };
        dayFlags()[`special:${special.id}`] = true;
        later(7000, { type: 'say', text: line(special.prompt || 'wantsToTalk.special', null) || line('wantsToTalk', 'psst… click me! 💬'), seconds: 10 });
        later(7000, { type: 'offer' });
      }
      // After a rough or tiring day, ask how today is going.
      const y = state.journal[yesterday()];
      if (!special && y && (y.mood === 'rough' || y.mood === 'tiring') && !y.followUp && !day.checkup) {
        const topic = persona.topics.find((x) => x.id === 'journal.checkup');
        if (topic) {
          day.checkup = true;
          offer = { topic, until: now() + 3 * 60 * MINUTE };
          later(7000, { type: 'say', text: line('journal.checkupPrompt', 'Yesterday sounded hard… how are you today? 💕'), seconds: 8 });
          later(7000, { type: 'offer' });
        }
      }
      state.lastSeen = now();
      dirty = true;
    }

    /**
     * Back after over 4 hours away. `lastSeen` only moves while you're using the computer, so a pet left running
     * overnight (sleep, a locked screen, the screen off, Power Nap) still notices a new day.
     */
    function returned(t) {
      return !!state.lastSeen && t - state.lastSeen > 4 * 3600 * 1000;
    }

    function tick(c) {
      ctx = { idle: 0, ...(c || {}) };
      if (ctx.owner) names.owner = ctx.owner;
      if (ctx.pet) names.pet = ctx.pet;
      if (typeof ctx.togetherMinutes === 'number') togetherMilestones(ctx.togetherMinutes);
      const t = now();
      const dt = Math.max(0, Math.min(MINUTE, t - lastTick));
      lastTick = t;
      if (ctx.idle < 60) {
        if (returned(t)) greet(true);
        state.lastSeen = t;
      }
      if (t - lastSave > 60000) dirty = true;

      for (const s of scheduled.filter((x) => x.at <= t)) {
        if (s.effect.type === 'say' && (ctx.speaking || ctx.talking)) { s.at = t + 3000; continue; }
        effects.push(s.effect);
        if (s.effect.type === 'say') lastAmbient = t;
        scheduled.splice(scheduled.indexOf(s), 1);
      }

      const active = ctx.idle < 120;
      if (active) {
        activeMs += dt; waterMs += dt; chatterMs += dt; encourageMs += dt;
        for (const c of state.checkins) if (c.enabled && c.every) checkinMs[c.id] = (checkinMs[c.id] || 0) + dt;
      }
      needsTick(t, dt);
      prevIdle = ctx.idle;
      if (ctx.idle > 300 || ctx.focus === 'focus') streakStart = t;
      if (offer && t > offer.until) offer = null;
      if (!chatterDue) chatterDue = CHATTER[state.settings.chatter] ? between(CHATTER[state.settings.chatter]) : 0;

      const s = state.settings;
      const h = new Date().getHours();
      const day = dayFlags();
      let dueC = null;
      if (t - startedAt > 45000 && canSpeak(t, 3 * MINUTE)) {
        const late = h >= 23 || h < 5;
        if (reminder && t >= reminder.at) {
          remindAgain(t);
        } else if (s.lateNight && late && ctx.idle < 10 && t - lastNight > 75 * MINUTE) {
          lastNight = t;
          say(line(h >= 1 && h < 5 ? 'lateNight.late' : 'lateNight', "It's late, {owner}… bedtime soon? 🌙"), 6, 'bedtime');
        } else if (s.breaks && t - streakStart >= s.breaks * MINUTE) {
          streakStart = t;
          say(line('break', 'Stretch break? 🙆'), 7, 'break');
        } else if (s.water && waterMs >= s.water * MINUTE) {
          waterMs = 0;
          say(line('water', 'Water break! 💧'), 6, 'water');
          // Then click the pet and report how many sips you took.
          const log = persona.topics.find((x) => x.id === 'water_log');
          if (log && !offer) {
            offer = { topic: log, until: t + 20 * MINUTE };
            if (reminder) reminder.offer = offer;
            effects.push({ type: 'offer' });
            later(6500, { type: 'say', text: line('water.ask', 'click me after your drink and tell me how many sips! 💧'), seconds: 6 });
          }
        } else if (s.motivation && !day.motivation && activeMs > 2 * MINUTE && h >= 5) {
          day.motivation = true;
          dirty = true;
          say(line('motivation', "You've got this, {owner}! ✨"), 8);
        } else if (s.recap && !day.recap && h >= 18 && (ctx.activeMinutes || 0) >= 60) {
          day.recap = true;
          dirty = true;
          const mins = ctx.activeMinutes;
          const hours = mins >= 90 ? `${Math.round(mins / 6) / 10} hours` : `${mins} minutes`;
          say(line(ctx.tasks > 0 ? 'recap.agents' : 'recap', 'We spent {hours} together today 💕', { hours, tasks: ctx.tasks || 0, focus: ctx.focusSessions || 0 }), 8);
        } else if (!offer && (dueC = dueCheckin())) {
          const { topic, vars } = checkinTopic(dueC);
          offer = { topic, vars, until: t + 20 * MINUTE };
          effects.push({ type: 'offer' });
          say(`${dueC.emoji} ${line('checkin.remind', '{title} time! Click me when you have 💪', { title: dueC.title })}`, 7, 'checkin');
          if (reminder) reminder.offer = offer;
        } else if (s.journal && !offer && !day.journalAsked && h >= 19 && activeMs > 10 * MINUTE && !(state.journal[dayKey()] && state.journal[dayKey()].mood)) {
          day.journalAsked = true;
          dirty = true;
          const topic = persona.topics.find((x) => x.id === 'journal.evening');
          if (topic) {
            offer = { topic, until: t + 90 * MINUTE };
            effects.push({ type: 'offer' });
            say(line('journal.prompt', 'Before the day ends… how was today? Click me 📔'), 8);
          }
        } else if (chatterDue && !offer && chatterMs >= chatterDue) {
          chatterMs = 0;
          chatterDue = CHATTER[s.chatter] ? between(CHATTER[s.chatter]) : 0;
          const topic = pickTopic();
          if (topic) {
            offer = { topic, until: t + 2 * MINUTE };
            say(line('wantsToTalk', 'psst… click me! 💬'), 10);
            effects.push({ type: 'offer' });
          }
        } else if (encourageMs >= encourageDue) {
          encourageMs = 0;
          encourageDue = between([80, 150]);
          say(line('encourage', "You're doing great 💕"), 6);
        }
      }

      if (dirty && t - lastSave > 5000) save();
      return drain();
    }

    /** "We've spent 100 hours together!" Time from before this feature counts as already celebrated. */
    function togetherMilestones(minutes) {
      const reached = TOGETHER_HOURS.filter((h) => minutes >= h * 60).length;
      if (typeof state.counters.together !== 'number') { state.counters.together = reached; dirty = true; return; }
      if (reached <= state.counters.together) return;
      state.counters.together = reached;
      const hours = TOGETHER_HOURS[reached - 1];
      changeAffection(1);
      effects.push({ type: 'mood', mood: 'done', seconds: 4 });
      const time = hours === 1 ? '1 hour' : `${hours.toLocaleString('en-US')} hours`;
      later(0, { type: 'say', text: line('together.milestone', "We've spent {time} together! 💕", { time, hours }), seconds: 7 });
      dirty = true;
    }

    function appChanged(name, title) {
      const cat = categorize(name, title);
      const t = now();
      if (cat === lastCategory) return drain();
      lastCategory = cat;
      if (!state.settings.appComments || cat === 'other' || t - startedAt < 20000) return drain();
      if (!canSpeak(t, 90000) || (appCooldown[cat] && t - appCooldown[cat] < 40 * MINUTE) || Math.random() > 0.5) return drain();
      const text = line(`app.${cat}`, null);
      if (text) { appCooldown[cat] = t; say(text, 3.5); }
      return drain();
    }

    function event(name, data) {
      data = data || {};
      switch (name) {
        case 'launch': greet(); break;
        case 'petted': changeAffection(0.25); needsBoost(0, 2); say(line('petted', 'hehe 💕'), 2.2); break;
        case 'xp': {
          // Coins for treats: one per 10 XP.
          state.needs.bank += Math.max(0, num(data.amount, 0));
          const coins = Math.floor(state.needs.bank / 10);
          if (coins) { state.needs.coins += coins; state.needs.bank -= coins * 10; dirty = true; }
          break;
        }
        case 'playdate': {
          const vars = { other: clean(data.other, 30) || 'my friend' };
          effects.push({ type: 'mood', mood: 'petted', seconds: 4 });
          say(line(data.first ? 'playdate.first' : 'playdate', 'hi {other}! let\'s play! 💕', vars), 4);
          if (now() - lastPlaydate > 10 * MINUTE) { lastPlaydate = now(); changeAffection(0.5); needsBoost(0, 10); }
          break;
        }
        case 'eventStart': {
          const title = clean(data.title, 40);
          say(line(`event.${clean(data.id, 20)}.start`, null, { title }) || line('event.start', "It's {title}! Spend an hour with me to earn something special ✨", { title }), 7);
          break;
        }
        case 'eventEarned':
          effects.push({ type: 'mood', mood: 'done', seconds: 4 });
          say(line('event.earned', 'You earned the {title} outfit! Do I look cute? ✨', { title: clean(data.title, 40) }), 6);
          break;
        case 'meetingSoon':
          effects.push({ type: 'mood', mood: 'startled', seconds: 1.5 });
          say(line('calendar.soon', '📅 {title} in {minutes} minutes!', { title: clean(data.title, 60) || 'A meeting', minutes: Math.max(1, Math.round(num(data.minutes, 5))) }), 8);
          break;
        case 'meetingNow':
          say(line('calendar.now', '📅 {title} is starting! Click me to join', { title: clean(data.title, 60) || 'Your meeting' }), 8);
          break;
        case 'wake': say(line('wake', 'oh! hi! 😳'), 3); break;
        case 'thrown': {
          const day = dayFlags();
          // Playtime: throwing is a game, so it never counts as rough handling (and is a little fun).
          if (data.playful) {
            day.playThrows = (day.playThrows || 0) + 1;
            needsBoost(0, 3);
            changeAffection(0.1);
            if (Math.random() < 0.35) say(line('thrown.playful', 'wheee! again! 🎾'), 2.2);
            dirty = true;
            break;
          }
          day.throws = (day.throws || 0) + 1;
          if (day.throws > THROW_LIMIT) {
            changeAffection(-0.3);
            if (day.throws === THROW_LIMIT + 1) say(line('thrownTooMuch', 'ow… can you stop throwing me? 😣'), 3.5);
          }
          dirty = true;
          break;
        }
        case 'quit':
          // Quitting from the menu is a goodbye too, just a quick one. Crashes and shutdowns aren't.
          state.cleanExit = true;
          state.lastSeen = now();
          save();
          break;
        case 'resume':
          if (returned(now())) greet(true);
          else if (now() - lastGreet > MINUTE) say(line('resume', 'welcome back! ☀️'), 4);
          break;
        case 'app': return appChanged(data.name, data.title);
        case 'playtimeStart':
          effects.push({ type: 'mood', mood: 'done', seconds: 2.5 });
          say(line('playtime.start', 'playtime! throw me as much as you like 🎾'), 4);
          break;
        case 'playtimeEnd': say(line('playtime.end', 'phew! that was fun 😆'), 3.5); break;
        case 'tripLeave':
          state.cleanExit = true;
          state.lastSeen = now();
          effects.push({ type: 'mood', mood: 'done', seconds: 3.5 });
          say(line('trip.leave', "a trip?! let's go! 🧳"), 3.5);
          save();
          break;
        case 'tripReturn': tripReturned(data); break;
        case 'tripArrive': {
          const vars = { host: clean(data.host, 40) || 'here', home: clean(data.homeName, 40) || 'home' };
          effects.push({ type: 'mood', mood: 'startled', seconds: 1.5 });
          say(line(data.first ? 'trip.arrive.first' : 'trip.arrive', 'ooh, a new computer! ✨', vars), 6);
          break;
        }
        case 'tripCalledHome': say(line('trip.calledHome', "oh! I'm back! 🏠"), 5); break;
        case 'tripLuggage': say(line('trip.luggage', 'found my stuff from our trip! 🧳'), 4); break;
        case 'movedIn':
          effects.push({ type: 'mood', mood: 'done', seconds: 3 });
          say(line('moving.in', 'a new home! ✨'), 6);
          break;
        case 'movingOut': say(line('moving.out', 'all packed! 📦'), 4); break;
        default: break;
      }
      return drain();
    }

    function drain() {
      const out = effects;
      effects = [];
      return out;
    }

    function save() {
      dirty = false;
      lastSave = now();
      if (typeof host.save === 'function') {
        try { host.save(JSON.stringify(state)); } catch (_) { /* host storage failed; try again next change */ }
      }
    }

    // MARK: UI calls (the talk window and the control center)

    function ui(action, payload) {
      payload = payload || {};
      let result = null;
      switch (action) {
        case 'open': {
          const topicId = payload.topic;
          clearReminder();
          if (topicId === 'offer' && offer) { const o = offer; offer = null; dayFlags()[`special:${o.topic.id}`] = true; result = startTopic(o.topic, o.vars); }
          else if (topicId && topicId !== 'offer') result = selectMenu(topicId);
          else result = menuNode('main');
          break;
        }
        case 'menu': result = selectMenu(String(payload.id || 'main')); break;
        case 'next':
          if (convo && convo.pending) result = convo.pending.type === 'ask' ? choose(-1) : convo.pending.type === 'input' ? input('') : advance();
          else result = advance();
          break;
        case 'choose': result = choose(Number(payload.index)); break;
        case 'input': result = input(payload.value); break;
        case 'game': result = gameResult(String(payload.game), String(payload.outcome)); break;
        case 'close':
          if (convo && convo.topic && convo.queue.length + (convo.pending ? 1 : 0) > 0) say(line('talk.bye', 'talk later! 👋'), 3);
          convo = null;
          break;
        case 'summary': result = summary(); break;
        case 'reminder': answerReminder(String(payload.answer || '')); break;
        case 'checkinSet': {
          const c = checkinById(String(payload.id || ''));
          const p = isObj(payload.patch) ? payload.patch : {};
          if (c) {
            if ('enabled' in p) c.enabled = !!p.enabled;
            if ('every' in p && CHECKIN_EVERY.includes(Number(p.every))) c.every = Number(p.every);
            if ('at' in p) c.at = /^\d\d:\d\d$/.test(String(p.at)) ? String(p.at) : '';
            if (!c.builtin) for (const k of ['emoji', 'title', 'sentence', 'unit']) if (k in p) c[k] = clean(p[k], k === 'emoji' ? 4 : 60);
            if (!c.builtin && 'target' in p) c.target = Math.max(1, Math.floor(num(Number(p.target), 1)));
            dirty = true;
          }
          result = summary();
          break;
        }
        case 'checkinAdd': {
          const kind = payload.kind === 'count' ? 'count' : 'done';
          state.checkins = normalizeCheckins(state.checkins.concat([{ ...payload, id: `c${now().toString(36)}`, kind, enabled: true }]));
          dirty = true;
          result = summary();
          break;
        }
        case 'checkinRemove':
          state.checkins = state.checkins.filter((c) => c.builtin || c.id !== payload.id);
          dirty = true;
          result = summary();
          break;
        case 'buyTreat': buyTreat(String(payload.id || '')); result = summary(); break;
        case 'gift': result = giveGift(String(payload.file || payload.id || '')); break;
        case 'giftCancel':
          convo = { topic: null, queue: [{ pool: 'gift.cancel' }], pending: null };
          result = advance();
          break;
        case 'setting': result = setSetting(payload.key, payload.value); break;
        case 'forget': forget(String(payload.key || '')); result = summary(); break;
        case 'remember': {
          const key = clean(payload.key, 40);
          if (key === 'birthday') remember('birthday', payload.value, 'birthday', displayDate(payload.value));
          else if (key) remember(key, payload.value, payload.label);
          result = summary();
          break;
        }
        default: break;
      }
      if (dirty) save();
      return { result, effects: drain() };
    }

    function setSetting(key, value) {
      if (!(key in DEFAULT_SETTINGS)) return summary();
      if (key === 'chatter' && !(value in CHATTER)) return summary();
      if (key === 'water' && !WATER_CHOICES.includes(Number(value))) return summary();
      if (key === 'breaks' && !BREAK_CHOICES.includes(Number(value))) return summary();
      state.settings[key] = typeof DEFAULT_SETTINGS[key] === 'number' ? Number(value) : typeof DEFAULT_SETTINGS[key] === 'boolean' ? !!value : String(value);
      if (key === 'chatter') chatterDue = CHATTER[state.settings.chatter] ? between(CHATTER[state.settings.chatter]) : 0;
      if (key === 'water') waterMs = 0;
      if (key === 'breaks') streakStart = now();
      if (key === 'remindUntilDone' && !state.settings.remindUntilDone) clearReminder();
      dirty = true;
      return summary();
    }

    function summary() {
      const topics = persona.topics.filter((t) => !HIDDEN.includes(t.category));
      return {
        personality: personaInfo,
        affection: affectionInfo(),
        tiers: TIERS.slice(BASE_TIER).map((t, i) => ({ id: t.id, name: tierName(i + BASE_TIER), at: t.at, reached: !!state.milestones[t.id] || state.affection >= t.at })),
        memories: Object.entries(state.memory).map(([key, v]) => ({ key, label: v.label, value: v.display || v.value, at: v.at })).sort((a, b) => b.at - a.at),
        settings: { ...state.settings },
        choices: { chatter: Object.keys(CHATTER), water: WATER_CHOICES, breaks: BREAK_CHOICES },
        counters: { ...state.counters },
        topics: { total: topics.length, seen: topics.filter((t) => state.seen[t.id]).length },
        firstMet: state.firstMet,
        offer: !!offer,
        trips: state.trips.slice(-10).reverse(),
        gifts: giftSummary(),
        checkins: checkinSummary(),
        checkinEvery: CHECKIN_EVERY,
        needs: needsSummary(),
        journal: Object.fromEntries(Object.entries(state.journal).slice(-42)),
        days: Object.keys(state.days).sort().slice(-14).map((d) => {
          const f = state.days[d];
          const checkins = {};
          for (const c of state.checkins) if (f[`ci:${c.id}:n`]) checkins[c.id] = f[`ci:${c.id}`] || 0;
          return { day: d, sips: f.sips || 0, waterBreaks: f.waterBreaks || 0, mood: (state.journal[d] && state.journal[d].mood) || null, checkins };
        }),
        water: { today: dayFlags().sips || 0, breaksToday: dayFlags().waterBreaks || 0, total: state.counters.sips || 0, breaks: state.counters.waterBreaks || 0 },
      };
    }

    // MARK: Sync and transfer

    /** What travels in sync profiles and transfer keys (no timers or per-day flags). */
    function exportData() {
      return { affection: state.affection, memory: state.memory, seen: state.seen, milestones: state.milestones, settings: state.settings, counters: state.counters, firstMet: state.firstMet, trips: state.trips, checkins: state.checkins, journal: state.journal, needs: state.needs, gifts: state.gifts };
    }

    /** Sync: keeps the higher affection, the newer of each memory, and every topic either device has seen. */
    function mergeData(data) {
      data = parsed(data);
      if (!isObj(data)) return;
      const incoming = normalize({ ...data, days: {}, gained: state.gained, lastSeen: state.lastSeen });
      state.affection = Math.max(state.affection, incoming.affection);
      for (const [k, v] of Object.entries(incoming.memory)) if (isObj(v) && (!state.memory[k] || num(v.at, 0) > num(state.memory[k].at, 0))) state.memory[k] = v;
      for (const [k, v] of Object.entries(incoming.seen)) state.seen[k] = Math.max(state.seen[k] || 0, num(v, 0));
      for (const [k, v] of Object.entries(incoming.milestones)) if (!state.milestones[k] || v < state.milestones[k]) state.milestones[k] = v;
      if (isObj(data.settings)) state.settings = incoming.settings;
      for (const k of Object.keys(incoming.counters)) state.counters[k] = Math.max(state.counters[k] || 0, num(incoming.counters[k], 0));
      if (incoming.firstMet < state.firstMet) state.firstMet = incoming.firstMet;
      if (Array.isArray(data.checkins)) state.checkins = incoming.checkins;
      for (const [k, v] of Object.entries(incoming.gifts)) if (!state.gifts[k] || state.gifts[k].count < v.count) state.gifts[k] = v;
      for (const [d, e] of Object.entries(incoming.journal)) if (!state.journal[d]) state.journal[d] = e;
      if (isObj(data.needs)) state.needs.coins = Math.max(state.needs.coins, incoming.needs.coins);
      const ids = new Set(state.trips.map((t) => t.id));
      state.trips = state.trips.concat(incoming.trips.filter((t) => !ids.has(t.id))).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)).slice(-TRIP_LOG);
      save();
    }

    /** Transfer keys replace everything. */
    function replaceData(data) {
      data = parsed(data);
      if (!isObj(data)) return;
      state = normalize({ ...data, days: state.days, gained: state.gained, lastSeen: state.lastSeen });
      save();
    }

    return {
      tick, event, ui, line: (key, fallback, extra) => line(key, fallback, extra), setPersonality, summary, exportData, mergeData, replaceData,
      hasOffer: () => !!offer && now() <= offer.until,
      setNames: (owner, pet) => { if (owner) names.owner = String(owner); if (pet) names.pet = String(pet); },
      flush: () => { state.lastSeen = now(); save(); },
      // For tests.
      _state: () => state, _persona: () => persona, _run: (topicId) => startTopic(persona.topics.find((t) => t.id === topicId)),
    };
  }

  const api = { create, categorize, TIERS, GAMES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DeskPetCompanion = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
