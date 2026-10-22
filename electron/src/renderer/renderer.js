// Draws whatever pose the main process sends, and reports presses and the pet's geometry back.
(() => {
  const canvas = document.getElementById('pet');
  const ctx = canvas.getContext('2d');
  const renderer = new PetRenderer();
  const start = performance.now();
  let pose = { mood: 'idle', look: { x: 0, y: 0 }, scale: 1 };
  let pack = null;
  let lastGeometry = '';

  if (new URLSearchParams(location.search).has('snapshot')) {
    window.deskpet.onSnapshot(runSnapshot);
    return;
  }

  window.deskpet.onPose((p) => { pose = p; });
  window.deskpet.onSound((event) => window.DeskPetSounds.play(event));
  window.deskpet.onPack(async (source) => {
    window.DeskPetSounds.setPack(source ? source.sounds : []);
    if (!source) { pack = null; return; }
    try {
      pack = await SpritePack.load(source);
      window.deskpet.send('pack-loaded', { ok: true });
    } catch (e) {
      pack = null;
      window.deskpet.send('pack-loaded', { ok: false, error: e.message });
    }
  });

  function frame() {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth, h = window.innerHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const geometry = renderer.render(ctx, w, h, pose, (performance.now() - start) / 1000, pack);
    const key = JSON.stringify(geometry);
    if (key !== lastGeometry) {
      lastGeometry = key;
      window.deskpet.send('geometry', geometry);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  /** Event position in the renderer's y-up window space. */
  const local = (e) => ({ x: e.clientX, y: window.innerHeight - e.clientY });

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    const g = renderer.geometry;
    if (pose.resizing && g) {
      const p = local(e);
      if (PetRenderer.contains(g.doneRect, p)) return window.deskpet.send('resize-finish');
      const near = (r) => PetRenderer.contains({ x: r.x - 6, y: r.y - 6, width: r.width + 12, height: r.height + 12 }, p);
      if (g.resizeHandles.some(near)) return window.deskpet.send('resize-start');
    }
    window.deskpet.send('press');
  });
  canvas.addEventListener('pointerup', (e) => {
    if (e.button !== 0) return;
    window.deskpet.send('release');
  });
  // Drop a sprite pack .zip, folder, or images onto the pet.
  canvas.addEventListener('dragenter', (e) => { e.preventDefault(); window.deskpet.send('drag-hover'); });
  canvas.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  canvas.addEventListener('drop', (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) window.deskpet.dropFiles([...e.dataTransfer.files]);
  });
  canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    window.deskpet.send('menu');
  });

  // MARK: Snapshot mode: a contact sheet of every pose, for checking the art without a screen.

  async function runSnapshot(request) {
    const snapPack = request.pack ? await SpritePack.load(request.pack) : null;
    const moods = ['idle', 'typing', 'thinking', 'reading', 'searching', 'delegating', 'needsYou', 'done',
      'sleeping', 'petted', 'dragged', 'error', 'tidying', 'oops', 'sleepy', 'flying', 'dizzy', 'walking'];
    const cases = moods.map((mood) => ({ label: mood, pose: { mood, subagents: mood === 'delegating' ? 3 : 0 } }));
    cases[0].pose.bubble = `hi ${request.ownerName}! 👋`;
    cases[0].pose.accessory = 'glasses';
    cases[8].pose.nightcap = true;
    cases[9].pose.accessory = 'headphones';
    cases[15].pose.spin = 0.8;
    cases.push({ label: 'thinking · small · #FF8FB1', pose: { mood: 'thinking', thoughtBubble: 'small', theme: '#FF8FB1', caption: 'Claude: thinking…', captionColor: '#AF52DE' } });
    cases.push({ label: 'needsYou · #2B2D42', pose: { mood: 'needsYou', theme: '#2B2D42', bubble: 'Claude needs you! 🙋', caption: 'Claude: needs your OK', captionColor: '#FF9500' } });
    cases.push({ label: 'resizing 150%', pose: { mood: 'idle', resizing: true, scale: 1.5 } });
    cases.push({ label: 'resizing 60%', pose: { mood: 'idle', resizing: true, scale: 0.6 } });
    for (const c of cases.slice(1, 8)) { c.pose.caption = `Claude: ${c.label}`; c.pose.captionColor = '#007AFF'; }

    const cellW = 300, cellH = 300, cols = 6;
    const rows = Math.ceil(cases.length / cols);
    const sheet = document.createElement('canvas');
    sheet.width = cellW * cols * 2;
    sheet.height = cellH * rows * 2;
    const sctx = sheet.getContext('2d');
    sctx.scale(2, 2);
    sctx.fillStyle = '#e8e8e8';
    sctx.fillRect(0, 0, cellW * cols, cellH * rows);
    const cell = document.createElement('canvas');
    cell.width = cellW * 2;
    cell.height = cellH * 2;
    const cctx = cell.getContext('2d');
    cases.forEach((c, i) => {
      const p = { look: { x: 0.3, y: 0.1 }, scale: 1, facingLeft: true, ...c.pose };
      cctx.setTransform(2, 0, 0, 2, 0, 0);
      renderer.lastSpriteRect = null;
      renderer.render(cctx, cellW, cellH, p, 0.6 + i * 0.37, snapPack);
      const x = (i % cols) * cellW, y = Math.floor(i / cols) * cellH;
      sctx.fillStyle = '#f6f6f6';
      sctx.fillRect(x + 2, y + 2, cellW - 4, cellH - 4);
      sctx.drawImage(cell, x, y, cellW, cellH);
      sctx.fillStyle = '#333';
      sctx.font = '12px sans-serif';
      sctx.fillText(c.label, x + 8, y + 16);
    });
    window.deskpet.send('snapshot-done', sheet.toDataURL('image/png'));
  }
})();
