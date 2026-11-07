// 0G evidence helper: runs the gateway's real risk check (server/risk.js assess + server/zerog.js
// infer) once on Maya's QR and on a spoofed QR, and prints the 0G request IDs.
//
//   node scripts/zg-smoke.mjs
//
// Needs ZG_API_KEY + ZG_BASE_URL (+ ZG_MODEL) or ZG_PRIVATE_KEY + ZG_PROVIDER in .env.
// Each run makes two small paid inference calls on whichever 0G network the key belongs to.
import { config } from "../server/config.js";
import { infer, zgStatus } from "../server/zerog.js";
import { assess } from "../server/risk.js";
import { parseUpiQr } from "../shared/upi.js";

const s = zgStatus();
if (!s.configured) {
  console.error("0G isn't configured. Set ZG_API_KEY + ZG_BASE_URL (+ ZG_MODEL), or ZG_PRIVATE_KEY + ZG_PROVIDER, in .env.");
  process.exit(1);
}
console.log(`0G mode=${s.mode} base=${s.baseUrl ?? "(provider)"} model=${config.zg.model || "(router default)"}`);

const cases = [
  ["genuine", "upi://pay?pa=maya.chai@blockhaven&pn=Maya's Chai Stall&am=20.00&cu=INR&tn=Cutting chai"],
  ["spoofed", "upi://pay?pa=maya.chai@blockhaven&pn=KYC Refund Desk&am=499&tn=Scan to receive your refund"],
];
let ok = 0;
for (const [label, qr] of cases) {
  const upi = parseUpiQr(qr);
  const r = await assess(upi, upi.amountPaise, (m) => infer(m));
  console.log(`\n[${label}] decision=${r.decision} level=${r.level} rules=${r.rules.level}`);
  console.log(`  ai.status=${r.ai.status} requestId=${r.ai.requestId ?? "-"} model=${r.ai.model ?? "-"} provider=${r.ai.provider ?? "-"} verified=${r.ai.verified ?? "-"} latencyMs=${r.ai.latencyMs ?? "-"}`);
  if (r.ai.status === "ok") {
    ok++;
    console.log(`  ai.risk=${r.ai.risk} reasons=${JSON.stringify(r.ai.reasons)}`);
  } else console.log(`  note: ${r.ai.note}`);
}
console.log(`\n${ok}/${cases.length} live 0G verdicts. Record the requestId values in README "Sponsor evidence".`);
process.exit(ok ? 0 : 2);
