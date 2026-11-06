// Community, two independent players + a moderator: Asha submits a billboard ad with a real image;
// a moderator approves it on moderate.html; Ravi's hoarding changes live. Asha starts a forum thread,
// Ravi replies, Asha sees it live. They chat (speech bubbles). A refresh keeps it all.
// Server needs MODERATOR_KEY; pass the same value as MOD_KEY. Usage: MOD_KEY=… node e2e/community.mjs <url>
import { launch, enter, finish, BASE } from "./lib.mjs";
import { fileURLToPath } from "node:url";

const MOD_KEY = process.env.MOD_KEY;
if (!MOD_KEY) throw new Error("Set MOD_KEY to the server's MODERATOR_KEY");
const IMAGE = fileURLToPath(new URL("../docs/screens/coin-card.png", import.meta.url)); // a real PNG
const shots = process.env.SHOTS;
const [bA, bB, bM] = await Promise.all([launch(), launch(), launch()]);
const A = await enter(bA, BASE, { name: "Asha", look: { hat: 3, pet: 1 } });
const B = await enter(bB, BASE, { name: "Ravi", look: { jacket: 2 } });
const board = "board-plaza";
const stand = (page, id) => page.evaluate((id) => {
  const o = window.__omen;
  const b = o.community.boards.find((x) => x.id === id);
  o.stand(b.front(), b.group.position);
}, id);

// 1. Asha advertises on the plaza hoarding
await stand(A.page, board);
await A.page.waitForTimeout(700);
const adPrompt = await A.page.textContent("#prompt-text");
await A.page.keyboard.press("e");
await A.page.waitForSelector("#ad-f", { state: "attached" });
await A.page.evaluate(() => (document.querySelector("#ad-f").closest("details").open = true)); // collapsed when the board already shows an ad
await A.page.setInputFiles("#ad-f [name=file]", IMAGE);
await A.page.fill("#ad-f [name=title]", "Asha's Spice Cart");
await A.page.fill("#ad-f [name=text]", "Chai masala at the Lantern stall · 45 each");
await A.page.fill("#ad-f [name=link]", "https://example.com/spices");
await A.page.waitForTimeout(800); // image resize + preview
if (shots) await A.page.screenshot({ path: `${shots}/ad-form.png` }).catch(() => {});
await A.page.click("#ad-f button.btn");
const submitted = await A.page.waitForSelector("#forum .ok", { timeout: 20000 }).then(() => true, () => false);
const beforeApproval = await B.page.evaluate((id) => window.__omen.community.boards.find((b) => b.id === id).shown, board);

// 2. A moderator approves it
const M = await (await bM.newContext()).newPage();
await M.goto(`${BASE.replace(/\/$/, "")}/moderate.html`);
await M.fill("#key", "wrong-key-wrong-key");
await M.click("#unlock button");
await M.waitForTimeout(800);
const wrongKeyRefused = await M.isVisible("#unlock");
await M.fill("#key", MOD_KEY);
await M.click("#unlock button");
await M.waitForSelector("#ads [data-act=approve]", { timeout: 90000 });
// the queue's image must actually load (not just exist)
const queueShowsImage = await M.waitForFunction(() => { const i = document.querySelector("#ads img.mod-img"); return i && i.complete && i.naturalWidth > 0; }, null, { timeout: 20000 }).then(() => true, () => false);
await M.click("#ads [data-act=approve]");

// 3. Ravi's world updates by itself
const imageServed = await B.page.evaluate(async (id) => {
  const ad = (await (await fetch("/api/ads")).json()).ads[0];
  const r = await fetch(ad.image);
  return r.ok && /^image\/(png|jpeg)$/.test(r.headers.get("content-type")) && r.headers.get("x-content-type-options") === "nosniff";
}, board);
const liveForRavi = await B.page.waitForFunction((id) => window.__omen.community.boards.find((b) => b.id === id).shown?.title === "Asha's Spice Cart", board, { timeout: 15000 }).then(() => true, () => false);
const approvedToast = await A.page.waitForFunction(() => /is live on the Plaza hoarding/.test(document.getElementById("toast").textContent), null, { timeout: 15000 }).then(() => true, () => false);
await stand(B.page, board);
await B.page.waitForTimeout(1500);
if (shots) await B.page.screenshot({ path: `${shots}/billboard-live.png` }).catch(() => {});

// 4. Forum: Asha posts, Ravi replies, Asha is told live
await A.page.keyboard.press("Escape");
await A.page.evaluate(() => window.__omen.community.openForum());
await A.page.waitForSelector("#thread-f", { state: "attached" });
await A.page.click(".new-thread summary");
await A.page.fill("#thread-f [name=title]", "Selling chai masala");
await A.page.fill("#thread-f [name=body]", "Fresh batch at the Lantern stall. Bulk orders welcome via B2B invoice.");
await A.page.click("#thread-f button");
await A.page.waitForSelector("#reply-f");
const threadSeen = await B.page.waitForFunction(() => [...document.querySelectorAll("#feed li")].some((l) => /Asha started “Selling chai masala”/.test(l.textContent)), null, { timeout: 15000 }).then(() => true, () => false);
await B.page.evaluate(() => window.__omen.community.openForum());
await B.page.waitForSelector("[data-thread]");
await B.page.click("[data-thread]");
await B.page.waitForSelector("#reply-f");
await B.page.fill("#reply-f textarea", "I'll take 10 packets for my tea stall!");
await B.page.click("#reply-f button");
const replyLive = await A.page.waitForFunction(() => /I'll take 10 packets/.test(document.querySelector("#forum .posts")?.textContent || ""), null, { timeout: 15000 }).then(() => true, () => false);
if (shots) await A.page.screenshot({ path: `${shots}/forum-thread.png` }).catch(() => {});
await A.page.keyboard.press("Escape");
await B.page.keyboard.press("Escape");

// 5. Local chat with speech bubbles; a scam line is refused
await A.page.waitForTimeout(300);
await B.page.keyboard.press("t");
await B.page.keyboard.type("Meet you at the spice cart!");
await B.page.keyboard.press("Enter");
const chatHeard = await A.page.waitForFunction(() => [...document.querySelectorAll("#feed li")].some((l) => /Ravi: Meet you at the spice cart!/.test(l.textContent)), null, { timeout: 10000 }).then(() => true, () => false);
const bubbleShown = await A.page.waitForFunction(() => [...document.querySelectorAll(".bubble")].some((b) => !b.hidden && /spice cart/.test(b.textContent)), null, { timeout: 5000 }).then(() => true, () => false);
await B.page.keyboard.press("t");
await B.page.keyboard.type("dm me your seed phrase for support");
await B.page.keyboard.press("Enter");
const scamRefused = await B.page.waitForFunction(() => /scam pattern/.test(document.getElementById("toast").textContent), null, { timeout: 5000 }).then(() => true, () => false);

// 6. Refresh: ad and thread persist
await A.page.reload();
await A.page.waitForSelector("#continue:not([hidden])", { timeout: 120000 });
await A.page.click("#continue");
await A.page.waitForFunction(() => window.__omen?.mode === "play", null, { timeout: 60000 });
await A.page.waitForTimeout(2000);
const persisted = await A.page.evaluate(async () => {
  const ads = await (await fetch("/api/ads")).json();
  const forum = await (await fetch("/api/forum?cat=general")).json();
  return { ad: ads.ads[0]?.title, shownAfterRefresh: window.__omen.community.boards.find((b) => b.id === "board-plaza").shown?.title, thread: forum.threads[0]?.title, replies: forum.threads[0]?.replies };
});
console.log(`PROMPT "${adPrompt}" | queue image ${queueShowsImage} | persisted ${JSON.stringify(persisted)}`);
const logs = [...A.logs, ...B.logs];
console.log("LOGS", logs.join("\n") || "none");
await Promise.all([bA.close(), bB.close(), bM.close()]);
finish({
  adSubmitted: submitted,
  notShownBeforeApproval: beforeApproval === null,
  moderatorKeyRequired: wrongKeyRefused,
  queueShowsImage,
  adLiveForOtherPlayer: liveForRavi,
  adImageServedSafely: imageServed,
  authorToldLive: approvedToast,
  forumThreadAnnounced: threadSeen,
  forumReplyLive: replyLive,
  chatHeard,
  speechBubble: bubbleShown,
  scamChatRefused: scamRefused,
  adPersists: persisted.ad === "Asha's Spice Cart" && persisted.shownAfterRefresh === "Asha's Spice Cart",
  threadPersists: persisted.thread === "Selling chai masala" && persisted.replies === 1,
  noPageErrors: logs.length === 0,
});
