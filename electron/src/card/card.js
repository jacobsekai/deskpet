// Hover card: level, today's stats, and agent sessions (click one to jump to it).
const card = document.getElementById('card');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

window.deskpetCard.onModel((m) => {
  const rows = m.rows.length
    ? m.rows.map((r) => `<div class="row" data-pid="${r.pid}" title="Jump to this session">
        <span class="dot" style="background:${r.color}"></span>
        <div><div class="title">${esc(r.title)}</div><div class="muted">${esc(r.detail)}</div>${r.tokens ? `<div class="tokens">${esc(r.tokens)}</div>` : ''}</div>
        <span class="elapsed">${esc(r.elapsed)}</span></div>`).join('') + '<div class="hint">Click a session to jump to it</div>'
    : '<div class="muted">No AI agents running</div>';
  card.innerHTML = `
    <div class="head"><span class="name">${esc(m.petName)}</span>
      <span class="lv" style="color:${m.accent};background:${m.accent}2e">${esc(m.rank || `Lv ${m.level}`)}</span>
      <span class="next">${m.atMax ? 'max level' : `${m.xpToNext} XP to Lv ${m.level + 1}`}</span></div>
    <div class="bar"><div style="width:${Math.round(m.progress * 100)}%;background:${m.accent}"></div></div>
    <div class="muted">${esc(m.today)}</div>
    ${m.nextReward ? `<div class="muted">${esc(m.nextReward)}</div>` : ''}
    ${m.focus ? `<div class="focus">${esc(m.focus)}</div>` : ''}
    ${m.quiet ? '<div class="muted">🤫 Quiet mode: you\'re on a call</div>' : ''}
    <hr>${rows}`;
  card.querySelectorAll('.row').forEach((row) => row.addEventListener('click', () => window.deskpetCard.jump(Number(row.dataset.pid))));
  const r = card.getBoundingClientRect();
  window.deskpetCard.size(Math.ceil(r.width + 12), Math.ceil(r.height + 12));
});
