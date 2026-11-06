// Deploy OmenPredictions (if public/predictions/markets.json has no contract) and create every
// market that has no marketId yet. Writes the address and ids back into the JSON.
// TESTNET ONLY. Needs the owner's key in the environment (never in a file that's committed):
//   PREDICTIONS_OWNER_KEY=0x… [PREDICTIONS_RPC=https://rpc.testnet.whitechain.io/] [PREDICTIONS_TOKEN=0x…] node scripts/predictions-setup.mjs
// Local check: start `anvil --chain-id 1874`, use one of anvil's printed dev keys and PREDICTIONS_RPC=http://127.0.0.1:8545.
import { readFileSync, writeFileSync } from "node:fs";
import { createWalletClient, createPublicClient, http, defineChain, zeroAddress, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const FILE = process.env.PREDICTIONS_FILE || "public/predictions/markets.json";
const key = process.env.PREDICTIONS_OWNER_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key || "")) throw new Error("Set PREDICTIONS_OWNER_KEY (a testnet key) in the environment.");
const rpc = process.env.PREDICTIONS_RPC || "https://rpc.testnet.whitechain.io/";
const chain = defineChain({ id: 1874, name: "Whitechain Sepolia", nativeCurrency: { name: "WBT", symbol: "WBT", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
const account = privateKeyToAccount(key);
const w = createWalletClient({ account, chain, transport: http(rpc) });
const pub = createPublicClient({ chain, transport: http(rpc) });
if ((await pub.getChainId()) !== 1874) throw new Error("That RPC isn't chain 1874.");

const art = JSON.parse(readFileSync("contracts/out/OmenPredictions.sol/OmenPredictions.json", "utf8"));
const abi = art.abi;
const cfg = JSON.parse(readFileSync(FILE, "utf8"));
const save = () => writeFileSync(FILE, JSON.stringify(cfg, null, 2) + "\n");

if (!cfg.contract) {
  const token = process.env.PREDICTIONS_TOKEN || zeroAddress; // zero → free testnet points
  const hash = await w.deployContract({ abi, bytecode: art.bytecode.object, args: [token, account.address] });
  const r = await pub.waitForTransactionReceipt({ hash });
  cfg.contract = r.contractAddress;
  cfg.mode = token === zeroAddress ? "points" : "usdt";
  cfg.deployTx = hash;
  save();
  console.log("deployed", cfg.contract, hash);
}
const closesAt = BigInt(Math.floor(new Date(cfg.closesAt).getTime() / 1000));
for (const b of cfg.booths)
  for (const m of b.markets || []) {
    if (m.marketId) continue;
    const hash = await w.writeContract({ address: cfg.contract, abi, functionName: "createMarket", args: [m.options.length, closesAt, m.question] });
    const r = await pub.waitForTransactionReceipt({ hash });
    const ev = parseEventLogs({ abi, logs: r.logs, eventName: "MarketCreated" })[0];
    m.marketId = Number(ev.args.marketId);
    save();
    console.log("market", m.marketId, m.key);
  }
console.log("done:", cfg.contract);
