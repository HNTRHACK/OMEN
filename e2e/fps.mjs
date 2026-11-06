// Frame-rate benchmark: walk a loop around Blockhaven for 20 s while the camera turns, and report
// per-second FPS (median / 5th percentile) and where adaptive quality settled.
// Usage: node e2e/fps.mjs http://localhost:5173/        (E2E_GPU=1 to use the real GPU)
import { launch, enter, BASE } from "./lib.mjs";

const browser = await launch();
const { page, logs } = await enter(browser, `${BASE.replace(/\/$/, "")}/?dev=1`);
const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const ext = gl?.getExtension("WEBGL_debug_renderer_info");
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : "unknown";
});
await page.evaluate(() => window.__omen.teleport(-9.6, 5.7, 0, 0));
await page.waitForTimeout(1500);
const startLevel = await page.evaluate(() => window.__omen.perf.level);
await page.keyboard.down("w");
await page.keyboard.down("Shift");
const box = await page.$("#scene");
const b = await box.boundingBox();
await page.mouse.move(b.width / 2, b.height / 2);
await page.mouse.down();
for (let i = 0; i < 40; i++) {
  await page.mouse.move(b.width / 2 + Math.sin(i / 3) * 120, b.height / 2, { steps: 4 });
  await page.waitForTimeout(500);
}
await page.mouse.up();
await page.keyboard.up("Shift");
await page.keyboard.up("w");
const { hist, level } = await page.evaluate(() => window.__omen.perf.stats());
const sorted = hist.slice(-18).sort((a, b) => a - b);
const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
const res = { renderer: gpu, viewport: "1280x800", samples: sorted.length, medianFps: +pct(0.5).toFixed(1), p5Fps: +pct(0.05).toFixed(1), startQuality: startLevel, settledQuality: level, pageErrors: logs.length };
console.log(JSON.stringify(res));
await browser.close();
