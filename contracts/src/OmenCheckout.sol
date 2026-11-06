// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// The parts of Whitechain's test USDT (TetherTokenV2 with EIP-3009) this checkout uses.
interface IEIP3009Token {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/// @title OmenCheckout
/// @notice Merchant checkout for OMEN's village merchants on Whitechain. A payer pays a registered
///         merchant in the one stablecoin this contract is deployed with (Whitechain Sepolia's
///         official test USDT). Each order can be paid exactly once, before its quote deadline, and
///         the funds go straight on to the merchant's payout address.
///
///         Two ways to pay:
///         - `payWithAuthorization` (gasless for the payer): the payer signs an EIP-3009
///           ReceiveWithAuthorization off-chain and anyone (OMEN's relayer) submits it and pays the
///           gas. The authorization's nonce is derived from the order, so a signature can only ever
///           settle the exact order, merchant, amount and deadline it was made for; and only this
///           contract can redeem it (`to == msg.sender` in the token).
///         - `pay`: classic approve + pay, where the payer sends the transaction.
///
///         Merchants can refund an order (up to what was paid) back to its payer.
/// @dev The `Paid` event is the receipt the OMEN backend verifies before it marks an order settled.
contract OmenCheckout {
    struct Merchant {
        address payout;
        bool active;
    }

    struct Order {
        address payer;
        bytes32 merchantId;
        uint128 amount;
        uint128 refunded;
    }

    /// The only token this checkout accepts. Fixed at deploy time.
    address public immutable token;
    address public owner;
    bool public paused;

    mapping(bytes32 merchantId => Merchant) public merchants;
    /// Every paid order. `payer == address(0)` means unpaid; an order can be paid once.
    mapping(bytes32 orderId => Order) public orders;

    event MerchantSet(bytes32 indexed merchantId, address payout, bool active);
    event Paid(
        bytes32 indexed orderId,
        bytes32 indexed merchantId,
        address indexed payer,
        address payout,
        uint256 amount,
        uint256 inrPaise
    );
    event Refunded(bytes32 indexed orderId, address indexed payer, uint256 amount);
    event Paused(bool paused);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotMerchant();
    error IsPaused();
    error ZeroAddress();
    error ZeroAmount();
    error AmountTooLarge();
    error UnknownMerchant();
    error UnknownOrder();
    error AlreadyPaid();
    error QuoteExpired();
    error RefundTooLarge();
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

    /// The EIP-3009 nonce a payer signs for an order. Binds the signature to every order term.
    function authorizationNonce(bytes32 orderId, bytes32 merchantId, uint256 amount, uint256 inrPaise, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(address(this), orderId, merchantId, amount, inrPaise, deadline));
    }

    /// Back-compat view: who paid `orderId` (zero if unpaid).
    function payerOf(bytes32 orderId) external view returns (address) {
        return orders[orderId].payer;
    }

    /// @notice Gasless for the payer: settle `orderId` with the payer's signed EIP-3009
    ///         ReceiveWithAuthorization (to = this contract, validAfter = 0, validBefore = deadline,
    ///         nonce = authorizationNonce(...)). Anyone may submit it; the terms can't be changed.
    ///         (Tether requires block.timestamp < validBefore, so this path closes one second
    ///         before `pay` does.)
    function payWithAuthorization(
        bytes32 orderId,
        bytes32 merchantId,
        uint256 amount,
        uint256 inrPaise,
        uint256 deadline,
        address payer,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        Merchant memory m = _open(orderId, merchantId, amount, deadline, payer);
        bytes32 nonce = authorizationNonce(orderId, merchantId, amount, inrPaise, deadline);
        // Pull from the payer into this contract (the token checks the signature and the nonce)...
        IEIP3009Token(token).receiveWithAuthorization(payer, address(this), amount, 0, deadline, nonce, v, r, s);
        // ...and pass it straight on to the merchant.
        _safeCall(abi.encodeWithSelector(0xa9059cbb, m.payout, amount)); // transfer
        emit Paid(orderId, merchantId, payer, m.payout, amount, inrPaise);
    }

    /// @notice Classic flow: the payer must first `approve` this contract for at least `amount`.
    /// @param inrPaise The INR value of the order in paise, as quoted. Recorded in the receipt only.
    /// @param deadline Unix time after which the quote is stale and the payment is refused.
    function pay(bytes32 orderId, bytes32 merchantId, uint256 amount, uint256 inrPaise, uint256 deadline) external {
        Merchant memory m = _open(orderId, merchantId, amount, deadline, msg.sender);
        _safeCall(abi.encodeWithSelector(0x23b872dd, msg.sender, m.payout, amount)); // transferFrom
        emit Paid(orderId, merchantId, msg.sender, m.payout, amount, inrPaise);
    }

    /// @notice The merchant's payout address refunds up to the paid amount of `orderId` to its
    ///         payer. The merchant must have approved this contract for the refund amount.
    function refund(bytes32 orderId, uint256 amount) external {
        Order storage o = orders[orderId];
        if (o.payer == address(0)) revert UnknownOrder();
        if (msg.sender != merchants[o.merchantId].payout) revert NotMerchant();
        if (amount == 0) revert ZeroAmount();
        if (amount > o.amount - o.refunded) revert RefundTooLarge();
        o.refunded += uint128(amount); // effects before the external call
        _safeCall(abi.encodeWithSelector(0x23b872dd, msg.sender, o.payer, amount));
        emit Refunded(orderId, o.payer, amount);
    }

    /// Checks shared by both pay paths; records the order (effects before any external call).
    function _open(bytes32 orderId, bytes32 merchantId, uint256 amount, uint256 deadline, address payer)
        private
        returns (Merchant memory m)
    {
        if (paused) revert IsPaused();
        if (block.timestamp > deadline) revert QuoteExpired();
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint128).max) revert AmountTooLarge();
        if (payer == address(0)) revert ZeroAddress();
        if (orders[orderId].payer != address(0)) revert AlreadyPaid();
        m = merchants[merchantId];
        if (!m.active) revert UnknownMerchant();
        orders[orderId] = Order(payer, merchantId, uint128(amount), 0);
    }

    /// Calls the token; works with tokens that return a bool and with tokens that return nothing.
    function _safeCall(bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
