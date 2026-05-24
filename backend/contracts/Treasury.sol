// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title Treasury V2 — Gardien multi-token (USDC + EURC)
/// @notice Reçoit et restitue USDC et EURC pour le compte du protocole InvestOr
/// @dev UUPS upgradeable — supporte plusieurs stablecoins (MiCA : USDC + EURC)
///
/// Nouveauté V2 — Multi-token :
///   - eurc (slot 5)                   : adresse EURC Circle
///   - _totalDepositedByToken (slot 6) : total déposé par token
///   - _supportedTokens (slot 7)       : whitelist des tokens acceptés
///   - _totalDeposited (slot 2) conservé pour compatibilité Reserve (lecture legacy)
///   - deposit/operatorWithdraw prennent maintenant un paramètre token
///   - totalDepositedAllTokens() agrège USDC + EURC (1:1 USD sur Sepolia)
contract Treasury is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ─── Storage ─────────────────────────────────────────────────────────────
    //
    //  0. usdc                    (address) — V1 inchangé
    //  1. _deposits               (mapping) — V1 déprécié conservé
    //  2. _totalDeposited         (uint256) — V1 déprécié conservé
    //  3. operator                (address) — V1 inchangé
    //  4. reserve                 (address) — V1 inchangé
    //  5. eurc                    (address) — V2
    //  6. _totalDepositedByToken  (mapping) — V2
    //  7. _supportedTokens        (mapping) — V2
    //

    IERC20  public usdc;                               // slot 0
    mapping(address => uint256) private _deposits;     // slot 1 déprécié
    uint256 private _totalDeposited;                   // slot 2 déprécié
    address public operator;                           // slot 3
    address public reserve;                            // slot 4
    IERC20  public eurc;                               // slot 5 V2
    mapping(address => uint256) private _totalDepositedByToken; // slot 6 V2
    mapping(address => bool)    private _supportedTokens;       // slot 7 V2

    // ─── Events ──────────────────────────────────────────────────────────────

    event Deposited(address indexed token, address indexed from, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OperatorWithdrawn(address indexed token, address indexed to, uint256 amount);
    event EmergencyWithdrawn(address indexed token, address indexed to, uint256 amount);
    event TokenAdded(address indexed token);
    event TokenRemoved(address indexed token);
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);
    event UsdcAddressUpdated(address indexed oldUsdc, address indexed newUsdc);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance(uint256 requested, uint256 available);
    error UnauthorizedOperator(address caller);
    error UnsupportedToken(address token);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner())
            revert UnauthorizedOperator(msg.sender);
        _;
    }

    modifier onlySupportedToken(address token) {
        if (!_supportedTokens[token]) revert UnsupportedToken(token);
        _;
    }

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(
        address initialOwner,
        address usdcAddress,
        address eurcAddress
    ) external initializer {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (usdcAddress  == address(0)) revert ZeroAddress();

        __Ownable_init(initialOwner);
        __Pausable_init();

        usdc = IERC20(usdcAddress);
        _supportedTokens[usdcAddress] = true;
        emit TokenAdded(usdcAddress);

        if (eurcAddress != address(0)) {
            eurc = IERC20(eurcAddress);
            _supportedTokens[eurcAddress] = true;
            emit TokenAdded(eurcAddress);
        }
    }

    // ─── Dépôt ───────────────────────────────────────────────────────────────

    function deposit(uint256 amount, address token)
        external whenNotPaused onlyOperator onlySupportedToken(token) nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        _totalDepositedByToken[token] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(token, msg.sender, amount);
    }

    function withdraw(uint256 amount, address token)
        external whenNotPaused onlyOperator onlySupportedToken(token) nonReentrant
    {
        if (amount == 0) revert ZeroAmount();
        uint256 available = IERC20(token).balanceOf(address(this));
        if (amount > available) revert InsufficientBalance(amount, available);
        _totalDepositedByToken[token] -= amount;
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(token, msg.sender, amount);
    }

    function operatorWithdraw(address to, uint256 amount, address token)
        external whenNotPaused onlyOperator onlySupportedToken(token) nonReentrant
    {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        uint256 available = IERC20(token).balanceOf(address(this));
        if (amount > available) revert InsufficientBalance(amount, available);
        _totalDepositedByToken[token] -= amount;
        IERC20(token).safeTransfer(to, amount);
        emit OperatorWithdrawn(token, to, amount);
    }

    function injectCapital(uint256 amount, address token)
        external whenNotPaused onlySupportedToken(token) nonReentrant
    {
        if (msg.sender != owner() && msg.sender != operator && msg.sender != reserve)
            revert UnauthorizedOperator(msg.sender);
        if (amount == 0) revert ZeroAmount();
        _totalDepositedByToken[token] += amount;
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(token, msg.sender, amount);
    }

    // ─── Vues ─────────────────────────────────────────────────────────────────

    function totalDepositedByToken(address token) external view returns (uint256) {
        return _totalDepositedByToken[token];
    }

    /// @notice Agrège USDC + EURC (1:1 USD sur Sepolia)
    function totalDepositedAllTokens() external view returns (uint256 total) {
        total = _totalDepositedByToken[address(usdc)];
        if (address(eurc) != address(0)) {
            total += _totalDepositedByToken[address(eurc)];
        }
    }

    /// @notice Compatibilité V1 Reserve — retourne USDC + EURC agrégés
    function totalDeposited() external view returns (uint256) {
        uint256 total = _totalDepositedByToken[address(usdc)];
        if (address(eurc) != address(0)) {
            total += _totalDepositedByToken[address(eurc)];
        }
        return total;
    }

    function isSupportedToken(address token) external view returns (bool) {
        return _supportedTokens[token];
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function setOperator(address newOperator) external onlyOwner {
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    function setReserve(address newReserve) external onlyOwner {
        reserve = newReserve;
    }

    function setEurc(address eurcAddress) external onlyOwner {
        if (eurcAddress == address(0)) revert ZeroAddress();
        eurc = IERC20(eurcAddress);
        _supportedTokens[eurcAddress] = true;
        emit TokenAdded(eurcAddress);
    }

    function addSupportedToken(address token) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        if (!_supportedTokens[token]) {
            _supportedTokens[token] = true;
            emit TokenAdded(token);
        }
    }

    function removeSupportedToken(address token) external onlyOwner {
        if (_supportedTokens[token]) {
            _supportedTokens[token] = false;
            emit TokenRemoved(token);
        }
    }

    function emergencyWithdraw(address to, address token) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance == 0) revert ZeroAmount();
        IERC20(token).safeTransfer(to, balance);
        emit EmergencyWithdrawn(token, to, balance);
    }

    function setUsdcAddress(address newUsdc) external onlyOwner {
        if (newUsdc == address(0)) revert ZeroAddress();
        emit UsdcAddressUpdated(address(usdc), newUsdc);
        _supportedTokens[address(usdc)] = false;
        usdc = IERC20(newUsdc);
        _supportedTokens[newUsdc] = true;
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Storage gap ─────────────────────────────────────────────────────────
    //
    //  8 slots explicites + __gap[42] = 50 ✅

    uint256[42] private __gap;
}
