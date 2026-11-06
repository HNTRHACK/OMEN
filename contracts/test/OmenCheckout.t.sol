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

    function transfer(address t, uint256 a) public returns (bool) {
        require(balanceOf[msg.sender] >= a, "balance");
        balanceOf[msg.sender] -= a;
        balanceOf[t] += a;
        return true;
    }
}

/// MockToken + EIP-3009 receiveWithAuthorization, mirroring TetherTokenV2's checks exactly:
/// to == msg.sender, validAfter < now < validBefore, single-use nonce, EIP-712 signature.
contract Mock3009 is MockToken {
    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");
    bytes32 public immutable DOMAIN_SEPARATOR;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Tether USD"), keccak256("1"), block.chainid, address(this)
            )
        );
    }

    function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)
        external
    {
        require(to == msg.sender, "TetherToken: to != msg.sender");
        require(block.timestamp > validAfter, "TetherToken: auth early");
        require(block.timestamp < validBefore, "TetherToken: auth expired");
        require(!authorizationState[from][nonce], "TetherToken: auth used");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, keccak256(abi.encode(RECEIVE_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))));
        require(ecrecover(digest, v, r, s) == from, "TetherToken: invalid signature");
        authorizationState[from][nonce] = true;
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

/// Signs EIP-3009 ReceiveWithAuthorization the way a wallet would (eth_signTypedData_v4).
abstract contract AuthSigner is Test {
    bytes32 constant RWA_TYPEHASH =
        keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

    function signAuth(uint256 pk, bytes32 domain, address to, uint256 value, uint256 validBefore, bytes32 nonce)
        internal
        pure
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        address from = vm.addr(pk);
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(RWA_TYPEHASH, from, to, value, uint256(0), validBefore, nonce))));
        return vm.sign(pk, digest);
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

/// Gasless checkout (EIP-3009) and refunds.
contract OmenCheckoutGaslessTest is AuthSigner {
    OmenCheckout co;
    Mock3009 usdt;
    uint256 payerPk = 0xA11CE;
    address payer;
    address maya = makeAddr("maya");
    address relayer = makeAddr("relayer");
    bytes32 constant MAYA = keccak256("maya-chai");
    bytes32 constant ORIN = keccak256("orin-relay");
    bytes32 constant ORDER = keccak256("order-1");
    uint256 constant AMT = 640_293;
    uint256 constant INR = 6_000;
    uint256 deadline;

    event Paid(bytes32 indexed orderId, bytes32 indexed merchantId, address indexed payer, address payout, uint256 amount, uint256 inrPaise);
    event Refunded(bytes32 indexed orderId, address indexed payer, uint256 amount);

    function setUp() public {
        vm.warp(1_800_000_000);
        payer = vm.addr(payerPk);
        usdt = new Mock3009();
        co = new OmenCheckout(address(usdt));
        co.setMerchant(MAYA, maya, true);
        co.setMerchant(ORIN, makeAddr("orin"), true);
        usdt.mint(payer, 10e6);
        deadline = block.timestamp + 120;
    }

    function sig(bytes32 order, bytes32 merchant, uint256 amount) internal view returns (uint8, bytes32, bytes32) {
        return signAuth(payerPk, usdt.DOMAIN_SEPARATOR(), address(co), amount, deadline, co.authorizationNonce(order, merchant, amount, INR, deadline));
    }

    function test_relayerSettlesSignedOrder_payerSpendsNoGas() public {
        (uint8 v, bytes32 r, bytes32 s) = sig(ORDER, MAYA, AMT);
        vm.expectEmit(true, true, true, true);
        emit Paid(ORDER, MAYA, payer, maya, AMT, INR);
        vm.prank(relayer); // the relayer sends the tx and pays the gas; the payer only signed
        co.payWithAuthorization(ORDER, MAYA, AMT, INR, deadline, payer, v, r, s);
        assertEq(usdt.balanceOf(maya), AMT);
        assertEq(usdt.balanceOf(payer), 10e6 - AMT);
        assertEq(usdt.balanceOf(address(co)), 0, "checkout passes funds straight on");
        assertEq(co.payerOf(ORDER), payer);
    }

    function test_relayerCannotChangeTerms() public {
        (uint8 v, bytes32 r, bytes32 s) = sig(ORDER, MAYA, AMT);
        vm.startPrank(relayer);
        vm.expectRevert(bytes("TetherToken: invalid signature")); // more money
        co.payWithAuthorization(ORDER, MAYA, AMT + 1, INR, deadline, payer, v, r, s);
        vm.expectRevert(bytes("TetherToken: invalid signature")); // another merchant
        co.payWithAuthorization(ORDER, ORIN, AMT, INR, deadline, payer, v, r, s);
        vm.expectRevert(bytes("TetherToken: invalid signature")); // another order
        co.payWithAuthorization(keccak256("order-2"), MAYA, AMT, INR, deadline, payer, v, r, s);
        vm.expectRevert(bytes("TetherToken: invalid signature")); // different INR on the receipt
        co.payWithAuthorization(ORDER, MAYA, AMT, INR + 1, deadline, payer, v, r, s);
        vm.expectRevert(bytes("TetherToken: invalid signature")); // someone else's money
        co.payWithAuthorization(ORDER, MAYA, AMT, INR, deadline, makeAddr("victim"), v, r, s);
        assertEq(usdt.balanceOf(payer), 10e6, "nothing moved");
    }

    function test_signatureCantBeReplayedOrUsedTwice() public {
        (uint8 v, bytes32 r, bytes32 s) = sig(ORDER, MAYA, AMT);
        co.payWithAuthorization(ORDER, MAYA, AMT, INR, deadline, payer, v, r, s);
        vm.expectRevert(OmenCheckout.AlreadyPaid.selector);
        co.payWithAuthorization(ORDER, MAYA, AMT, INR, deadline, payer, v, r, s);
        assertEq(usdt.balanceOf(maya), AMT, "settled exactly once");
    }

    function test_expiredAuthorizationRefused() public {
        (uint8 v, bytes32 r, bytes32 s) = sig(ORDER, MAYA, AMT);
        vm.warp(deadline + 1);
        vm.expectRevert(OmenCheckout.QuoteExpired.selector);
        co.payWithAuthorization(ORDER, MAYA, AMT, INR, deadline, payer, v, r, s);
    }

    function test_unknownMerchantAndPausedRefused() public {
        (uint8 v, bytes32 r, bytes32 s) = sig(ORDER, keccak256("nobody"), AMT);
        vm.expectRevert(OmenCheckout.UnknownMerchant.selector);
        co.payWithAuthorization(ORDER, keccak256("nobody"), AMT, INR, deadline, payer, v, r, s);
        co.setPaused(true);
        (v, r, s) = sig(ORDER, MAYA, AMT);
        vm.expectRevert(OmenCheckout.IsPaused.selector);
        co.payWithAuthorization(ORDER, MAYA, AMT, INR, deadline, payer, v, r, s);
    }

    function test_merchantRefundsUpToPaidAmount() public {
        (uint8 v, bytes32 r, bytes32 s) = sig(ORDER, MAYA, AMT);
        co.payWithAuthorization(ORDER, MAYA, AMT, INR, deadline, payer, v, r, s);
        vm.startPrank(maya);
        usdt.approve(address(co), type(uint256).max);
        vm.expectEmit(true, true, false, true);
        emit Refunded(ORDER, payer, 200_000);
        co.refund(ORDER, 200_000);
        co.refund(ORDER, AMT - 200_000);
        vm.expectRevert(OmenCheckout.RefundTooLarge.selector);
        co.refund(ORDER, 1);
        vm.stopPrank();
        assertEq(usdt.balanceOf(payer), 10e6, "fully refunded");
        assertEq(usdt.balanceOf(maya), 0);
    }

    function test_onlyTheMerchantCanRefund() public {
        (uint8 v, bytes32 r, bytes32 s) = sig(ORDER, MAYA, AMT);
        co.payWithAuthorization(ORDER, MAYA, AMT, INR, deadline, payer, v, r, s);
        vm.prank(payer);
        vm.expectRevert(OmenCheckout.NotMerchant.selector);
        co.refund(ORDER, 1);
        vm.prank(maya);
        vm.expectRevert(OmenCheckout.UnknownOrder.selector);
        co.refund(keccak256("never-paid"), 1);
    }
}

/// Player-run shops: direct merchant ids pay a shop's own address, no registration needed.
contract OmenCheckoutDirectTest is AuthSigner {
    OmenCheckout co;
    Mock3009 usdt;
    uint256 payerPk = 0xC0FFEE;
    address payer;
    address shop = makeAddr("asha-shop");
    uint256 deadline;

    function setUp() public {
        vm.warp(1_800_000_000);
        payer = vm.addr(payerPk);
        usdt = new Mock3009();
        co = new OmenCheckout(address(usdt));
        usdt.mint(payer, 10e6);
        deadline = block.timestamp + 120;
    }

    function test_directIdPaysTheShopWithoutRegistration() public {
        bytes32 id = co.directMerchantId(shop);
        assertEq(uint256(id) >> 160, co.DIRECT_TAG());
        assertEq(co.merchantOf(id).payout, shop);
        bytes32 order = keccak256("shop-order");
        (uint8 v, bytes32 r, bytes32 s) = signAuth(payerPk, usdt.DOMAIN_SEPARATOR(), address(co), 1_500_000, deadline, co.authorizationNonce(order, id, 1_500_000, 12_000, deadline));
        vm.prank(makeAddr("relayer"));
        co.payWithAuthorization(order, id, 1_500_000, 12_000, deadline, payer, v, r, s);
        assertEq(usdt.balanceOf(shop), 1_500_000);
        // only the shop's own address can refund it
        vm.prank(makeAddr("someone"));
        vm.expectRevert(OmenCheckout.NotMerchant.selector);
        co.refund(order, 1);
        vm.startPrank(shop);
        usdt.approve(address(co), 1_500_000);
        co.refund(order, 1_500_000);
        vm.stopPrank();
        assertEq(usdt.balanceOf(payer), 10e6);
    }

    function test_directIdForZeroAddressIsRefused() public {
        vm.expectRevert(OmenCheckout.ZeroAddress.selector);
        co.directMerchantId(address(0));
        bytes32 zeroDirect = bytes32(co.DIRECT_TAG() << 160);
        assertFalse(co.merchantOf(zeroDirect).active);
    }

    function test_registeredButDeactivatedMerchantStaysOff() public {
        // A registered id can't be revived by the direct fallback once deactivated.
        bytes32 id = co.directMerchantId(shop);
        co.setMerchant(id, shop, false);
        assertFalse(co.merchantOf(id).active);
    }

    function testFuzz_directIdRoundTrips(address a) public view {
        vm.assume(a != address(0));
        assertEq(co.merchantOf(co.directMerchantId(a)).payout, a);
    }
}

interface IERC20Like {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function authorizationState(address, bytes32) external view returns (bool);
}

/// Runs against a fork of the live Whitechain Sepolia chain and its official test USDT.
/// Enabled with WHITECHAIN_FORK=1 (needs network access).
contract OmenCheckoutForkTest is AuthSigner {
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

    // state (not locals) keeps the test under the EVM's stack limit without via-ir
    OmenCheckout gco;
    uint256 constant G_PK = 0xB0B;
    uint256 constant G_AMT = 640_293;
    bytes32 constant G_ORDER = keccak256("fork-gasless-order");
    bytes32 constant G_MAYA = keccak256("maya-chai");
    uint256 gDeadline;
    bytes32 gNonce;

    /// The Operate flow against the REAL TetherTokenV2: the payer only signs; a relayer pays gas.
    function test_fork_gaslessCheckoutAndRefund_realUsdt() public {
        vm.skip(!vm.envOr("WHITECHAIN_FORK", false));
        vm.createSelectFork("whitechain_sepolia");
        assertEq(block.chainid, 1874);

        gco = new OmenCheckout(USDT);
        address payer = vm.addr(G_PK);
        address maya = makeAddr("maya");
        gco.setMerchant(G_MAYA, maya, true);
        deal(USDT, payer, 10e6);
        assertEq(payer.balance, 0, "payer holds no WBT at all, so cannot pay gas");

        gDeadline = block.timestamp + 120;
        gNonce = gco.authorizationNonce(G_ORDER, G_MAYA, G_AMT, 6_000, gDeadline);
        _relay(makeAddr("relayer"), false);
        assertEq(IERC20Like(USDT).balanceOf(maya), G_AMT);
        assertEq(IERC20Like(USDT).balanceOf(payer), 10e6 - G_AMT);
        assertTrue(IERC20Like(USDT).authorizationState(payer, gNonce), "real token marked the authorization used");

        _relay(makeAddr("relayer"), true); // replaying the same signature is refused

        vm.startPrank(maya); // merchant refunds half
        IERC20Like(USDT).approve(address(gco), G_AMT);
        gco.refund(G_ORDER, G_AMT / 2);
        vm.stopPrank();
        assertEq(IERC20Like(USDT).balanceOf(payer), 10e6 - G_AMT + G_AMT / 2);
    }

    function _relay(address relayer, bool expectAlreadyPaid) internal {
        (uint8 v, bytes32 r, bytes32 s) = signAuth(G_PK, IERC20Like(USDT).DOMAIN_SEPARATOR(), address(gco), G_AMT, gDeadline, gNonce);
        if (expectAlreadyPaid) vm.expectRevert(OmenCheckout.AlreadyPaid.selector);
        vm.prank(relayer);
        gco.payWithAuthorization(G_ORDER, G_MAYA, G_AMT, 6_000, gDeadline, vm.addr(G_PK), v, r, s);
    }
}
