// "Only humans play OMEN": the first screen. World ID (IDKit, action "play-omen") proven to the
// server (/api/verify calls World's verify API), then a wallet on Whitechain Sepolia linked to that
// one human. The browser never decides it is verified: it asks /api/human.
import { qrCanvas } from "../pay/qr.js";
import { wallet, whitechain } from "../pay/wallet.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function api(path, body) {
  const r = await fetch(path, { method: body ? "POST" : "GET", credentials: "same-origin", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.message || `HTTP ${r.status}`), { code: j.error, status: r.status });
  return j;
}

/** The current server-confirmed human, or null. */
export const human = { current: null, guest: false };
export const fetchHuman = () => api("/api/human").then((r) => (human.current = r.human)).catch(() => (human.current = null));

/** Show the gate; resolves once the player is a verified human (or, if the server allows it, an unverified dev guest). */
export function humanGate() {
  const el = $("#gate");
  return new Promise(async (done) => {
    let cfg = { configured: false };
    try {
      [cfg] = await Promise.all([api("/api/world/config"), fetchHuman()]);
    } catch {
      /* offline server: shown below */
    }
    el.hidden = false;
    const finish = () => {
      el.classList.add("leaving");
      setTimeout(() => ((el.hidden = true), el.classList.remove("leaving")), 450);
      done(human.current);
    };
    let abort = null;

    const step = (html) => ($("#gate-body").innerHTML = html);

    const showVerify = (err = "") => {
      step(`
        <p class="gate-lede">OMEN is one human, one courier. Prove you're a unique person with World ID — no name, no email, nothing personal leaves your phone.</p>
        ${cfg.configured ? "" : `<p class="gate-err">World ID isn't configured on this server yet (needs <code>VITE_WORLD_APP_ID</code>, <code>WORLD_RP_ID</code>, <code>WORLD_RP_SIGNING_KEY</code>).</p>`}
        ${cfg.environment === "staging" ? `<p class="gate-note">STAGING: verify with the <a href="https://simulator.worldcoin.org/" target="_blank" rel="noopener">World ID simulator</a>. Not a real World ID.</p>` : ""}
        <div class="gate-levels" role="radiogroup" aria-label="Verification level">
          <label><input type="radio" name="lvl" value="orb" checked> <b>Orb</b> <small>strongest: verified in person</small></label>
          <label><input type="radio" name="lvl" value="device"> <b>Device</b> <small>any phone with World App</small></label>
        </div>
        <button id="gate-go" class="btn" type="button" ${cfg.configured ? "" : "disabled"}>Verify with World ID</button>
        ${err ? `<p class="gate-err">${esc(err)}</p>` : ""}
        ${!cfg.configured && cfg.allowGuest ? `<button id="gate-guest" class="linkish" type="button">Continue UNVERIFIED (dev server only — no predictions)</button>` : ""}`);
      $("#gate-go")?.addEventListener("click", () => verify($("input[name=lvl]:checked").value));
      $("#gate-guest")?.addEventListener("click", () => ((human.guest = true), finish()));
    };

    async function verify(level) {
      step(`<p class="gate-lede">Asking the server for a signed World ID request…</p>`);
      try {
        const ctx = await api("/api/world/rp-context", {});
        const { IDKit, orbLegacy, deviceLegacy } = await import("@worldcoin/idkit-core");
        const preset = (level === "device" ? deviceLegacy : orbLegacy)({ signal: "omen-player" });
        const request = await IDKit.request({ app_id: ctx.app_id, action: ctx.action, rp_context: ctx.rp_context, allow_legacy_proofs: true, environment: ctx.environment }).preset(preset);
        const uri = request.connectorURI;
        step(`
          <p class="gate-lede">Scan with <b>World App</b>${ctx.environment === "staging" ? " (or paste the link into the simulator)" : ""}.</p>
          <div class="gate-qr"></div>
          <p class="gate-row"><a class="btn small ghost" href="${esc(uri)}" target="_blank" rel="noopener">Open in World App</a> <button class="btn small ghost" id="gate-copy" type="button">Copy link</button></p>
          <p class="gate-note" id="gate-wait">Waiting for your phone… <button class="linkish" id="gate-cancel" type="button">cancel</button></p>`);
        $(".gate-qr").append(qrCanvas(uri, 256));
        $("#gate-copy").onclick = () => navigator.clipboard?.writeText(uri);
        abort = new AbortController();
        $("#gate-cancel").onclick = () => abort.abort();
        const out = await request.pollUntilCompletion({ pollInterval: 1500, timeout: 300000, signal: abort.signal });
        if (!out.success) return showVerify(out.error === "cancelled" || abort.signal.aborted ? "" : `World ID didn't complete (${out.error}).`);
        $("#gate-wait").textContent = "Checking your proof with World…";
        const v = await api("/api/verify", { result: out.result });
        human.current = v.human;
        showWallet(v.returning ? "Welcome back. Same human, same courier." : "");
      } catch (e) {
        showVerify(e.message);
      }
    }

    const badge = () =>
      human.current.environment === "production"
        ? `<p class="gate-badge ok">✓ VERIFIED HUMAN <small>World ID · ${esc(human.current.level)}</small></p>`
        : `<p class="gate-badge staging">STAGING SIMULATOR <small>not a real World ID</small></p>`;

    function showWallet(note = "", err = "") {
      const w = human.current.wallet;
      step(`
        ${badge()}
        ${note ? `<p class="gate-note">${esc(note)}</p>` : ""}
        <p class="gate-lede">${w ? `Your wallet <code>${esc(w.slice(0, 6))}…${esc(w.slice(-4))}</code> is linked.` : "Now link a wallet on <b>Whitechain Sepolia</b> (chain 1874). You'll use it to learn to pay — testnet tokens only."}</p>
        <button id="gate-wallet" class="btn" type="button">${w ? "Play" : wallet.available() ? "Connect wallet" : "No browser wallet found"}</button>
        ${w ? "" : `<button id="gate-nowallet" class="linkish" type="button">Skip the wallet for now (the tutorial payment will be simulated)</button>`}
        ${err ? `<p class="gate-err">${esc(err)}</p>` : ""}
        <p class="gate-fine">Testnet tokens only. No real money. Just for fun.</p>`);
      $("#gate-nowallet")?.addEventListener("click", finish);
      $("#gate-wallet").disabled = !w && !wallet.available();
      $("#gate-wallet").onclick = async () => {
        if (w) return finish();
        $("#gate-wallet").disabled = true;
        try {
          await linkWallet();
          finish();
        } catch (e) {
          showWallet("", e.shortMessage || e.message);
        }
      };
    }

    if (human.current) showWallet();
    else showVerify();
  });
}

/** Connect the browser wallet, switch to Whitechain Sepolia and prove ownership to the server. */
export async function linkWallet() {
  if (!wallet.address) await wallet.connect();
  await wallet.ensureChain(whitechain);
  const { message } = await api(`/api/human/wallet-message?address=${wallet.address}`);
  const signature = await wallet.provider.request({ method: "personal_sign", params: [toHex(message), wallet.address] });
  const r = await api("/api/human/wallet", { address: wallet.address, message, signature });
  human.current = r.human;
  return r.human;
}
const toHex = (s) => "0x" + [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");
