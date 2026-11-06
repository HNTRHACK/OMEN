import * as THREE from "three";
import { audio } from "./audio.js";

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

export const ui = {
  touch: matchMedia("(pointer: coarse)").matches,

  progress(p) {
    $("#load-bar").style.transform = `scaleX(${p})`;
  },
  hideLoading() {
    $("#loading").classList.add("gone");
    setTimeout(() => $("#loading").remove(), 800);
  },

  showTitle(hasSave, onStart) {
    const t = $("#title");
    t.hidden = false;
    $("#continue").hidden = !hasSave;
    $("#start").textContent = hasSave ? "New game" : "Start";
    $("#start").classList.toggle("ghost", hasSave);
    const go = (fresh) => {
      t.classList.add("leaving");
      setTimeout(() => (t.hidden = true), reduce ? 0 : 500);
      onStart(fresh);
    };
    $("#start").onclick = () => go(true);
    $("#continue").onclick = () => go(false);
    (hasSave ? $("#continue") : $("#start")).focus();
  },

  showHud() {
    $("#hud").hidden = false;
    if (ui.touch) $("#touch").hidden = false;
  },

  objective(text) {
    const o = $("#objective");
    if (!text) {
      o.hidden = true;
      return;
    }
    o.hidden = false;
    if ($("#objective-text").textContent !== text) {
      $("#objective-text").textContent = text;
      o.classList.remove("pop");
      void o.offsetWidth;
      o.classList.add("pop");
    }
  },

  toast(text, ms = 3200) {
    const t = $("#toast");
    t.textContent = text;
    t.hidden = false;
    t.classList.remove("in");
    void t.offsetWidth;
    t.classList.add("in");
    clearTimeout(ui._tt);
    ui._tt = setTimeout(() => (t.hidden = true), ms);
  },

  // ---------------------------------------------------------------- floating prompt over a speaker
  prompt(label, worldPos, camera) {
    const p = $("#prompt");
    if (!label) {
      p.hidden = true;
      return;
    }
    const v = worldPos.clone().project(camera);
    if (v.z > 1) {
      p.hidden = true;
      return;
    }
    p.hidden = false;
    $("#prompt-text").textContent = label;
    $("#prompt-key").textContent = ui.touch ? "Tap" : "E";
    p.style.transform = `translate(${((v.x + 1) / 2) * innerWidth}px, ${((1 - v.y) / 2) * innerHeight}px) translate(-50%, -100%)`;
  },

  // ---------------------------------------------------------------- satchel
  setItems(items) {
    const list = $("#satchel-list");
    $("#satchel-count").textContent = items.length ? String(items.length) : "";
    list.innerHTML = items.length
      ? items
          .map(
            (it) => `<li class="item"><div class="item-icon" aria-hidden="true">${ICONS[it.icon] || ""}</div>
            <div><p class="item-name">${esc(it.name)}</p><p class="item-desc">${esc(it.desc)}</p>
            ${it.simulated ? `<p class="sim">Simulated network data</p>` : ""}</div></li>`,
          )
          .join("")
      : `<li class="empty">Your satchel is empty. Deliveries you pick up will be kept here.</li>`;
  },
  bumpSatchel() {
    const b = $("#satchel-btn");
    b.classList.remove("bump");
    void b.offsetWidth;
    b.classList.add("bump");
  },

  chapterCard(onReplay, onExplore) {
    const c = $("#chapter");
    c.hidden = false;
    $("#replay").onclick = () => {
      c.hidden = true;
      onReplay();
    };
    $("#explore").onclick = () => {
      c.hidden = true;
      onExplore();
    };
    $("#explore").focus();
  },
};

// ------------------------------------------------------------------ dialogue

let typing = null;
let cleanupPending = null;
const VOICE = { KAI: 1.15, MAYA: 1.35, ORIN: 0.8, ECHO: 0.6, "RELAY 03": 1.6, "NOTICE BOARD": 1.0 };

ui.say = function say(name, text, { choices = null, tone = "" } = {}) {
  cleanupPending?.();
  const box = $("#dialogue");
  box.hidden = false;
  box.dataset.tone = tone || name.toLowerCase().replace(/\W+/g, "");
  $("#dlg-name").textContent = name;
  const body = $("#dlg-text");
  const ch = $("#dlg-choices");
  const next = $("#dlg-next");
  ch.innerHTML = "";
  next.hidden = true;
  body.textContent = "";
  const full = String(text);
  let i = 0;
  clearInterval(typing);
  return new Promise((resolve) => {
    const done = () => {
      clearInterval(typing);
      typing = null;
      body.textContent = full;
      if (choices) {
        ch.innerHTML = choices.map((c, k) => `<button class="choice" data-k="${k}">${esc(c.label)}</button>`).join("");
        ch.querySelectorAll("button").forEach((b) => {
          b.onclick = (e) => {
            e.stopPropagation();
            cleanup();
            resolve(choices[Number(b.dataset.k)].value);
          };
        });
        ch.querySelector("button")?.focus();
      } else {
        next.hidden = false;
      }
    };
    const advance = (e) => {
      if (e?.target?.closest?.(".choice")) return;
      if (typing) return done();
      if (!choices) {
        cleanup();
        resolve(true);
      }
    };
    const key = (e) => {
      if (["Enter", " ", "e", "E"].includes(e.key) && !(e.target instanceof HTMLButtonElement && e.target.classList.contains("choice"))) {
        e.preventDefault();
        advance();
      }
    };
    const cleanup = () => {
      box.removeEventListener("click", advance);
      removeEventListener("keydown", key);
      if (cleanupPending === cleanup) cleanupPending = null;
    };
    cleanupPending = cleanup;
    box.addEventListener("click", advance);
    setTimeout(() => addEventListener("keydown", key), 60);
    if (reduce) return done();
    const pitch = VOICE[name] || 1;
    typing = setInterval(() => {
      i += 1;
      body.textContent = full.slice(0, i);
      if (i % 3 === 0 && /\w/.test(full[i - 1] || "")) audio.blip(pitch);
      if (i >= full.length) done();
    }, 26);
  });
};

ui.closeDialogue = () => {
  cleanupPending?.();
  $("#dialogue").hidden = true;
};
ui.dialogueOpen = () => !$("#dialogue").hidden;

// ------------------------------------------------------------------ input

let releaseKeys = () => {};
/** Drop every held movement key (call when an overlay takes or returns the keyboard). */
export const clearHeldKeys = () => releaseKeys();

export function bindInput(input, { onAct, onOrbit }) {
  const keys = new Set();
  const sync = () => {
    input.y = (keys.has("w") || keys.has("arrowup") ? 1 : 0) - (keys.has("s") || keys.has("arrowdown") ? 1 : 0);
    input.x = (keys.has("d") || keys.has("arrowright") ? 1 : 0) - (keys.has("a") || keys.has("arrowleft") ? 1 : 0);
    input.run = keys.has("shift");
  };
  addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, select, #pay, #coin-card")) return;
    if (document.querySelector("#pay:not([hidden]), #coin-card:not([hidden])")) return; // an open sheet owns the keyboard
    const k = e.key.toLowerCase();
    if (ui.dialogueOpen()) return;
    if (k === "e" || k === "enter") return onAct();
    if (k === " ") {
      e.preventDefault();
      input.jump = true;
      return;
    }
    if (k === "tab" || k === "i") {
      e.preventDefault();
      toggleSatchel();
      return;
    }
    keys.add(k);
    sync();
  });
  addEventListener("keyup", (e) => {
    keys.delete(e.key.toLowerCase());
    sync();
  });
  // Forget held keys whenever the game loses the keyboard (window blur, tab hidden, an overlay
  // opening or closing); otherwise a key released elsewhere stays "down" and KAI walks on alone.
  releaseKeys = () => {
    keys.clear();
    sync();
  };
  addEventListener("blur", releaseKeys);
  document.addEventListener("visibilitychange", releaseKeys);

  // drag to look around
  const canvas = $("#scene");
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return;
    drag = { x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    onOrbit((e.clientX - drag.x) * 0.006, (e.clientY - drag.y) * 0.004);
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointerup", () => (drag = null));

  // touch: joystick on the left, swipe to look on the right, act + jump buttons
  const pad = $("#joy");
  const knob = $("#joy-knob");
  let id = null;
  let cx = 0;
  let cy = 0;
  pad.addEventListener("pointerdown", (e) => {
    id = e.pointerId;
    const r = pad.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    pad.setPointerCapture(id);
    move(e);
  });
  const move = (e) => {
    if (e.pointerId !== id) return;
    let dx = (e.clientX - cx) / 50;
    let dy = (e.clientY - cy) / 50;
    const len = Math.hypot(dx, dy);
    if (len > 1) {
      dx /= len;
      dy /= len;
    }
    knob.style.transform = `translate(${dx * 38}px, ${dy * 38}px)`;
    input.x = dx;
    input.y = -dy;
    input.run = len > 0.95;
  };
  pad.addEventListener("pointermove", move);
  const end = (e) => {
    if (e.pointerId !== id) return;
    id = null;
    knob.style.transform = "";
    input.x = input.y = 0;
    input.run = false;
  };
  pad.addEventListener("pointerup", end);
  pad.addEventListener("pointercancel", end);
  let look = null;
  $("#look").addEventListener("pointerdown", (e) => {
    look = { id: e.pointerId, x: e.clientX, y: e.clientY };
    $("#look").setPointerCapture(e.pointerId);
  });
  $("#look").addEventListener("pointermove", (e) => {
    if (!look || e.pointerId !== look.id) return;
    onOrbit((e.clientX - look.x) * 0.008, (e.clientY - look.y) * 0.005);
    look.x = e.clientX;
    look.y = e.clientY;
  });
  $("#look").addEventListener("pointerup", () => (look = null));
  $("#act-btn").onclick = onAct;
  $("#jump-btn").onclick = () => (input.jump = true);
  $("#satchel-btn").onclick = toggleSatchel;
  $("#satchel-close").onclick = toggleSatchel;
  $("#sound").onclick = () => {
    const m = audio.toggle();
    $("#sound").setAttribute("aria-pressed", String(!m));
    $("#sound").title = m ? "Sound off" : "Sound on";
  };
  $("#sound").setAttribute("aria-pressed", String(!audio.muted));
}

function toggleSatchel() {
  const s = $("#satchel");
  s.hidden = !s.hidden;
}

// ------------------------------------------------------------------ item icons (hand-drawn SVG)

const stroke = 'fill="none" stroke="#2B2230" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  receipt: `<svg viewBox="0 0 40 40"><path d="M10 5h20v30l-3.3-2.5-3.4 2.5-3.3-2.5-3.4 2.5-3.3-2.5L10 35z" fill="#FBF3E4" ${stroke}/><path d="M15 13h10M15 18h10M15 23h6" ${stroke}/><circle cx="28" cy="10" r="4" fill="#F3D98B" stroke="#2B2230" stroke-width="2"/></svg>`,
  sealed: `<svg viewBox="0 0 40 40"><rect x="5" y="10" width="30" height="21" rx="2" fill="#FBF3E4" ${stroke}/><path d="M5 11l15 11 15-11" ${stroke}/><circle cx="20" cy="22" r="4.5" fill="#B85C4A" stroke="#2B2230" stroke-width="2"/></svg>`,
  lens: `<svg viewBox="0 0 40 40"><circle cx="17" cy="17" r="10" fill="#9FC9D4" ${stroke}/><path d="M24.5 24.5L34 34" ${stroke} stroke-width="4"/><path d="M12 14a6 6 0 0 1 5-4" ${stroke}/></svg>`,
  tea: `<svg viewBox="0 0 40 40"><path d="M10 15h18v9a8 8 0 0 1-8 8h-2a8 8 0 0 1-8-8z" fill="#F1E6D2" ${stroke}/><path d="M28 18h2.5a3.5 3.5 0 0 1 0 7H28" ${stroke}/><path d="M15 6c-1.5 2 1.5 3 0 5M21 6c-1.5 2 1.5 3 0 5" ${stroke}/></svg>`,
};
export { ICONS };
export const tmp = new THREE.Vector3();
