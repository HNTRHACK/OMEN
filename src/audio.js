// Tiny synthesized soundscape (no audio files): wind, birdsong, footsteps, dialogue blips, chimes.
let ctx = null;
let master = null;
let muted = false;
try {
  muted = localStorage.getItem("omen.muted") === "1";
} catch {
  /* storage blocked */
}

export const audio = {
  get muted() {
    return muted;
  },

  start() {
    if (ctx) {
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      return;
    }
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return;
    }
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.55;
    master.connect(ctx.destination);
    wind();
    setInterval(() => !muted && Math.random() < 0.45 && chirp(), 3200);
  },

  toggle() {
    muted = !muted;
    try {
      localStorage.setItem("omen.muted", muted ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (!muted && ctx?.state === "suspended") ctx.resume().catch(() => {});
    if (master) master.gain.setTargetAtTime(muted ? 0 : 0.55, ctx.currentTime, 0.1);
    return muted;
  },

  step(speed) {
    if (!ctx || muted) return;
    noiseBurst(0.045, 900 + Math.random() * 500, 0.05 + Math.min(0.06, speed * 0.008));
  },

  blip(pitch = 1) {
    if (!ctx || muted) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "triangle";
    o.frequency.value = 330 * pitch * (0.94 + Math.random() * 0.12);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.07);
    o.connect(g).connect(master);
    o.start();
    o.stop(ctx.currentTime + 0.08);
  },

  chime(notes = [0, 4, 7, 12], gap = 0.11) {
    if (!ctx || muted) return;
    notes.forEach((n, i) => tone(523.25 * 2 ** (n / 12), ctx.currentTime + i * gap, 0.9, 0.12, "sine"));
  },

  zap() {
    if (!ctx || muted) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(120, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.35);
    g.gain.setValueAtTime(0.0001, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.09, ctx.currentTime + 0.05);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.5);
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.value = 1800;
    o.connect(f).connect(g).connect(master);
    o.start();
    o.stop(ctx.currentTime + 0.55);
    this.chime([7, 12, 16], 0.07);
  },

  jump() {
    if (!ctx || muted) return;
    tone(392, ctx.currentTime, 0.16, 0.05, "triangle", 620);
  },
};

function tone(freq, at, dur, vol, type = "sine", glideTo = null) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, at + dur * 0.7);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(master);
  o.start(at);
  o.stop(at + dur + 0.05);
}

function noiseBuffer(sec) {
  const b = ctx.createBuffer(1, ctx.sampleRate * sec, ctx.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

function noiseBurst(dur, freq, vol) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(dur);
  const f = ctx.createBiquadFilter();
  f.type = "bandpass";
  f.frequency.value = freq;
  f.Q.value = 1.2;
  const g = ctx.createGain();
  g.gain.setValueAtTime(vol, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
  s.connect(f).connect(g).connect(master);
  s.start();
}

function wind() {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuffer(4);
  s.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = "lowpass";
  f.frequency.value = 420;
  const g = ctx.createGain();
  g.gain.value = 0.05;
  const lfo = ctx.createOscillator();
  const lg = ctx.createGain();
  lfo.frequency.value = 0.08;
  lg.gain.value = 0.03;
  lfo.connect(lg).connect(g.gain);
  s.connect(f).connect(g).connect(master);
  s.start();
  lfo.start();
}

function chirp() {
  const at = ctx.currentTime;
  const n = 2 + Math.floor(Math.random() * 3);
  const base = 2200 + Math.random() * 1400;
  for (let i = 0; i < n; i++) tone(base, at + i * 0.13, 0.09, 0.025, "sine", base * 1.35);
}
