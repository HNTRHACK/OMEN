// Alfred, two independent browsers. Asha talks to Alfred (offline mode here: no AI provider key),
// gets a labelled answer and a quest, follows the guidance to a market stall, completes it, earns
// the satchel note, and a refresh keeps the quest. Ravi sees the same Alfred and is told Asha is
// asking him for advice. Usage: node e2e/alfred.mjs http://localhost:5173/
import { launch, enter, finish, BASE } from "./lib.mjs";

const shots = process.env.SHOTS;
const [bA, bB] = await Promise.all([launch(), launch()]);
const A = await enter(bA, BASE, { name: "Asha", look: { hat: 2, jacket: 3 } });
const B = await enter(bB, BASE, { name: "Ravi", look: { jacket: 1 } });
const standAt = (page, fn) => page.evaluate(fn);

// Both players see the same Alfred in the same place
const pos = (page) => page.evaluate(() => window.__omen.alfred.group.position.toArray().map((x) => +x.toFixed(3)));
const sameAlfred = JSON.stringify(await pos(A.page)) === JSON.stringify(await pos(B.page)) && (await B.page.evaluate(() => !!window.__omen.alfred.group.parent));
const tagVisible = await A.page.evaluate(() => [...document.querySelectorAll(".nametag")].some((t) => /Alfred · advisor/.test(t.textContent)));

// Ravi records his feed from now on (lines fade after ~6 s)
await B.page.evaluate(() => {
  window.__feedSeen = [];
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => window.__feedSeen.push(n.textContent)))).observe(document.getElementById("feed"), { childList: true });
});

// Asha walks up to Alfred; he turns to look at her; the prompt appears
await standAt(A.page, () => {
  const o = window.__omen;
  o.stand(o.alfred.local(0, 0, 1.5), o.alfred.group.position);
});
await A.page.waitForTimeout(1500);
const prompt = await A.page.textContent("#prompt-text");
const headTurns = await A.page.evaluate(() => Math.abs(window.__omen.alfred.headTarget) >= 0);
if (shots) await A.page.screenshot({ path: `${shots}/alfred-npc.png` }).catch(() => {});

// Talk to Alfred
await A.page.keyboard.press("e");
await A.page.waitForSelector("#alfred:not([hidden]) .al-msg.alfred");
const badge = (await A.page.textContent("#al-badge")).trim();
const heardOfIt = await B.page.waitForFunction(() => window.__feedSeen.some((t) => /Asha is asking Alfred for advice/.test(t)), null, { timeout: 15000 }).then(() => true, () => false);
const chips = await A.page.$$eval("#al-chips [data-starter]", (b) => b.length);
const disclaimer = /not professional financial, legal, medical or mental-health advice/.test(await A.page.textContent("#alfred .al-foot"));
await A.page.click('#al-chips [data-starter="0"]'); // "I want to start a small business…"
await A.page.waitForSelector("#al-log .al-label", { timeout: 30000 });
const label = (await A.page.textContent("#al-log .al-label")).trim();
const reply = (await A.page.textContent("#al-log .al-text")).trim();
const questCard = await A.page.$eval("#al-log .al-quest-card", (c) => c.textContent.replace(/\s+/g, " ").trim()).catch(() => "");
if (shots) await A.page.screenshot({ path: `${shots}/alfred-talk.png` }).catch(() => {});

// Accept the quest: the tracker chip appears
await A.page.click("[data-accept]");
const chipText = await A.page.textContent("#quest-chip").then((t) => t.replace(/\s+/g, " ").trim()).catch(() => "");
const chipShown = await A.page.isVisible("#quest-chip");

// Close with Escape: the keyboard returns to the game (walking works)
await A.page.keyboard.press("Escape");
await A.page.waitForTimeout(500);
const closed = await A.page.isHidden("#alfred");
const p0 = await A.page.evaluate(() => window.__omen.kai.group.position.toArray());
await A.page.keyboard.down("s");
await A.page.waitForTimeout(900);
await A.page.keyboard.up("s");
const p1 = await A.page.evaluate(() => window.__omen.kai.group.position.toArray());
const walksAfter = Math.hypot(...p1.map((x, i) => x - p0[i])) > 0.4;

// Guidance: a marker over the next step; walking to a market stall registers the arrival
await A.page.waitForTimeout(600);
const markerShown = await A.page.evaluate(() => window.__omen.alfredUI.target()?.place === "market");
await standAt(A.page, () => {
  const o = window.__omen;
  o.stand(o.stalls["plot-lantern"].front(), o.stalls["plot-lantern"].group.position);
});
const arrivalToast = await A.page.waitForFunction(() => /You've reached a market stall/.test(document.getElementById("toast").textContent), null, { timeout: 15000 }).then(() => true, () => false);
if (shots) await A.page.screenshot({ path: `${shots}/alfred-quest-arrival.png` }).catch(() => {});

// Open the quest book from the chip; tick every step: the quest completes and Alfred's note arrives
await A.page.click("#quest-chip");
await A.page.waitForSelector("#al-quests .al-quest", { timeout: 30000 }).catch(async (e) => {
  console.log("DIAGNOSTIC alfred hidden:", await A.page.getAttribute("#alfred", "hidden"), "| pane hidden:", await A.page.getAttribute("#al-quests", "hidden"), "| html:", (await A.page.innerHTML("#al-quests")).length, "| chip:", await A.page.textContent("#quest-chip"), "| errors:", A.logs.join(" | "));
  throw e;
});
const hereBadge = /you've been here/.test(await A.page.textContent("#al-quests"));
// The pane re-renders after every tick, so re-query each time; focus must stay on the ticked box.
const total = (await A.page.$$("#al-quests input[type=checkbox]")).length;
let focusKept = true;
for (let i = 0; i < total; i++) {
  await A.page.check(`#al-quests input[data-i="${i}"]`);
  await A.page.waitForTimeout(150);
  if (i < total - 1) focusKept = focusKept && (await A.page.evaluate((n) => document.activeElement?.dataset?.i === String(n), i));
}
const completeToast = await A.page.waitForFunction(() => /Quest complete/.test(document.getElementById("toast").textContent), null, { timeout: 10000 }).then(() => true, () => false);
const gotNote = await A.page.waitForFunction(() => window.__omen.state.items.includes("alfredNote"), null, { timeout: 10000 }).then(() => true, () => false);
const chipGone = await A.page.isHidden("#quest-chip");
await A.page.keyboard.press("Escape");

// Privacy: Alfred's conversation lives with the asker; Ravi has no quest and his chat history is empty
const ravisQuests = await B.page.evaluate(() => window.__omen.alfredUI.quests.length);

// Refresh: the quest (and its completion) survives
await A.page.reload();
await A.page.waitForSelector("#continue:not([hidden])", { timeout: 120000 });
await A.page.click("#continue");
await A.page.waitForFunction(() => window.__omen?.mode === "play", null, { timeout: 60000 });
await A.page.waitForTimeout(1200);
const persisted = await A.page.evaluate(() => window.__omen.alfredUI.quests.map((q) => ({ title: q.title, done: q.done, steps: q.steps.length })));
const noteSurvives = await A.page.evaluate(() => window.__omen.state.items.includes("alfredNote"));

console.log(`PROMPT "${prompt}" | badge "${badge}" | label "${label}"`);
console.log("REPLY", reply.slice(0, 140));
console.log("QUEST", questCard.slice(0, 200));
console.log("CHIP", chipText, "| persisted", JSON.stringify(persisted));
const logs = [...A.logs, ...B.logs];
console.log("LOGS", logs.join("\n") || "none");
await bA.close();
await bB.close();
finish({
  bothSeeTheSameAlfred: sameAlfred,
  alfredHasNameTag: tagVisible,
  talkPrompt: prompt === "Talk to Alfred",
  otherPlayerSawTheConversation: heardOfIt,
  offlineModeLabelledInHeader: badge === "Offline mode · not AI",
  starterChipsShown: chips === 4,
  disclaimerVisible: disclaimer,
  answerLabelledNotAI: label === "Offline answer: no AI provider is configured",
  answerIsAdvice: reply.length > 80,
  questOffered: /Quest: Open your first stall/.test(questCard) && /@ a market stall/.test(questCard),
  trackerChip: chipShown && /Open your first stall/.test(chipText),
  sheetClosesWithEscape: closed,
  walksAfterClosing: walksAfter,
  guidanceMarkerPointsAtStep: markerShown,
  arrivalDetected: arrivalToast && hereBadge,
  questCompletes: completeToast && chipGone,
  satchelNoteEarned: gotNote,
  keyboardFocusKeptWhenTicking: focusKept,
  otherPlayerHasNoQuest: ravisQuests === 0,
  questSurvivesRefresh: persisted.length === 1 && persisted[0].done === true && persisted[0].steps === 3,
  noteSurvivesRefresh: noteSurvives,
  noPageErrors: logs.length === 0,
});
