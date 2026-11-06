#!/usr/bin/env bash
# Prepares a LOCAL anvil fork of Whitechain Sepolia for the end-to-end tests and rehearsals.
#   1. anvil --fork-url https://rpc.testnet.whitechain.io/ --chain-id 1874 --port 8545   (another terminal)
#   2. bash scripts/fork-setup.sh
# Deploys OmenCheckout from anvil's unlocked dev account, registers Maya/Orin with payout
# 0x3C44…93BC, gives the test payer 0x7099…79C8 50 USDT and ZERO WBT (proving gasless checkout).
# Local only: refuses any RPC that isn't localhost, and deletes forge's broadcast files because the
# fork reuses chain ID 1874 and they must never be mistaken for testnet deployments.
set -euo pipefail
RPC="${FORK_RPC:-http://127.0.0.1:8545}"
case "$RPC" in http://127.0.0.1:*|http://localhost:*) ;; *) echo "Refusing: $RPC is not a local fork." >&2; exit 1 ;; esac
USDT=0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
PAYER=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
MAYA=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
[ "$(cast chain-id --rpc-url "$RPC")" = 1874 ] || { echo "Not a fork of chain 1874." >&2; exit 1; }
cd "$(dirname "$0")/../contracts"
OUT=$(MAYA_PAYOUT=$MAYA ORIN_PAYOUT=$MAYA forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --unlocked --sender $DEPLOYER 2>&1)
CHECKOUT=$(echo "$OUT" | grep -oE "OmenCheckout: 0x[0-9a-fA-F]{40}" | cut -d' ' -f2)
SLOT=$(PAYER=$PAYER forge script script/LocalFork.s.sol:FindUsdtSlot --rpc-url "$RPC" 2>&1 | grep -oE "0x[0-9a-f]{64}")
rm -rf broadcast cache
cast rpc anvil_setStorageAt $USDT "$SLOT" 0x0000000000000000000000000000000000000000000000000000000002faf080 --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance $PAYER 0x0 --rpc-url "$RPC" >/dev/null
echo "CHECKOUT_ADDRESS=$CHECKOUT"
echo "payer $PAYER: $(cast call $USDT 'balanceOf(address)(uint256)' $PAYER --rpc-url "$RPC" | cut -d' ' -f1) USDT units, $(cast balance $PAYER --rpc-url "$RPC") WBT"
echo "Now start the game against the fork, e.g.:"
echo "  WHITECHAIN_RPC=$RPC VITE_WHITECHAIN_RPC=$RPC CHECKOUT_ADDRESS=$CHECKOUT RELAYER_PRIVATE_KEY=<anvil dev key #3> MERCHANT_KEYS=maya-chai:<any secret> npm run dev"
