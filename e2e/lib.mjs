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
export async function enter(browser, url = BASE, { name, outfit, look, viewport = { width: 1280, height: 800 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const logs = [];
  page.on("pageerror", (e) => logs.push("pageerror: " + e.stack));
  // "Failed to load resource" console lines don't say which URL; requestfailed does. A failed
  // same-origin request is an error; a third-party one (Google Fonts) is a warning only.
  page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && logs.push("console: " + m.text()));
  page.on("requestfailed", (r) => {
    const line = `request failed: ${r.url().slice(0, 100)} (${r.failure()?.errorText})`;
    if (new URL(r.url()).origin === new URL(url).origin) logs.push(line);
    else console.log("warning, third-party " + line);
  });
  await page.goto(url);
  // landing → avatar creator → play
  await page.waitForSelector("#join:not([hidden])", { timeout: 120000 });
  await page.click("#join");
  await page.waitForSelector("#creator:not([hidden]) #mp-name");
  if (name) await page.fill("#mp-name", name);
  const want = { ...(look || {}), ...(outfit != null ? { jacket: outfit } : {}) };
  for (const [k, i] of Object.entries(want)) {
    const tab = { skin: "look", hair: "look", hairStyle: "look", body: "look", jacket: "outfit", pants: "outfit", scarf: "outfit", hat: "outfit", hatColor: "outfit", accessory: "extras", pet: "extras" }[k];
    await page.click(`.cr-tabs [data-tab="${tab}"]`);
    await page.click(`[data-k="${k}"][data-i="${i}"]`);
  }
  await page.click("#start");
  await page.waitForFunction(() => window.__omen?.mode === "play", null, { timeout: 60000 });
  for (let i = 0; i < 8 && (await page.isVisible("#dialogue")); i++) {
    await page.click(".dlg-panel");
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(300);
  return { page, logs, ctx };
}

/**
 * A browser context whose window.ethereum forwards to a LOCAL anvil fork, as `account`
 * (anvil's dev accounts are unlocked, so no keys are involved). Records every wallet method.
 */
export async function forkWalletContext(browser, account, rpc = process.env.FORK_RPC || "http://127.0.0.1:8545", viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(({ account, rpc }) => {
    window.__walletCalls = [];
    window.ethereum = {
      on() {},
      async request({ method, params }) {
        window.__walletCalls.push(method);
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
        if (method === "wallet_switchEthereumChain") {
          if (parseInt(params[0].chainId, 16) === 1874) return null;
          throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
        }
        if (method === "wallet_addEthereumChain") return null;
        const r = await (await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return r.result;
      },
    };
  }, { account, rpc });
  return ctx;
}

export const rpc = async (method, params, url = process.env.FORK_RPC || "http://127.0.0.1:8545") =>
  (await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()).result;

/** Exit non-zero if any check failed, so CI can use these. */
export function finish(results) {
  const bad = Object.entries(results).filter(([, ok]) => !ok);
  console.log(bad.length ? `FAILED: ${bad.map(([k]) => k).join(", ")}` : "ALL PASS");
  process.exit(bad.length ? 1 : 0);
}
