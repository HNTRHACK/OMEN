// Shared Playwright helpers for OMEN's browser tests.
// CHROME_PATH: a Chromium/Chrome binary (default: Playwright's cached Chromium, if installed).
// E2E_GPU=1 uses the real GPU instead of SwiftShader (software) rendering.
import { chromium } from "playwright-core";

export const BASE = process.argv[2] || process.env.BASE_URL || "http://localhost:5173/";
const SW = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
const GPU = ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"];


/** Webfonts are decoration; fetching them from the public internet makes runs depend on the network. */
async function blockFonts(ctx) {
  if (process.env.E2E_FONTS) return;
  await ctx.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (r) => r.abort());
}

export async function launch() {
  return chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: process.env.E2E_GPU ? GPU : SW });
}

/** Open the game, start fresh, skip the intro lines. Returns { page, logs, ctx }. */
export async function enter(browser, url = BASE, { name, outfit, look, viewport = { width: 1280, height: 800 } } = {}) {
  const ctx = await browser.newContext({ viewport });
  await blockFonts(ctx);
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
  await passGate(page);
  // landing → avatar creator → play
  await page.waitForSelector("#join:not([hidden])", { timeout: 120000 });
  await page.click("#join");
  await page.waitForSelector("#creator:not([hidden]) #mp-name");
  if (name) await page.fill("#mp-name", name);
  const want = { ...(look || {}), ...(outfit != null ? { jacket: outfit } : {}) };
  for (const [k, i] of Object.entries(want)) {
    // mirrors CREATOR_TABS in src/main.js (Face / Eyes / Hair / Outfit / Accessories / Pet)
    const tab = { skin: "face", hair: "hair", hairStyle: "hair", body: "outfit", jacket: "outfit", pants: "outfit", scarf: "outfit", hat: "outfit", hatColor: "outfit", accessory: "extras", pet: "pet" }[k];
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
 * "Only humans play OMEN": tests run against a dev server started with OMEN_ALLOW_UNVERIFIED_GUEST=1
 * and take its clearly-labelled UNVERIFIED path (or a session a test set up itself).
 */
export async function passGate(page) {
  await page.waitForSelector("#gate:not([hidden]) #gate-body button", { timeout: 120000 });
  if (await page.isVisible("#gate-guest")) await page.click("#gate-guest");
  else await page.click("#gate-wallet:not([disabled]), #gate-nowallet");
  await page.waitForSelector("#gate", { state: "hidden" });
}

/**
 * A browser context whose window.ethereum forwards to a LOCAL anvil fork, as `account`
 * (anvil's dev accounts are unlocked, so no keys are involved). Records every wallet method.
 */
export async function forkWalletContext(browser, account, rpc = process.env.FORK_RPC || "http://127.0.0.1:8545", viewport = { width: 1280, height: 800 }) {
  const ctx = await browser.newContext({ viewport });
  await blockFonts(ctx);
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

/** JSON-RPC against the local fork. A fork fetches state lazily from the public node, which can
 *  hiccup, so retry; and never turn an error into `undefined`: throw what the node said. */
export const rpc = async (method, params, url = process.env.FORK_RPC || "http://127.0.0.1:8545") => {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const j = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
      if (j.result !== undefined) return j.result;
      last = JSON.stringify(j.error);
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  throw new Error(`${method} failed after retries: ${last}`);
};

/** Exit non-zero if any check failed, so CI can use these. */
export function finish(results) {
  const bad = Object.entries(results).filter(([, ok]) => !ok);
  console.log(bad.length ? `FAILED: ${bad.map(([k]) => k).join(", ")}` : "ALL PASS");
  process.exit(bad.length ? 1 : 0);
}
