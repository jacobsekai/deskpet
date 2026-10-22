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
  const ICONS = { wander: '🚶', gravity: '🪂', walkOnWindows: '🪟', quietInCalls: '🤫', notifications: '🔔', sounds: '🔊', autoUpdate: '⬆️', startAtLogin: '🚀' };
  const TOGGLES = [
    ['notifications', 'Notifications', 'When agents finish, need you, or error'],
    ['sounds', 'Sounds', 'Purrs, pops, and chimes'],
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
    wireRewards();
    wireLook();
    wireFocus();
    wireAccount();
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
    const staticKey = JSON.stringify([state.look, state.toggles, state.blocklist, state.blockDuringFocus, state.strictBlock, state.names]);
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
      row.appendChild(el('div', '', `<div class="title">${esc(s.name)}${s.project ? ` · ${esc(s.project)}` : ''}</div><div class="detail">${esc(s.detail)}${s.precise ? '' : ' (guessed)'}</div>`));
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
  }

  function renderHome() {
    const r = state.rank;
    $('#hero-rank').textContent = r.title;
    $('#hero-name').textContent = state.names.petName;
    xpBar('#hero-xp-fill', '#hero-xp-text');
    $('#hero-next').textContent = state.nextReward || '';
    $('#home-focus').textContent = state.focus.phase === 'off' ? '🍅 Focus 25 min' : `⏹ ${state.focus.label}`;
    const t = state.today;
    const tiles = [
      [hm(t.activeMinutes), 'with you'], [hm(t.agentMinutes), 'agents working'], [t.tasks, `task${t.tasks === 1 ? '' : 's'} finished`],
      [t.pets, `pet${t.pets === 1 ? '' : 's'}`], [t.focusSessions, `focus session${t.focusSessions === 1 ? '' : 's'}`], [t.blocked, 'distractions blocked'],
    ];
    $('#today').innerHTML = tiles.map(([n, l]) => `<div class="tile"><div class="num">${esc(n)}</div><div class="lbl">${esc(l)}</div></div>`).join('');
    sessionRows(state.sessions, $('#home-sessions'));
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
      $('#modal').hidden = false;
    });
    $('#modal-cancel').addEventListener('click', () => { $('#modal').hidden = true; });
    $('#modal-ok').addEventListener('click', async () => {
      $('#modal').hidden = true;
      await call('prestige');
      burstConfetti();
      refresh();
    });
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

    const key = JSON.stringify(state.rewards.map((x) => [x.id, x.unlocked, x.worn]));
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
        card.appendChild(el('div', 'lvl', rw.unlocked ? (rw.worn ? 'Click to take off' : 'Click to wear') : `Unlocks at Lv ${rw.level}`));
        if (rw.unlocked) card.addEventListener('click', () => call('wear', { id: rw.id }).then(refresh));
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
      const row = el('div', `toggle${state.toggles[key] ? ' on' : ''}`);
      row.appendChild(el('div', 'icon', ICONS[key]));
      row.appendChild(el('div', '', `<div class="title">${esc(title)}</div><div class="desc">${esc(desc)}</div>`));
      row.appendChild(el('div', 'switch'));
      row.addEventListener('click', () => set(key, !state.toggles[key]));
      box.appendChild(row);
    }
  }

  // MARK: Account & About

  function note(text, kind) { $('#acc-note').textContent = text; $('#acc-note').className = `note ${kind || ''}`; }

  function wireAccount() {
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
