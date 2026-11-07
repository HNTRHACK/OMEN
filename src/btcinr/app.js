// OMEN Pay: the two-phone BTC→INR demo (Phone A pays, Phone B receives), on Codex's real
// backend (server/CONTRACT-BTCINR.md). Everything shown comes from the server: balances, quotes,
// receipts, notifications. Labelled SIMULATED BTC → INR SETTLEMENT throughout.
import "../style.css";
import "./pay.css";
import { api, live, keyFor, forgetKey, ApiError, LABEL } from "./api.js";
import { formatPaise, formatSats, formatRate, parseInr, ago, codeFromQr } from "./money.js";
import { qrCanvas, scanCamera, decodeFile } from "../pay/qr.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const main = $("#app");
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
};
const when = (t) => new Date(t).toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const payUrl = (code) => `${location.origin}${location.pathname.replace(/[^/]*$/, "")}pay.html#/r/${code}`;

// friendly messages for the contract's error codes (never shown for success paths)
const WHY = {
  insufficient_funds: "Not enough DEMO BTC for this payment.",
  quote_expired: "That quote expired. Get a fresh one.",
  quote_used: "This quote was already used.",
  request_paid: "This payment request has already been paid.",
  request_expired: "This payment request has expired. Ask the merchant for a new QR.",
  request_not_found: "That QR isn't a valid OMEN Pay request.",
  self_payment: "You can't pay your own shop. Use a different phone (or browser) as the customer.",
  rate_stale: "The BTC/INR rate is out of date, so quotes are paused. Try again in a moment.",
  rate_unavailable: "No BTC/INR rate is available right now, so payments are paused.",
  bad_amount: "Enter an amount between ₹0.01 and ₹10,000.",
  merchant_exists: "This device already has a merchant shop. Sign in to it instead.",
  bad_credentials: "That merchant ID and access code don't match.",
  login_limited: "Too many sign-in attempts. Wait a few minutes and try again.",
  session_expired: "Your session expired. Please sign in again.",
  rate_limited: "Too many requests. Slow down a little.",
  network: "No connection to the OMEN server. Check your network.",
  bad_name: "Use 2–24 letters for your name (2–48 for a business name).",
};
const why = (e) => WHY[e?.code] || e?.message || String(e);

// ---------------------------------------------------------------- shell
let role = null;
let feed = null; // live connection
let chimeCtx = null;
function chime() {
  try {
    chimeCtx ||= new AudioContext();
    const a = chimeCtx;
    [0, 4, 7, 12].forEach((n, i) => {
      const o = a.createOscillator();
      const g = a.createGain();
      o.frequency.value = 523.25 * 2 ** (n / 12);
      g.gain.setValueAtTime(0.0001, a.currentTime + i * 0.08);
      g.gain.exponentialRampToValueAtTime(0.18, a.currentTime + i * 0.08 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + i * 0.08 + 0.35);
      o.connect(g).connect(a.destination);
      o.start(a.currentTime + i * 0.08);
      o.stop(a.currentTime + i * 0.08 + 0.4);
    });
  } catch {
    /* no audio */
  }
}
function toast(html, kind = "") {
  const t = $("#toast");
  t.className = `pay-toast ${kind}`;
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 6000);
}
function setConn(state) {
  const el = $("#conn");
  el.dataset.state = state;
  el.textContent = { live: "live", reconnecting: "reconnecting…", unauthorized: "signed out", off: "" }[state] ?? state;
}
function render(html) {
  main.innerHTML = html;
  main.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => go(b.dataset.go)));
  (main.querySelector("[autofocus]") || null)?.focus({ preventScroll: true });
}
const go = (h) => (location.hash = h);
const err = (e) => `<p class="err" role="alert">${esc(why(e))}</p>`;
const balanceCard = (kind, value) =>
  kind === "btc"
    ? `<section class="bal" data-balance><p class="bal-k">DEMO BTC balance</p><p class="bal-v"><span data-btc>${formatSats(value)}</span> <small>BTC</small></p><p class="bal-s"><span data-sats>${BigInt(value).toLocaleString("en-IN")}</span> demo satoshis · no cash value</p></section>`
    : `<section class="bal inr" data-balance><p class="bal-k">DEMO INR balance</p><p class="bal-v" data-inr>${formatPaise(value)}</p><p class="bal-s">simulated settlement · no rupees move in any bank</p></section>`;

// ---------------------------------------------------------------- home
function home() {
  render(`<section class="card hero"><h1>OMEN Pay</h1><p>Pay with DEMO bitcoin; the shop receives DEMO rupees. Use two phones: one pays, one receives.</p></section>
    <div class="roles">
      <button class="role" data-go="#/customer"><b>📱 Pay</b><span>Phone A · customer with a DEMO BTC wallet</span></button>
      <button class="role" data-go="#/merchant"><b>🏪 Receive</b><span>Phone B · merchant showing a QR</span></button>
    </div>
    <p class="fine">${esc(LABEL)}: no bitcoin moves on any blockchain and no rupees move through any bank or UPI. Balances are OMEN demo ledger entries with no cash value.</p>`);
}

// ---------------------------------------------------------------- customer (Phone A)
let customer = null;
async function customerHome(msg = "") {
  role = "customer";
  store.set("omen.btcinr.role", "customer");
  render(`<p class="loading">Loading your wallet…</p>`);
  try {
    customer = await api.customer();
  } catch (e) {
    if (e.code === "no_account") return customerJoin();
    return render(`${err(e)}<button class="btn" data-go="#/">Back</button>`);
  }
  connect("customer");
  render(`${balanceCard("btc", customer.balance.btcSats)}
    ${msg}
    <div class="row-actions big"><button class="btn" data-go="#/scan" autofocus>Scan to pay</button></div>
    <p class="who">Signed in as <b>${esc(customer.displayName)}</b> · this device's OMEN guest identity</p>
    <h2>Your payments</h2><ul class="hist" id="hist"><li class="muted">Loading…</li></ul>`);
  history("customer");
}
function customerJoin() {
  render(`<section class="card"><h2>Join OMEN Pay</h2><p>Your DEMO wallet is funded once with <b>0.01000000 DEMO BTC</b> (1,000,000 demo satoshis). It has no cash value.</p>
    <form id="join" class="form"><label>Your name<input name="n" required minlength="2" maxlength="24" autocomplete="nickname" autofocus></label><button class="btn">Create my DEMO wallet</button></form>
    <p class="fine">This phone's OMEN guest identity is your customer account. Use a different phone or browser for the merchant.</p></section>`);
  $("#join").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector("button");
    b.disabled = true;
    try {
      customer = await api.joinCustomer(e.target.n.value.trim());
      const pending = sessionStorage.getItem("omen.btcinr.pendingCode");
      if (pending) return go(`#/r/${pending}`);
      customerHome();
    } catch (er) {
      b.disabled = false;
      e.target.insertAdjacentHTML("beforeend", err(er));
    }
  };
}
let scanner = null;
function scan(msg = "") {
  render(`<section class="card"><h2>Scan the shop's QR</h2>
    <div class="cam"><video id="vid" playsinline muted></video><div class="cam-frame"></div></div>
    <p class="fine" id="cam-msg">Point the camera at the QR on the merchant's phone.</p>
    ${msg}
    <div class="row-actions"><label class="btn ghost file">Upload a photo of the QR<input type="file" id="qrfile" accept="image/*" hidden></label></div>
    <form id="code-f" class="form inline"><label>Or type the code<input name="c" placeholder="rq_…" autocomplete="off" spellcheck="false"></label><button class="btn small">Go</button></form>
    <button class="linkish" data-go="#/customer">← Back to wallet</button></section>`);
  const useText = (text) => {
    const code = codeFromQr(text, location.origin);
    if (!code) return scan(`<p class="err">That QR isn't an OMEN Pay request from this site, so it wasn't opened.</p>`);
    stopScan();
    go(`#/r/${code}`);
  };
  scanner = scanCamera($("#vid"));
  scanner.result.then((t) => t && useText(t)).catch((e) => ($("#cam-msg").innerHTML = `<span class="err">${esc(e.name === "NotAllowedError" ? "Camera permission was declined. Upload a photo of the QR or type the code." : `The camera isn't available (${e.message}). Upload a photo or type the code.`)}</span>`));
  $("#qrfile").onchange = async (e) => {
    try {
      useText(await decodeFile(e.target.files[0]));
    } catch (er) {
      $("#cam-msg").innerHTML = `<span class="err">${esc(er.message)}</span>`;
    }
  };
  $("#code-f").onsubmit = (e) => (e.preventDefault(), useText(e.target.c.value));
}
const stopScan = () => (scanner?.stop(), (scanner = null));

let quoteTimer = 0;
async function payFlow(code) {
  role = "customer";
  try {
    customer = await api.customer();
  } catch (e) {
    if (e.code === "no_account") {
      sessionStorage.setItem("omen.btcinr.pendingCode", code);
      return customerJoin();
    }
    return render(err(e));
  }
  sessionStorage.removeItem("omen.btcinr.pendingCode");
  connect("customer");
  render(`<p class="loading">Opening the payment request…</p>`);
  let req;
  let rate = null;
  try {
    [req, rate] = await Promise.all([api.request(code), api.rate().catch((e) => ({ error: e }))]);
  } catch (e) {
    return render(`${err(e)}<div class="row-actions"><button class="btn" data-go="#/scan">Scan again</button></div>`);
  }
  const fixed = req.inrPaise != null;
  const rateLine = rate?.error
    ? `<p class="rate bad">${esc(why(rate.error))}</p>`
    : `<p class="rate ${rate.stale ? "bad" : ""}">Indicative rate <b>${formatRate(rate.inrPerBtc)}</b> per BTC · ${esc(rate.source === "coingecko" ? "CoinGecko" : rate.source)} · updated ${esc(ago(rate.fetchedAt))}${rate.stale ? " · <b>stale: quotes paused</b>" : ""}</p>`;
  render(`${balanceCard("btc", customer.balance.btcSats)}
    <section class="card"><p class="kick">Paying</p><h2 class="merchant">${esc(req.merchant.businessName)}</h2>
      ${req.reference ? `<p class="ref">For: ${esc(req.reference)}</p>` : ""}
      <form id="amt" class="form"><label>Amount in INR${fixed ? " <small>(set by the merchant)</small>" : ""}<input name="a" inputmode="decimal" ${fixed ? `value="${(req.inrPaise / 100).toFixed(2)}" readonly` : 'placeholder="0.00" autofocus'} required></label>
      ${rateLine}<button class="btn" ${rate?.error || rate?.stale ? "disabled" : ""}>Get BTC quote</button></form>
      <div id="q"></div></section>
    <button class="linkish" data-go="#/customer">Cancel</button>`);
  $("#amt").onsubmit = async (e) => {
    e.preventDefault();
    const paise = fixed ? req.inrPaise : parseInr(e.target.a.value);
    if (!paise) return ($("#q").innerHTML = err({ code: "bad_amount" }));
    const b = e.target.querySelector("button");
    b.disabled = true;
    try {
      showQuote(await api.quote(code, paise), code);
    } catch (er) {
      $("#q").innerHTML = err(er);
    }
    b.disabled = false;
  };
}

function showQuote(q, code) {
  clearInterval(quoteTimer);
  const enough = BigInt(customer.balance.btcSats) >= BigInt(q.btcSats);
  $("#q").innerHTML = `<div class="quote" data-quote="${esc(q.id)}">
      <dl><dt>${esc(q.merchant.businessName)} receives</dt><dd class="inr">${formatPaise(q.inrPaise)} <small>DEMO INR</small></dd>
      <dt>You pay</dt><dd class="btc">${formatSats(q.btcSats)} <small>DEMO BTC</small><br><small>${BigInt(q.btcSats).toLocaleString("en-IN")} satoshis, rounded up</small></dd>
      <dt>Rate</dt><dd>${formatRate(q.inrPerBtc)} per BTC <small>· ${esc(q.rateSource === "coingecko" ? "CoinGecko" : q.rateSource)}, ${esc(when(q.rateFetchedAt))}</small></dd>
      <dt>Quote valid</dt><dd><b id="left">…</b></dd></dl>
      ${enough ? "" : `<p class="err">Not enough DEMO BTC for this payment.</p>`}
      <button class="btn big" id="confirm" ${enough ? "" : "disabled"}>Confirm payment</button>
      <p class="fine">${esc(LABEL)}. Nothing moves on any blockchain or bank.</p></div>`;
  const left = () => {
    const s = Math.max(0, Math.round((q.expiresAt - Date.now()) / 1000));
    const el = $("#left");
    if (!el) return clearInterval(quoteTimer);
    el.textContent = s ? `${s} s` : "expired";
    if (!s) {
      clearInterval(quoteTimer);
      const c = $("#confirm");
      if (c && !c.dataset.sent) {
        c.disabled = true;
        c.insertAdjacentHTML("afterend", `<button class="btn ghost" id="requote">Get a fresh quote</button>`);
        $("#requote").onclick = () => $("#amt").requestSubmit();
      }
    }
  };
  left();
  quoteTimer = setInterval(left, 1000);
  $("#confirm").onclick = () => confirmPay(q);
}

/** Settle with the quote's own idempotency key. Never show success before status "confirmed". */
async function confirmPay(q, attempt = 1) {
  const c = $("#confirm");
  if (c) {
    c.disabled = true;
    c.dataset.sent = "1";
    c.textContent = attempt > 1 ? "Checking whether it went through…" : "Confirming with the OMEN ledger…";
  }
  try {
    const r = await api.pay(q.id, keyFor(q.id));
    if (r.payment?.status !== "confirmed") throw new ApiError(500, "internal", "The ledger didn't confirm this payment.");
    forgetKey(q.id);
    clearInterval(quoteTimer);
    chime();
    navigator.vibrate?.(60);
    go(`#/receipt/${r.payment.id}?new=1`);
  } catch (e) {
    // an unknown outcome (lost response, timeout, server error) is retried with the SAME key
    if ((e.code === "network" || e.status >= 500) && attempt < 4) {
      await new Promise((res) => setTimeout(res, 1200 * attempt));
      return confirmPay(q, attempt + 1);
    }
    if (c) {
      c.textContent = "Confirm payment";
      c.disabled = ["quote_expired", "quote_used", "insufficient_funds", "request_paid"].includes(e.code);
      delete c.dataset.sent;
      c.insertAdjacentHTML("afterend", err(e));
    }
  }
}

// ---------------------------------------------------------------- merchant (Phone B)
let merchant = null;
async function merchantHome(msg = "") {
  role = "merchant";
  store.set("omen.btcinr.role", "merchant");
  render(`<p class="loading">Opening your shop…</p>`);
  try {
    merchant = await api.merchant();
  } catch (e) {
    if (["unauthorized", "session_expired", "no_identity", "merchant_not_found"].includes(e.code) || e.status === 401) return merchantSignIn(e.code === "session_expired" ? err(e) : "");
    return render(`${err(e)}<button class="btn" data-go="#/">Back</button>`);
  }
  store.set("omen.btcinr.merchantId", merchant.id);
  connect("merchant");
  render(`${balanceCard("inr", merchant.balance.inrPaise)}
    ${msg}
    <section class="card qrcard"><p class="kick">Scan to pay</p><h2 class="merchant">${esc(merchant.businessName)}</h2>
      <div class="qr" id="qr"></div><p class="fine" id="qr-note">Any amount · the customer enters it</p>
      <details><summary>Ask for a specific amount</summary>
        <form id="fixed" class="form"><label>Amount in INR<input name="a" inputmode="decimal" placeholder="250.00" required></label><label>Reference <small>(optional)</small><input name="r" maxlength="40" placeholder="Table 4"></label><button class="btn small">Show this QR</button></form></details>
    </section>
    <h2>Payments received</h2><ul class="hist" id="hist"><li class="muted">Loading…</li></ul>
    <p class="who">${esc(merchant.displayName)} · merchant <code>${esc(merchant.id)}</code> <button class="linkish" id="out">Sign out</button></p>`);
  showQr(merchant.receiveCode, null);
  history("merchant");
  $("#fixed").onsubmit = async (e) => {
    e.preventDefault();
    const paise = parseInr(e.target.a.value);
    if (!paise) return e.target.insertAdjacentHTML("beforeend", err({ code: "bad_amount" }));
    try {
      showQr((await api.fixedRequest(paise, e.target.r.value.trim())).code, paise, e.target.r.value.trim());
      e.target.closest("details").open = false;
    } catch (er) {
      e.target.insertAdjacentHTML("beforeend", err(er));
    }
  };
  $("#out").onclick = async () => {
    await api.signOutMerchant().catch(() => {});
    feed?.close();
    feed = null;
    merchantSignIn();
  };
}
function showQr(code, paise, ref = "") {
  const box = $("#qr");
  box.innerHTML = "";
  const c = qrCanvas(payUrl(code), 600);
  c.setAttribute("aria-label", "Payment QR code");
  c.dataset.code = code;
  box.append(c);
  $("#qr-note").innerHTML = paise ? `<b>${formatPaise(paise)}</b>${ref ? ` · ${esc(ref)}` : ""} · single use · expires in 15 min <button class="linkish" id="anyamt">Back to any amount</button>` : "Any amount · the customer enters it";
  $("#anyamt")?.addEventListener("click", () => showQr(merchant.receiveCode, null));
}
function merchantSignIn(msg = "") {
  const lastId = store.get("omen.btcinr.merchantId") || "";
  render(`<section class="card"><h2>Open your shop</h2>${msg}
      <form id="up" class="form"><label>Business name<input name="b" required minlength="2" maxlength="48" placeholder="Chai Point" autofocus></label><label>Your name<input name="n" required minlength="2" maxlength="24"></label><button class="btn">Create my DEMO shop</button></form>
      <p class="fine">Starts at ₹0.00 DEMO INR. One shop per OMEN identity; use a different phone or browser from the customer.</p></section>
    <details class="card" ${lastId ? "open" : ""}><summary>Already have a shop? Sign in</summary>
      <form id="in" class="form"><label>Merchant ID<input name="id" required value="${esc(lastId)}" autocomplete="username" spellcheck="false"></label><label>Access code<input name="code" required autocomplete="current-password" spellcheck="false"></label><button class="btn small">Sign in</button></form>
      <button class="linkish" id="recover">Lost the code? Recover with this device's identity</button></details>`);
  $("#up").onsubmit = async (e) => {
    e.preventDefault();
    const b = e.target.querySelector("button");
    b.disabled = true;
    try {
      const r = await api.signUpMerchant(e.target.b.value.trim(), e.target.n.value.trim());
      showAccessCode(r);
    } catch (er) {
      b.disabled = false;
      e.target.insertAdjacentHTML("beforeend", err(er));
    }
  };
  $("#in").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api.signInMerchant(e.target.id.value.trim(), e.target.code.value.trim());
      merchantHome();
    } catch (er) {
      e.target.insertAdjacentHTML("beforeend", err(er));
    }
  };
  $("#recover").onclick = async () => {
    try {
      showAccessCode(await api.recoverMerchant());
    } catch (er) {
      $("#recover").insertAdjacentHTML("afterend", err(er));
    }
  };
}
function showAccessCode(r) {
  store.set("omen.btcinr.merchantId", r.merchant.id);
  render(`<section class="card"><h2>Your shop is open</h2>
    <p>Keep these to sign in on another device. <b>The access code is shown only once.</b></p>
    <dl class="creds"><dt>Merchant ID</dt><dd><code>${esc(r.merchant.id)}</code></dd><dt>Access code</dt><dd><code data-access>${esc(r.accessCode)}</code></dd></dl>
    <button class="btn" id="cont" autofocus>I've saved it: show my QR</button></section>`);
  $("#cont").onclick = () => merchantHome();
}

// ---------------------------------------------------------------- shared: history, receipt, live
async function history(r) {
  const el = $("#hist");
  if (!el) return;
  try {
    const { payments } = await api.history(r);
    if (!$("#hist")) return;
    $("#hist").innerHTML = payments.length
      ? payments.map((p) => `<li><a href="#/receipt/${esc(p.id)}"><b>${esc(r === "merchant" ? p.customer.displayName : p.merchant.businessName)}</b><span>${r === "merchant" ? `+${formatPaise(p.inrPaise)}` : `−${formatSats(p.btcSats)} BTC`}</span><small>${esc(when(p.confirmedAt))} · ${esc(p.status)}</small></a></li>`).join("")
      : `<li class="muted">No payments yet.</li>`;
  } catch (e) {
    if ($("#hist")) $("#hist").innerHTML = `<li>${err(e)}</li>`;
  }
}
async function receipt(id, fresh) {
  render(`<p class="loading">Loading the receipt…</p>`);
  let p;
  try {
    p = await api.payment(id);
  } catch (e) {
    return render(`${err(e)}<button class="btn" data-go="#/${role || ""}">Back</button>`);
  }
  const mine = role === "merchant";
  render(`<section class="card receipt ${p.status === "confirmed" ? "ok" : ""}" data-receipt="${esc(p.id)}">
      ${p.status === "confirmed" ? `<p class="stamp">${fresh ? "Payment confirmed" : "Confirmed"}</p>` : `<p class="err">Status: ${esc(p.status)}</p>`}
      <p class="amt">${formatPaise(p.inrPaise)}</p>
      <p class="sub">${mine ? `received from <b>${esc(p.customer.displayName)}</b>` : `paid to <b>${esc(p.merchant.businessName)}</b>`}</p>
      <dl>
        <dt>Customer paid</dt><dd>${formatSats(p.btcSats)} DEMO BTC <small>(${BigInt(p.btcSats).toLocaleString("en-IN")} sats)</small></dd>
        <dt>Merchant received</dt><dd>${formatPaise(p.inrPaise)} DEMO INR</dd>
        <dt>Rate</dt><dd>${formatRate(p.inrPerBtc)} / BTC · ${esc(p.rateSource === "coingecko" ? "CoinGecko" : p.rateSource)} · ${esc(when(p.rateFetchedAt))}</dd>
        <dt>From</dt><dd>${esc(p.customer.displayName)}</dd>
        <dt>To</dt><dd>${esc(p.merchant.businessName)}</dd>
        ${p.reference ? `<dt>Reference</dt><dd>${esc(p.reference)}</dd>` : ""}
        <dt>Confirmed</dt><dd>${esc(when(p.confirmedAt))}</dd>
        <dt>Transaction ID</dt><dd><code data-txid>${esc(p.id)}</code></dd>
        <dt>Order ID</dt><dd><code>${esc(p.orderId)}</code></dd>
        <dt>Settlement</dt><dd><b>${esc(p.label || LABEL)}</b><br><small>No blockchain hash, UTR or bank reference exists: this is OMEN's demo ledger.</small></dd>
      </dl>
      <button class="btn" data-go="#/${mine ? "merchant" : "customer"}" autofocus>Done</button></section>`);
}

function connect(r) {
  if (feed && feed.role === r) return;
  feed?.close();
  const resync = async () => {
    try {
      if (r === "customer") {
        customer = await api.customer();
        setBalance(customer.balance, customer.version);
      } else {
        merchant = await api.merchant();
        setBalance(merchant.balance, merchant.version);
      }
      if ($("#hist")) history(r);
    } catch (e) {
      if (e.status === 401) setConn("unauthorized");
    }
  };
  feed = live(r, {
    resync,
    onState: setConn,
    onBalance: (b, v) => setBalance(b, v),
    onPayment: (p) => {
      if (r === "merchant") {
        chime();
        navigator.vibrate?.([80, 60, 80]);
        toast(`<b>Payment received · ${formatPaise(p.inrPaise)}</b><br>from ${esc(p.customer.displayName)} · ${esc(LABEL)} <a href="#/receipt/${esc(p.id)}">View receipt</a>`, "ok");
      }
      if ($("#hist")) history(r);
    },
    onExpired: () => {
      setConn("unauthorized");
      if (r === "merchant") merchantSignIn(err({ code: "session_expired" }));
    },
  });
  feed.role = r;
}
let balVersion = -1;
function setBalance(b, v) {
  if (v != null && v < balVersion) return; // older update: ignore
  if (v != null) balVersion = v;
  if (b.btcSats != null && $("[data-btc]")) {
    $("[data-btc]").textContent = formatSats(b.btcSats);
    $("[data-sats]").textContent = BigInt(b.btcSats).toLocaleString("en-IN");
  }
  if (b.inrPaise != null && $("[data-inr]")) {
    const el = $("[data-inr]");
    if (el.textContent !== formatPaise(b.inrPaise)) {
      el.textContent = formatPaise(b.inrPaise);
      el.closest(".bal").classList.remove("flash");
      void el.offsetWidth;
      el.closest(".bal").classList.add("flash");
    }
  }
}

// ---------------------------------------------------------------- router
function route() {
  stopScan();
  clearInterval(quoteTimer);
  const h = location.hash || "";
  let m;
  if ((m = /^#\/r\/([A-Za-z0-9_-]{6,64})$/.exec(h))) return payFlow(m[1]);
  if ((m = /^#\/receipt\/([A-Za-z0-9_-]+)(\?new=1)?$/.exec(h))) return receipt(m[1], !!m[2]);
  if (h === "#/customer") return customerHome();
  if (h === "#/scan") return scan();
  if (h === "#/merchant") {
    balVersion = -1;
    return merchantHome();
  }
  const last = store.get("omen.btcinr.role");
  if (h === "" && last) return go(`#/${last}`);
  home();
}
$("#label").textContent = LABEL;
role = store.get("omen.btcinr.role"); // so a receipt opened directly shows this phone's side
addEventListener("hashchange", route);
route();
window.__pay = { api, get role() {
  return role;
} }; // test hook (read-only views)
