// DeskPet control center, shared by the macOS app (WKWebView) and the Windows app (Electron).
// Talks to the host through `call(action, payload)` and refreshes from `state` every second.
(() => {
  const { Color } = window.DeskPetColor;

  // MARK: Bridge (same shape as the setup wizard's)

  const pending = new Map();
  let seq = 0;
  window.__deskpetReply = (id, result) => {
    const resolve = pending.get(id);
    if (resolve) { pending.delete(id); resolve(result); }
  };
  const bridge = window.deskpetPanel || {
    call(action, payload = {}) {
      return new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        window.webkit.messageHandlers.deskpet.postMessage({ id, action, payload });
      });
    },
  };
  const call = (action, payload) => bridge.call(action, payload || {});
  // Script errors go to the host's log (the macOS WebKit view has no visible console).
  window.addEventListener('error', (e) => call('log', { message: `${e.message} @ ${e.lineno}:${e.colno}` }));
  window.addEventListener('unhandledrejection', (e) => call('log', { message: String(e.reason && e.reason.stack || e.reason) }));

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hm = (m) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`);

  let state = null;
  let page = 'home';
  let focusMinutes = 25;
  const packs = new Map();
  const renderers = new Map();
  const THEMES = [null, '#FF8FB1', '#FF6B6B', '#FFB347', '#7BD389', '#4FC3F7', '#9C88FF', '#2B2D42'];
  const ICONS = { stay: '📌', typeAlong: '⌨️', wander: '🚶', gravity: '🪂', walkOnWindows: '🪟', quietInCalls: '🤫', notifications: '🔔', sounds: '🔊', autoUpdate: '⬆️', startAtLogin: '🚀' };
  const TOGGLES = [
    ['notifications', 'Notifications', 'When agents finish, need you, or error'],
    ['sounds', 'Sounds', 'Purrs, pops, and chimes'],
    ['stay', 'Stay in one place', "Doesn't walk, fall, or ride windows. Drag to move"],
    ['typeAlong', 'Type along with me', 'Types on a laptop while you type'],
    ['walkOnWindows', 'Walk on windows', 'Lands on and rides your windows'],
    ['wander', 'Wander around', 'Takes little walks'],
    ['gravity', 'Gravity', 'Falls when dropped. Throw me!'],
    ['quietInCalls', 'Quiet during calls', 'Hush while a mic or camera is on'],
    ['autoUpdate', 'Automatic updates', 'From GitHub releases'],
    ['startAtLogin', 'Open at login', 'Starts when you sign in'],
  ];

  // MARK: Setup

  async function init() {
    state = await call('state');
    const native = state.chrome === 'native';
    const root = document.documentElement.style;
    root.setProperty('--titlebar-inset', native ? '86px' : '18px');
    root.setProperty('--close-display', native ? 'none' : 'grid');
    root.setProperty('--chrome-radius', native ? '0' : '14px');
    $('#version').textContent = `v${state.version}`;
    $('#about-version').textContent = `v${state.version}`;

    document.querySelectorAll('#sidebar button').forEach((b) => b.addEventListener('click', () => show(b.dataset.page)));
    $('#close').addEventListener('click', () => call('close'));
    wireHome();
    wireCompanion();
    wireRewards();
    wireLook();
    wireFocus();
    wireAccount();
    wireTrips();
    wireCheckins();
    wireGifts();
    wireGallery();
    wireAbout();
    render();
    if (state.openPage) show(state.openPage);
    requestAnimationFrame(frame);
    setInterval(refresh, 1000);
  }

  async function refresh() {
    const next = await call('state');
    if (!next) return;
    state = next;
    render();
  }

  function show(name) {
    page = name;
    document.querySelectorAll('#sidebar button').forEach((b) => b.classList.toggle('on', b.dataset.page === name));
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('on', p.dataset.page === name));
    $('#content').scrollTop = 0;
    if (name === 'account' && !$('#acc-key').value) call('transferExport').then((r) => { $('#acc-key').value = r.key; });
  }

  async function set(key, value) {
    await call('set', { key, value });
    refresh();
  }

  // MARK: Rendering (cheap enough to redo every second)

  let lastStatic = '';
  function render() {
    applyAccent();
    const r = state.rank;
    $('#mini-rank').textContent = `${state.names.petName} · ${r.title}`;
    renderHome();
    renderRewards();
    renderFocus();
    renderAgents();
    // These only change on user action; rebuilding them every second would steal focus and clicks.
    const staticKey = JSON.stringify([state.look, state.toggles, state.panicKey, state.blocklist, state.blockDuringFocus, state.strictBlock, state.names]);
    if (staticKey !== lastStatic) {
      lastStatic = staticKey;
      renderLook();
      renderBehavior();
      renderBlocklist();
      if (document.activeElement !== $('#acc-pet') && document.activeElement !== $('#acc-owner')) {
        $('#acc-pet').value = state.names.petName;
        $('#acc-owner').value = state.names.ownerName;
      }
    }
    renderSync();
    renderCompanion();
    renderTrips();
    renderInsights();
    renderCheckins();
    renderGifts();
    renderNeeds();
    renderQuiet();
    renderCalendar();
    renderEvent();
    document.querySelectorAll('.pet-name').forEach((n) => { n.textContent = state.names.petName; });
    $('#about-update').textContent = state.update.available ? `Version ${state.update.available} is available!` : `You're on the latest version (${state.version}).`;
    $('#about-update-btn').textContent = state.update.available ? `⬆️ Update to v${state.update.available}` : 'Check for updates';
  }

  function applyAccent() {
    const c = Color.hex(state.look.themeColor || '');
    const root = document.documentElement.style;
    if (!c) { root.removeProperty('--accent'); root.removeProperty('--accent-2'); return; }
    root.setProperty('--accent', c.darkened(0.6).css());
    root.setProperty('--accent-2', c.blend(0.35, Color.hex('#9B7BFF')).darkened(0.5).css());
  }

  function xpBar(fillSel, textSel) {
    const r = state.rank;
    $(fillSel).style.width = `${Math.round(r.progress * 100)}%`;
    $(textSel).textContent = r.atMax ? (r.canPrestige ? 'MAX · ready to prestige' : 'MAX LEVEL') : `${r.xpToNext} XP to Lv ${r.level + 1}`;
  }

  function sessionRows(list, container) {
    container.innerHTML = '';
    if (!state.sessions.length) { container.appendChild(el('div', 'empty', 'No AI agents running right now.')); return; }
    for (const s of state.sessions) {
      const row = el('div', 'session');
      const dot = el('span', 'dot');
      dot.style.background = s.color;
      row.appendChild(dot);
      row.appendChild(el('div', '', `<div class="title">${esc(s.name)}${s.project ? ` · ${esc(s.project)}` : ''}</div><div class="detail">${esc(s.detail)}${s.precise ? '' : ' (guessed)'}</div>${s.summary ? `<div class="summary">✓ ${esc(s.summary)}</div>` : ''}`));
      row.appendChild(el('div', 'tokens', `${esc(s.elapsed)}${s.tokens ? `<br>${esc(s.tokens)}` : ''}`));
      const jump = el('button', 'jump', 'Jump ↗');
      jump.disabled = !s.pid;
      jump.addEventListener('click', () => call('jump', { pid: s.pid }));
      row.appendChild(jump);
      container.appendChild(row);
    }
  }

  // MARK: Home

  function wireHome() {
    $('#home-focus').addEventListener('click', () => (state.focus.phase === 'off' ? call('focusStart', { minutes: 25 }) : call('focusStop')).then(refresh));
    $('#home-bring').addEventListener('click', () => call('bringHere'));
    $('#home-poses').addEventListener('click', () => call('previewPoses'));
    $('#home-talk').addEventListener('click', () => call('talk'));
  }

  function renderHome() {
    const r = state.rank;
    $('#hero-rank').textContent = r.title;
    $('#hero-name').textContent = state.names.petName;
    xpBar('#hero-xp-fill', '#hero-xp-text');
    $('#hero-next').textContent = state.nextReward || '';
    $('#hero-together').textContent = togetherText();
    $('#home-focus').textContent = state.focus.phase === 'off' ? '🍅 Focus 25 min' : `⏹ ${state.focus.label}`;
    const t = state.today;
    const tiles = [
      [hm(t.activeMinutes), 'with you'], [hm(t.agentMinutes), 'agents working'], [t.tasks, `task${t.tasks === 1 ? '' : 's'} finished`],
      [t.pets, `pet${t.pets === 1 ? '' : 's'}`], [t.focusSessions, `focus session${t.focusSessions === 1 ? '' : 's'}`], [t.blocked, 'distractions blocked'],
    ];
    $('#today').innerHTML = tiles.map(([n, l]) => `<div class="tile"><div class="num">${esc(n)}</div><div class="lbl">${esc(l)}</div></div>`).join('');
    sessionRows(state.sessions, $('#home-sessions'));
  }

  /** "⏱ 42h 10m together since Oct 15" */
  function togetherText() {
    const m = state.togetherMinutes || 0;
    const time = m >= 60000 ? `${Math.round(m / 60).toLocaleString()} hours` : hm(m);
    const since = state.companion && state.companion.firstMet;
    const d = since ? new Date(`${since}T12:00:00`) : null;
    const when = d && !isNaN(d) ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : '';
    return `⏱ ${time} together${when ? ` since ${when}` : ''}`;
  }

  // MARK: Companion

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function companion(op, payload) {
    return call('companion', { op, ...(payload || {}) }).then((summary) => { if (summary && state) state.companion = summary; lastCompanion = ''; renderCompanion(); });
  }

  function wireCompanion() {
    $('#cp-talk').addEventListener('click', () => call('talk'));
    document.querySelectorAll('.switch-btn[data-companion]').forEach((sw) => sw.addEventListener('click', () => companion('setting', { key: sw.dataset.companion, value: !sw.classList.contains('on') })));
    for (let m = 1; m <= 12; m++) $('#cp-bday-month').add(new Option(MONTHS[m - 1], m));
    for (let d = 1; d <= 31; d++) $('#cp-bday-day').add(new Option(d, d));
    $('#cp-bday-save').addEventListener('click', () => {
      const v = `${String($('#cp-bday-month').value).padStart(2, '0')}-${String($('#cp-bday-day').value).padStart(2, '0')}`;
      companion('remember', { key: 'birthday', value: v });
    });
    $('#cp-forget-all').addEventListener('click', () => {
      $('#modal-emblem').textContent = '🧠';
      $('#modal-title').textContent = 'Forget everything?';
      $('#modal-text').textContent = `${state.names.petName} forgets everything you've told them: your birthday, favorites, nickname, and the rest. Your bond and progress stay.`;
      openModal({ ok: 'Forget', cancel: 'Keep', onOk: () => companion('forget', { key: '*' }) });
    });
  }

  function segmented(container, values, current, label, key) {
    container.innerHTML = '';
    for (const v of values) {
      const b = el('button', v === current ? 'on' : '', esc(label(v)));
      b.addEventListener('click', () => companion('setting', { key, value: v }));
      container.appendChild(b);
    }
  }

  let lastCompanion = '';
  function renderCompanion() {
    const c = state.companion;
    if (!c) return;
    const key = JSON.stringify([c, state.togetherMinutes]);
    if (key === lastCompanion) return;
    lastCompanion = key;
    const a = c.affection;
    const p = c.personality || {};
    $('#cp-personality').textContent = `${p.name || 'Friend'} personality${p.source ? ` · ${p.source}` : ''}`;
    $('#cp-tier').textContent = a.tier;
    $('#cp-hearts').textContent = a.upset ? '💔' : '♥'.repeat(a.hearts) + '♡'.repeat(Math.max(0, a.maxHearts - a.hearts));
    $('#cp-fill').style.width = `${Math.round(a.progress * 100)}%`;
    $('#cp-next').textContent = a.next ? `on the way to ${a.next}` : 'closest there is 💕';
    $('#cp-hint').textContent = a.upset
      ? `${state.names.petName} is upset. Kind words, an apology (Talk → Tell…), and time together help.`
      : `Your bond grows when you talk, play, pet, and say goodbye before quitting (up to ${a.todayLeft} more today). Unkindness, too much throwing, and long absences make it shrink.`;
    const n = c.counters || {};
    $('#cp-stats').innerHTML = `${esc(togetherText())}<br>${n.talks || 0} conversations · ${n.games || 0} games (${n.wins || 0} won)<br>${c.topics.seen} of ${c.topics.total} topics heard`;
    $('#cp-pet-name').textContent = state.names.petName;
    const tierIndex = c.tiers.findIndex((t) => t.name === a.tier);
    $('#cp-ladder').innerHTML = c.tiers.map((t, i) => `<div class="rung${t.reached ? ' reached' : ''}${i === tierIndex ? ' current' : ''}"><div class="h">${i === 0 ? '🤝' : '♥'.repeat(i)}</div>${esc(t.name)}</div>`).join('');
    const s = c.settings;
    segmented($('#cp-water'), c.choices.water, s.water, (v) => (v ? `${v} min` : 'Off'), 'water');
    const w = c.water || {};
    const sips = (n) => `${n} sip${n === 1 ? '' : 's'}`;
    $('#cp-water-log').textContent = w.breaks
      ? `Today: ${sips(w.today)} over ${w.breaksToday} break${w.breaksToday === 1 ? '' : 's'} · ${sips(w.total)} all time. Log one any time: Talk → Tell ${state.names.petName}… → I took a water break.`
      : `After a water reminder, click ${state.names.petName} and say how many sips you took (or Talk → Tell ${state.names.petName}… → I took a water break).`;
    segmented($('#cp-breaks'), c.choices.breaks, s.breaks, (v) => (v ? `${v} min` : 'Off'), 'breaks');
    segmented($('#cp-chatter'), c.choices.chatter, s.chatter, (v) => v[0].toUpperCase() + v.slice(1), 'chatter');
    document.querySelectorAll('.switch-btn[data-companion]').forEach((sw) => sw.classList.toggle('on', !!s[sw.dataset.companion]));
    const bday = c.memories.find((m) => m.key === 'birthday');
    if (bday && document.activeElement.tagName !== 'SELECT') {
      const m = MONTHS.indexOf(bday.value.split(' ')[0]) + 1;
      if (m) { $('#cp-bday-month').value = m; $('#cp-bday-day').value = Number(bday.value.split(' ')[1]); }
    }
    const list = $('#cp-memories');
    list.innerHTML = '';
    const items = c.memories.filter((m) => m.key !== 'birthday');
    if (!items.length) list.appendChild(el('div', 'empty', `Nothing yet. ${state.names.petName} asks about you in conversations, or pick "Ask me about me" when you talk.`));
    for (const m of items) {
      const row = el('div', 'memory', `<div><div class="k">${esc(m.label)}</div><div class="v">${esc(m.value)}</div></div>`);
      const forget = el('button', '', '✕');
      forget.title = 'Forget this';
      forget.addEventListener('click', () => companion('forget', { key: m.key }));
      row.appendChild(forget);
      list.appendChild(row);
    }
  }

  // MARK: Rewards

  function wireRewards() {
    $('#prestige-btn').addEventListener('click', () => {
      const r = state.rank;
      $('#modal-emblem').textContent = r.nextEmblem;
      $('#modal-title').textContent = `Enter ${r.nextPrestigeTitle}?`;
      $('#modal-text').textContent = r.prestige + 1 >= 10
        ? `${state.names.petName} goes back to level 1 as a Prestige Master and can then level all the way to 1000. Every reward stays unlocked.`
        : `${state.names.petName} goes back to level 1 and earns a ${r.nextEmblem} prestige badge. Every reward stays unlocked.`;
      openModal({ ok: 'Prestige', cancel: 'Not yet', onOk: async () => { await call('prestige'); burstConfetti(); refresh(); } });
    });
    $('#modal-cancel').addEventListener('click', () => { $('#modal').hidden = true; });
    $('#modal-ok').addEventListener('click', () => { $('#modal').hidden = true; if (modalActions.ok) modalActions.ok(); });
    $('#modal-alt').addEventListener('click', () => { $('#modal').hidden = true; if (modalActions.alt) modalActions.alt(); });
    $('#badge-toggle').addEventListener('change', (e) => set('showPrestigeBadge', e.target.checked));
  }

  let lastRewards = '';
  function renderRewards() {
    const r = state.rank;
    $('#rw-rank').textContent = r.title;
    $('#rw-title').textContent = r.prestige >= 10 ? 'Prestige Master' : r.prestige ? r.prestigeTitle : 'Rewards';
    xpBar('#rw-xp-fill', '#rw-xp-text');
    $('#rw-hint').textContent = r.prestige >= 10
      ? `Level up to 1000. You're at ${r.level}.`
      : r.canPrestige ? 'You hit level 100! Prestige to start again with a badge. Every reward stays unlocked.'
        : `Prestige unlocks at level 100 (${r.xpToPrestige} XP to go).${r.prestige ? '' : ' Rewards you unlock stay yours after prestiging.'}`;
    $('#rw-emblem').textContent = r.emblem || '⭐';
    $('#prestige-btn').disabled = !r.canPrestige;
    $('#prestige-btn').textContent = r.prestige >= 10 ? '💎 Max prestige' : `⭐ Prestige → ${r.prestige + 1}`;
    $('#badge-toggle').checked = state.toggles.showPrestigeBadge;
    $('#badge-toggle').parentElement.style.visibility = r.prestige ? 'visible' : 'hidden';

    const key = JSON.stringify([state.eventPreview, state.rewards.map((x) => [x.id, x.unlocked, x.worn])]);
    if (key === lastRewards) return;
    lastRewards = key;
    const box = $('#reward-slots');
    box.innerHTML = '';
    for (const slot of state.slots) {
      box.appendChild(el('h3', '', esc(slot.title)));
      const grid = el('div', 'reward-grid');
      for (const rw of state.rewards.filter((x) => x.slot === slot.id)) {
        const card = el('div', `reward${rw.unlocked ? '' : ' locked'}${rw.worn ? ' worn' : ''}`);
        card.dataset.reward = rw.id;
        card.appendChild(el('canvas'));
        card.appendChild(el('div', 'name', esc(rw.title)));
        card.appendChild(el('div', 'lvl', rw.unlocked ? (rw.worn ? 'Click to take off' : 'Click to wear') : rw.event ? `${EVENT_NAMES[rw.event] || 'Event'} reward · click to ${state.eventPreview === false ? 'preview' : 'hide the preview'}` : `Unlocks at Lv ${rw.level}`));
        if (rw.unlocked || rw.event) card.addEventListener('click', () => call('wear', { id: rw.id }).then(() => { lastRewards = ''; refresh(); }));
        grid.appendChild(card);
      }
      box.appendChild(grid);
    }
  }

  // MARK: Look

  async function loadPack(name) {
    if (!name) return null;
    if (packs.has(name)) return packs.get(name);
    packs.set(name, null);
    try {
      const source = await call('pack', { name });
      for (const f of source.files) if (typeof f.data === 'string') f.data = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
      const pack = await SpritePack.load(source);
      packs.set(name, pack);
      return pack;
    } catch (_) {
      packs.set(name, false);
      return null;
    }
  }

  function wireLook() {
    $('#pack-import').addEventListener('click', () => call('importPack').then(refresh));
    $('#pack-export').addEventListener('click', () => call('exportPack'));
    $('#pack-folder').addEventListener('click', () => call('openSprites'));
    $('#look-bubble').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => set('thoughtBubble', b.dataset.value)));
    const size = $('#size');
    size.addEventListener('input', () => { $('#size-label').textContent = `${size.value}%`; });
    size.addEventListener('change', () => set('scale', Number(size.value) / 100));
    $('#size-resize').addEventListener('click', () => call('resize'));
    $('#size-reset').addEventListener('click', () => set('scale', 1));
  }

  function renderLook() {
    const look = state.look;
    const grid = $('#look-packs');
    grid.innerHTML = '';
    for (const name of ['', ...look.packs]) {
      const card = el('button', `pack${(look.spritePack || '') === name ? ' selected' : ''}`);
      card.dataset.pack = name;
      card.appendChild(el('canvas'));
      card.appendChild(el('span', 'name', esc(name || 'Mochi the cat')));
      card.addEventListener('click', () => set('spritePack', name));
      if (name) loadPack(name);
      grid.appendChild(card);
    }
    $('#pack-export').disabled = !look.spritePack;

    const sw = $('#look-swatches');
    sw.innerHTML = '';
    let matched = false;
    for (const hex of THEMES) {
      const b = el('button', `swatch${hex ? '' : ' classic'}`);
      if (hex) b.style.background = hex;
      b.title = hex || 'Classic';
      const on = (look.themeColor || '') === (hex || '');
      matched = matched || on;
      b.classList.toggle('selected', on);
      b.addEventListener('click', () => set('themeColor', hex || ''));
      sw.appendChild(b);
    }
    const custom = el('label', `swatch custom${matched ? '' : ' selected'}`);
    custom.title = 'Any color';
    const input = el('input');
    input.type = 'color';
    input.value = (look.themeColor || '#ff8fb1').toLowerCase();
    input.addEventListener('change', () => set('themeColor', input.value.toUpperCase()));
    custom.appendChild(input);
    sw.appendChild(custom);

    $('#look-bubble').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === look.thoughtBubble));
    if (document.activeElement !== $('#size')) {
      $('#size').value = Math.round(look.scale * 100);
      $('#size-label').textContent = `${Math.round(look.scale * 100)}%`;
    }
  }

  // MARK: Focus

  function wireFocus() {
    $('#focus-length').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      focusMinutes = Number(b.dataset.min);
      $('#focus-length').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      if (state.focus.phase === 'off') $('#focus-clock').textContent = `${focusMinutes}:00`;
    }));
    $('#focus-start').addEventListener('click', () => call('focusStart', { minutes: focusMinutes }).then(refresh));
    $('#focus-stop').addEventListener('click', () => call('focusStop').then(refresh));
    document.querySelectorAll('.switch-btn[data-key]').forEach((s) => s.addEventListener('click', () => set(s.dataset.key, !s.classList.contains('on'))));
    const add = () => {
      const v = $('#block-add').value.trim();
      if (!v) return;
      $('#block-add').value = '';
      set('blocklist', [...state.blocklist, v]);
    };
    $('#block-add-btn').addEventListener('click', add);
    $('#block-add').addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    $('#block-reset').addEventListener('click', () => set('blocklist', null));
  }

  function renderFocus() {
    const f = state.focus;
    const ring = $('#ring-fg');
    if (f.phase === 'off') {
      $('#focus-clock').textContent = `${focusMinutes}:00`;
      $('#focus-phase').textContent = 'Ready';
      ring.style.strokeDashoffset = 326.7;
    } else {
      const r = Math.ceil(f.remaining);
      $('#focus-clock').textContent = `${Math.floor(r / 60)}:${String(r % 60).padStart(2, '0')}`;
      $('#focus-phase').textContent = f.phase === 'focus' ? '🍅 Focusing' : '☕ Break';
      ring.style.strokeDashoffset = 326.7 * (f.remaining / Math.max(1, f.total));
    }
    $('#focus-start').disabled = f.phase !== 'off';
    $('#focus-stop').disabled = f.phase === 'off';
  }

  function renderBlocklist() {
    document.querySelectorAll('.switch-btn[data-key]').forEach((s) => s.classList.toggle('on', !!state[s.dataset.key]));
    const chips = $('#block-chips');
    chips.innerHTML = '';
    for (const site of state.blocklist) {
      const chip = el('span', 'chip-site', esc(site));
      const x = el('button', '', '✕');
      x.title = `Remove ${site}`;
      x.addEventListener('click', () => set('blocklist', state.blocklist.filter((s) => s !== site)));
      chip.appendChild(x);
      chips.appendChild(chip);
    }
    $('#block-note').textContent = state.platform === 'windows'
      ? 'Matched against the browser window title, in any browser.'
      : state.platform === 'linux' ? 'Matched against the browser window title (X11 sessions; Wayland doesn\'t share window titles).'
      : 'Reads the active tab in Safari, Chrome, Edge, Brave, Arc, Vivaldi, and Opera (macOS asks once per browser).';
  }

  // MARK: Agents

  function renderAgents() {
    const h = state.hooks;
    const providers = [
      { title: 'Claude Code', glyph: '✳', color: 'linear-gradient(135deg,#e08a6a,#c96442)', status: h.claudeLive ? 'live' : h.claudeInstalled ? 'waiting' : 'off', action: 'hooks', canConnect: true },
      { title: 'Kiro CLI', glyph: 'K', color: 'linear-gradient(135deg,#9d86ff,#6a4ff0)', status: h.kiroInstalled ? 'on' : 'off', action: 'kiro', canConnect: h.kiroSupported },
      { title: 'Codex', glyph: '◎', color: 'linear-gradient(135deg,#3a3a3a,#111)', status: 'auto' },
      { title: 'Amazon Q, Gemini, Cursor, …', glyph: '✦', color: 'linear-gradient(135deg,#4f8cf7,#9b72cb)', status: 'cpu' },
    ];
    const key = JSON.stringify([h, state.platform]);
    const box = $('#agent-providers');
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.innerHTML = '';
      for (const p of providers) {
        const row = el('div', 'provider');
        const badge = el('div', 'badge', p.glyph);
        badge.style.background = p.color;
        row.appendChild(badge);
        const desc = { live: 'Connected: exact states via hooks', waiting: 'Connected. Send Claude any message to say hi', on: 'Connected: exact states via hooks', off: 'Not connected', auto: 'Exact states, read automatically from its session log', cpu: 'Detected while running (from CPU use)' }[p.status];
        row.appendChild(el('div', '', `<div class="title">${esc(p.title)}</div><div class="desc">${esc(desc)}</div>`));
        if (p.action && p.canConnect !== false) {
          const on = p.status !== 'off';
          const b = el('button', on ? 'ghost-btn' : 'primary connect', on ? 'Disconnect' : 'Connect');
          b.addEventListener('click', () => call(p.action, { install: !on }).then(refresh));
          row.appendChild(b);
        } else {
          row.appendChild(el('span', `pill ${p.status === 'auto' ? 'live' : 'idle'}`, p.action ? 'Not available here' : 'Automatic'));
        }
        box.appendChild(row);
      }
    }
    sessionRows(state.sessions, $('#agent-sessions'));
  }

  // MARK: Behavior

  function renderBehavior() {
    const box = $('#behavior-toggles');
    box.className = 'toggles behavior';
    box.innerHTML = '';
    for (const [key, title, desc] of TOGGLES) {
      if (key === 'startAtLogin' && !state.toggles.startAtLoginSupported) continue;
      if (key === 'walkOnWindows' && state.toggles.walkOnWindowsSupported === false) continue;
      const row = el('div', `toggle${state.toggles[key] ? ' on' : ''}`);
      row.appendChild(el('div', 'icon', ICONS[key]));
      row.appendChild(el('div', '', `<div class="title">${esc(title)}</div><div class="desc">${esc(desc)}</div>`));
      row.appendChild(el('div', 'switch'));
      row.addEventListener('click', () => set(key, !state.toggles[key]));
      box.appendChild(row);
    }
    // Emergency hide: a system-wide shortcut that hides the pet and everything it shows until pressed again.
    const p = state.panicKey;
    if (p) {
      const row = el('div', 'toggle panic-row');
      row.appendChild(el('div', 'icon', '🙈'));
      row.appendChild(el('div', '', `<div class="title">Emergency hide</div><div class="desc">${p.ok ? 'Press it anywhere to hide the pet, bubbles, and windows; press again to bring them back'
        : '<span class="warn">That shortcut is taken by another app, so pick another one</span>'}</div>`));
      const seg = el('div', 'segmented');
      for (const o of p.options) {
        const b = el('button', o.id === p.id ? 'on' : '', esc(o.label));
        b.addEventListener('click', (e) => { e.stopPropagation(); set('panicKey', o.id); });
        seg.appendChild(b);
      }
      row.appendChild(seg);
      box.appendChild(row);
    }
  }

  let modalActions = {};
  /** Shows the modal (title/text/emblem already filled in) with up to two actions. */
  function openModal({ ok, alt, cancel, onOk, onAlt }) {
    modalActions = { ok: onOk, alt: onAlt };
    $('#modal-ok').textContent = ok;
    $('#modal-cancel').textContent = cancel || 'Cancel';
    $('#modal-alt').hidden = !alt;
    if (alt) $('#modal-alt').textContent = alt;
    $('#modal').hidden = false;
  }

  // MARK: Sync

  const PLATFORM_ICONS = { macOS: '💻', Windows: '🪟', Linux: '🐧' };
  let lastSync = '';

  function renderSync() {
    const s = state.sync;
    if (!s) return;
    const key = JSON.stringify(s);
    if (key === lastSync) return;
    lastSync = key;
    const box = $('#sync-box');
    box.innerHTML = '';
    if (!s.enabled) {
      box.appendChild(el('p', 'sub', 'Pick a folder your cloud drive already syncs. Each device keeps its own file there, so XP and stats add up across all of them, and names, settings, rewards, and prestige follow whichever device changed them last. Nothing goes through a server.'));
      const row = el('div', 'actions');
      for (const c of s.candidates) {
        const b = el('button', 'ghost-btn folder-btn', `<span>☁️ ${esc(c.name)}</span><small>${esc(c.path)}</small>`);
        b.addEventListener('click', () => startSync(c.path, c.name));
        row.appendChild(b);
      }
      const choose = el('button', s.candidates.length ? 'ghost-btn' : 'primary', s.candidates.length ? 'Choose another folder…' : 'Choose a synced folder…');
      choose.addEventListener('click', async () => { const r = await call('syncChoose'); if (r && r.path) startSync(r.path, r.path.split(/[\\/]/).pop()); });
      row.appendChild(choose);
      box.appendChild(row);
      return;
    }
    box.appendChild(el('div', 'sync-on', `<span class="dot-live"></span>Syncing through ${esc(s.folderName || s.folder)}${s.lastSync ? `<span class="muted"> · ${esc(s.lastSync)}</span>` : ''}`));
    if (s.error) box.appendChild(el('p', 'note error', esc(s.error)));
    const list = el('div', 'devices');
    for (const d of s.devices) {
      list.appendChild(el('div', 'device', `<span class="icon">${PLATFORM_ICONS[d.platform] || '🖥️'}</span>
        <div><div><b>${esc(d.name)}</b> ${d.me ? '<span class="me">THIS DEVICE</span>' : ''}</div><div class="meta">${esc(d.platform)} · ${d.xp} XP · updated ${esc(d.updated)}</div></div><span></span>`));
    }
    if (s.devices.length < 2) list.appendChild(el('div', 'empty', `Turn on sync on your other devices with the same folder and they'll show up here.`));
    box.appendChild(list);
    const packs = el('div', 'toggle-row', `<span>Keep sprite packs in the sync folder</span><div class="switch-btn${s.syncPacks ? ' on' : ''}"></div>`);
    packs.querySelector('.switch-btn').addEventListener('click', () => call('syncPacks', { on: !s.syncPacks }).then(refresh));
    box.appendChild(packs);
    const row = el('div', 'actions');
    const now = el('button', 'ghost-btn', '🔄 Sync now');
    now.addEventListener('click', () => call('syncNow').then(refresh));
    const off = el('button', 'ghost-btn', 'Turn off sync');
    off.addEventListener('click', () => call('syncDisable').then(refresh));
    row.appendChild(now);
    row.appendChild(off);
    box.appendChild(row);
  }

  /** If the folder already has progress from other devices, ask how to join. */
  async function startSync(path, name) {
    const found = await call('syncInspect', { path });
    if (!found.devices || !found.localXP) {
      await call('syncEnable', { path, mode: 'merge' });
      return refresh();
    }
    $('#modal-emblem').textContent = '☁️';
    $('#modal-title').textContent = `Join sync in ${name}?`;
    $('#modal-text').textContent = `${found.names.join(', ')} already ${found.devices === 1 ? 'has' : 'have'} ${found.xp} XP there, and this device has ${found.localXP} XP. `
      + 'Combine adds them together. If you already moved this progress with a transfer key, use the synced progress instead so nothing counts twice (this device\'s stats are backed up).';
    openModal({
      ok: 'Combine', alt: 'Use synced progress', cancel: 'Cancel',
      onOk: () => call('syncEnable', { path, mode: 'merge' }).then(refresh),
      onAlt: () => call('syncEnable', { path, mode: 'fresh' }).then(refresh),
    });
  }

  // MARK: Insights (charts follow the dataviz rules: one series per chart, one axis, hover values, labels never color-only)

  const BAR = '#e85d3a';
  const MOODS = [
    { id: 'rough', emoji: '😢', label: 'Rough', color: '#d03b3b' },
    { id: 'tiring', emoji: '🥱', label: 'Tiring', color: '#f0a39c' },
    { id: 'okay', emoji: '😐', label: 'Okay', color: '#e4e1db' },
    { id: 'good', emoji: '🙂', label: 'Good', color: '#86b6ef' },
    { id: 'amazing', emoji: '🤩', label: 'Amazing', color: '#2a78d6' },
  ];
  const EVENT_NAMES = { halloween: '🎃 Halloween', winter: '❄️ Winter', valentine: '💕 Valentine' };
  let lastInsights = '';

  const dayLabel = (d, opts) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, opts || { weekday: 'short', month: 'short', day: 'numeric' });

  function tip(e, html) {
    const t = $('#chart-tip');
    if (!html) { t.hidden = true; return; }
    t.innerHTML = html;
    t.hidden = false;
    const r = $('#content').getBoundingClientRect();
    t.style.left = `${Math.min(e.clientX - r.left + 12, r.width - 190)}px`;
    t.style.top = `${e.clientY - r.top + $('#content').scrollTop + 14}px`;
  }

  /** A small single-series bar chart: 14 days, baseline at 0, 4px rounded tops, 2px gaps, hover for values. */
  function barChart(title, days, value, format) {
    const card = el('div', 'card chart');
    const values = days.map(value);
    const max = Math.max(1, ...values);
    const total = values.reduce((a, b) => a + b, 0);
    card.appendChild(el('div', 'chart-head', `<span class="chart-title">${esc(title)}</span><span class="chart-total">${esc(format(total))} total</span>`));
    const W = 300, H = 92, pad = 2, bw = (W - pad * (days.length - 1)) / days.length;
    const bars = values.map((v, i) => {
      const h = v ? Math.max(3, (v / max) * (H - 14)) : 0;
      const x = i * (bw + pad);
      const y = H - h;
      const r = Math.min(4, h, bw / 2);
      return `<g data-i="${i}"><rect class="hit" x="${x}" y="0" width="${bw + pad}" height="${H}"></rect>${h ? `<path d="M${x},${H} V${y + r} q0,-${r} ${r},-${r} h${bw - 2 * r} q${r},0 ${r},${r} V${H} Z" fill="${BAR}"></path>` : ''}</g>`;
    }).join('');
    card.insertAdjacentHTML('beforeend', `<svg class="bars" viewBox="0 0 ${W} ${H + 16}" role="img" aria-label="${esc(title)}, last 14 days">
      <line x1="0" x2="${W}" y1="${H}" y2="${H}" class="baseline"></line>${bars}
      <text x="0" y="${H + 13}" class="axis">${esc(dayLabel(days[0].day, { month: 'short', day: 'numeric' }))}</text>
      <text x="${W}" y="${H + 13}" class="axis" text-anchor="end">Today</text></svg>`);
    card.querySelectorAll('g[data-i]').forEach((g) => {
      const i = Number(g.dataset.i);
      g.addEventListener('mousemove', (e) => tip(e, `<b>${esc(dayLabel(days[i].day))}</b><br>${esc(format(values[i]))}`));
      g.addEventListener('mouseleave', () => tip(null));
    });
    return card;
  }

  function renderInsights() {
    const history = state.history || [];
    const c = state.companion || {};
    const key = JSON.stringify([history, c.days, c.journal]);
    if (key === lastInsights || !history.length) return;
    lastInsights = key;
    const engineDays = new Map((c.days || []).map((d) => [d.day, d]));
    // 14 days, oldest first, with the engine's per-day numbers merged in.
    const days = history.slice(-14).map((h) => ({ ...h, ...(engineDays.get(h.day) || {}), day: h.day }));
    const today = days.length - 1;
    const weekday = (new Date().getDay() + 6) % 7; // Monday = 0
    const thisWeek = days.slice(Math.max(0, today - weekday));
    const lastWeek = days.slice(Math.max(0, today - weekday - 7), Math.max(0, today - weekday)).slice(0, thisWeek.length);
    const sum = (list, f) => list.reduce((a, d) => a + (f(d) || 0), 0);
    const tiles = [
      ['Time together', (d) => d.activeMinutes, hm],
      ['Agents working', (d) => d.agentMinutes, hm],
      ['Focus sessions', (d) => d.focusSessions, String],
      ['Sips of water', (d) => d.sips, String],
    ];
    $('#in-tiles').innerHTML = tiles.map(([label, f, fmt]) => {
      const now = sum(thisWeek, f);
      const before = sum(lastWeek, f);
      const diff = now - before;
      const delta = !lastWeek.length || (!now && !before) ? '' : diff === 0 ? '<div class="delta">same as last week</div>'
        : `<div class="delta ${diff > 0 ? 'up' : 'down'}">${diff > 0 ? '▲' : '▼'} ${esc(fmt(Math.abs(diff)))} vs last week</div>`;
      return `<div class="tile"><div class="num">${esc(fmt(now))}</div><div class="lbl">${esc(label)}</div>${delta}</div>`;
    }).join('');
    const charts = $('#in-charts');
    charts.innerHTML = '';
    charts.appendChild(barChart('Time together', days, (d) => d.activeMinutes || 0, hm));
    charts.appendChild(barChart('Agents working', days, (d) => d.agentMinutes || 0, hm));
    charts.appendChild(barChart('Focus sessions', days, (d) => d.focusSessions || 0, (n) => `${n} session${n === 1 ? '' : 's'}`));
    charts.appendChild(barChart('Sips of water', days, (d) => d.sips || 0, (n) => `${n} sip${n === 1 ? '' : 's'}`));

    // Mood calendar: the last 6 weeks, Monday first; emoji in every cell so mood never rests on color alone.
    const journal = c.journal || {};
    const cal = $('#in-moods');
    cal.innerHTML = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('');
    const start = new Date();
    start.setHours(12, 0, 0, 0);
    start.setDate(start.getDate() - weekday - 35);
    for (let i = 0; i < 42; i++) {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      const id = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const future = d > new Date();
      const e = journal[id];
      const m = e && MOODS.find((x) => x.id === e.mood);
      const cell = el('div', `cell${future ? ' future' : ''}${m ? '' : ' empty'}`, m ? m.emoji : '');
      if (m) cell.style.background = m.color;
      cell.addEventListener('mousemove', (ev) => tip(ev, `<b>${esc(dayLabel(id))}</b><br>${m ? `${m.emoji} ${esc(m.label)}` : 'No entry'}${e && e.note ? `<br>"${esc(e.note)}"` : ''}`));
      cell.addEventListener('mouseleave', () => tip(null));
      cal.appendChild(cell);
    }
    $('#in-mood-legend').innerHTML = MOODS.map((m) => `<span><i style="background:${m.color}"></i>${m.emoji} ${m.label}</span>`).join('')
      + (Object.keys(journal).length ? '' : `<span class="muted">${esc(state.names.petName)} asks every evening.</span>`);
  }

  // MARK: Gifts

  let lastGifts = '';
  function wireGifts() {
    const make = async () => {
      const r = await call('giftMake', { name: $('#gift-name').value });
      $('#gift-note').textContent = r && r.ok ? `Made ${r.file} 🎁 Now give it from the talk window.` : (r && r.error) || "Couldn't make that gift file";
      if (r && r.ok) $('#gift-name').value = '';
    };
    $('#gift-make').addEventListener('click', make);
    $('#gift-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') make(); });
    $('#gift-folder').addEventListener('click', () => call('giftsFolder'));
  }

  function renderGifts() {
    const g = state.companion && state.companion.gifts;
    if (!g) return;
    const key = JSON.stringify(g);
    if (key === lastGifts) return;
    lastGifts = key;
    const box = $('#gift-list');
    box.innerHTML = '';
    if (!g.unlocked) box.appendChild(el('div', 'empty', `🔒 ${esc(state.names.petName)} accepts gifts once you're ${esc(g.tier)}.`));
    else if (g.ideas.length) box.appendChild(el('div', 'empty', `Ideas: ${g.ideas.map(esc).join(', ')}…`));
    for (const r of g.received) {
      box.appendChild(el('div', 'memory', `<div><div class="k">${esc(dayLabel(r.first))}${r.count > 1 ? ` · ×${r.count}` : ''}</div><div class="v">🎁 ${esc(r.name)}</div></div>`));
    }
  }

  // MARK: Check-ins and needs

  let lastCheckins = '';
  function wireCheckins() {
    const every = $('#ci-every');
    for (const v of [0, 15, 20, 30, 45, 60, 90, 120]) every.add(new Option(v ? `${v} min of activity` : 'Only at a time', v));
    every.value = '60';
    const kind = () => document.querySelectorAll('.ci-count').forEach((n) => { n.hidden = $('#ci-kind').value !== 'count'; });
    $('#ci-kind').addEventListener('change', kind);
    kind();
    $('#ci-add').addEventListener('click', async () => {
      const title = $('#ci-title').value.trim();
      const sentence = $('#ci-sentence').value.trim();
      if (!title) { $('#ci-note').textContent = 'Give it a name'; return; }
      if ($('#ci-kind').value === 'count' && !sentence.includes('__')) { $('#ci-note').textContent = 'Put __ where the number goes'; return; }
      const after = sentence.split('__')[1] || '';
      await companion('checkinAdd', {
        emoji: $('#ci-emoji').value.trim() || '✅', title, kind: $('#ci-kind').value, sentence, unit: after.trim().split(' ')[0] || '',
        target: Number($('#ci-target').value) || 1, every: Number($('#ci-every').value), at: $('#ci-at').value,
      });
      $('#ci-title').value = '';
      $('#ci-sentence').value = '';
      $('#ci-note').textContent = 'Added ✓';
    });
  }

  function renderCheckins() {
    const c = state.companion;
    if (!c || !c.checkins) return;
    const key = JSON.stringify(c.checkins);
    if (key === lastCheckins) return;
    lastCheckins = key;
    const box = $('#cp-checkins');
    box.innerHTML = '';
    for (const ci of c.checkins) {
      const row = el('div', 'checkin');
      const today = ci.todayCount ? (ci.kind === 'count' ? `today: ${ci.today}${ci.unit ? ` ${ci.unit}` : ''}` : `done ${ci.todayCount}× today`) : '';
      row.appendChild(el('div', 'ci-name', `<span class="ci-emoji">${esc(ci.emoji)}</span><div><b>${esc(ci.title)}</b><div class="meta">${esc(ci.at && !ci.every ? `every day at ${ci.at}` : `every ${ci.every} min of activity`)}${today ? ` · ${esc(today)}` : ''}</div></div>`));
      const every = el('select', 'ci-every');
      for (const v of c.checkinEvery || []) every.add(new Option(v ? `${v} min` : 'At a time', v));
      every.value = String(ci.every);
      every.addEventListener('change', () => companion('checkinSet', { id: ci.id, patch: { every: Number(every.value) } }));
      row.appendChild(every);
      if (!ci.builtin) {
        const rm = el('button', 'ci-remove', '✕');
        rm.title = 'Remove';
        rm.addEventListener('click', () => companion('checkinRemove', { id: ci.id }));
        row.appendChild(rm);
      } else row.appendChild(el('span'));
      const sw = el('div', `switch-btn${ci.enabled ? ' on' : ''}`);
      sw.addEventListener('click', () => companion('checkinSet', { id: ci.id, patch: { enabled: !ci.enabled } }));
      row.appendChild(sw);
      box.appendChild(row);
    }
  }

  let lastNeeds = '';
  function renderNeeds() {
    const n = state.companion && state.companion.needs;
    if (!n) return;
    const key = JSON.stringify(n);
    if (key === lastNeeds) return;
    lastNeeds = key;
    const box = $('#cp-needs');
    box.innerHTML = '';
    const toggle = el('div', 'toggle-row', `<span>⚡ Energy and fun meters<small class="muted">Breaks restore energy, playing restores fun. Nothing bad happens if they run low.</small></span><div class="switch-btn${n.enabled ? ' on' : ''}"></div>`);
    toggle.querySelector('.switch-btn').addEventListener('click', () => companion('setting', { key: 'needs', value: !n.enabled }));
    box.appendChild(toggle);
    if (!n.enabled) return;
    const meter = (label, v) => `<div class="meter"><span>${label}</span><div class="meter-track"><div style="width:${v}%"></div></div><b>${v}</b></div>`;
    box.appendChild(el('div', 'meters', meter('⚡ Energy', n.energy) + meter('🎈 Fun', n.fun)));
    const shop = el('div', 'actions');
    shop.appendChild(el('span', 'coins', '🪙 ∞'));
    for (const t of n.treats) {
      const b = el('button', 'ghost-btn', `${t.emoji} ${esc(t.title)}`);
      b.title = [t.energy && `+${t.energy} energy`, t.fun && `+${t.fun} fun`].filter(Boolean).join(', ');
      b.addEventListener('click', () => companion('buyTreat', { id: t.id }));
      shop.appendChild(b);
    }
    box.appendChild(shop);
    box.appendChild(el('p', 'note', "Coins never run out, so treats are always there. Your pet gets full if you feed it more than a few in a row."));
  }

  // MARK: Quiet hours and calendar

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let lastQuiet = '';
  function renderQuiet() {
    const q = state.quietHours;
    if (!q) return;
    const key = JSON.stringify(q);
    const focused = document.activeElement && document.activeElement.closest && document.activeElement.closest('#bh-quiet');
    if (key === lastQuiet || focused) return;
    lastQuiet = key;
    const save = (patch) => set('quietHours', { enabled: q.enabled, days: q.days, from: q.from, to: q.to, notifications: q.notifications, ...patch });
    const box = $('#bh-quiet');
    box.innerHTML = '';
    const on = el('div', 'toggle-row', `<span>No remarks or sounds on a schedule${q.active ? '<small class="ok-text">On right now</small>' : ''}</span><div class="switch-btn${q.enabled ? ' on' : ''}"></div>`);
    on.querySelector('.switch-btn').addEventListener('click', () => save({ enabled: !q.enabled }));
    box.appendChild(on);
    const row = el('div', 'row-inline quiet-row');
    const days = el('div', 'day-chips');
    DAY_NAMES.forEach((name, i) => {
      const b = el('button', q.days.includes(i) ? 'on' : '', name);
      b.addEventListener('click', () => save({ days: q.days.includes(i) ? q.days.filter((x) => x !== i) : [...q.days, i].sort() }));
      days.appendChild(b);
    });
    row.appendChild(days);
    const from = el('input');
    from.type = 'time';
    from.value = q.from;
    const to = el('input');
    to.type = 'time';
    to.value = q.to;
    from.addEventListener('change', () => save({ from: from.value || '09:00' }));
    to.addEventListener('change', () => save({ to: to.value || '17:00' }));
    row.appendChild(el('span', 'field-label', 'from'));
    row.appendChild(from);
    row.appendChild(el('span', 'field-label', 'to'));
    row.appendChild(to);
    box.appendChild(row);
    const notif = el('div', 'toggle-row', `<span>Still show agent notifications</span><div class="switch-btn${q.notifications ? ' on' : ''}"></div>`);
    notif.querySelector('.switch-btn').addEventListener('click', () => save({ notifications: !q.notifications }));
    box.appendChild(notif);
  }

  let lastCalendar = '';
  function renderCalendar() {
    const c = state.calendar;
    if (!c) return;
    const key = JSON.stringify(c);
    if (key === lastCalendar || (document.activeElement && document.activeElement.id === 'cal-ics')) return;
    lastCalendar = key;
    const save = (patch) => set('calendar', { source: c.source, icsUrl: c.icsUrl, lead: c.lead, ...patch });
    const box = $('#bh-calendar');
    box.innerHTML = '';
    box.appendChild(el('p', 'sub', `${esc(state.names.petName)} warns you before meetings and can open the meeting link. Event titles stay on this computer.`));
    const sources = el('div', 'segmented');
    const options = [['off', 'Off'], ...(c.system ? [['system', state.platform === 'mac' ? 'Calendar app' : 'Outlook']] : []), ['ics', 'Calendar link (ICS)']];
    for (const [id, label] of options) {
      const b = el('button', c.source === id ? 'on' : '', esc(label));
      b.addEventListener('click', () => save({ source: id }));
      sources.appendChild(b);
    }
    box.appendChild(sources);
    if (c.source === 'ics') {
      const url = el('input', 'wide-input');
      url.id = 'cal-ics';
      url.placeholder = 'https://…/calendar.ics';
      url.value = c.icsUrl || '';
      url.addEventListener('change', () => save({ icsUrl: url.value.trim() }));
      box.appendChild(el('div', 'row-inline')).appendChild(url);
    }
    if (c.source !== 'off') {
      const lead = el('div', 'setting-row', '<span>Warn me</span>');
      const seg = el('div', 'segmented');
      for (const m of [1, 5, 10, 15]) {
        const b = el('button', c.lead === m ? 'on' : '', `${m} min before`);
        b.addEventListener('click', () => save({ lead: m }));
        seg.appendChild(b);
      }
      lead.appendChild(seg);
      box.appendChild(lead);
      const time = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      const status = c.status === 'ok' ? (c.next ? `Next: ${c.next.title} at ${time(c.next.start)}` : 'Connected. No more meetings today.')
        : c.status === 'denied' ? 'DeskPet needs calendar access: allow it in System Settings → Privacy & Security → Calendars.'
          : c.status && c.status !== 'off' ? c.status : '';
      const row = el('div', 'actions');
      const note = el('span', `note ${c.status === 'ok' ? 'ok' : c.status === 'off' ? '' : 'error'}`, esc(status));
      row.appendChild(note);
      const test = el('button', 'ghost-btn', 'Check now');
      test.addEventListener('click', async () => {
        const r = await call('calendarTest');
        lastCalendar = '';
        if (r && !r.ok && r.error) note.textContent = r.error;
        refresh();
      });
      row.appendChild(test);
      box.appendChild(row);
    }
  }

  // MARK: Seasonal events

  function renderEvent() {
    const e = state.events && state.events.active;
    const b = $('#home-event');
    b.hidden = !e;
    if (!e) return;
    const pct = Math.min(100, Math.round((e.minutes / e.goal) * 100));
    b.innerHTML = e.earned ? `${esc(e.emoji)} ${esc(e.title)} event: outfit earned! Wear it from Rewards ✨`
      : `${esc(e.emoji)} ${esc(e.title)} event until ${esc(dayLabel(`2000-${e.until}`, { month: 'short', day: 'numeric' }))}: <b>${Math.floor(e.minutes)}/${e.goal} min</b> together to earn the outfit <span class="event-bar"><i style="width:${pct}%"></i></span>`;
  }

  // MARK: Gallery

  function wireGallery() {
    $('#gallery-open').addEventListener('click', async () => {
      const box = $('#look-gallery');
      box.hidden = false;
      box.innerHTML = '<div class="empty">Loading the gallery…</div>';
      const r = await call('galleryList');
      box.innerHTML = '';
      if (!r || !r.ok) { box.appendChild(el('div', 'note error', esc((r && r.error) || "Couldn't reach the gallery. Are you online?"))); return; }
      for (const p of r.packs) {
        const card = el('div', 'gallery-card');
        const img = el('img', 'gallery-preview');
        img.src = p.preview;
        img.alt = `${p.name} preview`;
        card.appendChild(img);
        card.appendChild(el('div', '', `<b>${esc(p.name)}</b><div class="meta">${esc(p.description || '')}${p.author ? ` · by ${esc(p.author)}` : ''}</div>`));
        const b = el('button', p.installed ? 'ghost-btn' : 'primary', p.installed ? 'Installed ✓' : 'Install');
        b.disabled = p.installed;
        b.addEventListener('click', async () => {
          b.textContent = 'Installing…';
          const x = await call('galleryInstall', { id: p.id });
          b.textContent = x && x.ok ? 'Installed ✓' : 'Try again';
          b.disabled = !!(x && x.ok);
          // Wear it straight away; the Character cards above switch back any time.
          if (x && x.ok) { lastStatic = ''; await set('spritePack', p.id); }
        });
        card.appendChild(b);
        box.appendChild(card);
      }
      if (!r.packs.length) box.appendChild(el('div', 'empty', 'No packs yet.'));
    });
  }

  // MARK: Trips

  let tripPick = null;
  let tripCopyApp = true;
  let tripBusy = false;
  let tripDone = null;
  let tripError = '';
  let lastTrips = '';

  function ago(ms) {
    const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
    return m < 60 ? `${m} min` : m < 36 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
  }

  function wireTrips() {
    // Drives come and go; refresh the list whenever the page is opened.
    document.querySelector('#sidebar button[data-page="trips"]').addEventListener('click', () => call('tripDrives').then((r) => {
      if (r && r.drives && state.trip) { state.trip.drives = r.drives; lastTrips = ''; renderTrips(); }
    }));
  }

  function tripButton(label, cls, onClick) {
    const b = el('button', cls, label);
    b.addEventListener('click', onClick);
    return b;
  }

  function renderTrips() {
    const t = state.trip;
    if (!t) return;
    const c = state.companion || {};
    const key = JSON.stringify([t, c.trips, state.names, tripPick, tripCopyApp, tripBusy, tripDone, tripError, t.away && Math.floor(Date.now() / 60000)]);
    if (key === lastTrips) return;
    lastTrips = key;
    const pet = esc(state.names.petName);
    const box = $('#trip-box');
    box.innerHTML = '';

    if (t.mode === 'visiting') {
      const v = t.visiting || {};
      $('#trip-emoji').textContent = '🗺️';
      $('#trip-eyebrow').textContent = 'Visiting';
      $('#trip-title').textContent = `${state.names.petName} is visiting ${v.host || 'this computer'}`;
      $('#trip-sub').textContent = `From ${v.homeName || 'home'}. Everything ${state.names.petName} earns here is saved to the drive and comes home with them.`;
      box.appendChild(el('p', 'sub', `When you're done, choose <b>Go home</b> (or quit DeskPet) before you eject the drive.`));
      box.appendChild(el('div', 'actions', '')).appendChild(tripButton('🏠 Go home', 'primary', () => call('quit')));
    } else if (t.mode === 'away') {
      const a = t.away || {};
      $('#trip-emoji').textContent = '🧳';
      $('#trip-eyebrow').textContent = 'On a trip';
      $('#trip-title').textContent = `${state.names.petName} is out with you`;
      $('#trip-sub').textContent = `On ${a.volume || 'your drive'} for ${a.leftAt ? ago(a.leftAt) : 'a bit'}. Plug the drive back in here and ${state.names.petName} comes home and asks about your day.`;
      const row = el('div', 'actions');
      if (a.present) {
        row.appendChild(tripButton(`🏠 Welcome ${pet} home`, 'primary', () => call('tripWelcome').then(refresh)));
        if (t.ejectable !== false) row.appendChild(tripButton('⏏️ Eject the drive', 'ghost-btn', () => call('tripEject').then(refresh)));
      }
      row.appendChild(tripButton(`Call ${pet} home without the drive…`, 'ghost-btn', () => {
        $('#modal-emblem').textContent = '🏠';
        $('#modal-title').textContent = `Call ${state.names.petName} home?`;
        $('#modal-text').textContent = `${state.names.petName} comes back right away. Anything from the trip stays on the drive and gets unpacked next time you plug it in here.`;
        openModal({ ok: 'Call home', cancel: 'Wait for the drive', onOk: () => call('tripCallHome').then(refresh) });
      }));
      box.appendChild(row);
    } else {
      $('#trip-emoji').textContent = '🧳';
      $('#trip-eyebrow').textContent = 'Trips';
      $('#trip-title').textContent = `Take ${state.names.petName} with you`;
      $('#trip-sub').textContent = `${state.names.petName} packs into a USB drive and leaves your screen. On another computer they can come out and keep you company. Plug the drive back in here and ${state.names.petName} comes home and asks how your day went.`;
      if (tripDone) {
        box.appendChild(el('div', 'sync-on', `<span class="dot-live"></span>${pet} is packed on ${esc(tripDone.name)}!`));
        box.appendChild(el('p', 'sub', tripDone.ejectable ? 'Eject the drive and take it with you.' : 'Take the folder with you, then bring it back here.'));
        return;
      }
      const drives = t.drives || [];
      if (tripPick && !drives.some((d) => d.path === tripPick.path) && !tripPick.custom) tripPick = null;
      if (!tripPick && drives.length) tripPick = drives[0];
      box.appendChild(el('h3', 'card-title', 'Pick a drive'));
      const list = el('div', 'actions');
      for (const d of drives) {
        const b = el('button', `ghost-btn folder-btn${tripPick && tripPick.path === d.path ? ' picked' : ''}`, `<span>💾 ${esc(d.name)}</span><small>${esc(d.path)}</small>`);
        b.addEventListener('click', () => { tripPick = d; renderTrips(); });
        list.appendChild(b);
      }
      if (tripPick && tripPick.custom) list.appendChild(el('button', 'ghost-btn folder-btn picked', `<span>📁 ${esc(tripPick.name)}</span><small>${esc(tripPick.path)}</small>`));
      list.appendChild(tripButton(drives.length ? 'Another folder…' : 'Choose a drive or folder…', 'ghost-btn', async () => {
        const r = await call('tripChooseFolder');
        if (r && r.path) { tripPick = { path: r.path, name: r.path.split(/[\\/]/).filter(Boolean).pop() || r.path, custom: true }; renderTrips(); }
      }));
      box.appendChild(list);
      if (!drives.length && !tripPick) box.appendChild(el('p', 'note', 'No USB drive found. Plug one in, or choose any folder.'));
      const copy = t.appCopy || {};
      if (copy.possible) {
        const row = el('div', 'toggle-row', `<span>Put DeskPet on the drive too${copy.size ? ` (${esc(copy.size)})` : ''}<small class="muted"> so ${pet} can come out on computers without DeskPet</small></span><div class="switch-btn${tripCopyApp ? ' on' : ''}"></div>`);
        row.querySelector('.switch-btn').addEventListener('click', () => { tripCopyApp = !tripCopyApp; renderTrips(); });
        box.appendChild(row);
      }
      const go = el('div', 'actions');
      const pack = tripButton(tripBusy ? 'Packing…' : `🧳 Pack ${pet}'s bag`, 'primary', async () => {
        if (!tripPick || tripBusy) return;
        tripBusy = true;
        tripError = '';
        renderTrips();
        const r = await call('tripTake', { path: tripPick.path, copyApp: !!(copy.possible && tripCopyApp) });
        tripBusy = false;
        if (r && r.ok) tripDone = { name: tripPick.name, ejectable: r.ejectable };
        else tripError = (r && r.error) || "couldn't pack the bag";
        renderTrips();
        refresh();
      });
      pack.disabled = !tripPick || tripBusy;
      go.appendChild(pack);
      if (tripError) go.appendChild(el('span', 'note error', esc(tripError)));
      box.appendChild(go);
    }
    if (t.mode !== 'home') tripDone = null;

    const visitors = $('#trip-visitors');
    visitors.innerHTML = '';
    for (const v of t.visitors || []) {
      const card = el('div', 'card visitor-card', `<div class="trip-emoji">🚪</div><div><b>${esc(v.pet)} is at the door!</b><div class="meta">Visiting from ${esc(v.homeName)}</div></div>`);
      card.appendChild(tripButton(`Let ${esc(v.pet)} out`, 'primary', () => call('tripLetOut', { path: v.path }).then(refresh)));
      visitors.appendChild(card);
    }

    const log = $('#trip-log');
    log.innerHTML = '';
    const trips = c.trips || [];
    if (!trips.length) log.appendChild(el('div', 'empty', `No trips yet. When ${pet} comes home, they'll ask about your day, and it shows up here.`));
    const MOOD_ICONS = { amazing: '🤩', 'pretty good': '🙂', okay: '😐', tiring: '🥱', rough: '😢' };
    for (const tr of trips) {
      const where = tr.places && tr.places.length ? ` · visited ${esc(tr.places.join(', '))}` : '';
      const day = new Date(`${tr.day}T12:00:00`);
      const when = isNaN(day) ? tr.day : day.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
      log.appendChild(el('div', 'device', `<span class="icon">${MOOD_ICONS[tr.mood] || '🧳'}</span>
        <div><div><b>${esc(when)}</b>${tr.activity ? ` · ${esc(tr.activity)}` : ''}</div><div class="meta">${hm(tr.minutes || 0)}${where}${tr.moment ? ` · "${esc(tr.moment)}"` : ''}</div></div><span></span>`));
    }
  }

  // MARK: Account & About

  function note(text, kind) { $('#acc-note').textContent = text; $('#acc-note').className = `note ${kind || ''}`; }

  function moveNote(text, kind) { $('#mv-note').textContent = text; $('#mv-note').className = `note ${kind || ''}`; }

  function wireAccount() {
    $('#mv-pack').addEventListener('click', async () => {
      const r = await call('movingPack');
      if (r && r.ok) moveNote(r.note || 'Packed! Open the file on your new computer 📦', r.note ? '' : 'ok');
      else if (r && r.error) moveNote(r.error, 'error');
    });
    $('#mv-open').addEventListener('click', async () => {
      const p = await call('movingOpen');
      if (!p || (!p.ok && !p.error)) return;
      if (!p.ok) return moveNote(p.error, 'error');
      $('#modal-emblem').textContent = '🏠';
      $('#modal-title').textContent = 'Move in?';
      $('#modal-text').textContent = `${p.summary}. This replaces the names, level, stats, memories, and settings on this device (a backup of the stats is kept).`;
      openModal({
        ok: 'Move in', cancel: 'Cancel',
        onOk: async () => {
          const r = await call('movingApply', { path: p.path });
          if (!r.ok) return moveNote(r.error, 'error');
          moveNote(r.note || 'Moved in! Welcome home ✨', r.note ? '' : 'ok');
          lastStatic = '';
          lastRewards = '';
          refresh();
        },
      });
    });
    $('#acc-save').addEventListener('click', () => call('rename', { petName: $('#acc-pet').value, ownerName: $('#acc-owner').value }).then(refresh));
    $('#acc-copy').addEventListener('click', async () => { await call('copy', { text: $('#acc-key').value }); $('#acc-copy').textContent = 'Copied! 📋'; setTimeout(() => { $('#acc-copy').textContent = 'Copy transfer key'; }, 1500); });
    $('#acc-save-key').addEventListener('click', () => call('saveKey', { key: $('#acc-key').value }));
    $('#acc-open-key').addEventListener('click', async () => { const r = await call('openKey'); if (r && r.key) $('#acc-import').value = r.key; });
    let confirmed = false;
    $('#acc-import').addEventListener('input', () => { confirmed = false; $('#acc-import-btn').textContent = 'Import'; note(''); });
    $('#acc-import-btn').addEventListener('click', async () => {
      if (!confirmed) {
        const p = await call('transferPreview', { key: $('#acc-import').value });
        if (!p.ok) return note(p.error, 'error');
        confirmed = true;
        $('#acc-import-btn').textContent = 'Replace and import';
        return note(`Found ${p.summary}. Click again to replace this device's data.`, 'ok');
      }
      const r = await call('transferImport', { key: $('#acc-import').value });
      if (!r.ok) return note(r.error, 'error');
      confirmed = false;
      $('#acc-import').value = '';
      $('#acc-import-btn').textContent = 'Import';
      note(r.note || 'Imported! Welcome home ✨', 'ok');
      lastStatic = '';
      lastRewards = '';
      refresh();
    });
  }

  function wireAbout() {
    $('#about-update-btn').addEventListener('click', async () => {
      if (state.update.available) return call('installUpdate');
      $('#about-update').textContent = 'Checking…';
      await call('checkUpdates');
      setTimeout(refresh, 2500);
    });
    $('#about-wizard').addEventListener('click', () => call('openWizard'));
    $('#about-quit').addEventListener('click', () => call('quit'));
  }

  // MARK: Pet previews

  function renderer(canvas) {
    if (!renderers.has(canvas)) renderers.set(canvas, new PetRenderer());
    return renderers.get(canvas);
  }

  function drawPet(canvas, w, h, pose, t, pack) {
    if (!canvas.clientWidth) return;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const r = renderer(canvas);
    r.lastSpriteRect = null;
    r.render(ctx, w, h, { look: { x: 0, y: 0 }, subagents: 0, theme: state.look.themeColor || null, ...pose }, t, pack);
  }

  const start = performance.now();
  function frame() {
    const t = (performance.now() - start) / 1000;
    if (state) {
      const pack = state.look.spritePack ? packs.get(state.look.spritePack) || null : null;
      const p = state.preview;
      const fit = (target) => (pack ? Math.min(2.2, target / pack.height) : target / 82);
      if (page === 'home') drawPet($('#hero-pet'), 220, 200, { ...p, mood: Math.floor(t / 4) % 3 === 2 ? 'petted' : 'idle', scale: fit(120) }, t, pack);
      drawPet($('#mini-pet'), 140, 120, { ...p, mood: 'idle', scale: fit(60), prestige: 0 }, t + 1, pack);
      if (page === 'about') drawPet($('#about-pet'), 160, 140, { ...p, mood: 'done', scale: fit(70) }, t, pack);
      if (page === 'rewards') {
        document.querySelectorAll('.reward[data-reward]').forEach((card) => {
          const rw = state.rewards.find((x) => x.id === card.dataset.reward);
          const pose = { mood: rw.slot === 'trail' ? 'walking' : 'idle', scale: fit(rw.slot === 'hat' ? 54 : 46), facingLeft: false };
          pose[rw.slot === 'golden' ? 'golden' : rw.slot] = rw.slot === 'golden' ? true : rw.value;
          drawPet(card.querySelector('canvas'), 150, 130, pose, t + rw.level, pack);
        });
      }
      if (page === 'look') {
        document.querySelectorAll('#look-packs .pack[data-pack]').forEach((card) => {
          const name = card.dataset.pack;
          const pk = name ? packs.get(name) : null;
          if (name && !pk) return;
          drawPet(card.querySelector('canvas'), 168, 144, { mood: card.classList.contains('selected') ? 'petted' : 'idle', scale: pk ? 92 / pk.height : 0.95 }, t + name.length, pk);
        });
      }
    }
    drawConfetti();
    requestAnimationFrame(frame);
  }

  // MARK: Confetti (prestige)

  let confetti = [];
  function burstConfetti() {
    const c = $('#confetti');
    const colors = ['#ff7a59', '#ff4f8b', '#9b7bff', '#4fc3f7', '#ffcc00', '#34c759'];
    confetti = Array.from({ length: 220 }, () => ({
      x: c.clientWidth / 2 + (Math.random() - 0.5) * 120, y: c.clientHeight * 0.35, vx: (Math.random() - 0.5) * 900, vy: -300 - Math.random() * 500,
      size: 5 + Math.random() * 6, spin: Math.random() * 8, rot: Math.random() * Math.PI, color: colors[(Math.random() * colors.length) | 0], life: 0,
    }));
  }

  let lastConfetti = performance.now();
  function drawConfetti() {
    const c = $('#confetti');
    const w = c.clientWidth, h = c.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastConfetti) / 1000);
    lastConfetti = now;
    confetti = confetti.filter((p) => p.life < 4 && p.y < h + 20);
    for (const p of confetti) {
      p.life += dt; p.vy += 700 * dt; p.vx *= 0.99; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.spin * dt;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - p.life / 4);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
  }

  // For automated screenshots.
  window.__panelShow = (name) => show(name);

  init();
})();
