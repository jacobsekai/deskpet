// Sprite packs: a port of Sprites.swift. Same folder format, so packs work on both apps.
(() => {
  const MOOD_NAMES = {
    idle: 'idle', walking: 'walking', walk: 'walking', sleepy: 'sleepy', sleeping: 'sleeping', sleep: 'sleeping',
    petted: 'petted', happy: 'petted', dragged: 'dragged', flying: 'flying', thrown: 'flying', dizzy: 'dizzy',
    startled: 'startled', surprised: 'startled', usertyping: 'userTyping', thinking: 'thinking', typing: 'typing',
    working: 'typing', reading: 'reading', searching: 'searching', delegating: 'delegating', needsyou: 'needsYou',
    attention: 'needsYou', done: 'done', celebrate: 'done', oops: 'oops', error: 'error', tidying: 'tidying',
  };

  const FALLBACKS = {
    walking: ['idle'], sleepy: ['sleeping'], startled: ['dragged', 'needsYou'], dragged: ['startled'],
    flying: ['dragged', 'startled'], dizzy: ['error', 'oops', 'startled'], userTyping: ['idle'], petted: ['done'],
    done: ['petted'], typing: ['thinking'], reading: ['searching', 'thinking'], searching: ['reading', 'thinking'],
    delegating: ['typing', 'thinking'], tidying: ['typing', 'thinking'], oops: ['error', 'startled'],
    error: ['oops', 'startled'], needsYou: ['startled'],
  };

  /** The default 4x4 sheet layout (see README). */
  const DEFAULT_CELLS = [
    'idle_1', 'idle_2', 'typing_1', 'typing_2',
    'thinking', 'needs-you', 'done', 'petted',
    'sleeping', 'sleepy', 'dragged', 'startled',
    'reading', 'searching', 'oops', 'error',
  ];

  const moodNamed = (name) => MOOD_NAMES[String(name).toLowerCase().replace(/[_-]/g, '')] || null;

  /** "typing_2" -> ["typing", 2]; "idle" -> ["idle", 0] */
  function splitFrameNumber(s) {
    const m = /^(.*?)[_-]?(\d+)$/.exec(s);
    return m && m[1] ? [m[1], parseInt(m[2], 10)] : [s, 0];
  }

  const MIME = { png: 'image/png', gif: 'image/gif', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg' };

  /** Decodes every frame of an image; `duration` (seconds) is set only for animated images. */
  async function decodeFrames(data, ext) {
    const type = MIME[ext] || 'image/png';
    if ((ext === 'gif' || ext === 'webp') && typeof ImageDecoder !== 'undefined') {
      try {
        const decoder = new ImageDecoder({ data, type });
        await decoder.tracks.ready;
        const count = decoder.tracks.selectedTrack.frameCount;
        const frames = [];
        for (let i = 0; i < count; i++) {
          const { image } = await decoder.decode({ frameIndex: i });
          const bitmap = await createImageBitmap(image);
          frames.push({ image: bitmap, duration: count > 1 && image.duration ? image.duration / 1e6 : null });
          image.close();
        }
        decoder.close();
        return frames;
      } catch (_) { /* fall through to a single frame */ }
    }
    return [{ image: await createImageBitmap(new Blob([data], { type })), duration: null }];
  }

  function pixels(image) {
    const c = new OffscreenCanvas(image.width, image.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    return { canvas: c, ctx, data: ctx.getImageData(0, 0, image.width, image.height) };
  }

  /** Optionally flood-fills the background (from the edges) to transparent, then finds the content bounds. */
  function processImage(image, removeBackground, tolerance) {
    const { canvas, ctx, data } = pixels(image);
    const px = data.data;
    const w = image.width, h = image.height;
    if (removeBackground && px[3] > 200) {
      const ref = [px[0], px[1], px[2]];
      const visited = new Uint8Array(w * h);
      const stack = [];
      for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
      for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
      while (stack.length) {
        const i = stack.pop();
        if (visited[i]) continue;
        visited[i] = 1;
        const o = i * 4;
        if (Math.abs(px[o] - ref[0]) > tolerance || Math.abs(px[o + 1] - ref[1]) > tolerance || Math.abs(px[o + 2] - ref[2]) > tolerance) continue;
        px[o] = px[o + 1] = px[o + 2] = px[o + 3] = 0;
        const x = i % w, y = (i / w) | 0;
        if (x > 0) stack.push(i - 1);
        if (x < w - 1) stack.push(i + 1);
        if (y > 0) stack.push(i - w);
        if (y < h - 1) stack.push(i + w);
      }
      ctx.putImageData(data, 0, 0);
    }
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (px[(y * w + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX) return null;
    // The head: the first row from the top that's wide (raised hands, ears, and stray hairs are
    // narrow), then the widest solid span across the next ~12% of the character.
    const longestRun = (y) => {
      let best = null, start = -1;
      for (let x = minX; x <= maxX + 1; x++) {
        const solid = x <= maxX && px[(y * w + x) * 4 + 3] > 100;
        if (solid && start < 0) start = x;
        if (!solid && start >= 0) { if (!best || x - 1 - start > best[1] - best[0]) best = [start, x - 1]; start = -1; }
      }
      return best;
    };
    const widthNeeded = Math.max(3, Math.floor((maxX - minX + 1) * 0.25));
    let headTop = minY;
    for (let y = minY; y <= maxY; y++) { const run = longestRun(y); if (run && run[1] - run[0] + 1 >= widthNeeded) { headTop = y; break; } }
    const headRows = Math.max(2, Math.floor((maxY - minY) * 0.12));
    let hMin = maxX, hMax = minX;
    for (let y = headTop; y <= Math.min(maxY, headTop + headRows); y++) { const run = longestRun(y); if (run) { hMin = Math.min(hMin, run[0]); hMax = Math.max(hMax, run[1]); } }
    if (hMax < hMin) { hMin = minX; hMax = maxX; }
    return {
      canvas,
      bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
      head: { x: hMin, y: headTop, width: hMax - hMin + 1 },
    };
  }

  /** Ranges where counts exceed `noise`, merging ranges closer than `minGap` and dropping short specks. */
  function runs(counts, noise, minGap, minLength) {
    const result = [];
    let start = -1;
    counts.forEach((c, i) => {
      if (c >= noise) { if (start < 0) start = i; } else if (start >= 0) { result.push([start, i]); start = -1; }
    });
    if (start >= 0) result.push([start, counts.length]);
    const merged = [];
    for (const r of result) {
      const last = merged[merged.length - 1];
      if (last && r[0] - last[1] < minGap) last[1] = r[1]; else merged.push([...r]);
    }
    return merged.filter(([a, b]) => b - a >= minLength);
  }

  /** Finds poses by empty gaps; null means "use the even grid". */
  function detectCells(sheet, columns, rows, tolerance) {
    const { data } = pixels(sheet);
    const px = data.data;
    const w = sheet.width, h = sheet.height;
    const bg = [px[0], px[1], px[2], px[3]];
    const mask = new Uint8Array(w * h);
    const rowCounts = new Array(h).fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const o = (y * w + x) * 4;
        let content = px[o + 3] >= 8;
        if (content && bg[3] >= 200) {
          content = Math.abs(px[o] - bg[0]) > tolerance || Math.abs(px[o + 1] - bg[1]) > tolerance || Math.abs(px[o + 2] - bg[2]) > tolerance;
        }
        if (content) { mask[y * w + x] = 1; rowCounts[y]++; }
      }
    }
    const bands = runs(rowCounts, Math.max(1, (w / 500) | 0), Math.max(2, (h / 60) | 0), Math.max(4, (h / (rows * 5)) | 0));
    if (bands.length !== rows) return null;
    const margin = 4;
    const rects = [];
    for (const [y0b, y1b] of bands) {
      const colCounts = new Array(w).fill(0);
      for (let y = y0b; y < y1b; y++) for (let x = 0; x < w; x++) if (mask[y * w + x]) colCounts[x]++;
      let spans = runs(colCounts, 1, Math.max(2, (w / 60) | 0), Math.max(4, (w / (columns * 5)) | 0));
      if (spans.length !== columns) {
        const cw = (w / columns) | 0;
        spans = Array.from({ length: columns }, (_, i) => [i * cw, (i + 1) * cw]);
      }
      for (const [x0s, x1s] of spans) {
        const x0 = Math.max(0, x0s - margin), x1 = Math.min(w, x1s + margin);
        const y0 = Math.max(0, y0b - margin), y1 = Math.min(h, y1b + margin);
        rects.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
      }
    }
    return rects;
  }

  function sheetSpecs(options, fileNames) {
    let raw = [];
    if (options.sheet && typeof options.sheet === 'object') raw = [options.sheet];
    else if (typeof options.sheet === 'string') raw = [{ file: options.sheet }];
    else if (Array.isArray(options.sheets)) raw = options.sheets;
    else if (fileNames.includes('sheet.png')) raw = [{ file: 'sheet.png' }];
    return raw.map((d) => {
      let cells = DEFAULT_CELLS;
      if (Array.isArray(d.cells)) cells = d.cells.flat().map((c) => (typeof c === 'string' ? c : ''));
      const columns = Math.max(1, d.columns || 4);
      const rows = Math.max(1, d.rows || Math.ceil(cells.length / columns));
      return { file: d.file || 'sheet.png', columns, rows, cells, mode: String(d.mode || 'auto').toLowerCase() };
    });
  }

  class SpritePack {
    /**
     * @param {{name: string, options: object, files: {name: string, data: ArrayBuffer}[]}} source
     */
    static async load(source) {
      const pack = new SpritePack();
      const o = source.options || {};
      pack.name = source.name;
      pack.height = Math.min(220, Math.max(40, o.height || 120));
      pack.effects = o.effects !== false;
      pack.bounce = o.bounce !== false;
      pack.pixelated = !!o.pixelated;
      pack.facesLeft = String(o.facing || '').toLowerCase() === 'left';
      const fps = Math.max(0.5, o.fps || 6);
      const tolerance = o.tolerance || 40;
      const removeBackground = typeof o.removeBackground === 'boolean' ? o.removeBackground : typeof o.removeBackground === 'string';

      pack.settings = {};
      for (const [key, v] of Object.entries(o.moods || {})) {
        const mood = moodNamed(key);
        if (!mood) continue;
        pack.settings[mood] = {
          scale: v.scale || 1,
          offset: { x: v.offsetX || 0, y: v.offsetY || 0 },
          fps: v.fps,
          durations: Array.isArray(v.durations) && v.durations.length ? v.durations.map((d) => Math.max(0.02, d)) : null,
        };
      }

      const byName = Object.fromEntries(source.files.map((f) => [f.name, f]));
      const fromFiles = {};
      for (const f of source.files) {
        const ext = f.name.split('.').pop().toLowerCase();
        if (!MIME[ext]) continue;
        const [base, index] = splitFrameNumber(f.name.replace(/\.[^.]+$/, ''));
        const mood = moodNamed(base);
        if (!mood) continue;
        (fromFiles[mood] = fromFiles[mood] || []).push({ index, frames: await decodeFrames(f.data, ext), removeBackground });
      }

      // Spritesheet cells have flat backgrounds, so they get background removal unless explicitly disabled.
      const fromSheets = {};
      const sheetRemoveBackground = typeof o.removeBackground === 'boolean' ? o.removeBackground : true;
      for (const spec of sheetSpecs(o, Object.keys(byName))) {
        const file = byName[spec.file];
        if (!file) continue;
        const [{ image: sheet }] = await decodeFrames(file.data, spec.file.split('.').pop().toLowerCase());
        const detected = spec.mode === 'grid' ? null : detectCells(sheet, spec.columns, spec.rows, tolerance);
        const cw = sheet.width / spec.columns, ch = sheet.height / spec.rows;
        const rects = detected || Array.from({ length: spec.rows * spec.columns }, (_, i) => ({
          x: Math.round((i % spec.columns) * cw), y: Math.round(Math.floor(i / spec.columns) * ch), width: Math.round(cw), height: Math.round(ch),
        }));
        for (let i = 0; i < Math.min(spec.cells.length, rects.length); i++) {
          const name = spec.cells[i];
          if (!name) continue;
          const [base, index] = splitFrameNumber(name);
          const mood = moodNamed(base);
          if (!mood) continue;
          const r = rects[i];
          const cell = await createImageBitmap(sheet, r.x, r.y, r.width, r.height);
          (fromSheets[mood] = fromSheets[mood] || []).push({ index, frames: [{ image: cell, duration: null }], removeBackground: sheetRemoveBackground });
        }
      }
      // A loose file replaces that mood's sheet cells.
      const grouped = { ...fromSheets, ...fromFiles };

      pack.animations = {};
      for (const [mood, entries] of Object.entries(grouped)) {
        const moodFPS = (pack.settings[mood] && pack.settings[mood].fps) || fps;
        const processed = [];
        for (const entry of entries.sort((a, b) => a.index - b.index)) {
          for (const f of entry.frames) {
            const p = processImage(f.image, entry.removeBackground, tolerance);
            if (p) processed.push({ ...p, w: f.image.width, h: f.image.height, duration: f.duration || 1 / moodFPS });
          }
        }
        if (!processed.length) continue;
        const durations = pack.settings[mood] && pack.settings[mood].durations;
        if (durations) processed.forEach((p, i) => { p.duration = durations[Math.min(i, durations.length - 1)]; });
        // Crop every frame to the union of their content so animations don't jitter.
        const sameSize = new Set(processed.map((p) => `${p.w}x${p.h}`)).size === 1;
        const u = processed.map((p) => p.bounds).reduce((a, b) => {
          const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
          return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
        });
        pack.animations[mood] = await Promise.all(processed.map(async (p) => {
          const b = sameSize ? u : p.bounds;
          return {
            image: await createImageBitmap(p.canvas, b.x, b.y, b.width, b.height), duration: p.duration,
            head: { x: (p.head.x + p.head.width / 2 - b.x) / b.width, width: p.head.width / b.width, top: Math.max(0, p.head.y - b.y) / b.height },
          };
        }));
      }

      const idle = pack.animations.idle && pack.animations.idle[0];
      if (!idle) throw new Error(`no idle image in ${source.name}`);
      // Every mood uses idle's pixel density, so poses keep a consistent size relative to each other.
      pack.pointsPerPixel = pack.height / idle.image.height;
      return pack;
    }

    hasArt(mood) { return !!this.animations[mood]; }

    resolve(mood) {
      for (const m of [mood, ...(FALLBACKS[mood] || [])]) if (this.animations[m]) return m;
      return 'idle';
    }

    /** The image for a mood at time t, with its size and offset in points. */
    frame(mood, t) {
      const resolved = this.resolve(mood);
      const frames = this.animations[resolved];
      const total = frames.reduce((s, f) => s + f.duration, 0);
      let remaining = ((t % total) + total) % total;
      let frame = frames[0];
      for (const f of frames) {
        if (remaining < f.duration) { frame = f; break; }
        remaining -= f.duration;
      }
      const s = this.settings[resolved] || { scale: 1, offset: { x: 0, y: 0 } };
      return {
        image: frame.image,
        head: frame.head || { x: 0.5, width: 0.5, top: 0 },
        width: frame.image.width * this.pointsPerPixel * s.scale,
        height: frame.image.height * this.pointsPerPixel * s.scale,
        offset: s.offset,
      };
    }
  }

  window.SpritePack = SpritePack;
})();
