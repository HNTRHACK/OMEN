// Arkiv evidence helper. Uses the same schema (shared/arkivRecord.js) and query as the game.
//
//   node scripts/arkiv-smoke.mjs read [owner]   query omen.record.v1 on Rabdi (no key needed)
//   node scripts/arkiv-smoke.mjs write          write one delivery record, then read it back
//                                               needs ARKIV_PRIVATE_KEY (a THROWAWAY testnet key
//                                               funded with Rabdi tGLM) in .env
//
// The in-game flow (Wallet → receipt → "Save receipt to Arkiv") is the main path: it writes from
// the player's own browser wallet. This script exists so the read path, and optionally one write,
// can be demonstrated from a terminal.
import "../server/config.js"; // loads .env
import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { desc } from "@arkiv-network/sdk/query";
import { http, isHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Record, recordValues } from "../shared/arkivRecord.js";

const chain = rabdi({ accessKey: process.env.VITE_ARKIV_ACCESS_KEY ?? "" });
const pub = createPublicClient({ chain, transport: http() });
const [, , cmd = "read", ownerArg] = process.argv;

async function read(owner) {
  let q = pub.select({ $key: true, $owner: true, $expiresAt: true, kind: true, merchant: true, status: true, ref: true, createdAt: true }).from(Record);
  if (owner) q = q.ownedBy(owner);
  const res = await q.orderBy(desc("createdAt")).limit(10).fetch();
  console.log(`chain ${chain.id} · schema omen.record.v1 · owner ${owner || "(any)"} · ${res.entities.length} record(s)`);
  for (const e of res.entities) console.log(` ${e.$key} owner=${e.$owner} kind=${e.kind?.value} merchant=${e.merchant?.value} status=${e.status?.value} ref=${e.ref?.value}`);
  return res.entities;
}

if (cmd === "read") {
  await read(ownerArg);
} else if (cmd === "write") {
  const pk = process.env.ARKIV_PRIVATE_KEY;
  if (!pk || !isHex(pk)) throw new Error("Set ARKIV_PRIVATE_KEY (throwaway, funded with Rabdi tGLM) in .env");
  const account = privateKeyToAccount(pk);
  const w = createWalletClient({ chain, transport: http(), account });
  const values = recordValues({ kind: "delivery", mode: "story", merchant: "maya-chai", status: "delivered", ref: `smoke-${Date.now()}`, note: "OMEN Arkiv smoke test" });
  const { entityKey, txHash } = await w.createEntity(Record, values, { expiration: ExpirationTime.fromDays(30), flags: { readonly: true } });
  console.log(`wrote entity ${entityKey}\n  tx ${chain.blockExplorers.default.url}/tx/${txHash}\n  writer ${account.address}`);
  const rows = await read(account.address);
  if (!rows.some((r) => r.$key === entityKey)) throw new Error("Wrote the entity but couldn't read it back yet; retry `read` in a few seconds.");
  console.log("read-back OK");
} else throw new Error(`unknown command ${cmd}`);
