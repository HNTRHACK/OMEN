// Adaptive quality + developer frame-rate overlay (?dev=1).
//
// The ink-outline look renders the scene several times per frame, so resolution is what costs the
// most. When the average frame rate stays low, step down: render scale first, then the shadow map.
// When it stays high, step back up (never above the starting level). Changes are spaced out so the
// image doesn't flicker between levels.
export const LEVELS = [
  { name: "high", scale: 1, shadow: 2048 },
  { name: "medium", scale: 0.85, shadow: 2048 },
  { name: "low", scale: 0.7, shadow: 1024 },
  { name: "lowest", scale: 0.55, shadow: 512 },
];

export function createPerf({ renderer, sun, basePR, mobile, apply }) {
  const dev = new URLSearchParams(location.search).has("dev");
  let level = mobile ? 1 : 0;
  const start = level;
  let frames = 0;
  let acc = 0;
  let lastChange = 0;
  let clock = 0;
  const hist = []; // recent 1-second FPS samples
  let el = null;
  if (dev) {
    el = document.createElement("pre");
    el.id = "fps";
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = "position:fixed;left:8px;top:58px;z-index:40;margin:0;font:12px/1.35 ui-monospace,Consolas,monospace;background:rgba(43,34,48,.82);color:#fbf3e4;padding:6px 8px;border-radius:6px;pointer-events:none";
    document.body.append(el);
  }

  function set(i) {
    level = Math.max(0, Math.min(LEVELS.length - 1, i));
    const L = LEVELS[level];
    apply(basePR * L.scale);
    if (sun.shadow.mapSize.x !== L.shadow) {
      sun.shadow.mapSize.set(L.shadow, L.shadow);
      sun.shadow.map?.dispose();
      sun.shadow.map = null; // three.js rebuilds it at the new size
    }
  }
  set(level);

  return {
    get level() {
      return LEVELS[level].name;
    },
    stats: () => ({ level: LEVELS[level].name, hist: hist.slice() }),
    frame(dt) {
      frames++;
      acc += dt;
      clock += dt;
      if (acc < 1) return;
      const fps = frames / acc;
      hist.push(fps);
      if (hist.length > 30) hist.shift();
      frames = 0;
      acc = 0;
      const avg3 = hist.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, hist.length);
      if (clock - lastChange > 3 && hist.length >= 3) {
        if (avg3 < 40 && level < LEVELS.length - 1) {
          set(level + 1);
          lastChange = clock;
        } else if (avg3 > 57 && level > start && hist.slice(-8).every((f) => f > 57)) {
          set(level - 1);
          lastChange = clock;
        }
      }
      if (el) {
        const info = renderer.info.render;
        el.textContent = `${fps.toFixed(0)} fps  ${(1000 / fps).toFixed(1)} ms\nquality ${LEVELS[level].name} (${(basePR * LEVELS[level].scale).toFixed(2)}x)\ndraws ${info.calls}  tris ${(info.triangles / 1000).toFixed(0)}k`;
      }
    },
  };
}
