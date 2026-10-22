// Pose sounds for the Windows app: small synthesized effects (macOS uses its system sounds),
// overridable by a sprite pack's sounds/<event>.(wav|mp3|ogg|m4a) files.
(() => {
  let ctx = null;
  const custom = new Map();
  const audio = () => (ctx = ctx || new AudioContext());
  const VOLUME = 0.32;

  function tone(freq, start, duration, { type = 'sine', gain = 1, endFreq = null } = {}) {
    const a = audio();
    const osc = a.createOscillator();
    const env = a.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, a.currentTime + start);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, a.currentTime + start + duration);
    env.gain.setValueAtTime(0.0001, a.currentTime + start);
    env.gain.exponentialRampToValueAtTime(VOLUME * gain, a.currentTime + start + 0.012);
    env.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + start + duration);
    osc.connect(env).connect(a.destination);
    osc.start(a.currentTime + start);
    osc.stop(a.currentTime + start + duration + 0.05);
  }

  /** A soft purr: low noise pulsing ~25 times a second. */
  function purr() {
    const a = audio();
    const length = Math.floor(a.sampleRate * 0.9);
    const buffer = a.createBuffer(1, length, a.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      last = (last + 0.04 * (Math.random() * 2 - 1)) / 1.04; // brown noise
      const pulse = 0.5 + 0.5 * Math.sin((2 * Math.PI * 25 * i) / a.sampleRate);
      const fade = Math.min(1, i / 2000, (length - i) / 6000);
      data[i] = last * 6 * pulse * fade;
    }
    const src = a.createBufferSource();
    const filter = a.createBiquadFilter();
    const env = a.createGain();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    env.gain.value = VOLUME * 1.6;
    src.buffer = buffer;
    src.connect(filter).connect(env).connect(a.destination);
    src.start();
  }

  const SYNTH = {
    pet: purr,
    done: () => [523.25, 659.25, 783.99].forEach((f, i) => tone(f, i * 0.09, 0.32, { type: 'triangle' })),
    'needs-you': () => { tone(783.99, 0, 0.25, { type: 'triangle' }); tone(1046.5, 0.16, 0.4, { type: 'triangle' }); },
    bounce: () => tone(620, 0, 0.12, { endFreq: 180, gain: 0.8 }),
    wake: () => tone(1760, 0, 0.18, { type: 'triangle', gain: 0.6 }),
    'level-up': () => [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.07, i === 3 ? 0.5 : 0.18, { type: 'square', gain: 0.35 })),
    'focus-done': () => [783.99, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, i * 0.12, 0.35, { type: 'triangle' })),
  };

  window.DeskPetSounds = {
    async setPack(files) {
      custom.clear();
      for (const f of files || []) {
        try { custom.set(f.event, await audio().decodeAudioData(f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength))); } catch (_) { /* unsupported file */ }
      }
    },
    play(event) {
      const a = audio();
      if (a.state === 'suspended') a.resume();
      const buffer = custom.get(event);
      if (buffer) {
        const src = a.createBufferSource();
        const env = a.createGain();
        env.gain.value = VOLUME * 1.5;
        src.buffer = buffer;
        src.connect(env).connect(a.destination);
        src.start();
      } else if (SYNTH[event]) {
        SYNTH[event]();
      }
    },
  };
})();
