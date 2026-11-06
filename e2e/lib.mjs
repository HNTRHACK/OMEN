// Shared Playwright helpers for OMEN's browser tests.
// CHROME_PATH: a Chromium/Chrome binary (default: Playwright's cached Chromium, if installed).
// E2E_GPU=1 uses the real GPU instead of SwiftShader (software) rendering.
import { chromium } from "playwright-core";

export const BASE = process.argv[2] || process.env.BASE_URL || "http://localhost:5173/";
const SW = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const GPU = ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"];

export async function launch() {
  return chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: process.env.E2E_GPU ? GPU : SW });
}

/** Open the game, start fresh, skip the intro lines. Returns { page, logs, ctx }. */
export async function enter(browser, url = BASE, { name, viewport = { width: 1280, height: 800 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const logs = [];
  page.on("pageerror", (e) => logs.push("pageerror: " + e.stack));
  page.on("console", (m) => m.type() === "error" && logs.push("console: " + m.text()));
  await page.goto(url);
  await page.waitForSelector("#start:not([hidden])", { timeout: 120000 });
  if (name && (await page.$("#mp-name"))) await page.fill("#mp-name", name);
  await page.click("#start");
  await page.waitForFunction(() => window.__omen?.mode === "play", null, { timeout: 60000 });
  for (let i = 0; i < 8 && (await page.isVisible("#dialogue")); i++) {
    await page.click(".dlg-panel");
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(300);
  return { page, logs, ctx };
}

/** Exit non-zero if any check failed, so CI can use these. */
export function finish(results) {
  const bad = Object.entries(results).filter(([, ok]) => !ok);
  console.log(bad.length ? `FAILED: ${bad.map(([k]) => k).join(", ")}` : "ALL PASS");
  process.exit(bad.length ? 1 : 0);
}
