// Alfred, Blockhaven's advisor NPC. Conversational advice (careers, business, education, everyday
// challenges) with knowledge of OMEN, plus practical quests whose steps point at real places in the
// village. Providers, in order of preference:
//   1. Claude (Anthropic API) when ANTHROPIC_API_KEY is set: claude-opus-5-5 by default, structured
//      JSON output, low effort (chat), server-side refusal fallbacks.
//   2. 0G inference (the gateway's existing 0G router config) when configured.
//   3. Offline mode: hand-written guidance, ALWAYS labelled as not AI.
// Spend is bounded per player and globally per day.
import Anthropic from "@anthropic-ai/sdk";
import { ApiError } from "./payments.js";
import { rateLimiter } from "./moderation.js";
import { clean } from "./commerce.js";
import { PLACES } from "../shared/places.js";

export { PLACES };
const TOPICS = ["career", "business", "education", "life", "omen", "other"];

const SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "What Alfred says: warm, practical, 40-160 words." },
    topic: { type: "string", enum: TOPICS },
    quest: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          properties: {
            title: { type: "string" },
            why: { type: "string" },
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: { text: { type: "string" }, place: { type: "string", enum: Object.keys(PLACES) } },
                required: ["text", "place"],
                additionalProperties: false,
              },
            },
          },
          required: ["title", "why", "steps"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["reply", "topic", "quest"],
  additionalProperties: false,
};

// Stable (cacheable) instructions: who Alfred is, what Blockhaven is, and his limits.
export const SYSTEM = `You are Alfred, a kind, practical mentor who sits on a bench in Blockhaven, the village in the browser game OMEN. Players (couriers) ask you for advice about careers, running a business, education and everyday challenges, and about OMEN itself.

How to answer:
- Be warm, concrete and brief (40-160 words). Give 2-4 actionable next steps the person can take in real life this week. Ask one clarifying question when the request is vague.
- You are not a licensed financial, legal, medical or mental-health professional. For consequential decisions (money, investments, contracts, health, safety) give general guidance only, say plainly that nothing is guaranteed, and suggest who to consult. Never promise returns. If someone seems in crisis or at risk of harm, encourage them to contact local emergency services or a trusted person right away.
- Never ask for, or encourage sharing, seed phrases, private keys or passwords. If a message looks like a scam ("double your crypto", fake airdrops, "support" asking for keys), say so.
- Stay in character as Alfred, but never claim to be human if asked directly.

What you know about Blockhaven (OMEN):
- Places: ${Object.entries(PLACES).map(([k, v]) => `${k} = ${v}`).join("; ")}.
- Couriers walk with W/A/S/D, press E to interact, T to chat, M for the market, P for the wallet.
- Payments: scan a merchant's UPI QR (e.g. at Maya's stall) and pay with Whitechain Sepolia TESTNET USDT (one wallet signature, no gas; test tokens have no monetary value) or with DEMO credits (play money, 1,000,000 to start). Rupee amounts are quoted equivalents only: no real INR is ever paid out.
- Couriers can claim a vacant market stall (one each), list products with prices and stock, receive orders live, and send B2B invoices to other stalls. Delivery is simulated.
- The community board in the plaza is a forum; hoardings show moderated player ads (1 day free, longer rentals).
- Crypto coins along the lanes are educational collectibles with live market data; finding one never adds money to a wallet.

Quests: when a practical plan would help, include a quest with a short title, one sentence on why it helps, and 2-4 steps. Each step is a real-world action paired with a Blockhaven place where the player can practise or reflect (for example: draft your pitch, then post it on the community board). Use only the listed place ids. Otherwise set quest to null.`;

/** Offline guidance, clearly labelled as not AI. */
function offline(text) {
  const t = text.toLowerCase();
  const pick = (re) => re.test(t);
  if (pick(/\b(shop|stall|business|sell|customer|startup|pric|invoic|market)/))
    return {
      topic: "business",
      reply: "Start small and learn from real customers. Write down one product, who it's for, and a price you'd happily defend. Then put it in front of people this week and ask what would make them buy twice. Track every sale, even tiny ones: numbers beat guesses. Nothing here is guaranteed, so test cheaply before you spend.",
      quest: { title: "Open your first stall", why: "Selling one thing to one person teaches more than a month of planning.", steps: [{ text: "Claim a vacant stall and list one product with a fair price", place: "market" }, { text: "Post a short pitch and ask for honest feedback", place: "board" }, { text: "Sell to one courier, then ask what they'd change", place: "market" }] },
    };
  if (pick(/\b(career|job|interview|resume|cv\b|work|intern|hire|hiring)/))
    return {
      topic: "career",
      reply: "Pick one role you're curious about and look at five real job posts for it. Note the skills that keep repeating, then build one small project that shows two of them. Ask someone already in that job for 15 minutes of their time: people say yes more often than you'd think. Update your CV to lead with what you made, not what you studied.",
      quest: { title: "One step closer to the job you want", why: "A small shipped project and one real conversation beat a perfect plan.", steps: [{ text: "Write down the 3 skills most job posts ask for", place: "alfred" }, { text: "Share your project idea and ask for feedback", place: "board" }, { text: "Reflect on what you learned up at the lookout", place: "lookout" }] },
    };
  if (pick(/\b(stud|exam|learn|course|college|school|educat|focus|revis)/))
    return {
      topic: "education",
      reply: "Study in short focused blocks (25-40 minutes), then test yourself from memory instead of re-reading: recall is what makes things stick. Teach one idea to someone else each day; if you can't explain it simply, that's where to dig. Sleep is part of studying, not a break from it.",
      quest: { title: "Learn it by teaching it", why: "Explaining an idea exposes exactly what you don't understand yet.", steps: [{ text: "Pick one topic and summarise it in five sentences", place: "alfred" }, { text: "Post your summary and invite questions", place: "board" }] },
    };
  return {
    topic: t.match(/\b(omen|blockhaven|pay|wallet|usdt|demo|coin)\b/) ? "omen" : "life",
    reply: "Tell me a little more and I can be more useful. In the meantime: write down the one thing that would make this week better, and the smallest step towards it you could take today. If it's about Blockhaven, the plaza has the market and the community board, Maya's stall takes testnet USDT or DEMO credits, and the coins on the lanes teach you about real cryptocurrencies.",
    quest: null,
  };
}

function cleanQuest(q) {
  if (!q || typeof q !== "object") return null;
  const steps = (Array.isArray(q.steps) ? q.steps : []).filter((s) => PLACES[s?.place]).slice(0, 4).map((s) => ({ text: clean(s.text, 160), place: s.place }));
  if (!steps.length) return null;
  return { title: clean(q.title, 60) || "A small quest", why: clean(q.why, 160), steps };
}

export function createAlfred({
  apiKey = process.env.ANTHROPIC_API_KEY || "",
  model = process.env.ALFRED_MODEL || "claude-opus-5-5",
  zgInfer = null, // async (messages) => { content, requestId, model } | null
  dailyCap = Number(process.env.ALFRED_DAILY_CAP || 300),
  client = null, // injectable for tests
  now = () => Date.now(),
} = {}) {
  const anthropic = client || (apiKey ? new Anthropic({ apiKey, maxRetries: 1, timeout: 45_000 }) : null);
  // Guests are unlimited, so every per-player map is bounded (oldest entries dropped first).
  const bounded = (m, max = 2000) => {
    if (m.size > max) m.delete(m.keys().next().value);
    return m;
  };
  const history = new Map(); // playerId → [{ role, content }]
  const perMin = rateLimiter(6, 3);
  const perDay = new Map(); // playerId → { day, n }
  let global = { day: "", n: 0 };
  const day = () => new Date(now()).toISOString().slice(0, 10);

  function status() {
    return anthropic ? { provider: "claude", model } : zgInfer ? { provider: "0g" } : { provider: "offline" };
  }

  function budget(playerId) {
    const d = day();
    if (global.day !== d) global = { day: d, n: 0 };
    const p = perDay.get(playerId);
    const mine = p && p.day === d ? p : { day: d, n: 0 };
    bounded(perDay).set(playerId, mine);
    return { ok: mine.n < 40 && global.n < dailyCap, spend: () => (mine.n++, global.n++) };
  }

  async function viaClaude(messages) {
    const res = await anthropic.beta.messages.create({
      model,
      max_tokens: 4000, // adaptive thinking shares this budget; a truncated JSON answer would fall back to offline
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // a refusal is re-run on the routed fallback model inside the same call
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
    });
    if (res.stop_reason === "refusal") return { refused: true, model: res.model, requestId: res.id };
    const text = res.content.find((b) => b.type === "text")?.text;
    if (!text) throw new Error(`no text (stop_reason ${res.stop_reason})`);
    return { out: JSON.parse(text), model: res.model, requestId: res.id };
  }

  async function via0g(messages) {
    const r = await zgInfer([{ role: "system", content: `${SYSTEM}\n\nReply with ONLY a JSON object: {"reply": string, "topic": one of ${JSON.stringify(TOPICS)}, "quest": null or {"title", "why", "steps": [{"text", "place"}]}}` }, ...messages]);
    if (!r) throw new Error("0G not configured");
    const m = /\{[\s\S]*\}/.exec(r.content || "");
    if (!m) throw new Error("0G answer wasn't JSON");
    return { out: JSON.parse(m[0]), model: r.model, requestId: r.requestId };
  }

  /** One turn with Alfred. Never throws for provider trouble: falls back to labelled offline advice. */
  async function ask(playerId, name, rawText, ctx = {}) {
    if (!playerId) throw new ApiError(401, "no_identity", "Join the world first.");
    const text = clean(rawText, 600);
    if (text.length < 2) throw new ApiError(400, "empty", "Ask Alfred something.");
    if (!perMin(playerId, now())) throw new ApiError(429, "slow_down", "Alfred is still thinking about your last question.");
    const turns = history.get(playerId) || [];
    const context = `[Courier: ${clean(name, 16) || "Courier"}${ctx.shop ? `, runs the stall "${clean(ctx.shop, 32)}"` : ""}${ctx.coins ? `, has found ${Number(ctx.coins) | 0} crypto coins` : ""}]`;
    const messages = [...turns, { role: "user", content: `${context}\n${text}` }];

    let result = null;
    let label;
    const b = budget(playerId);
    const s = status();
    if (s.provider !== "offline" && b.ok) {
      try {
        b.spend();
        result = s.provider === "claude" ? await viaClaude(messages) : await via0g(messages);
        label = s.provider === "claude" ? `AI · Claude (${result.model})` : `AI · 0G (${result.model || "router"})`;
      } catch (e) {
        console.warn("alfred provider failed:", e?.status || "", String(e?.message || e).slice(0, 160));
        result = null;
        label = "Offline answer: the AI provider didn't respond";
      }
    } else label = s.provider === "offline" ? "Offline answer: no AI provider is configured" : "Offline answer: Alfred's AI budget for today is used up";

    let out;
    if (result?.refused) {
      out = { reply: "That's one I'd rather not advise on. If it's urgent or about your safety, please reach out to local emergency services or someone you trust. Is there another way I can help?", topic: "other", quest: null };
      label = `AI · Claude declined (${result.model})`;
    } else if (result?.out) out = result.out;
    else out = offline(text);

    const reply = clean(out.reply, 1200) || "Hmm. Ask me that another way?";
    const quest = cleanQuest(out.quest);
    if (result?.out) {
      turns.push({ role: "user", content: `${context}\n${text}` }, { role: "assistant", content: JSON.stringify({ reply, topic: out.topic, quest }) });
      bounded(history).set(playerId, turns.slice(-12)); // last 6 exchanges
    }
    return { reply, topic: TOPICS.includes(out.topic) ? out.topic : "other", quest, ai: !!result?.out, label, requestId: result?.requestId || null };
  }

  return { ask, status, forget: (id) => history.delete(id) };
}
