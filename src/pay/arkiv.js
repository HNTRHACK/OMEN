// Payment and delivery records on Arkiv (Rabdi testnet), written by the player's own wallet so
// the wallet owns them, and queried back into the in-game history.

import { createPublicClient, createWalletClient, ExpirationTime } from "@arkiv-network/sdk";
import { rabdi } from "@arkiv-network/sdk/chains";
import { desc, eq } from "@arkiv-network/sdk/query";
import { custom, http } from "viem";
import { Record, recordValues } from "../../shared/arkivRecord.js";
import { wallet } from "./wallet.js";

// An Arkiv access key is not a secret (it ships with any app that talks to the chain); restrict
// it to your origins at hub.arkiv.network/access-keys. Empty = public, rate-limited endpoint.
export const arkivChain = rabdi({ accessKey: import.meta.env.VITE_ARKIV_ACCESS_KEY ?? "" });
const pub = createPublicClient({ chain: arkivChain, transport: http() });

/** Write a read-only record from the connected wallet. Resolves { entityKey, txHash }. */
export async function writeRecord(r) {
  if (!wallet.address) throw new Error("Connect a wallet to write records to Arkiv.");
  const values = recordValues(r); // validate before asking the wallet for anything
  await wallet.ensureChain(arkivChain);
  const w = createWalletClient({ chain: arkivChain, transport: custom(wallet.provider), account: wallet.address });
  return w.createEntity(Record, values, { expiration: ExpirationTime.fromDays(30), flags: { readonly: true } });
}

const flat = (e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v && typeof v === "object" && "value" in v ? v.value : v]));

/** OMEN records owned by `owner`, newest first. */
export async function queryRecords(owner, kind) {
  let q = pub.select().from(Record);
  if (kind) q = q.where(eq("kind", kind));
  const res = await q.ownedBy(owner).orderBy(desc("createdAt")).limit(50).fetch();
  return res.entities.map(flat);
}
