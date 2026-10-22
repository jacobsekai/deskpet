// First-run setup wizard, shared by the macOS app (WKWebView) and the Windows app (Electron).
// Both hosts implement the same small `call(action, payload)` bridge.
(() => {
  const { Color } = window.DeskPetColor;

  // MARK: Bridge

  const pending = new Map();
  let seq = 0;
  window.__deskpetReply = (id, result) => {
    const resolve = pending.get(id);
    if (resolve) { pending.delete(id); resolve(result); }
  };
  const bridge = window.deskpetWizard || {
    call(action, payload = {}) {
      return new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        window.webkit.messageHandlers.deskpet.postMessage({ id, action, payload });
      });
    },
  };
  const call = (action, payload) => bridge.call(action, payload || {});

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const STEPS = ['welcome', 'names', 'look', 'agents', 'touches', 'done'];
  const THEMES = [null, '#FF8FB1', '#FF6B6B', '#FFB347', '#7BD389', '#4FC3F7', '#9C88FF', '#2B2D42'];
  const PROVIDERS = [
    { name: 'Claude', title: 'Claude Code', color: 'linear-gradient(135deg,#e08a6a,#c96442)', glyph: '✳', hooks: true },
    { name: 'Codex', title: 'Codex', color: 'linear-gradient(135deg,#3a3a3a,#111)', glyph: '◎', auto: true },
    { name: 'Kiro', title: 'Kiro CLI', color: 'linear-gradient(135deg,#9d86ff,#6a4ff0)', glyph: 'K', kiro: true },
    { name: 'Amazon Q', title: 'Amazon Q', color: 'linear-gradient(135deg,#7b6cf6,#3d2fb8)', glyph: 'Q' },
    { name: 'Gemini', title: 'Gemini CLI', color: 'linear-gradient(135deg,#4f8cf7,#9b72cb)', glyph: '✦' },
    { name: 'Cursor', title: 'Cursor Agent', color: 'linear-gradient(135deg,#444,#1b1b1b)', glyph: '▲' },
  ];

  let state = null;
  let step = 0;
  const packs = new Map(); // name -> SpritePack (null while loading / on failure)
  const renderer = new PetRenderer();
  let mouse = null;
  let hookUI = 'idle'; // idle | connecting | waiting | live | error
  let hookError = '';

  // MARK: Setup

  async function init() {
    state = await call('state');
    document.documentElement.style.setProperty('--titlebar-inset', state.chrome === 'native' ? '86px' : '18px');
    document.documentElement.style.setProperty('--close-display', state.chrome === 'native' ? 'none' : 'grid');
    document.documentElement.style.setProperty('--chrome-radius', state.chrome === 'native' ? '0' : '14px');
    hookUI = state.hooksLive ? 'live' : state.hooksInstalled ? 'waiting' : 'idle';

    $('#owner').value = state.ownerName;
    $('#petName').value = state.petName;
    for (const input of [$('#owner'), $('#petName')]) input.addEventListener('input', updateNames);
    updateNames();

    buildDots();
    buildPacks();
    buildSwatches();
    buildBubble();
    buildProviders();
    buildToggles();
    buildTips();
    applyAccent();

    document.querySelectorAll('[data-next]').forEach((b) => b.addEventListener('click', next));
    $('#next').addEventListener('click', next);
    $('#back').addEventListener('click', () => go(step - 1));
    $('#finish').addEventListener('click', () => call('finish', names()));
    $('#close').addEventListener('click', () => call('close'));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && step < STEPS.length - 1) next();
      if (e.key === 'Enter' && step === STEPS.length - 1) call('finish', names());
    });
    $('.stage').addEventListener('mousemove', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      mouse = { x: e.clientX - r.left, y: r.height - (e.clientY - r.top) };
    });
    $('.stage').addEventListener('mouseleave', () => { mouse = null; });

    if (state.spritePack) loadPack(state.spritePack);
    go(0);
    requestAnimationFrame(frame);
    setInterval(poll, 1500);
  }

  function names() {
    return {
      ownerName: $('#owner').value.trim() || state.ownerName,
      petName: $('#petName').value.trim() || 'Mochi',
    };
  }

  function updateNames() {
    const n = names();
    document.querySelectorAll('.pet-name').forEach((e) => { e.textContent = n.petName; });
    document.querySelectorAll('.owner-name').forEach((e) => { e.textContent = n.ownerName; });
  }

  // MARK: Navigation

  function next() { go(step + 1); }

  function go(target) {
    target = Math.max(0, Math.min(STEPS.length - 1, target));
    if (STEPS[step] === 'names' && target !== step) call('save', names());
    const panels = [...document.querySelectorAll('.panel')];
    panels.forEach((p, i) => {
      p.classList.toggle('active', i === target);
      p.classList.toggle('left', i < target);
    });
    step = target;
    const name = STEPS[step];
    $('#nav').classList.toggle('hidden', name === 'welcome' || name === 'done');
    $('#back').style.visibility = step <= 1 ? 'hidden' : 'visible';
    document.querySelectorAll('#dots span').forEach((d, i) => d.classList.toggle('on', i === step));
    if (name === 'names') setTimeout(() => $('#owner').focus(), 350);
    if (name === 'done') burstConfetti();
    poll();
  }

  function buildDots() {
    const dots = $('#dots');
    STEPS.forEach(() => dots.appendChild(el('span')));
  }

  // MARK: Look

  async function loadPack(name) {
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

  function buildPacks() {
    const grid = $('#packs');
    grid.innerHTML = '';
    for (const name of ['', ...state.packs]) {
      const card = el('button', 'pack');
      card.dataset.pack = name;
      const canvas = el('canvas');
      card.appendChild(canvas);
      card.appendChild(el('span', 'name', escape(name || 'Mochi the cat')));
      card.addEventListener('click', async () => {
        state.spritePack = name;
        grid.querySelectorAll('.pack').forEach((c) => c.classList.toggle('selected', c.dataset.pack === name));
        if (name) await loadPack(name);
        call('set', { key: 'spritePack', value: name });
      });
      if (name) loadPack(name);
      grid.appendChild(card);
    }
    const add = el('button', 'pack add', '<span class="plus">＋</span><span class="name">Add your own</span>');
    add.title = 'Opens the sprites folder: drop in images or a spritesheet';
    add.addEventListener('click', () => call('openSprites'));
    grid.appendChild(add);
    grid.querySelectorAll('.pack').forEach((c) => c.classList.toggle('selected', c.dataset.pack === (state.spritePack || '')));
  }

  function buildSwatches() {
    const box = $('#swatches');
    for (const hex of THEMES) {
      const s = el('button', `swatch${hex ? '' : ' classic'}`);
      s.title = hex || 'Classic';
      if (hex) s.style.background = hex;
      s.dataset.hex = hex || '';
      s.addEventListener('click', () => setTheme(hex || ''));
      box.appendChild(s);
    }
    const custom = el('label', 'swatch custom');
    custom.title = 'Any color';
    const input = el('input');
    input.type = 'color';
    input.addEventListener('input', () => setTheme(input.value.toUpperCase()));
    custom.appendChild(input);
    box.appendChild(custom);
    markSwatch();
  }

  function setTheme(hex) {
    state.themeColor = hex;
    markSwatch();
    applyAccent();
    call('set', { key: 'themeColor', value: hex });
  }

  function markSwatch() {
    let matched = false;
    document.querySelectorAll('.swatch').forEach((s) => {
      const on = s.dataset.hex !== undefined && s.dataset.hex === (state.themeColor || '');
      matched = matched || on;
      s.classList.toggle('selected', on);
    });
    document.querySelector('.swatch.custom').classList.toggle('selected', !matched);
  }

  /** The whole wizard picks up the theme color. */
  function applyAccent() {
    const c = Color.hex(state.themeColor || '');
    const root = document.documentElement.style;
    if (!c) {
      root.removeProperty('--accent');
      root.removeProperty('--accent-2');
      return;
    }
    root.setProperty('--accent', c.darkened(0.6).css());
    root.setProperty('--accent-2', c.blend(0.35, Color.hex('#9B7BFF')).darkened(0.5).css());
  }

  function buildBubble() {
    const seg = $('#bubble');
    seg.querySelectorAll('button').forEach((b) => {
      b.classList.toggle('on', b.dataset.value === state.thoughtBubble);
      b.addEventListener('click', () => {
        state.thoughtBubble = b.dataset.value;
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        call('set', { key: 'thoughtBubble', value: state.thoughtBubble });
      });
    });
  }

  // MARK: Agents

  function buildProviders() {
    const list = $('#providers');
    list.innerHTML = '';
    const badge = (p, cls = 'badge') => {
      const b = el('div', cls, p.glyph);
      b.style.background = p.color;
      return b;
    };

    const claude = PROVIDERS[0];
    const row = el('div', 'provider hero');
    row.appendChild(badge(claude));
    const text = el('div');
    text.appendChild(el('div', 'title', claude.title));
    text.appendChild(el('div', 'desc', hookDescription()));
    if (hookUI === 'error') text.appendChild(el('div', 'error', escape(hookError)));
    row.appendChild(text);
    if (hookUI === 'live') row.appendChild(el('span', 'pill live', '<span class="dot-live"></span>Live'));
    else if (hookUI === 'waiting') row.appendChild(el('span', 'pill waiting', '<span class="dot-live"></span>Waiting'));
    else {
      const b = el('button', 'primary connect', hookUI === 'connecting' ? 'Connecting…' : 'Connect');
      b.disabled = hookUI === 'connecting';
      b.addEventListener('click', connectClaude);
      row.appendChild(b);
    }
    list.appendChild(row);

    // Everything else is detected by process, so a compact grid is enough.
    const grid = el('div', 'others');
    for (const p of PROVIDERS.slice(1)) {
      const running = state.running.includes(p.name);
      const chip = el('div', `chip${running ? ' running' : ''}`);
      chip.appendChild(badge(p, 'badge small'));
      const t = el('div');
      t.appendChild(el('div', 'title', p.title));
      let status = running ? '<span class="dot-live"></span>Running now' : 'Noticed when it runs';
      if (p.kiro && !state.kiroInstalled && !running) status = 'Not connected';
      if (p.auto && !running) status = 'Exact states, automatic';
      if (p.kiro && state.kiroInstalled && !running) status = 'Connected ✓';
      t.appendChild(el('div', 'status', status));
      chip.appendChild(t);
      if (p.kiro && !state.kiroInstalled) {
        const b = el('button', 'mini', 'Connect');
        b.title = 'Adds DeskPet hooks to your Kiro CLI agents for exact states';
        b.addEventListener('click', async () => {
          b.textContent = '…';
          const r = await call('kiro', { install: true });
          if (r && r.ok) state.kiroInstalled = true;
          else b.textContent = 'No agents';
          if (r && r.ok) buildProviders();
        });
        chip.appendChild(b);
      }
      grid.appendChild(chip);
    }
    list.appendChild(grid);
  }

  function hookDescription() {
    switch (hookUI) {
      case 'live': return 'Connected: Mochi sees every thought, edit, and question';
      case 'waiting': return 'Connected! Send Claude Code any message to say hi';
      case 'connecting': return 'Adding DeskPet hooks to Claude Code…';
      default: return 'One click: adds hooks so Mochi sees exactly what Claude is doing';
    }
  }

  async function connectClaude() {
    hookUI = 'connecting';
    buildProviders();
    const result = await call('hooks', { install: true });
    if (result && result.ok) {
      hookUI = 'waiting';
    } else {
      hookUI = 'error';
      hookError = (result && result.error) || "Couldn't update Claude Code's settings";
    }
    buildProviders();
  }

  async function poll() {
    if (!state) return;
    const name = STEPS[step];
    if (name !== 'agents') return;
    const s = await call('status');
    const before = `${hookUI}|${state.running.join()}`;
    state.running = s.running;
    if (hookUI !== 'connecting' && hookUI !== 'error') hookUI = s.hooksLive ? 'live' : s.hooksInstalled ? 'waiting' : 'idle';
    if (`${hookUI}|${state.running.join()}` !== before) buildProviders();
  }

  // MARK: Touches & tips

  function buildToggles() {
    const box = $('#toggles');
    const items = [
      state.startAtLoginSupported && { key: 'startAtLogin', icon: '🚀', title: state.platform === 'windows' ? 'Start with Windows' : 'Open at login', desc: 'Starts when you sign in' },
      { key: 'notifications', icon: '🔔', title: 'Notifications', desc: 'When agents finish or need you' },
      { key: 'sounds', icon: '🔊', title: 'Sounds', desc: 'Purrs, pops, and chimes' },
      { key: 'walkOnWindows', icon: '🪟', title: 'Walk on windows', desc: 'Stands on and rides windows' },
      { key: 'wander', icon: '🚶', title: 'Wander around', desc: 'Takes little walks' },
      { key: 'gravity', icon: '🪂', title: 'Gravity', desc: 'Falls when dropped' },
      { key: 'quietInCalls', icon: '🤫', title: 'Quiet during calls', desc: 'Hush when mic/camera is on' },
      { key: 'autoUpdate', icon: '⬆️', title: 'Automatic updates', desc: 'From GitHub releases' },
    ].filter(Boolean);
    for (const item of items) {
      const row = el('div', `toggle${state[item.key] ? ' on' : ''}`);
      row.appendChild(el('div', 'icon', item.icon));
      const text = el('div');
      text.appendChild(el('div', 'title', item.title));
      text.appendChild(el('div', 'desc', item.desc));
      row.appendChild(text);
      row.appendChild(el('div', 'switch'));
      row.addEventListener('click', async () => {
        state[item.key] = !state[item.key];
        row.classList.toggle('on', state[item.key]);
        const r = await call('set', { key: item.key, value: state[item.key] });
        if (r && r.value !== undefined && r.value !== state[item.key]) {
          state[item.key] = r.value;
          row.classList.toggle('on', r.value);
        }
      });
      box.appendChild(row);
    }
  }

  function buildTips() {
    const home = state.platform === 'windows'
      ? 'Every option lives in the <kbd>system tray</kbd> (check the ^ arrow)'
      : 'Every option lives under <kbd>🐾</kbd> in the menu bar';
    const tips = [
      ['🐾', home],
      ['🫳', 'Drag me anywhere, or flick and let go to throw me'],
      ['🖱️', 'Right-click me for the menu, resize, and more'],
      ['🎨', 'Drop art into the sprites folder for a whole new look'],
    ];
    $('#tips').innerHTML = tips.map(([icon, text]) => `<li><span class="tip-icon">${icon}</span><span>${text}</span></li>`).join('');
  }

  // MARK: Animation

  function poseFor(t) {
    const n = names();
    const base = { look: lookAtMouse(), theme: state.themeColor || null, thoughtBubble: state.thoughtBubble, subagents: 0 };
    switch (STEPS[step]) {
      case 'welcome': return { ...base, mood: Math.floor(t / 3.2) % 2 ? 'petted' : 'done', bubble: `hi! I'm ${n.petName} 👋` };
      case 'names': return { ...base, mood: 'idle', bubble: `nice to meet you, ${n.ownerName}!` };
      case 'look': return { ...base, mood: 'thinking', caption: 'Claude: thinking…', captionColor: '#AF52DE' };
      case 'agents': return { ...base, mood: hookUI === 'live' ? 'typing' : hookUI === 'waiting' ? 'needsYou' : 'typing', caption: hookUI === 'live' ? 'Claude: writing code' : null, captionColor: '#007AFF', subagents: hookUI === 'live' ? 1 : 0 };
      case 'touches': return { ...base, mood: 'walking', facingLeft: Math.floor(t / 2.5) % 2 === 1 };
      default: return { ...base, mood: 'done', bubble: `let's go, ${n.ownerName}! ✨` };
    }
  }

  function lookAtMouse() {
    if (!mouse) return { x: 0, y: 0 };
    const stage = $('.stage').getBoundingClientRect();
    const dx = mouse.x - stage.width / 2, dy = mouse.y - 140;
    const d = Math.hypot(dx, dy) || 1;
    const f = Math.min(1, d / 150);
    return { x: (dx / d) * f, y: (dy / d) * f };
  }

  function sizeCanvas(canvas, w, h) {
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx;
  }

  const start = performance.now();
  const cardRenderer = new PetRenderer();

  function frame() {
    const t = (performance.now() - start) / 1000;
    const stage = $('#pet');
    const w = stage.clientWidth, h = stage.clientHeight;
    const ctx = sizeCanvas(stage, w, h);
    const pack = state.spritePack ? packs.get(state.spritePack) || null : null;
    const pose = poseFor(t);
    pose.scale = pack ? Math.min(2.2, 190 / pack.height) : 1.55;
    renderer.render(ctx, w, h, pose, t, pack);

    // Pack cards are rendered at 2x their CSS size, so the pet's ground margin shrinks to fit.
    document.querySelectorAll('.pack[data-pack]').forEach((card) => {
      const canvas = card.querySelector('canvas');
      const name = card.dataset.pack;
      const p = name ? packs.get(name) : null;
      const c = sizeCanvas(canvas, 168, 144);
      if (name && !p) { c.clearRect(0, 0, 168, 144); return; }
      cardRenderer.lastSpriteRect = null;
      const selected = card.classList.contains('selected');
      cardRenderer.render(c, 168, 144, {
        mood: selected ? 'petted' : 'idle', look: { x: 0, y: 0 }, scale: p ? 92 / p.height : 0.95, subagents: 0,
      }, t + name.length, p);
    });

    drawConfetti();
    requestAnimationFrame(frame);
  }

  // MARK: Confetti

  let confetti = [];
  function burstConfetti() {
    const canvas = $('#confetti');
    const w = canvas.clientWidth;
    const colors = ['#ff7a59', '#ff4f8b', '#9b7bff', '#4fc3f7', '#ffcc00', '#34c759'];
    confetti = Array.from({ length: 140 }, () => ({
      x: w / 2 + (Math.random() - 0.5) * 60, y: 150, vx: (Math.random() - 0.5) * 520, vy: -260 - Math.random() * 380,
      size: 4 + Math.random() * 5, spin: Math.random() * 6, rot: Math.random() * Math.PI, color: colors[(Math.random() * colors.length) | 0],
      life: 0,
    }));
  }

  let lastConfetti = performance.now();
  function drawConfetti() {
    const canvas = $('#confetti');
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const ctx = sizeCanvas(canvas, w, h);
    ctx.clearRect(0, 0, w, h);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastConfetti) / 1000);
    lastConfetti = now;
    confetti = confetti.filter((p) => p.life < 3.5 && p.y < h + 20);
    for (const p of confetti) {
      p.life += dt;
      p.vy += 620 * dt;
      p.vx *= 0.99;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.spin * dt;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - p.life / 3.5);
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
      ctx.restore();
    }
  }

  // For automated screenshots of each step.
  window.__wizardGo = (n) => go(n);

  init();
})();
