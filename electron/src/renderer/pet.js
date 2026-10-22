// Draws the pet onto a canvas. A port of PetView.swift from the macOS app.
//
// Drawing uses y-up coordinates with the origin at the window's bottom-left, like AppKit,
// so shapes match the Swift version one to one. Text and images are flipped back upright.
(() => {
  const { Color, SYS, INK, Theme } = window.DeskPetColor;

  const outline = INK;
  const fur = new Color(0.99, 0.77, 0.54);
  const furLight = new Color(1.0, 0.93, 0.82);
  const pink = new Color(1.0, 0.6, 0.66);
  const GROUND = 34;
  const FONT = '-apple-system, "Segoe UI", "Segoe UI Emoji", system-ui, sans-serif';

  const abs = Math.abs, sin = Math.sin, cos = Math.cos, min = Math.min, max = Math.max;
  const fmod = (a, b) => ((a % b) + b) % b;
  const rect = (x, y, width, height) => ({ x, y, width, height });
  const inset = (r, d) => rect(r.x + d, r.y + d, r.width - 2 * d, r.height - 2 * d);
  const union = (a, b) => {
    const x = min(a.x, b.x), y = min(a.y, b.y);
    return rect(x, y, max(a.x + a.width, b.x + b.width) - x, max(a.y + a.height, b.y + b.height) - y);
  };
  const contains = (r, p) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

  class PetRenderer {
    constructor() {
      this.lastSpriteRect = null;
      this.geometry = null;
    }

    /**
     * Draws one frame. `pose` comes from the main process; `pack` is a loaded SpritePack or null.
     * Returns geometry (window coordinates, y-up) used for hit testing and physics.
     */
    render(ctx, width, height, pose, t, pack) {
      this.ctx = ctx;
      this.W = width;
      this.H = height;
      this.pose = pose;
      this.pack = pack;
      this.scale = pose.scale || 1;
      this.theme = pose.theme ? Theme.fromHex(pose.theme) : new Theme();
      this.lastSpriteRect = pack ? this.lastSpriteRect : null;

      ctx.save();
      ctx.clearRect(0, 0, width, height);
      ctx.translate(0, height);
      ctx.scale(1, -1);

      ctx.save();
      ctx.translate(0, GROUND * (1 - this.scale));
      ctx.scale(this.scale, this.scale);
      const anchor = pack ? this.drawSprites(t) : this.drawCatScene(t);
      ctx.restore();

      if (pose.bubble) {
        const a = this.toWindow(anchor);
        this.drawSpeech(pose.bubble, a.x, a.y);
      }
      if (pose.caption) this.drawCaption(pose.caption, Color.hex(pose.captionColor) || SYS.gray);
      if (pose.resizing) this.drawResizeOverlay();
      ctx.restore();

      this.geometry = {
        hitRect: this.hitRect(),
        bodyExtent: this.bodyExtent(),
        eye: this.toWindow({ x: this.petCenterX(), y: GROUND + 40 }),
        resizeHandles: this.handleRects(),
        doneRect: this.doneRect(),
      };
      return this.geometry;
    }

    // MARK: Coordinates

    get canvas() {
      const s = this.scale;
      return rect(0, 0, this.W / s, (this.H - GROUND * (1 - s)) / s);
    }

    toWindow(p) { return { x: p.x * this.scale, y: GROUND * (1 - this.scale) + p.y * this.scale }; }
    toWindowRect(r) {
      const o = this.toWindow(r);
      return rect(o.x, o.y, r.width * this.scale, r.height * this.scale);
    }

    petCenterX() {
      const mid = this.canvas.width / 2;
      return this.pose.mood === 'typing' && !this.pack ? mid - 32 : mid;
    }

    hitRect() {
      let r = this.pack && this.lastSpriteRect
        ? inset(this.toWindowRect(this.lastSpriteRect), -6)
        : this.toWindowRect(rect(this.petCenterX() - 50, GROUND - 12, 100, 104));
      if (this.pose.resizing) r = union(union(r, inset(this.resizeBox(), -12)), this.doneRect());
      return r;
    }

    bodyExtent() {
      if (this.pack && this.lastSpriteRect) {
        return { halfWidth: (this.lastSpriteRect.width / 2) * this.scale, height: this.lastSpriteRect.height * this.scale };
      }
      return { halfWidth: 46 * this.scale, height: 84 * this.scale };
    }

    resizeBox() {
      const cx = this.canvas.width / 2;
      let box;
      if (this.pack) {
        const s = this.pack.frame('idle', 0);
        box = rect(cx - s.width / 2, GROUND, s.width, s.height);
      } else {
        box = rect(cx - 46, GROUND - 2, 112, 88);
      }
      return inset(this.toWindowRect(box), -8);
    }

    handleRects() {
      const b = this.resizeBox();
      return [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
        .map(([x, y]) => rect(x - 6, y - 6, 12, 12));
    }

    doneLabel() { return `${Math.round(this.scale * 100)}%   ·   Done`; }

    doneRect() {
      const ctx = this.ctx;
      ctx.save();
      ctx.font = `600 11.5px ${FONT}`;
      const w = ctx.measureText(this.doneLabel()).width + 22;
      ctx.restore();
      const b = this.resizeBox();
      return rect(b.x + b.width / 2 - w / 2, min(b.y + b.height + 8, this.H - 24), w, 22);
    }

    // MARK: Scenes

    drawCatScene(t) {
      const m = this.pose.mood;
      const cx = this.petCenterX();
      const g = GROUND;
      const bob = this.bounce(m, t);
      const base = g + bob;
      const lift = m === 'dragged' ? 8 : 0;

      const s = m === 'dragged' ? 0.55 : 1 - min(bob, 12) / 36;
      if (m !== 'flying') this.fill(this.oval(cx, g - 1, 78 * s, 11 * s), new Color(0, 0, 0, 0.16));

      if (this.pose.subagents > 0 && m !== 'idle' && m !== 'sleeping') this.drawMinis(cx, g, t);
      if (m === 'typing') this.at(cx + 46, g, {}, () => this.drawLaptop(t));

      const face = this.faceFor(m, t);
      this.at(cx, base + lift, {
        flip: this.pose.facingLeft && m === 'walking',
        rotate: m === 'dragged' ? sin(t * 4) * 0.12 : m === 'flying' ? this.pose.spin : 0,
        pivotY: m === 'flying' ? 38 : 70,
        scaleY: m === 'sleeping' ? 1 + sin(t * 1.4) * 0.025 : 1,
      }, () => this.drawCat(m, t, face.eyes, face.mouth, face.look || this.pose.look));

      this.drawProps(m, t, cx, g, base);
      this.drawEffects(m, t, cx, base);
      if (!this.pose.bubble) this.drawThoughts(m, t, cx, base);
      return { x: cx, y: base + 92 };
    }

    drawSprites(t) {
      const pack = this.pack;
      const m = this.pose.mood;
      const canvas = this.canvas;
      const cx = canvas.width / 2;
      const g = GROUND;
      const bob = pack.bounce ? this.bounce(m, t) : 0;
      const base = g + bob + (m === 'dragged' ? 8 : 0);
      const frame = pack.frame(m, t);
      const fit = min(1, (canvas.width - 10) / frame.width, (canvas.height - g - 10) / frame.height);
      const w = frame.width * fit, h = frame.height * fit;

      const s = m === 'dragged' ? 0.55 : 1 - min(bob, 12) / 36;
      if (m !== 'flying') this.fill(this.oval(cx, g - 1, w * 0.75 * s, 11 * s), new Color(0, 0, 0, 0.16));

      if (this.pose.subagents > 0 && m !== 'idle' && m !== 'sleeping') {
        const mini = pack.frame('typing', t + 0.4);
        const mw = mini.width * 0.4, mh = mini.height * 0.4;
        const xs = [cx - w / 2 - mw / 2 - 8, cx + w / 2 + mw / 2 + 8].slice(0, min(this.pose.subagents, 2));
        xs.forEach((x, i) => {
          if (x - mw / 2 <= 0 || x + mw / 2 >= canvas.width) return;
          const hop = abs(sin(t * 7 + i * 1.7)) * 3;
          this.image(mini.image, rect(x - mw / 2, g + hop, mw, mh), false, pack.pixelated);
        });
      }

      const r = rect(cx - w / 2 + frame.offset.x, base + frame.offset.y, w, h);
      this.lastSpriteRect = r;
      const movingLeft = this.pose.facingLeft && m === 'walking';
      const movingRight = !this.pose.facingLeft && m === 'walking';
      const ctx = this.ctx;
      ctx.save();
      const pivot = (px, py, angle) => { ctx.translate(px, py); ctx.rotate(angle); ctx.translate(-px, -py); };
      if (m === 'dragged') pivot(cx, r.y + r.height, sin(t * 4) * 0.1);
      else if (m === 'walking' && !pack.hasArt('walking')) pivot(r.x + r.width / 2, r.y, sin(t * 9) * 0.07); // waddle
      else if (m === 'flying') pivot(r.x + r.width / 2, r.y + r.height / 2, this.pose.spin);
      this.image(frame.image, r, pack.facesLeft ? movingRight : movingLeft, pack.pixelated);
      ctx.restore();

      const k = min(1.8, max(0.7, pack.height / 82));
      if (pack.effects) {
        this.at(cx, base + r.height - 82 * k, { scale: k }, () => {
          this.drawEffects(m, t, 0, 0);
          if (!this.pose.bubble) this.drawThoughts(m, t, 0, 0);
        });
      }
      return { x: cx, y: r.y + r.height + 8 };
    }

    bounce(m, t) {
      switch (m) {
        case 'walking': return abs(sin(t * 9)) * 4;
        case 'userTyping': return abs(sin(t * 11)) * 2;
        case 'needsYou': return abs(sin(t * 7)) * 7;
        case 'done': return abs(sin(t * 6)) * 9;
        case 'petted': return abs(sin(t * 8)) * 2;
        case 'startled': return abs(sin(t * 10)) * 6;
        case 'typing': return abs(sin(t * 14)) * 0.8;
        case 'sleeping': case 'sleepy': case 'dragged': case 'flying': return 0;
        case 'dizzy': return abs(sin(t * 3)) * 1.5;
        default: return sin(t * 2) * 1.2;
      }
    }

    faceFor(m, t) {
      switch (m) {
        case 'idle': case 'userTyping': case 'walking': return { eyes: 'open', mouth: 'w' };
        case 'sleepy': {
          const yawning = fmod(t, 7) < 1.6;
          return { eyes: yawning ? 'closed' : 'half', mouth: yawning ? 'yawn' : 'flat', look: { x: 0, y: -0.4 } };
        }
        case 'sleeping': return { eyes: 'closed', mouth: 'flat', look: { x: 0, y: 0 } };
        case 'petted': case 'done': return { eyes: 'happy', mouth: 'smile', look: { x: 0, y: 0 } };
        case 'dragged': case 'startled': case 'flying': return { eyes: 'wide', mouth: 'open' };
        case 'dizzy': return { eyes: 'cross', mouth: 'w', look: { x: 0, y: 0 } };
        case 'thinking': return { eyes: 'open', mouth: 'flat', look: { x: 0.6, y: 0.9 } };
        case 'typing': return { eyes: 'focused', mouth: 'w', look: { x: 0.9, y: -0.5 } };
        case 'reading': return { eyes: 'open', mouth: 'flat', look: { x: sin(t * 2.5) * 0.8, y: -0.9 } };
        case 'searching': return { eyes: 'wide', mouth: 'flat', look: { x: 0.8, y: 0.1 } };
        case 'delegating': return { eyes: 'open', mouth: 'smile', look: { x: sin(t * 1.3), y: -0.2 } };
        case 'needsYou': return { eyes: 'wide', mouth: 'open' };
        case 'oops': return { eyes: 'wide', mouth: 'flat', look: { x: -0.3, y: 0.2 } };
        case 'error': return { eyes: 'cross', mouth: 'open', look: { x: 0, y: 0 } };
        case 'tidying': return { eyes: 'happy', mouth: 'w', look: { x: 0, y: 0 } };
        default: return { eyes: 'open', mouth: 'w' };
      }
    }

    // MARK: Cat (local coordinates: origin = bottom-center of the body)

    drawCat(m, t, eyes, mouth, look) {
      const sway = sin(t * (m === 'needsYou' || m === 'done' ? 7 : 2)) * 10;
      const tail = new Path2D();
      if (m === 'dragged' || m === 'flying') {
        tail.moveTo(30, 14);
        tail.bezierCurveTo(44, 8, 42, -6, 40 + sway * 0.3, -18);
      } else {
        tail.moveTo(32, 12);
        tail.bezierCurveTo(58, 4, 66, 24, 60, 42 + sway);
      }
      this.strokePath(tail, outline, 12, 'round');
      this.strokePath(tail, fur, 7, 'round');

      const perk = m === 'needsYou' || m === 'startled' ? 4 : m === 'sleepy' || m === 'sleeping' ? -3 : 0;
      for (const side of [-1, 1]) {
        const ear = this.poly([[side * 38, 46], [side * 32, 82 + perk], [side * 11, 62]]);
        this.fillStroke(ear, fur, 2.5, 'round');
        this.fill(this.poly([[side * 31, 54], [side * 30, 74 + perk], [side * 18, 61]]), pink);
      }

      if (m === 'dragged' || m === 'flying') {
        for (const side of [-1, 1]) this.fillStroke(this.oval(side * 15, -6 + sin(t * 5 + side) * 2, 13, 17), furLight);
      } else {
        const step = m === 'walking' ? sin(t * 12) * 3 : 0;
        this.fillStroke(this.oval(-16, 3 + max(0, step), 18, 11), furLight);
        this.fillStroke(this.oval(16, 3 + max(0, -step), 18, 11), furLight);
      }

      const body = new Path2D();
      body.roundRect(-42, 0, 84, 66, [{ x: 38, y: 32 }]);
      this.fillStroke(body, fur);
      this.fill(this.oval(0, 17, 50, 26), furLight);

      const lx = look.x * 3.5, ly = look.y * 2.5;
      this.drawEyes(eyes, t, lx, ly);
      const cheek = pink.alpha(m === 'petted' || m === 'done' ? 0.95 : 0.55);
      this.fill(this.oval(-27, 30, 11, 7), cheek);
      this.fill(this.oval(27, 30, 11, 7), cheek);
      this.fill(this.oval(lx * 0.5, 33 + ly * 0.4, 5, 3.5), pink);
      this.drawMouth(mouth, lx * 0.5, ly * 0.4);

      const ctx = this.ctx;
      if (this.pose.accessory === 'glasses') {
        const gl = new Path2D();
        gl.ellipse(-15, 39, 10, 9, 0, 0, Math.PI * 2);
        gl.moveTo(25, 39);
        gl.ellipse(15, 39, 10, 9, 0, 0, Math.PI * 2);
        gl.moveTo(-5, 41); gl.lineTo(5, 41);
        this.strokePath(gl, outline, 2.2);
        this.fill(this.oval(-15, 39, 20, 18), new Color(1, 1, 1, 0.18));
        this.fill(this.oval(15, 39, 20, 18), new Color(1, 1, 1, 0.18));
      } else if (this.pose.accessory === 'headphones') {
        const band = new Path2D();
        band.arc(0, 38, 44, (15 * Math.PI) / 180, (165 * Math.PI) / 180, false);
        this.strokePath(band, outline, 5);
        this.strokePath(band, SYS.pink, 2.5);
        for (const side of [-1, 1]) {
          const cup = new Path2D();
          cup.roundRect(side * 44 - 7, 26, 14, 24, 6);
          this.fillStroke(cup, SYS.pink);
        }
      }
      if (this.pose.nightcap) {
        const cap = new Path2D();
        cap.moveTo(-26, 58);
        cap.bezierCurveTo(-10, 66, 10, 68, 26, 60);
        cap.bezierCurveTo(34, 78, 42, 78, 46, 66);
        cap.bezierCurveTo(30, 90, -12, 86, -26, 58);
        cap.closePath();
        this.fillStroke(cap, new Color(0.3, 0.4, 0.85));
        this.fillStroke(this.oval(46, 66, 11, 11), Color.white);
      }
      void ctx;
    }

    drawEyes(style, t, dx, dy) {
      const blinking = fmod(t, 4.3) < 0.13;
      for (const side of [-1, 1]) {
        const ex = side * 15 + dx, ey = 40 + dy;
        let s = style;
        if (blinking && (s === 'open' || s === 'focused')) s = 'closed';
        switch (s) {
          case 'open': case 'focused':
            this.fill(this.oval(ex, ey, 9, s === 'focused' ? 8 : 12), outline);
            this.fill(this.oval(ex + 1.6, ey + 2.4, 3.2, 3.2), Color.white);
            break;
          case 'wide':
            this.fillStroke(this.oval(ex, ey, 14, 15), Color.white, 2);
            this.fill(this.oval(ex + dx * 0.4, ey + dy * 0.4, 6, 7), outline);
            break;
          case 'closed': this.line([[ex - 5, ey], [ex, ey - 2.5], [ex + 5, ey]], 2.2); break;
          case 'happy': this.line([[ex - 5, ey - 2], [ex, ey + 3], [ex + 5, ey - 2]], 2.4); break;
          case 'half':
            this.fill(this.oval(ex, ey - 2, 9, 7), outline);
            this.fillRect(rect(ex - 6, ey - 1, 12, 6), fur);
            this.line([[ex - 5, ey - 1], [ex + 5, ey - 1]], 2.2);
            break;
          case 'cross':
            this.line([[ex - 4, ey - 4], [ex + 4, ey + 4]], 2.4);
            this.line([[ex - 4, ey + 4], [ex + 4, ey - 4]], 2.4);
            break;
        }
      }
    }

    drawMouth(style, dx, dy) {
      const x = dx, y = 30 + dy;
      switch (style) {
        case 'w': {
          const p = new Path2D();
          p.arc(x - 3, y, 3, Math.PI, Math.PI * 2, false);
          p.arc(x + 3, y, 3, Math.PI, Math.PI * 2, false);
          this.strokePath(p, outline, 2, 'round');
          break;
        }
        case 'smile': {
          const p = new Path2D();
          p.moveTo(x - 6, y);
          p.bezierCurveTo(x - 4, y - 7, x + 4, y - 7, x + 6, y);
          p.closePath();
          this.fill(p, outline);
          this.fill(this.oval(x, y - 3.5, 5, 2.5), pink);
          break;
        }
        case 'open': this.fill(this.oval(x, y - 2, 6, 7), outline); break;
        case 'yawn':
          this.fill(this.oval(x, y - 3, 10, 12), outline);
          this.fill(this.oval(x, y - 6, 6, 4), pink);
          break;
        case 'flat': this.line([[x - 4, y - 1], [x + 4, y - 1]], 2); break;
      }
    }

    // MARK: Props (canvas coordinates)

    drawProps(m, t, cx, g, base) {
      switch (m) {
        case 'typing': {
          const tapA = abs(sin(t * 15)) * 4, tapB = abs(cos(t * 15)) * 4;
          this.arm([cx + 30, base + 22], [cx + 52, g + 11 + tapA]);
          this.arm([cx + 34, base + 16], [cx + 68, g + 10 + tapB]);
          break;
        }
        case 'thinking': this.arm([cx + 34, base + 14], [cx + 24, base + 25]); break;
        case 'reading': this.drawBook(cx, base + 4, t); break;
        case 'searching': {
          const lx = cx + 34 + sin(t * 1.7) * 6, ly = base + 40 + cos(t * 2.3) * 4;
          const handle = new Path2D();
          handle.moveTo(lx + 9, ly - 9); handle.lineTo(lx + 20, ly - 22);
          this.strokePath(handle, outline, 7, 'round');
          this.strokePath(handle, SYS.brown, 4, 'round');
          this.fillStroke(this.oval(lx, ly, 26, 26), SYS.teal.alpha(0.3), 3.5);
          this.fill(this.oval(lx - 5, ly + 5, 6, 4), new Color(1, 1, 1, 0.7));
          this.fillStroke(this.oval(lx + 20, ly - 22, 13, 11), furLight);
          break;
        }
        case 'needsYou': {
          const a = 1.1 + sin(t * 12) * 0.45;
          const sx = cx + 30, sy = base + 34;
          this.arm([sx, sy], [sx + cos(a) * 22, sy + sin(a) * 22]);
          break;
        }
        case 'tidying': {
          const a = -0.5 + sin(t * 6) * 0.35;
          const tx = cx + 36, ty = base + 44;
          const ex = tx + sin(a) * 46, ey = ty - cos(a) * 46;
          const stick = new Path2D();
          stick.moveTo(tx, ty); stick.lineTo(ex, ey);
          this.strokePath(stick, outline, 6);
          this.strokePath(stick, SYS.brown, 3);
          this.fillStroke(this.oval(ex, ey + 2, 20, 10), SYS.yellow, 2);
          for (let i = 0; i < 3; i++) {
            const phase = fmod(t * 1.5 + i / 3, 1);
            this.fill(this.oval(ex + 8 + phase * 20, g + 4 + phase * 10, 6 + phase * 8, 6 + phase * 8), new Color(0.6, 0.6, 0.6, 0.6 * (1 - phase)));
          }
          this.fillStroke(this.oval(tx, ty, 13, 11), furLight);
          break;
        }
      }
    }

    /** Sparkles, hearts, sweat, and dizzy stars. Shared by the cat and sprite packs. */
    drawEffects(m, t, cx, base) {
      switch (m) {
        case 'done': {
          const spots = [[-56, 64], [52, 76], [-36, 100], [44, 36], [-58, 26]];
          spots.forEach(([x, y], i) => {
            const r = 4 + abs(sin(t * 4 + i)) * 6;
            this.fillStroke(this.star(cx + x, base + y, r), i % 2 === 0 ? SYS.yellow : SYS.orange, 1.5);
          });
          break;
        }
        case 'petted':
          for (let i = 0; i < 3; i++) {
            const phase = fmod(t * 0.9 + i / 3, 1);
            const x = cx + [-30, 2, 32][i] + sin(phase * 6) * 5;
            this.fill(this.heart(x, base + 78 + phase * 44, 14), SYS.pink.alpha(1 - phase));
          }
          break;
        case 'oops': this.fillStroke(this.teardrop(cx + 33, base + 62), SYS.cyan.alpha(0.8), 1.8); break;
        case 'error': case 'dizzy':
          for (let i = 0; i < 3; i++) {
            const a = t * 3 + i * 2.1;
            this.fillStroke(this.star(cx + cos(a) * 32, base + 80 + sin(a) * 6, 6), SYS.yellow, 1.5);
          }
          break;
      }
    }

    /** Thought cloud, Zzz, and "!" — hidden while a speech bubble is showing. */
    drawThoughts(m, t, cx, base) {
      const ctx = this.ctx;
      const theme = this.theme;
      switch (m) {
        case 'thinking': {
          if (this.pose.thoughtBubble === 'off') return;
          ctx.save();
          if (this.pose.thoughtBubble === 'small') {
            // Shrink toward the head, where the trail of little circles starts.
            const hx = cx + 26, hy = base + 78;
            ctx.translate(hx, hy); ctx.scale(0.5, 0.5); ctx.translate(-hx, -hy);
          }
          const c = [cx + 54, base + 116];
          const puffs = [[-22, 0, 15], [0, 7, 19], [22, 0, 15], [-9, -8, 13], [11, -8, 13], [-28, -38, 3.5], [-20, -26, 5.5]];
          const paths = puffs.map(([x, y, r]) => this.oval(c[0] + x, c[1] + y, r * 2, r * 2));
          for (const p of paths) this.strokePath(p, theme.bubbleStroke, 5);
          for (const p of paths) this.fill(p, theme.bubbleFill);
          for (let i = 0; i < 3; i++) {
            this.fill(this.oval(c[0] - 12 + i * 12, c[1] + max(0, sin(t * 6 - i)) * 4, 6, 6), theme.bubbleText);
          }
          ctx.restore();
          break;
        }
        case 'sleeping':
          for (let i = 0; i < 3; i++) {
            const phase = fmod(t * 0.35 + i / 3, 1);
            this.text(i % 2 === 0 ? 'z' : 'Z', cx + 30 + phase * 30, base + 74 + phase * 50, 11 + phase * 10, outline.alpha(1 - phase));
          }
          break;
        case 'needsYou': {
          const x = cx + 44, y = base + 94;
          this.fill(this.oval(x, y, 28, 28), theme.alertFill);
          this.strokePath(this.oval(x, y, 28, 28), theme.bubbleStroke, 2.5);
          this.text('!', x, y, 20, theme.textOn(theme.alertFill));
          break;
        }
        case 'startled': this.text('!', cx, base + 96, 22, outline); break;
      }
    }

    drawLaptop(t) {
      const screen = new Path2D();
      screen.roundRect(6, 8, 58, 42, 4);
      this.fillStroke(screen, new Color(0.32, 0.32, 0.32));
      const inner = rect(10, 12, 50, 34);
      this.fillRect(inner, new Color(0.1, 0.14, 0.22));

      const widths = [28, 18, 36, 22, 30, 14, 40, 24, 20, 33];
      const colors = [SYS.pink, SYS.teal, SYS.yellow, SYS.green, SYS.purple];
      const progress = Math.floor(t * 3.5);
      const visible = min(6, (progress % 12) + 1);
      const scroll = Math.floor(progress / 12);
      for (let i = 0; i < visible; i++) {
        const k = (i + scroll * 3) % widths.length;
        const indent = k % 3 === 1 ? 6 : 0;
        let w = widths[k];
        if (i === visible - 1) w *= fmod(t * 3.5, 1);
        this.fillRect(rect(inner.x + 4 + indent, inner.y + inner.height - 6 - i * 5, min(w, inner.width - 8 - indent), 2.4), colors[k % colors.length].alpha(0.9));
      }

      const deck = this.poly([[-2, 0], [70, 0], [64, 9], [4, 9]]);
      this.fillStroke(deck, new Color(0.82, 0.82, 0.82), 2.5, 'round');
      this.fillRect(rect(10, 4, 48, 2), new Color(0.6, 0.6, 0.6));
    }

    drawBook(cx, y, t) {
      this.fillStroke(this.poly([[cx - 30, y + 2], [cx, y - 2], [cx + 30, y + 2], [cx + 30, y + 30], [cx, y + 26], [cx - 30, y + 30]]), SYS.red);
      for (const side of [-1, 1]) {
        this.fillStroke(this.poly([[cx, y], [cx + side * 27, y + 4], [cx + side * 27, y + 30], [cx, y + 26]]), Color.white, 1.5);
        for (let i = 0; i < 4; i++) this.fillRect(rect(side > 0 ? cx + 4 : cx - 23, y + 9 + i * 5, 19, 1.5), new Color(0.7, 0.7, 0.7));
      }
      const phase = fmod(t, 2.5) / 0.45;
      if (phase < 1) {
        const edge = cx + 27 * (1 - 2 * phase);
        this.fillStroke(this.poly([[cx, y], [edge, y + 6], [edge, y + 32], [cx, y + 26]]), new Color(0.96, 0.96, 0.96), 1.5);
      }
      this.fillStroke(this.oval(cx - 31, y + 16, 13, 12), furLight);
      this.fillStroke(this.oval(cx + 31, y + 16, 13, 12), furLight);
    }

    drawMinis(cx, g, t) {
      const xs = [cx - 82, cx + 82].filter((x) => x > 20 && x < this.canvas.width - 20);
      xs.slice(0, min(this.pose.subagents, 2)).forEach((x, i) => {
        const hop = abs(sin(t * 7 + i * 1.7)) * 3;
        this.fill(this.oval(x, g - 1, 32, 5), new Color(0, 0, 0, 0.12));
        this.at(x - 6, g + hop, { scale: 0.4 }, () => this.drawCat('typing', t + i, 'focused', 'w', { x: 0.9, y: -0.5 }));
        this.at(x + 8, g, { scale: 0.4 }, () => this.drawLaptop(t + i));
      });
      if (this.pose.subagents > 2) this.text(`+${this.pose.subagents - 2}`, cx + 82, g + 44, 11, outline);
    }

    drawSpeech(s, anchorX, y) {
      const ctx = this.ctx;
      const theme = this.theme;
      ctx.save();
      ctx.font = `600 12px ${FONT}`;
      const lines = this.wrap(s, 196);
      const textW = max(...lines.map((l) => ctx.measureText(l).width));
      const lineH = 15;
      const w = Math.ceil(textW) + 20, h = lines.length * lineH + 10;
      const tailY = min(y, this.H - h - 12);
      const x = min(max(4, anchorX - w / 2), this.W - w - 4);
      const r = rect(x, tailY + 8, w, h);
      const bubble = new Path2D();
      bubble.roundRect(r.x, r.y, r.width, r.height, 10);
      const tail = this.poly([[anchorX - 7, tailY + 10], [anchorX + 2, tailY], [anchorX + 7, tailY + 10]]);
      for (const p of [bubble, tail]) this.strokePath(p, theme.bubbleStroke, 2.5, 'butt', 'round');
      const fill = theme.bubbleFill.alpha(0.97);
      this.fill(bubble, fill);
      this.fill(tail, fill);
      lines.forEach((line, i) => {
        this.text(line, r.x + r.width / 2, r.y + r.height - 5 - lineH * (i + 0.5), 12, theme.bubbleText, 600);
      });
      ctx.restore();
    }

    drawCaption(s, statusColor) {
      const ctx = this.ctx;
      const color = this.theme.captionFill(statusColor);
      ctx.save();
      ctx.font = `600 10.5px ${FONT}`;
      let text = s;
      const maxW = this.W - 24;
      while (ctx.measureText(text).width > maxW && text.length > 1) text = text.slice(0, -2) + '…';
      const w = min(this.W - 8, ctx.measureText(text).width + 18);
      const r = rect(this.W / 2 - w / 2, 3, w, 18);
      const pill = new Path2D();
      pill.roundRect(r.x, r.y, r.width, r.height, 9);
      this.fill(pill, color.alpha(0.92));
      this.text(text, this.W / 2, r.y + 9, 10.5, this.theme.textOn(color), 600);
      ctx.restore();
    }

    drawResizeOverlay() {
      const ctx = this.ctx;
      const box = this.resizeBox();
      const accent = this.theme.resizeAccent;
      const border = new Path2D();
      border.roundRect(box.x, box.y, box.width, box.height, 6);
      this.fill(border, accent.alpha(0.06));
      ctx.save();
      ctx.setLineDash([6, 4]);
      this.strokePath(border, accent, 1.5);
      ctx.restore();
      for (const h of this.handleRects()) {
        const p = new Path2D();
        p.roundRect(h.x, h.y, h.width, h.height, 3);
        this.fill(p, Color.white);
        this.strokePath(p, accent, 2);
      }
      const pill = this.doneRect();
      const pp = new Path2D();
      pp.roundRect(pill.x, pill.y, pill.width, pill.height, 11);
      this.fill(pp, accent);
      this.text(this.doneLabel(), pill.x + pill.width / 2, pill.y + pill.height / 2, 11.5, this.theme.textOn(accent), 600);
    }

    // MARK: Helpers

    at(x, y, { scale = 1, flip = false, rotate = 0, pivotY = 70, scaleY = 1 } = {}, body) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(x, y);
      if (rotate) { ctx.translate(0, pivotY); ctx.rotate(rotate); ctx.translate(0, -pivotY); }
      ctx.scale(flip ? -scale : scale, scale * scaleY);
      body();
      ctx.restore();
    }

    oval(cx, cy, w, h) {
      const p = new Path2D();
      p.ellipse(cx, cy, w / 2, h / 2, 0, 0, Math.PI * 2);
      return p;
    }

    poly(points) {
      const p = new Path2D();
      points.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
      p.closePath();
      return p;
    }

    fill(path, color) { this.ctx.fillStyle = color.css(); this.ctx.fill(path); }
    fillRect(r, color) { this.ctx.fillStyle = color.css(); this.ctx.fillRect(r.x, r.y, r.width, r.height); }

    strokePath(path, color, width, cap = 'butt', join = 'miter') {
      const ctx = this.ctx;
      ctx.strokeStyle = color.css();
      ctx.lineWidth = width;
      ctx.lineCap = cap;
      ctx.lineJoin = join;
      ctx.stroke(path);
    }

    fillStroke(path, fillColor, width = 2.5, join = 'miter') {
      this.fill(path, fillColor);
      this.strokePath(path, outline, width, 'butt', join);
    }

    line(points, width) {
      const p = new Path2D();
      points.forEach(([x, y], i) => (i === 0 ? p.moveTo(x, y) : p.lineTo(x, y)));
      this.strokePath(p, outline, width, 'round', 'round');
    }

    arm(a, b) {
      const p = new Path2D();
      p.moveTo(a[0], a[1]); p.lineTo(b[0], b[1]);
      this.strokePath(p, outline, 12, 'round');
      this.strokePath(p, fur, 7.5, 'round');
      this.fillStroke(this.oval(b[0], b[1], 14, 11), furLight);
    }

    /** Draws upright text centered at (x, y) in the y-up space. */
    text(s, x, y, size, color, weight = 800) {
      const ctx = this.ctx;
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(1, -1);
      ctx.font = `${weight} ${size}px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color.css();
      ctx.fillText(s, 0, 0);
      ctx.restore();
    }

    wrap(s, maxWidth) {
      const ctx = this.ctx;
      const lines = [];
      let line = '';
      for (const word of s.split(' ')) {
        const next = line ? `${line} ${word}` : word;
        if (ctx.measureText(next).width > maxWidth && line) { lines.push(line); line = word; } else line = next;
      }
      if (line) lines.push(line);
      return lines.length ? lines : [''];
    }

    /** Draws an image upright into a y-up rect, optionally mirrored. */
    image(img, r, flip, pixelated) {
      const ctx = this.ctx;
      ctx.save();
      ctx.imageSmoothingEnabled = !pixelated;
      ctx.imageSmoothingQuality = 'high';
      ctx.translate(flip ? r.x + r.width : r.x, r.y + r.height);
      ctx.scale(flip ? -1 : 1, -1);
      ctx.drawImage(img, 0, 0, r.width, r.height);
      ctx.restore();
    }

    star(cx, cy, r) {
      const pts = [];
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4 + Math.PI / 2;
        const rr = i % 2 === 0 ? r : r * 0.38;
        pts.push([cx + cos(a) * rr, cy + sin(a) * rr]);
      }
      return this.poly(pts);
    }

    heart(cx, cy, s) {
      const p = new Path2D();
      p.moveTo(cx, cy - s * 0.5);
      p.bezierCurveTo(cx - s * 0.15, cy - s * 0.25, cx - s * 0.5, cy - s * 0.1, cx - s * 0.5, cy + s * 0.15);
      p.arc(cx - s * 0.25, cy + s * 0.15, s * 0.25, Math.PI, 0, true);
      p.arc(cx + s * 0.25, cy + s * 0.15, s * 0.25, Math.PI, 0, true);
      p.bezierCurveTo(cx + s * 0.5, cy - s * 0.1, cx + s * 0.15, cy - s * 0.25, cx, cy - s * 0.5);
      p.closePath();
      return p;
    }

    teardrop(cx, cy) {
      const p = new Path2D();
      p.moveTo(cx, cy + 10);
      p.bezierCurveTo(cx - 1, cy + 6, cx - 5, cy + 2, cx - 5, cy - 2);
      p.arc(cx, cy - 2, 5, Math.PI, 0, false);
      p.bezierCurveTo(cx + 5, cy + 2, cx + 1, cy + 6, cx, cy + 10);
      p.closePath();
      return p;
    }
  }

  PetRenderer.GROUND = GROUND;
  PetRenderer.contains = contains;
  window.PetRenderer = PetRenderer;
})();
