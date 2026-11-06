// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface (test USDT on Whitechain Sepolia).
interface IERC20Min {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title OmenPredictions
/// @notice TESTNET ONLY. NO REAL MONEY. JUST FOR FUN.
///         Prediction booths for the OMEN game at ETHGlobal Mumbai. Players stake test USDT, or
///         free non-transferable testnet points when `token` is zero, on market options.
///         - One World ID-verified player per wallet: the owner marks wallets verified only after
///           the OMEN server has verified that wallet's World ID proof (one nullifier = one wallet).
///         - Markets close at a fixed timestamp. The owner resolves with a bitmask of winning
///           options (several can win, e.g. "top 3 finalists"). Winners claim a pro-rata share of
///           the whole pool. If nobody backed a winning option, or a market is cancelled, everyone
///           can claim their stake back.
contract OmenPredictions {
    struct Market {
        uint64 closesAt;
        uint8 optionCount; // ≤ 64
        bool resolved;
        bool cancelled;
        uint64 winMask;
        uint256 total;
        uint256 winningTotal;
    }

    uint256 public constant POINTS_GRANT = 1_000e6; // 1,000 points, 6 decimals like test USDT
    uint8 public constant MAX_OPTIONS = 64;

    address public owner;
    address public pendingOwner;
    IERC20Min public immutable token; // zero → free testnet points mode

    uint256 public marketCount;
    mapping(uint256 => Market) public markets;
    mapping(uint256 => mapping(uint8 => uint256)) public optionTotal;
    mapping(uint256 => mapping(address => mapping(uint8 => uint256))) public stakeOf;
    mapping(uint256 => mapping(address => uint256)) public stakedBy;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(address => bool) public verified;
    mapping(address => uint256) public points;
    mapping(address => bool) public pointsGranted;

    event MarketCreated(uint256 indexed marketId, uint8 optionCount, uint64 closesAt, string question);
    event Verified(address indexed player, bool verified);
    event Staked(uint256 indexed marketId, address indexed player, uint8 indexed optionId, uint256 amount);
    event Resolved(uint256 indexed marketId, uint64 winMask, uint256 winningTotal, uint256 total);
    event Cancelled(uint256 indexed marketId);
    event Claimed(uint256 indexed marketId, address indexed player, uint256 amount);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotVerified();
    error BadMarket();
    error BadOption();
    error ZeroAmount();
    error Closed();
    error NotClosed();
    error AlreadySettled();
    error NotSettled();
    error AlreadyClaimed();
    error NothingToClaim();
    error InsufficientPoints();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    uint256 private _lock = 1;

    modifier nonReentrant() {
        require(_lock == 1, "reentrant");
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address token_, address owner_) {
        token = IERC20Min(token_);
        owner = owner_;
        emit OwnershipTransferred(address(0), owner_);
    }

    // ---------------------------------------------------------------- owner

    function createMarket(uint8 optionCount, uint64 closesAt, string calldata question) external onlyOwner returns (uint256 id) {
        if (optionCount < 2 || optionCount > MAX_OPTIONS) revert BadOption();
        if (closesAt <= block.timestamp) revert Closed();
        id = ++marketCount;
        markets[id] = Market({closesAt: closesAt, optionCount: optionCount, resolved: false, cancelled: false, winMask: 0, total: 0, winningTotal: 0});
        emit MarketCreated(id, optionCount, closesAt, question);
    }

    /// @notice Called by the OMEN server's owner key after it verified this wallet's World ID proof.
    function setVerified(address[] calldata players, bool isVerified) external onlyOwner {
        for (uint256 i; i < players.length; ++i) {
            address p = players[i];
            verified[p] = isVerified;
            if (isVerified && address(token) == address(0) && !pointsGranted[p]) {
                pointsGranted[p] = true;
                points[p] += POINTS_GRANT;
            }
            emit Verified(p, isVerified);
        }
    }

    function resolve(uint256 marketId, uint64 winMask) external onlyOwner {
        Market storage m = _market(marketId);
        if (block.timestamp < m.closesAt) revert NotClosed();
        if (m.resolved || m.cancelled) revert AlreadySettled();
        if (winMask == 0 || (m.optionCount < 64 && winMask >> m.optionCount != 0)) revert BadOption();
        uint256 win;
        for (uint8 o; o < m.optionCount; ++o) if (winMask & (uint64(1) << o) != 0) win += optionTotal[marketId][o];
        m.resolved = true;
        m.winMask = winMask;
        m.winningTotal = win;
        emit Resolved(marketId, winMask, win, m.total);
    }

    function cancel(uint256 marketId) external onlyOwner {
        Market storage m = _market(marketId);
        if (m.resolved || m.cancelled) revert AlreadySettled();
        m.cancelled = true;
        emit Cancelled(marketId);
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(owner, to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // --------------------------------------------------------------- player

    function stake(uint256 marketId, uint8 optionId, uint256 amount) external nonReentrant {
        if (!verified[msg.sender]) revert NotVerified();
        Market storage m = _market(marketId);
        if (block.timestamp >= m.closesAt || m.resolved || m.cancelled) revert Closed();
        if (optionId >= m.optionCount) revert BadOption();
        if (amount == 0) revert ZeroAmount();
        if (address(token) == address(0)) {
            if (points[msg.sender] < amount) revert InsufficientPoints();
            points[msg.sender] -= amount;
        } else if (!token.transferFrom(msg.sender, address(this), amount)) {
            revert TransferFailed();
        }
        stakeOf[marketId][msg.sender][optionId] += amount;
        stakedBy[marketId][msg.sender] += amount;
        optionTotal[marketId][optionId] += amount;
        m.total += amount;
        emit Staked(marketId, msg.sender, optionId, amount);
    }

    /// @notice What `player` can claim now (0 if unsettled, already claimed or lost).
    function claimable(uint256 marketId, address player) public view returns (uint256) {
        Market storage m = markets[marketId];
        if (claimed[marketId][player]) return 0;
        // Cancelled, or nobody backed a winner: everyone gets their stake back.
        if (m.cancelled || (m.resolved && m.winningTotal == 0)) return stakedBy[marketId][player];
        if (!m.resolved) return 0;
        uint256 mine;
        for (uint8 o; o < m.optionCount; ++o) if (m.winMask & (uint64(1) << o) != 0) mine += stakeOf[marketId][player][o];
        return mine * m.total / m.winningTotal;
    }

    function claim(uint256 marketId) external nonReentrant returns (uint256 amount) {
        Market storage m = _market(marketId);
        if (!m.resolved && !m.cancelled) revert NotSettled();
        if (claimed[marketId][msg.sender]) revert AlreadyClaimed();
        amount = claimable(marketId, msg.sender);
        if (amount == 0) revert NothingToClaim();
        claimed[marketId][msg.sender] = true;
        if (address(token) == address(0)) points[msg.sender] += amount;
        else if (!token.transfer(msg.sender, amount)) revert TransferFailed();
        emit Claimed(marketId, msg.sender, amount);
    }

    function _market(uint256 id) internal view returns (Market storage m) {
        m = markets[id];
        if (m.optionCount == 0) revert BadMarket();
    }
}
