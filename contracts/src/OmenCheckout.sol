// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title OmenCheckout
/// @notice Merchant checkout for OMEN's village merchants on Whitechain. A payer pays a registered
///         merchant in the one stablecoin this contract is deployed with (Whitechain Sepolia's
///         official test USDT). Each order can be paid exactly once, before its quote deadline, and
///         the funds go straight to the merchant's payout address: the contract never holds them.
/// @dev The `Paid` event is the receipt the OMEN backend verifies before it marks an order settled.
contract OmenCheckout {
    struct Merchant {
        address payout;
        bool active;
    }

    /// The only token this checkout accepts. Fixed at deploy time.
    address public immutable token;
    address public owner;
    bool public paused;

    mapping(bytes32 merchantId => Merchant) public merchants;
    /// Who paid each order (zero if unpaid). Prevents paying an order twice.
    mapping(bytes32 orderId => address payer) public payerOf;

    event MerchantSet(bytes32 indexed merchantId, address payout, bool active);
    event Paid(
        bytes32 indexed orderId,
        bytes32 indexed merchantId,
        address indexed payer,
        address payout,
        uint256 amount,
        uint256 inrPaise
    );
    event Paused(bool paused);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error IsPaused();
    error ZeroAddress();
    error ZeroAmount();
    error UnknownMerchant();
    error AlreadyPaid();
    error QuoteExpired();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address token_) {
        if (token_ == address(0)) revert ZeroAddress();
        token = token_;
        owner = msg.sender;
        emit OwnerChanged(address(0), msg.sender);
    }

    // ------------------------------------------------------------------ admin

    function setMerchant(bytes32 merchantId, address payout, bool active) external onlyOwner {
        if (payout == address(0)) revert ZeroAddress();
        merchants[merchantId] = Merchant(payout, active);
        emit MerchantSet(merchantId, payout, active);
    }

    function setPaused(bool p) external onlyOwner {
        paused = p;
        emit Paused(p);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    // ------------------------------------------------------------------ checkout

    /// @notice Pay `amount` (token base units) for `orderId` to `merchantId`. The payer must first
    ///         `approve` this contract for at least `amount`.
    /// @param inrPaise The INR value of the order in paise, as quoted. Recorded in the receipt only.
    /// @param deadline Unix time after which the quote is stale and the payment is refused.
    function pay(bytes32 orderId, bytes32 merchantId, uint256 amount, uint256 inrPaise, uint256 deadline) external {
        if (paused) revert IsPaused();
        if (block.timestamp > deadline) revert QuoteExpired();
        if (amount == 0) revert ZeroAmount();
        if (payerOf[orderId] != address(0)) revert AlreadyPaid();
        Merchant memory m = merchants[merchantId];
        if (!m.active) revert UnknownMerchant();

        payerOf[orderId] = msg.sender; // effects before the external call
        _safeTransferFrom(msg.sender, m.payout, amount);
        emit Paid(orderId, merchantId, msg.sender, m.payout, amount, inrPaise);
    }

    /// Works with tokens that return a bool and with tokens (like mainnet USDT) that return nothing.
    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
