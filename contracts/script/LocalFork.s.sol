// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {stdStorage, StdStorage} from "forge-std/StdStorage.sol";

/// Local verification helper (never broadcast to a public network): prints the storage slot that
/// holds `PAYER`'s balance in Whitechain's test USDT, so a local anvil fork can fund a test wallet
/// with `anvil_setStorageAt`. See README "Verify the USDT flow on a local fork".
contract FindUsdtSlot is Script {
    using stdStorage for StdStorage;
    address constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;

    function run() external {
        address payer = vm.envAddress("PAYER");
        uint256 slot = stdstore.target(USDT).sig("balanceOf(address)").with_key(payer).find();
        console.log("slot", vm.toString(bytes32(slot)));
    }
}
