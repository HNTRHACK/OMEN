// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {OmenPredictions} from "../src/OmenPredictions.sol";

contract TestUSDT {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external {
        balanceOf[to] += a;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[to] += a;
        return true;
    }
}

contract OmenPredictionsTest is Test {
    OmenPredictions points;
    OmenPredictions usdtMarket;
    TestUSDT usdt;
    address owner = address(0xA11CE);
    address alice = address(0xA1);
    address bob = address(0xB0);
    address carol = address(0xC0);
    address mallory = address(0xBAD);
    uint64 closes;

    function setUp() public {
        vm.warp(1_800_000_000);
        closes = uint64(block.timestamp + 1 days);
        points = new OmenPredictions(address(0), owner);
        usdt = new TestUSDT();
        usdtMarket = new OmenPredictions(address(usdt), owner);
        address[] memory ps = new address[](3);
        (ps[0], ps[1], ps[2]) = (alice, bob, carol);
        vm.startPrank(owner);
        points.setVerified(ps, true);
        usdtMarket.setVerified(ps, true);
        points.createMarket(2, closes, "Will a game project win?");
        usdtMarket.createMarket(3, closes, "Top 3 finalists");
        vm.stopPrank();
        for (uint256 i; i < 3; ++i) {
            usdt.mint(ps[i], 100e6);
            vm.prank(ps[i]);
            usdt.approve(address(usdtMarket), type(uint256).max);
        }
    }

    function test_verifiedPlayersGetFreePointsOnce() public {
        assertEq(points.points(alice), 1_000e6);
        address[] memory ps = new address[](1);
        ps[0] = alice;
        vm.prank(owner);
        points.setVerified(ps, true);
        assertEq(points.points(alice), 1_000e6, "no double grant");
        assertEq(usdtMarket.points(alice), 0, "no points in USDT mode");
    }

    function test_onlyVerifiedCanStake() public {
        vm.prank(mallory);
        vm.expectRevert(OmenPredictions.NotVerified.selector);
        points.stake(1, 0, 1);
    }

    function test_onlyOwnerAdmin() public {
        address[] memory ps = new address[](1);
        ps[0] = mallory;
        vm.startPrank(mallory);
        vm.expectRevert(OmenPredictions.NotOwner.selector);
        points.setVerified(ps, true);
        vm.expectRevert(OmenPredictions.NotOwner.selector);
        points.createMarket(2, closes, "x");
        vm.expectRevert(OmenPredictions.NotOwner.selector);
        points.resolve(1, 1);
        vm.stopPrank();
    }

    function test_closesAtFixedTimestamp() public {
        vm.warp(closes);
        vm.prank(alice);
        vm.expectRevert(OmenPredictions.Closed.selector);
        points.stake(1, 0, 1e6);
    }

    function test_cannotResolveBeforeClose() public {
        vm.prank(owner);
        vm.expectRevert(OmenPredictions.NotClosed.selector);
        points.resolve(1, 1);
    }

    function test_proRataPointsPayout() public {
        vm.prank(alice);
        points.stake(1, 0, 100e6); // yes
        vm.prank(bob);
        points.stake(1, 0, 300e6); // yes
        vm.prank(carol);
        points.stake(1, 1, 600e6); // no
        vm.warp(closes);
        vm.prank(owner);
        points.resolve(1, 1); // option 0 ("yes") wins
        assertEq(points.claimable(1, alice), 250e6); // 100/400 of 1000
        assertEq(points.claimable(1, bob), 750e6);
        assertEq(points.claimable(1, carol), 0);
        vm.prank(alice);
        points.claim(1);
        assertEq(points.points(alice), 900e6 + 250e6);
        vm.prank(alice);
        vm.expectRevert(OmenPredictions.AlreadyClaimed.selector);
        points.claim(1);
        vm.prank(carol);
        vm.expectRevert(OmenPredictions.NothingToClaim.selector);
        points.claim(1);
    }

    function test_multiWinnerUsdtPayout() public {
        vm.prank(alice);
        usdtMarket.stake(1, 0, 10e6);
        vm.prank(bob);
        usdtMarket.stake(1, 1, 30e6);
        vm.prank(carol);
        usdtMarket.stake(1, 2, 60e6);
        vm.warp(closes);
        vm.prank(owner);
        usdtMarket.resolve(1, 3); // options 0 and 1 both finish top 3
        vm.prank(alice);
        usdtMarket.claim(1);
        vm.prank(bob);
        usdtMarket.claim(1);
        assertEq(usdt.balanceOf(alice), 90e6 + 25e6); // 10/40 of 100
        assertEq(usdt.balanceOf(bob), 70e6 + 75e6);
        assertEq(usdt.balanceOf(address(usdtMarket)), 0);
    }

    function test_noWinnerBackedRefundsEveryone() public {
        vm.prank(alice);
        usdtMarket.stake(1, 0, 10e6);
        vm.warp(closes);
        vm.prank(owner);
        usdtMarket.resolve(1, 4);
        vm.prank(alice);
        usdtMarket.claim(1);
        assertEq(usdt.balanceOf(alice), 100e6);
    }

    function test_cancelRefunds() public {
        vm.prank(bob);
        points.stake(1, 1, 5e6);
        vm.prank(owner);
        points.cancel(1);
        vm.prank(bob);
        points.claim(1);
        assertEq(points.points(bob), 1_000e6);
    }

    function test_badOptionAndMask() public {
        vm.prank(alice);
        vm.expectRevert(OmenPredictions.BadOption.selector);
        points.stake(1, 2, 1e6);
        vm.warp(closes);
        vm.prank(owner);
        vm.expectRevert(OmenPredictions.BadOption.selector);
        points.resolve(1, 4);
    }

    function test_cannotOverspendPoints() public {
        vm.prank(alice);
        vm.expectRevert(OmenPredictions.InsufficientPoints.selector);
        points.stake(1, 0, 1_001e6);
    }
}
