// Alfred's conversation sheet and quest book.
//
// Honesty rules baked in: the header badge always says whether answers come from an AI provider or
// from offline scripted advice, every answer carries its own label, and Alfred's disclaimer is
// always visible. Quests are practical plans whose steps point at real places in Blockhaven; the
// game can verify that you ARRIVED, but only you can say you DID the thing, so "done" is a tick box.
import { authed } from "./identity.js";
import { PLACES, PLACE_SHORT } from "../shared/places.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const KEY = "omen.quests.v1";
const MAX_ACTIVE = 4;
const MAX_STORED = 8;

/** Alfred's appearance: the courier rig, dressed as an elderly mentor (see main.js for the cane). */
export const ALFRED_LOOK = Object.freeze({ skin: 1, hair: 4, hairStyle: 0, hat: 4, hatColor: 4, jacket: 4, pants: 3, scarf: 3, body: 2, accessory: 1, pet: 0 });

export const STARTERS = [
  "I want to start a small business. Where do I begin?",
  "How should I prepare for a job interview?",
  "I can't focus when I study. Any tips?",
  "How do the market and payments work here?",
];

const clip = (s, n) => String(s ?? "").slice(0, n);
function loadQuests() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, MAX_STORED).map((q) => ({
      id: clip(q.id, 12) || Math.random().toString(36).slice(2, 10),
      title: clip(q.title, 60),
      why: clip(q.why, 160),
      done: !!q.done,
      rewarded: !!q.rewarded,
      steps: (Array.isArray(q.steps) ? q.steps : []).filter((s) => PLACES[s?.place]).slice(0, 4).map((s) => ({ text: clip(s.text, 160), place: s.place, done: !!s.done, arrived: !!s.arrived })),
    })).filter((q) => q.steps.length);
  } catch {
    return [];
  }
}

export function createAlfredUI({ myName, context, onOpenChange = () => {}, toast, chime, blip, setTalking = () => {}, onComplete = () => {}, onQuestChange = () => {} }) {
  let quests = loadQuests();
  let tracked = null; // { id, i }: the step the guidance marker points at
  let tab = "talk";
  let provider = null;
  let waiting = false;
  const waiters = []; // promises handed out by open(), resolved when the sheet closes
  let managed = false;
  let greeted = false;

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(quests));
    } catch {
      /* storage blocked */
    }
  };
  const active = () => quests.filter((q) => !q.done);

  // ---------------------------------------------------------------- DOM
  const root = document.createElement("div");
  root.id = "alfred";
  root.hidden = true;
  root.innerHTML = `
    <section class="al-sheet" role="dialog" aria-labelledby="al-h">
      <header class="pay-head"><h2 id="al-h">Alfred</h2><span id="al-badge" class="badge demo"></span><button class="x" type="button" aria-label="Close">×</button></header>
      <div class="cr-tabs" role="tablist"><button type="button" role="tab" data-tab="talk">Talk</button><button type="button" role="tab" data-tab="quests">Quests</button></div>
      <div id="al-talk" class="al-pane">
        <div id="al-log" role="log" aria-live="polite" aria-label="Conversation with Alfred"></div>
        <div id="al-chips" class="al-chips"></div>
        <form id="al-form"><input name="q" maxlength="600" autocomplete="off" placeholder="Ask about careers, business, school, life…" aria-label="Your question for Alfred"><button class="btn small">Ask</button></form>
      </div>
      <div id="al-quests" class="al-pane" hidden></div>
      <p class="fine al-foot">Alfred gives general guidance, not professional financial, legal, medical or mental-health advice, and nothing he says is guaranteed. Never share seed phrases or private keys.</p>
    </section>`;
  document.body.append(root);
  const $ = (s) => root.querySelector(s);
  const log = $("#al-log");

  const chip = Object.assign(document.createElement("button"), { id: "quest-chip", type: "button", hidden: true });
  document.getElementById("hud")?.append(chip);
  chip.onclick = () => (root.hidden ? open({ tab: "quests" }) : setTab("quests"));

  root.addEventListener("keydown", (e) => {
    e.stopPropagation(); // WASD/E/T/P/M stay in the sheet while it's open
    if (e.key === "Escape") close();
  });
  // Escape closes the sheet even when focus hasn't reached the text box yet (or has left it).
  document.addEventListener("keydown", (e) => e.key === "Escape" && !root.hidden && close());
  $(".x").onclick = () => close();
  root.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));

  const isOpen = () => !root.hidden;

  function setTab(t) {
    tab = t;
    root.querySelectorAll("[data-tab]").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === t)));
    $("#al-talk").hidden = t !== "talk";
    $("#al-quests").hidden = t !== "quests";
    if (t === "quests") renderQuests();
    // Focus after the opening keypress has finished: focusing synchronously would let the E that
    // opened the sheet be typed into the text box.
    else setTimeout(() => !root.hidden && tab === "talk" && $("#al-form input").focus({ preventScroll: true }), 60);
    refreshLabels();
  }

  function refreshLabels() {
    const n = active().length;
    root.querySelector('[data-tab="quests"]').textContent = n ? `Quests (${n})` : "Quests";
    const b = $("#al-badge");
    if (provider === "claude") (b.textContent = "AI · Claude"), (b.className = "badge real");
    else if (provider === "0g") (b.textContent = "AI · 0G"), (b.className = "badge real");
    else if (provider === "offline") (b.textContent = "Offline mode · not AI"), (b.className = "badge sim");
    else b.textContent = "";
  }

  function open({ tab: t = "talk", managed: m = false } = {}) {
    managed = m;
    const first = root.hidden;
    root.hidden = false;
    if (first && !managed) onOpenChange(true);
    setTab(t);
    if (first) {
      fetch("/api/alfred")
        .then((r) => r.json())
        .then((s) => ((provider = s.provider), refreshLabels(), greet()))
        .catch(() => ((provider = "offline"), refreshLabels(), greet()));
    }
    return new Promise((res) => waiters.push(res));
  }
  function close() {
    if (root.hidden) return;
    if (root.contains(document.activeElement)) document.activeElement.blur();
    root.hidden = true;
    setTalking(false);
    if (!managed) onOpenChange(false);
    waiters.splice(0).forEach((res) => res());
  }

  // ---------------------------------------------------------------- conversation
  function addMsg(who, html, cls = "") {
    const el = Object.assign(document.createElement("div"), { className: `al-msg ${who} ${cls}` });
    el.innerHTML = html;
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  function greet() {
    if (greeted) return;
    greeted = true;
    addMsg("alfred", `<p>Ah, a courier. Pull up a bench. I'm Alfred. Ask me about careers, running a business, studying, or the trickier parts of life, and I'll try to leave you with something you can <i>do</i> this week. I can also set you a small quest around the village.</p>${provider === "offline" ? `<p class="al-note">No AI provider is configured on this server, so for now I answer from a small book of scripted advice. Answers will say so.</p>` : ""}`);
    $("#al-chips").innerHTML = STARTERS.map((s, i) => `<button type="button" class="chip" data-starter="${i}">${esc(s)}</button>`).join("");
    $("#al-chips").querySelectorAll("[data-starter]").forEach((b) => (b.onclick = () => ask(STARTERS[Number(b.dataset.starter)])));
  }

  function typeInto(el, text) {
    return new Promise((resolve) => {
      if (reduce) {
        el.textContent = text;
        return resolve();
      }
      let i = 0;
      setTalking(true);
      const done = () => {
        clearInterval(t);
        el.textContent = text;
        setTalking(false);
        el.removeEventListener("click", done);
        resolve();
      };
      const t = setInterval(() => {
        i += 2;
        el.textContent = text.slice(0, i);
        if (i % 6 === 0 && /\w/.test(text[i - 1] || "")) blip?.(0.7);
        log.scrollTop = log.scrollHeight;
        if (i >= text.length) done();
      }, 22);
      el.addEventListener("click", done); // click to skip the typing
    });
  }

  const questSig = (q) => `${q.title}|${q.steps.map((s) => s.text).join("|")}`;

  async function ask(text) {
    text = String(text || "").trim();
    if (!text || waiting) return;
    waiting = true;
    $("#al-form").querySelector("button").disabled = true;
    $("#al-chips").innerHTML = "";
    addMsg("me", `<p>${esc(text)}</p>`);
    const thinking = addMsg("alfred", `<p class="al-dots" aria-label="Alfred is thinking">Alfred is thinking<span>.</span><span>.</span><span>.</span></p>`);
    try {
      const r = await authed("/api/alfred", { method: "POST", body: { name: myName(), text, context: context() } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.message || `Alfred couldn't answer (HTTP ${r.status}).`);
      thinking.innerHTML = `<p class="al-text"></p>`;
      await typeInto(thinking.querySelector(".al-text"), j.reply);
      thinking.insertAdjacentHTML("beforeend", `<p class="al-label ${j.ai ? "ai" : "off"}">${esc(j.label)}</p>`);
      if (j.quest) {
        const mine = quests.some((q) => questSig(q) === questSig(j.quest));
        thinking.insertAdjacentHTML("beforeend", `<div class="al-quest-card"><b>Quest: ${esc(j.quest.title)}</b><p>${esc(j.quest.why)}</p><ol>${j.quest.steps.map((s) => `<li>${esc(s.text)} <small>@ ${esc(PLACE_SHORT[s.place])}</small></li>`).join("")}</ol><button type="button" class="btn small" data-accept ${mine ? "disabled" : ""}>${mine ? "Accepted" : "Accept quest"}</button></div>`);
        const btn = thinking.querySelector("[data-accept]");
        btn.onclick = () => {
          const err = addQuest(j.quest);
          if (err) return toast(err, 4000);
          btn.disabled = true;
          btn.textContent = "Accepted";
          toast(`Quest accepted: ${j.quest.title}. Follow the marker!`, 4500);
          chime?.();
        };
      }
    } catch (e) {
      thinking.innerHTML = `<p class="err">${esc(e.message)}</p>`;
    } finally {
      waiting = false;
      $("#al-form").querySelector("button").disabled = false;
      $("#al-form input").focus({ preventScroll: true });
      log.scrollTop = log.scrollHeight;
    }
  }
  $("#al-form").onsubmit = (e) => {
    e.preventDefault();
    const input = e.target.q;
    const t = input.value;
    input.value = "";
    ask(t);
  };

  // ---------------------------------------------------------------- quests
  function addQuest(q) {
    if (active().length >= MAX_ACTIVE) return `You already have ${MAX_ACTIVE} quests. Finish or abandon one first.`;
    const quest = { id: Math.random().toString(36).slice(2, 10), title: clip(q.title, 60), why: clip(q.why, 160), done: false, rewarded: false, steps: q.steps.filter((s) => PLACES[s.place]).slice(0, 4).map((s) => ({ text: clip(s.text, 160), place: s.place, done: false, arrived: false })) };
    if (!quest.steps.length) return "That quest has no steps in Blockhaven.";
    quests = [quest, ...quests].slice(0, MAX_STORED);
    tracked = { id: quest.id, i: 0 };
    changed();
    return null;
  }
  const nextStep = (q) => q.steps.findIndex((s) => !s.done);

  function target() {
    let q = tracked && quests.find((x) => x.id === tracked.id && !x.done);
    let i = q ? tracked.i : -1;
    if (!q || q.steps[i]?.done) {
      q = active()[0];
      i = q ? nextStep(q) : -1;
    }
    if (!q || i < 0) return null;
    return { quest: q, i, step: q.steps[i], place: q.steps[i].place };
  }

  function changed() {
    save();
    const t = target();
    const n = active().length;
    chip.hidden = !n;
    if (t) {
      const doneN = t.quest.steps.filter((s) => s.done).length;
      chip.innerHTML = `<b>Quest</b> ${esc(t.quest.title)} <small>${doneN}/${t.quest.steps.length} · next: ${esc(PLACE_SHORT[t.place])}</small>`;
    }
    refreshLabels();
    if (!root.hidden && tab === "quests") renderQuests();
    onQuestChange(t);
  }

  function setDone(qid, i, v) {
    const q = quests.find((x) => x.id === qid);
    if (!q || !q.steps[i]) return;
    q.steps[i].done = v;
    const finished = q.steps.every((s) => s.done);
    if (finished && !q.done) {
      q.done = true;
      toast(`Quest complete: ${q.title}! Nicely done.`, 5000);
      chime?.();
      if (!q.rewarded) {
        q.rewarded = true;
        onComplete(q);
      }
    } else if (!finished && q.done) q.done = false;
    if (tracked?.id === qid) tracked = null; // fall back to the next undone step
    changed();
  }

  /** The game calls this with the place the player is standing at; returns true on a first arrival. */
  function arrived(place) {
    const t = target();
    if (!t || t.place !== place || t.step.arrived) return false;
    t.step.arrived = true;
    changed();
    return true;
  }

  function renderQuests() {
    const pane = $("#al-quests");
    // The pane is rebuilt on every change; keep keyboard focus on the control the player was using.
    const had = pane.contains(document.activeElement) ? { ...document.activeElement.dataset } : null;
    const live = quests.filter((q) => !q.done);
    const finished = quests.filter((q) => q.done);
    const card = (q) => `<article class="al-quest"><h3>${esc(q.title)}</h3><p class="muted">${esc(q.why)}</p><ol>${q.steps
      .map(
        (s, i) => `<li class="${s.done ? "done" : ""}"><label><input type="checkbox" data-q="${esc(q.id)}" data-i="${i}" ${s.done ? "checked" : ""}> ${esc(s.text)}</label>
        <small>@ ${esc(PLACE_SHORT[s.place])}${s.arrived ? ` · <span class="here">you've been here ✓</span>` : ""}</small>
        ${!s.done && !q.done ? `<button class="link" type="button" data-show="${esc(q.id)}" data-i="${i}">Show me</button>` : ""}</li>`,
      )
      .join("")}</ol>${q.done ? "" : `<button class="link" type="button" data-drop="${esc(q.id)}">Abandon quest</button>`}</article>`;
    pane.innerHTML = `${live.length ? live.map(card).join("") : `<p class="muted">No quests yet. Ask Alfred for advice on something real (a job, a business idea, studying) and he'll suggest a small quest.</p>`}
      ${finished.length ? `<h3 class="al-done-h">Completed</h3>${finished.map(card).join("")}` : ""}
      <p class="fine">The game can tell when you've <i>arrived</i> at a place. Whether you actually did the step is up to you: tick it when you have.</p>`;
    if (had?.q) pane.querySelector(`[data-q="${had.q}"][data-i="${had.i}"]`)?.focus({ preventScroll: true });
    pane.querySelectorAll("[data-q]").forEach((c) => (c.onchange = () => setDone(c.dataset.q, Number(c.dataset.i), c.checked)));
    pane.querySelectorAll("[data-show]").forEach(
      (b) =>
        (b.onclick = () => {
          tracked = { id: b.dataset.show, i: Number(b.dataset.i) };
          const q = quests.find((x) => x.id === b.dataset.show);
          toast(`Follow the marker to ${PLACE_SHORT[q.steps[tracked.i].place]}.`, 3500);
          changed();
          close();
        }),
    );
    pane.querySelectorAll("[data-drop]").forEach(
      (b) =>
        (b.onclick = () => {
          quests = quests.filter((q) => q.id !== b.dataset.drop);
          tracked = null;
          changed();
        }),
    );
  }

  changed(); // restore the chip from a previous visit
  return { open, close, isOpen, target, arrived, active, get quests() { return quests; }, get provider() { return provider; }, _ask: ask };
}
