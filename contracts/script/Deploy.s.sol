// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {OmenCheckout} from "../src/OmenCheckout.sol";

/// Deploys OmenCheckout with Whitechain Sepolia's official test USDT and registers the village
/// merchants. Payout addresses come from the environment (default: the deployer).
///
///   forge script script/Deploy.s.sol --rpc-url whitechain_sepolia --private-key $PRIVATE_KEY \
///     --broadcast --verify --verifier blockscout --verifier-url https://explorer.testnet.whitechain.io/api/
contract Deploy is Script {
    address constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;

    function run() external returns (OmenCheckout co) {
        vm.startBroadcast();
        address deployer = msg.sender;
        co = new OmenCheckout(USDT);
        co.setMerchant(keccak256("maya-chai"), vm.envOr("MAYA_PAYOUT", deployer), true);
        co.setMerchant(keccak256("orin-relay"), vm.envOr("ORIN_PAYOUT", deployer), true);
        vm.stopBroadcast();
        console.log("OmenCheckout:", address(co));
    }
}
