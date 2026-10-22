// Mini-games for the talk window. Each one draws into `arena`, narrates through `say`, and resolves
// with "win", "lose", or "draw" from your side.
(() => {
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  // MARK: Rock, paper, scissors (first to three)

  async function rps({ arena, score, say, pet }) {
    const HANDS = { rock: '✊', paper: '✋', scissors: '✌️' };
    const BEATS = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
    let you = 0, them = 0;
    const picks = el('div', 'rps-picks');
    const mine = el('div', 'rps-pick', '❔');
    const theirs = el('div', 'rps-pick', '❔');
    picks.append(mine, el('div', 'rps-vs', 'VS'), theirs);
    const buttons = el('div', 'rps-buttons');
    arena.append(picks, buttons);
    const show = () => { score.textContent = `You ${you} · ${them} ${pet}`; };
    show();
    return new Promise((resolve) => {
      for (const [name, icon] of Object.entries(HANDS)) {
        const b = el('button', '', icon);
        b.title = name;
        b.addEventListener('click', async () => {
          buttons.querySelectorAll('button').forEach((x) => { x.disabled = true; });
          mine.textContent = '✊'; theirs.textContent = '✊';
          mine.className = theirs.className = 'rps-pick shake';
          await wait(520);
          const choice = pick(Object.keys(HANDS));
          mine.textContent = icon; theirs.textContent = HANDS[choice];
          mine.className = theirs.className = 'rps-pick';
          if (name === choice) say(pick(['Same! Again!', 'A tie! Go again!', 'Great minds think alike!']));
          else if (BEATS[name] === choice) { you++; mine.classList.add('won'); say(pick(['Nooo! You got me!', 'Hmph! Lucky!', 'Okay, okay, nice one!'])); }
          else { them++; theirs.classList.add('won'); say(pick(['Hehe, got you!', 'Point for me!', 'Did you see that coming?'])); }
          show();
          if (you === 3 || them === 3) { await wait(900); resolve(you === 3 ? 'win' : 'lose'); return; }
          buttons.querySelectorAll('button').forEach((x) => { x.disabled = false; });
        });
        buttons.appendChild(b);
      }
    });
  }

  // MARK: Tic-tac-toe (the pet plays well, but not perfectly)

  const LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
  const winner = (b) => {
    for (const l of LINES) if (b[l[0]] && b[l[0]] === b[l[1]] && b[l[0]] === b[l[2]]) return { mark: b[l[0]], line: l };
    return b.every(Boolean) ? { mark: 'draw', line: [] } : null;
  };
  function minimax(b, turn) {
    const w = winner(b);
    if (w) return { score: w.mark === 'X' ? 10 : w.mark === 'O' ? -10 : 0 };
    let best = { score: turn === 'X' ? -Infinity : Infinity, move: -1 };
    for (let i = 0; i < 9; i++) {
      if (b[i]) continue;
      b[i] = turn;
      const r = minimax(b, turn === 'X' ? 'O' : 'X');
      b[i] = null;
      if (turn === 'X' ? r.score > best.score : r.score < best.score) best = { score: r.score, move: i };
    }
    return best;
  }

  async function ttt({ arena, score, say, pet }) {
    const board = Array(9).fill(null);
    const grid = el('div', 'ttt');
    const cells = board.map((_, i) => {
      const b = el('button');
      b.addEventListener('click', () => play(i));
      grid.appendChild(b);
      return b;
    });
    arena.appendChild(grid);
    score.textContent = `You ⭕ · ❌ ${pet}`;
    let done, busy = false;
    const result = new Promise((r) => { done = r; });
    const draw = () => board.forEach((m, i) => {
      cells[i].innerHTML = m ? `<span class="mark">${m === 'O' ? '⭕' : '❌'}</span>` : '';
      cells[i].disabled = !!m || busy;
    });
    const finish = async (w) => {
      busy = true;
      draw();
      w.line.forEach((i) => cells[i].classList.add('win'));
      say(w.mark === 'O' ? 'You got three in a row!' : w.mark === 'X' ? 'Three in a row! Hehe!' : "It's full! A tie!");
      await wait(1100);
      done(w.mark === 'O' ? 'win' : w.mark === 'X' ? 'lose' : 'draw');
    };
    async function play(i) {
      if (busy || board[i]) return;
      board[i] = 'O';
      let w = winner(board);
      if (w) return finish(w);
      busy = true;
      draw();
      say(pick(['Hmm…', 'Let me think…', 'Ooh, tricky…']));
      await wait(550);
      const open = board.map((m, j) => (m ? -1 : j)).filter((j) => j >= 0);
      // A quarter of the time the pet makes a casual move, so you can actually win.
      const move = Math.random() < 0.25 ? pick(open) : minimax(board, 'X').move;
      board[move] = 'X';
      busy = false;
      w = winner(board);
      if (w) return finish(w);
      say(pick(['Your turn!', 'Beat that!', 'Okay, go!']));
      draw();
    }
    draw();
    return result;
  }

  // MARK: Word guess (six petals)

  function flower(petals) {
    let svg = '<svg viewBox="0 0 100 100" class="words-flower" width="96" height="96">';
    svg += '<path d="M50 62 C50 80 48 90 50 99" stroke="#4caf50" stroke-width="4" fill="none"/>';
    svg += '<ellipse cx="38" cy="84" rx="9" ry="4" fill="#66bb6a" transform="rotate(-30 38 84)"/>';
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      const x = 50 + Math.cos(a) * 17, y = 42 + Math.sin(a) * 17;
      const shown = i < petals;
      svg += `<ellipse cx="${x}" cy="${y}" rx="11" ry="14" fill="${shown ? '#ff8fb1' : 'none'}" stroke="${shown ? '#ff4f8b' : 'rgba(42,29,24,0.12)'}" stroke-dasharray="${shown ? '0' : '3 3'}" transform="rotate(${(a * 180) / Math.PI + 90} ${x} ${y})"/>`;
    }
    svg += '<circle cx="50" cy="42" r="10" fill="#ffcc00" stroke="#f0a500" stroke-width="2"/></svg>';
    return svg;
  }

  async function words({ arena, score, say, words: list }) {
    const word = pick(list).toLowerCase().replace(/[^a-z]/g, '') || 'friend';
    const guessed = new Set();
    let petals = 6;
    const pic = el('div', '', flower(petals));
    const shown = el('div', 'words-word');
    const keys = el('div', 'words-keys');
    arena.append(pic, shown, keys);
    let done, over = false;
    const result = new Promise((r) => { done = r; });
    const render = (reveal) => {
      shown.innerHTML = [...word].map((c) => `<span class="${reveal && !guessed.has(c) ? 'missed' : ''}">${guessed.has(c) || reveal ? c : ''}</span>`).join('');
      pic.innerHTML = flower(petals);
      score.textContent = `${petals} petal${petals === 1 ? '' : 's'} left`;
    };
    const guess = async (c) => {
      if (over || guessed.has(c)) return;
      guessed.add(c);
      const btn = keys.querySelector(`[data-k="${c}"]`);
      const hit = word.includes(c);
      if (btn) { btn.disabled = true; btn.classList.add(hit ? 'hit' : 'miss'); }
      if (!hit) { petals--; say(pick(['Nope! A petal fell…', 'Not that one!', 'Ooh, close? No.'])); } else say(pick(['Yes! That one is in there!', 'Nice!', 'Ooh, good guess!']));
      const solved = [...word].every((x) => guessed.has(x));
      render(petals === 0);
      if (solved || petals === 0) {
        over = true;
        document.removeEventListener('keydown', onKey);
        say(solved ? `You got it: ${word.toUpperCase()}!` : `The word was ${word.toUpperCase()}!`);
        await wait(1300);
        done(solved ? 'win' : 'lose');
      }
    };
    for (const c of 'abcdefghijklmnopqrstuvwxyz') {
      const b = el('button', '', c);
      b.dataset.k = c;
      b.addEventListener('click', () => guess(c));
      keys.appendChild(b);
    }
    const onKey = (e) => { if (/^[a-z]$/i.test(e.key) && !e.metaKey && !e.ctrlKey) guess(e.key.toLowerCase()); };
    document.addEventListener('keydown', onKey);
    say(`${word.length} letters. Type or click a letter!`);
    render(false);
    return result;
  }

  // MARK: Pong (first to five)

  async function pong({ arena, score, say, pet, accent }) {
    const W = 380, H = 230, PAD = 54, PW = 8, R = 6;
    const dpr = window.devicePixelRatio || 1;
    const canvas = el('canvas', 'pong');
    canvas.width = W * dpr; canvas.height = H * dpr;
    canvas.style.width = `${W}px`; canvas.style.height = `${H}px`;
    arena.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    let you = 0, them = 0;
    let py = H / 2, ay = H / 2, keyDir = 0;
    let ball;
    const serve = (dir) => {
      const a = (Math.random() - 0.5) * 0.9;
      ball = { x: W / 2, y: H / 2, vx: Math.cos(a) * 210 * dir, vy: Math.sin(a) * 210, wait: 0.8 };
    };
    serve(Math.random() < 0.5 ? 1 : -1);
    canvas.addEventListener('mousemove', (e) => { const r = canvas.getBoundingClientRect(); py = e.clientY - r.top; });
    const onKey = (e) => {
      if (e.key === 'ArrowUp' || e.key === 'w') keyDir = e.type === 'keydown' ? -1 : 0;
      if (e.key === 'ArrowDown' || e.key === 's') keyDir = e.type === 'keydown' ? 1 : 0;
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('keyup', onKey);
    const show = () => { score.textContent = `You ${you} · ${them} ${pet}`; };
    show();
    return new Promise((resolve) => {
      let last = performance.now();
      const frame = (now) => {
        const dt = Math.min(0.033, (now - last) / 1000);
        last = now;
        py = Math.max(PAD / 2, Math.min(H - PAD / 2, py + keyDir * 320 * dt));
        // The pet watches the ball, a little slowly, so it can be beaten.
        const target = ball.vx > 0 ? ball.y : H / 2;
        ay += Math.max(-180 * dt, Math.min(180 * dt, (target - ay) * 0.12));
        ay = Math.max(PAD / 2, Math.min(H - PAD / 2, ay));
        if (ball.wait > 0) ball.wait -= dt;
        else {
          ball.x += ball.vx * dt; ball.y += ball.vy * dt;
          if (ball.y < R || ball.y > H - R) { ball.vy *= -1; ball.y = Math.max(R, Math.min(H - R, ball.y)); }
          const hit = (padY, x, dir) => {
            if (Math.abs(ball.y - padY) < PAD / 2 + R && (dir < 0 ? ball.x - R < x + PW && ball.x > x : ball.x + R > x && ball.x < x + PW)) {
              const off = (ball.y - padY) / (PAD / 2);
              const speed = Math.min(430, Math.hypot(ball.vx, ball.vy) * 1.06);
              const a = off * 0.9;
              ball.vx = Math.cos(a) * speed * -dir; ball.vy = Math.sin(a) * speed;
              ball.x = dir < 0 ? x + PW + R : x - R;
            }
          };
          if (ball.vx < 0) hit(py, 14, -1); else hit(ay, W - 14 - PW, 1);
          if (ball.x < -R || ball.x > W + R) {
            if (ball.x < 0) { them++; say(pick(['Point for me!', 'Hehe!', 'Too fast?'])); } else { you++; say(pick(['Aah! Missed it!', 'Nice shot!', 'How?!'])); }
            show();
            if (you === 5 || them === 5) {
              document.removeEventListener('keydown', onKey);
              document.removeEventListener('keyup', onKey);
              setTimeout(() => resolve(you === 5 ? 'win' : 'lose'), 700);
              return;
            }
            serve(ball.x < 0 ? 1 : -1);
          }
        }
        ctx.clearRect(0, 0, W, H);
        ctx.setLineDash([6, 8]);
        ctx.strokeStyle = 'rgba(42,29,24,0.12)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(W / 2, 8); ctx.lineTo(W / 2, H - 8); ctx.stroke();
        ctx.setLineDash([]);
        const paddle = (x, y, color) => { ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y - PAD / 2, PW, PAD, 4); ctx.fill(); };
        paddle(14, py, '#2a1d18');
        paddle(W - 14 - PW, ay, accent || '#ff4f8b');
        ctx.fillStyle = accent || '#ff7a59';
        ctx.beginPath(); ctx.arc(ball.x, ball.y, R, 0, Math.PI * 2); ctx.fill();
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
  }

  window.DeskPetGames = { rps, ttt, words, pong };
})();
