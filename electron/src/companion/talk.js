// The talk window, shared by the macOS app (WKWebView) and the Windows/Linux app (Electron).
// The conversation itself runs in the host's companion engine; this page shows its nodes and sends answers back.
(() => {
  const pending = new Map();
  let seq = 0;
  window.__deskpetReply = (id, result) => {
    const resolve = pending.get(id);
    if (resolve) { pending.delete(id); resolve(result); }
  };
  const bridge = window.deskpetTalk || {
    call(action, payload = {}) {
      return new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        window.webkit.messageHandlers.deskpet.postMessage({ id, action, payload });
      });
    },
  };
  const call = (action, payload) => bridge.call(action, payload || {});
  window.addEventListener('error', (e) => call('log', { message: `talk: ${e.message} @ ${e.lineno}:${e.colno}` }));
  window.addEventListener('unhandledrejection', (e) => call('log', { message: `talk: ${String(e.reason && e.reason.stack || e.reason)}` }));

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  let node = null;
  let typing = null;
  let busy = false;
  let accent = null;
  let lastHeight = 0;

  async function init() {
    const info = (await call('init')) || {};
    applyTheme(info.theme);
    $('#close').addEventListener('click', close);
    $('#text').addEventListener('click', skipTyping);
    $('#continue').addEventListener('click', () => send('next'));
    $('#answer').addEventListener('submit', (e) => { e.preventDefault(); submitAnswer(); });
    $('#answer-skip').addEventListener('click', () => send('input', { value: '' }));
    for (let m = 1; m <= 12; m++) $('#answer-month').add(new Option(MONTHS[m - 1], m));
    for (let d = 1; d <= 31; d++) $('#answer-day').add(new Option(d, d));
    document.addEventListener('keydown', onKey);
    open(info.start || null);
  }

  function applyTheme(hex) {
    if (!hex || !window.DeskPetColor) return;
    const c = window.DeskPetColor.Color.hex(hex);
    if (!c) return;
    accent = c.darkened(0.6).css();
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--accent-2', c.blend(0.35, window.DeskPetColor.Color.hex('#9B7BFF')).darkened(0.5).css());
  }

  async function open(topic) {
    const r = await call('open', { topic });
    show(r);
  }
  window.__talkOpen = (topic) => open(topic);

  async function send(action, payload) {
    if (busy) return;
    busy = true;
    try { show(await call(action, payload)); } finally { busy = false; }
  }

  function close() { call('close'); }

  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (!node || $('#game').hidden === false) return;
    if (typing && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); skipTyping(); return; }
    if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
    if ((e.key === 'Enter' || e.key === ' ') && node.kind === 'line') { e.preventDefault(); send('next'); return; }
    const n = Number(e.key);
    if (n >= 1 && n <= 9) {
      const btn = document.querySelectorAll('#choices .choice:not(.back)')[n - 1];
      if (btn) { e.preventDefault(); btn.click(); }
    }
  }

  // MARK: Showing a node

  function show(n) {
    if (!n) return;
    node = n;
    $('#speaker').textContent = n.speaker || '';
    if (n.affection) {
      const a = n.affection;
      $('#hearts').textContent = a.upset ? '💔' : '♥'.repeat(a.hearts) + '♡'.repeat(Math.max(0, a.maxHearts - a.hearts));
      $('#tier').textContent = a.tier;
      $('#bond').title = a.next ? `${a.tier}: ${Math.round(a.progress * 100)}% of the way to ${a.next}` : a.tier;
    }
    if (n.confetti) burstConfetti();
    if (n.kind === 'end') { setTimeout(close, 300); return; }
    if (n.kind === 'game') { startGame(n); return; }
    $('#game').hidden = true;
    $('#dialogue').hidden = false;
    clearControls();
    type(n.text || '', () => controls(n));
    resize();
  }

  function clearControls() {
    $('#choices').innerHTML = '';
    $('#choices').className = 'choices';
    $('#answer').hidden = true;
    $('#continue').hidden = true;
  }

  function type(text, done) {
    const p = $('#text');
    if (typing) clearInterval(typing.timer);
    let i = 0;
    const chars = [...text];
    p.innerHTML = '<span class="caret"></span>';
    const finish = () => {
      clearInterval(typing.timer);
      typing = null;
      p.textContent = text;
      done();
      resize();
    };
    typing = { finish, timer: setInterval(() => {
      i += 2;
      if (i >= chars.length) { finish(); return; }
      p.innerHTML = `${esc(chars.slice(0, i).join(''))}<span class="caret"></span>`;
    }, 28) };
    if (!chars.length) finish();
  }

  function skipTyping() { if (typing) typing.finish(); }

  function controls(n) {
    const box = $('#choices');
    if (n.kind === 'line') { $('#continue').hidden = false; $('#continue').focus(); return; }
    if (n.kind === 'ask') {
      if (n.choices.length <= 2 || n.choices.some((c) => c.length > 26)) box.classList.add('one');
      n.choices.forEach((label, index) => box.appendChild(choice(label, null, null, () => send('choose', { index }))));
      return;
    }
    if (n.kind === 'pickGift') {
      // The host opens a file picker for .gift files (in ~/.deskpet/gifts); the engine reacts to the file's name.
      box.classList.add('one');
      box.appendChild(choice('🎁 Choose a gift file…', 'Any file named like salmon_bento.gift', null, async () => {
        const r = await call('pickGift');
        if (r && r.file) send('gift', { file: r.file });
      }));
      box.appendChild(choice('Never mind', null, null, () => send('giftCancel')));
      return;
    }
    if (n.kind === 'input') {
      const date = n.input.kind === 'date';
      $('#answer').hidden = false;
      $('#answer-text').hidden = date;
      $('#answer-date').hidden = !date;
      $('#answer-text').value = '';
      $('#answer-text').placeholder = n.input.placeholder || '';
      // Fill-in-the-blank: "I took [ ] sips of water this water break".
      const number = n.input.kind === 'number';
      $('#answer').classList.toggle('fill-in', number || !!n.input.prefix);
      $('#answer-text').classList.toggle('blank', number);
      $('#answer-text').inputMode = number ? 'numeric' : 'text';
      $('#answer-text').maxLength = n.input.max || 40;
      for (const [id, text] of [['#answer-prefix', n.input.prefix], ['#answer-suffix', n.input.suffix]]) {
        $(id).hidden = !text;
        $(id).textContent = text || '';
      }
      if (date) {
        const now = new Date();
        $('#answer-month').value = now.getMonth() + 1;
        $('#answer-day').value = now.getDate();
        $('#answer-month').focus();
      } else $('#answer-text').focus();
      return;
    }
    if (n.kind === 'menu') {
      const m = n.menu;
      if (m.items.some((i) => i.label.length > 30) || m.items.length < 3) box.classList.add('one');
      for (const item of m.items) box.appendChild(choice(item.label, item.hint, item.badge, () => send('menu', { id: item.id })));
      if (m.locked) { const l = document.createElement('div'); l.className = 'locked'; l.textContent = m.locked; box.appendChild(l); }
      if (m.back) {
        const b = choice('← Back', null, null, () => send('menu', { id: m.back }));
        b.classList.add('back');
        box.appendChild(b);
      }
    }
  }

  function choice(label, hint, badge, onClick) {
    const b = document.createElement('button');
    b.className = 'choice';
    b.innerHTML = `${esc(label)}${hint ? `<span class="hint">${esc(hint)}</span>` : ''}${badge ? `<span class="badge">${esc(badge)}</span>` : ''}`;
    b.addEventListener('click', onClick);
    return b;
  }

  function submitAnswer() {
    if (!node || node.kind !== 'input') return;
    const value = node.input.kind === 'date'
      ? `${String($('#answer-month').value).padStart(2, '0')}-${String($('#answer-day').value).padStart(2, '0')}`
      : $('#answer-text').value;
    send('input', { value });
  }

  // MARK: Games

  async function startGame(n) {
    const game = window.DeskPetGames[n.game];
    if (!game) { send('game', { game: n.game, outcome: 'draw' }); return; }
    clearControls();
    $('#game').hidden = false;
    $('#arena').innerHTML = '';
    $('#text').textContent = n.text || '';
    const say = (text) => { $('#text').textContent = text; };
    const playing = game({ arena: $('#arena'), score: $('#score'), say, pet: n.speaker, words: n.words || [], accent });
    resize();
    const outcome = await playing;
    $('#game').hidden = true;
    $('#arena').innerHTML = '';
    $('#score').textContent = '';
    if (outcome === 'win') burstConfetti();
    send('game', { game: n.game, outcome });
  }

  // MARK: Window size

  /** Asks the host to fit the window to what's showing. */
  function resize() {
    requestAnimationFrame(() => {
      const header = $('#box').querySelector('header').offsetHeight;
      const game = $('#game').hidden ? 0 : $('#game').offsetHeight + 4;
      const inner = $('#text').offsetHeight + 10 + ($('#choices').scrollHeight || 0) + ($('#answer').hidden ? 0 : $('#answer').offsetHeight + 8) + ($('#continue').hidden ? 0 : 26);
      const h = Math.round(Math.min(560, Math.max(160, header + game + inner + 24 + 20)));
      if (Math.abs(h - lastHeight) > 2) { lastHeight = h; call('resize', { height: h }); }
    });
  }

  // MARK: Confetti

  let confetti = [];
  function burstConfetti() {
    const c = $('#confetti');
    const colors = ['#ff7a59', '#ff4f8b', '#9b7bff', '#4fc3f7', '#ffcc00', '#34c759'];
    confetti = Array.from({ length: 120 }, () => ({
      x: c.clientWidth / 2 + (Math.random() - 0.5) * 80, y: c.clientHeight * 0.3, vx: (Math.random() - 0.5) * 600, vy: -200 - Math.random() * 350,
      size: 4 + Math.random() * 5, spin: Math.random() * 8, rot: Math.random() * Math.PI, color: colors[(Math.random() * colors.length) | 0], life: 0,
    }));
    let last = performance.now();
    const frame = (now) => {
      const w = c.clientWidth, h = c.clientHeight, dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      confetti = confetti.filter((p) => p.life < 3 && p.y < h + 20);
      for (const p of confetti) {
        p.life += dt; p.vy += 600 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.spin * dt;
        ctx.save();
        ctx.globalAlpha = Math.max(0, 1 - p.life / 3);
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        ctx.restore();
      }
      if (confetti.length) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  // For automated screenshots: `window.__talkDemo(action, payload)` drives the window without clicks.
  window.__talkDemo = (action, payload) => send(action, payload);

  init();
})();
