// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {OmenCheckout} from "../src/OmenCheckout.sol";

/// ERC-20 that returns bool (like most tokens).
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    bool public noReturn; // behave like mainnet USDT: transferFrom returns nothing

    function setNoReturn(bool v) external { noReturn = v; }
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(allowance[f][msg.sender] >= a, "allowance");
        require(balanceOf[f] >= a, "balance");
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        if (noReturn) assembly { return(0, 0) }
        return true;
    }
}

/// Token whose transferFrom returns false instead of reverting.
contract FalseToken {
    function transferFrom(address, address, uint256) external pure returns (bool) { return false; }
}

contract OmenCheckoutTest is Test {
    OmenCheckout co;
    MockToken usdt;
    address payer = makeAddr("payer");
    address maya = makeAddr("maya");
    bytes32 constant MAYA = keccak256("maya-chai");
    bytes32 constant ORDER = keccak256("order-1");

    event Paid(bytes32 indexed orderId, bytes32 indexed merchantId, address indexed payer, address payout, uint256 amount, uint256 inrPaise);

    function setUp() public {
        usdt = new MockToken();
        co = new OmenCheckout(address(usdt));
        co.setMerchant(MAYA, maya, true);
        usdt.mint(payer, 100e6);
        vm.prank(payer);
        usdt.approve(address(co), type(uint256).max);
    }

    function test_paysMerchantDirectly() public {
        vm.expectEmit(true, true, true, true);
        emit Paid(ORDER, MAYA, payer, maya, 2_500_000, 20_000);
        vm.prank(payer);
        co.pay(ORDER, MAYA, 2_500_000, 20_000, block.timestamp + 60);
        assertEq(usdt.balanceOf(maya), 2_500_000);
        assertEq(usdt.balanceOf(address(co)), 0, "checkout never holds funds");
        assertEq(co.payerOf(ORDER), payer);
    }

    function test_worksWithNoReturnTokens() public {
        usdt.setNoReturn(true);
        vm.prank(payer);
        co.pay(ORDER, MAYA, 1e6, 8_800, block.timestamp);
        assertEq(usdt.balanceOf(maya), 1e6);
    }

    function test_rejectsDoublePay() public {
        vm.startPrank(payer);
        co.pay(ORDER, MAYA, 1e6, 1, block.timestamp);
        vm.expectRevert(OmenCheckout.AlreadyPaid.selector);
        co.pay(ORDER, MAYA, 1e6, 1, block.timestamp);
    }

    function test_rejectsExpiredQuote() public {
        vm.warp(1000);
        vm.prank(payer);
        vm.expectRevert(OmenCheckout.QuoteExpired.selector);
        co.pay(ORDER, MAYA, 1e6, 1, 999);
    }

    function test_rejectsUnknownOrInactiveMerchant() public {
        vm.prank(payer);
        vm.expectRevert(OmenCheckout.UnknownMerchant.selector);
        co.pay(ORDER, keccak256("nobody"), 1e6, 1, block.timestamp);
        co.setMerchant(MAYA, maya, false);
        vm.prank(payer);
        vm.expectRevert(OmenCheckout.UnknownMerchant.selector);
        co.pay(ORDER, MAYA, 1e6, 1, block.timestamp);
    }

    function test_rejectsZeroAmountAndPaused() public {
        vm.prank(payer);
        vm.expectRevert(OmenCheckout.ZeroAmount.selector);
        co.pay(ORDER, MAYA, 0, 1, block.timestamp);
        co.setPaused(true);
        vm.prank(payer);
        vm.expectRevert(OmenCheckout.IsPaused.selector);
        co.pay(ORDER, MAYA, 1, 1, block.timestamp);
    }

    function test_insufficientAllowanceReverts() public {
        address poor = makeAddr("poor");
        usdt.mint(poor, 1e6);
        vm.prank(poor);
        vm.expectRevert(OmenCheckout.TransferFailed.selector);
        co.pay(ORDER, MAYA, 1e6, 1, block.timestamp);
        assertEq(co.payerOf(ORDER), address(0), "failed payment leaves order unpaid");
    }

    function test_falseReturnReverts() public {
        OmenCheckout c2 = new OmenCheckout(address(new FalseToken()));
        c2.setMerchant(MAYA, maya, true);
        vm.expectRevert(OmenCheckout.TransferFailed.selector);
        c2.pay(ORDER, MAYA, 1, 1, block.timestamp);
    }

    function test_onlyOwnerAdmin() public {
        vm.startPrank(payer);
        vm.expectRevert(OmenCheckout.NotOwner.selector);
        co.setMerchant(MAYA, payer, true);
        vm.expectRevert(OmenCheckout.NotOwner.selector);
        co.setPaused(true);
        vm.expectRevert(OmenCheckout.NotOwner.selector);
        co.transferOwnership(payer);
    }

    function test_rejectsZeroAddresses() public {
        vm.expectRevert(OmenCheckout.ZeroAddress.selector);
        new OmenCheckout(address(0));
        vm.expectRevert(OmenCheckout.ZeroAddress.selector);
        co.setMerchant(MAYA, address(0), true);
    }

    function testFuzz_payMovesExactAmount(uint96 amount) public {
        vm.assume(amount > 0 && amount <= 100e6);
        vm.prank(payer);
        co.pay(ORDER, MAYA, amount, 1, block.timestamp);
        assertEq(usdt.balanceOf(maya), amount);
        assertEq(usdt.balanceOf(payer), 100e6 - uint256(amount));
    }
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

/// Runs against a fork of the live Whitechain Sepolia chain and its official test USDT.
/// Enabled with WHITECHAIN_FORK=1 (needs network access).
contract OmenCheckoutForkTest is Test {
    address constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;

    function test_fork_realUsdtCheckout() public {
        vm.skip(!vm.envOr("WHITECHAIN_FORK", false));
        vm.createSelectFork("whitechain_sepolia");
        assertEq(block.chainid, 1874);
        assertEq(IERC20Like(USDT).decimals(), 6);

        OmenCheckout co = new OmenCheckout(USDT);
        address payer = makeAddr("payer");
        address maya = makeAddr("maya");
        co.setMerchant(keccak256("maya-chai"), maya, true);
        deal(USDT, payer, 10e6);

        vm.startPrank(payer);
        IERC20Like(USDT).approve(address(co), 2_500_000);
        co.pay(keccak256("fork-order"), keccak256("maya-chai"), 2_500_000, 20_000, block.timestamp + 60);
        vm.stopPrank();

        assertEq(IERC20Like(USDT).balanceOf(maya), 2_500_000);
        assertEq(IERC20Like(USDT).balanceOf(payer), 7_500_000);
    }
}
