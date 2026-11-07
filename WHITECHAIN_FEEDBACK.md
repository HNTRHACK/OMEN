# Whitechain feedback

Notes from building OMEN's USDT checkout on Whitechain Sepolia on 2026-11-06.

## What worked

- **Standard EVM, no surprises.** Foundry with `solc 0.8.30` / `evm_version = "prague"` (as the
  Foundry guide says) compiled and ran first time.
- **Forking the testnet is a great dev loop.** `anvil --fork-url https://rpc.testnet.whitechain.io/
  --chain-id 1874` let us deploy our checkout, fund a test wallet with the *real* test USDT
  contract's storage, and drive the whole browser flow locally before spending testnet gas.
- **The public RPC sends CORS headers** (`access-control-allow-origin: *`), so the browser can read
  balances without a proxy.
- Test USDT behaved as expected on the fork: `decimals() = 6`, and `approve` + `transferFrom`
  through our checkout worked. (Our contract's transfer helper accepts tokens that return a bool or
  nothing, so we didn't need to know which this one does.)

## Where we got stuck

1. **Network parameters are spread out.** The ETHGlobal page lists chain ID, USDT address and
   explorer but no RPC URL (it points to an Ankr offer). The RPC (`https://rpc.testnet.whitechain.io/`)
   is on the *Connect wallet* docs page, and the chain ID isn't on the Foundry deploy page. One
   "Testnet at a glance" table would save time.
2. **Getting test USDT.** The faucet gives WBT. We couldn't find an official, documented way to get
   the official test USDT (`0xcedf…55a7`) in the docs we read. Hackathon READMEs mention swapping
   on a testnet DEX, but the docs should say how.
3. **USDT sits behind a proxy**, so finding its balance slot for local forks needs forge-std's
   `stdstore` (we added `contracts/script/LocalFork.s.sol` for this). A note in the docs would help
   others test with forks.
4. **Blockscout verification** needs `--verifier blockscout` and a verifier URL that *ends in
   `/api/`*. The Foundry guide says so, but it's an easy one to miss.

## What the docs lacked

- A checkout/merchant-payments reference. The docs don't say that the test USDT supports
  gasless authorizations; we only found out from the explorer's verified source
  (`TetherTokenV2 is TetherToken, EIP3009`, with `permit` and `transferWithAuthorization` /
  `receiveWithAuthorization`), after building a two-step approve + pay flow that costs the payer
  gas. Stating this up front would steer teams to gasless checkouts from the start, which is what
  the Operate track asks for.
- Guidance on confirmations/finality for payment UX on the OP Stack.
