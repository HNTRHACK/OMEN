// Network facts, each checked against an official source on 2026-11-06 (see README "Sponsor evidence").

export const WHITECHAIN = {
  id: 1874, // confirmed with eth_chainId on rpc.testnet.whitechain.io
  name: "Whitechain Sepolia",
  rpc: "https://rpc.testnet.whitechain.io/",
  explorer: "https://explorer.testnet.whitechain.io",
  faucet: "https://faucet.testnet.whitechain.io",
  native: { name: "WBT", symbol: "WBT", decimals: 18 },
};

/** Official Whitechain Sepolia test USDT (ETHGlobal Mumbai Whitechain prize page). 6 decimals on-chain. */
export const USDT = { address: "0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7", symbol: "USDT", decimals: 6 };

export const ARKIV = {
  id: 7794095,
  name: "Arkiv Rabdi testnet",
  explorer: "https://rabdi.explorer.arkiv.network",
  faucet: "https://hub.arkiv.network/faucet",
};

export const txUrl = (hash) => `${WHITECHAIN.explorer}/tx/${hash}`;
export const addressUrl = (addr) => `${WHITECHAIN.explorer}/address/${addr}`;
export const arkivTxUrl = (hash) => `${ARKIV.explorer}/tx/${hash}`;
