// Small color helper mirroring the NSColor operations the macOS version uses.
class Color {
  constructor(r, g, b, a = 1) {
    this.r = r; this.g = g; this.b = b; this.a = a;
  }

  /** Accepts "#RGB" or "#RRGGBB", with or without "#". */
  static hex(hex) {
    let s = String(hex || '').trim().toUpperCase().replace(/^#/, '');
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    if (!/^[0-9A-F]{6}$/.test(s)) return null;
    const v = parseInt(s, 16);
    return new Color(((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255);
  }

  css() {
    const c = (x) => Math.round(Math.min(1, Math.max(0, x)) * 255);
    return `rgba(${c(this.r)},${c(this.g)},${c(this.b)},${this.a})`;
  }

  hexString() {
    const c = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
    return `#${c(this.r)}${c(this.g)}${c(this.b)}`.toUpperCase();
  }

  alpha(a) { return new Color(this.r, this.g, this.b, a); }

  /** Mix `fraction` of `other` into this color. */
  blend(fraction, other) {
    const m = (x, y) => x + (y - x) * fraction;
    return new Color(m(this.r, other.r), m(this.g, other.g), m(this.b, other.b), m(this.a, other.a));
  }

  luminance() { return 0.2126 * this.r + 0.7152 * this.g + 0.0722 * this.b; }

  /** Darkens until luminance is at most `max`, keeping the hue. */
  darkened(max) {
    let c = this;
    for (let i = 0; i < 12 && c.luminance() > max; i++) c = c.blend(0.15, Color.black);
    return c;
  }
}

Color.white = new Color(1, 1, 1);
Color.black = new Color(0, 0, 0);

// Approximations of the macOS system colors used by the Swift version.
const SYS = {
  pink: Color.hex('#FF2D55'), teal: Color.hex('#30B0C7'), yellow: Color.hex('#FFCC00'),
  orange: Color.hex('#FF9500'), red: Color.hex('#FF3B30'), green: Color.hex('#34C759'),
  purple: Color.hex('#AF52DE'), blue: Color.hex('#007AFF'), indigo: Color.hex('#5856D6'),
  gray: Color.hex('#8E8E93'), cyan: Color.hex('#32ADE6'), mint: Color.hex('#00C7BE'),
  brown: new Color(0.6, 0.4, 0.2),
};

const INK = new Color(0.29, 0.19, 0.15);

/** UI colors derived from one accent color; a null accent means the built-in look. */
class Theme {
  constructor(accent = null) { this.accent = accent; }
  static fromHex(hex) { const c = Color.hex(hex); return c ? new Theme(c) : new Theme(); }
  get bubbleStroke() { return this.accent ? this.accent.darkened(0.55) : INK; }
  get bubbleFill() { return this.accent ? this.accent.blend(0.9, Color.white) : Color.white; }
  get bubbleText() { return this.accent ? this.accent.darkened(0.35) : INK; }
  get alertFill() { return this.accent || SYS.yellow; }
  get resizeAccent() { return this.accent || SYS.blue; }
  captionFill(status) { return this.accent || status; }
  textOn(fill) { return fill.luminance() > 0.62 ? INK : Color.white; }
}

window.DeskPetColor = { Color, SYS, INK, Theme };
