// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./IYieldStrategy.sol";

/// @title Treasury V3 — Gardien multi-token (USDC + EURC) + poche rendement
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
///
/// Nouveauté V3 — Poche rendement (2.2) :
///   - yieldStrategy (slot 8) : stratégie externe (Morpho...) via IYieldStrategy
///   - operatorWithdraw() rapatrie automatiquement le manquant depuis yieldStrategy
///     si le solde liquide ne suffit pas à honorer une vente GLD
///   - rebalance() ajuste la répartition liquide/rendement vers un ratio cible,
///     déclenché par Reserve (ou owner) — jamais automatique dans cette V1
///   - GLD ne transite JAMAIS par cette poche — uniquement USDC/EURC, aucun
///     conflit avec la couche de conformité ERC-3643 du token GLD
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
    //  8. yieldStrategy           (address) — V3, ajouté après tous les slots existants
    //

    IERC20  public usdc;                               // slot 0
    mapping(address => uint256) private _deposits;     // slot 1 déprécié
    uint256 private _totalDeposited;                   // slot 2 déprécié
    address public operator;                           // slot 3
    address public reserve;                            // slot 4
    IERC20  public eurc;                               // slot 5 V2
    mapping(address => uint256) private _totalDepositedByToken; // slot 6 V2
    mapping(address => bool)    private _supportedTokens;       // slot 7 V2
    IYieldStrategy public yieldStrategy;               // slot 8 V3

    // ─── Events ──────────────────────────────────────────────────────────────

    event Deposited(address indexed token, address indexed from, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OperatorWithdrawn(address indexed token, address indexed to, uint256 amount);
    event EmergencyWithdrawn(address indexed token, address indexed to, uint256 amount);
    event TokenAdded(address indexed token);
    event TokenRemoved(address indexed token);
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);
    event UsdcAddressUpdated(address indexed oldUsdc, address indexed newUsdc);
    event YieldStrategyUpdated(address indexed oldStrategy, address indexed newStrategy);
    event Rebalanced(address indexed token, uint256 amount, bool depositedToStrategy);
    event YieldShortfallCovered(address indexed token, uint256 amountWithdrawn);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance(uint256 requested, uint256 available);
    error UnauthorizedOperator(address caller);
    error UnsupportedToken(address token);
    error NoYieldStrategy();
    error InvalidBps(uint256 bps);

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

    modifier onlyReserveOrOwner() {
        if (msg.sender != owner() && msg.sender != reserve)
            revert UnauthorizedOperator(msg.sender);
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

        // Rapatriement automatique depuis la poche rendement si le solde liquide
        // ne suffit pas — garantit qu'une vente GLD ne peut jamais échouer faute
        // de liquidité immédiate tant que la stratégie a de quoi couvrir.
        if (available < amount &&
            address(yieldStrategy) != address(0) &&
            yieldStrategy.asset() == token)
        {
            uint256 shortfall = amount - available;
            uint256 recovered = yieldStrategy.withdraw(shortfall);
            available = IERC20(token).balanceOf(address(this));
            emit YieldShortfallCovered(token, recovered);
        }

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

    /// @notice Solde liquide + valeur investie dans la stratégie de rendement (si `token`
    ///         correspond à yieldStrategy.asset()), sinon solde liquide seul
    function totalManaged(address token) external view returns (uint256) {
        uint256 liquid = IERC20(token).balanceOf(address(this));
        if (address(yieldStrategy) != address(0) && yieldStrategy.asset() == token) {
            liquid += yieldStrategy.totalAssets();
        }
        return liquid;
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

    /// @notice Configure la stratégie de rendement externe (Morpho, etc.)
    /// @dev address(0) désactive la poche rendement — operatorWithdraw() et rebalance()
    ///      redeviennent des no-ops vis-à-vis de la stratégie
    function setYieldStrategy(address newStrategy) external onlyReserveOrOwner {
        emit YieldStrategyUpdated(address(yieldStrategy), newStrategy);
        yieldStrategy = IYieldStrategy(newStrategy);
    }

    /// @notice Rééquilibre la poche liquide/rendement d'un token vers un ratio cible
    /// @param token Le token concerné — doit correspondre à yieldStrategy.asset()
    /// @param targetLiquidBps Part cible en poche liquide, en points de base (7500 = 75%)
    /// @dev Jamais automatique dans cette V1 — appelé par Reserve (ou owner) explicitement.
    ///      Ne modifie jamais _totalDepositedByToken : l'argent reste celui des clients,
    ///      qu'il dorme dans Treasury ou qu'il travaille dans la stratégie.
    function rebalance(address token, uint256 targetLiquidBps)
        external whenNotPaused onlyReserveOrOwner onlySupportedToken(token) nonReentrant
    {
        if (address(yieldStrategy) == address(0)) revert NoYieldStrategy();
        if (yieldStrategy.asset() != token) revert UnsupportedToken(token);
        if (targetLiquidBps > 10_000) revert InvalidBps(targetLiquidBps);

        uint256 liquid = IERC20(token).balanceOf(address(this));
        uint256 invested = yieldStrategy.totalAssets();
        uint256 totalHeld = liquid + invested;
        if (totalHeld == 0) return;

        uint256 targetLiquid = totalHeld * targetLiquidBps / 10_000;

        if (liquid > targetLiquid) {
            uint256 surplus = liquid - targetLiquid;
            IERC20(token).forceApprove(address(yieldStrategy), surplus);
            yieldStrategy.deposit(surplus);
            emit Rebalanced(token, surplus, true);
        } else if (liquid < targetLiquid) {
            uint256 shortfall = targetLiquid - liquid;
            uint256 toWithdraw = invested < shortfall ? invested : shortfall;
            if (toWithdraw > 0) {
                yieldStrategy.withdraw(toWithdraw);
                emit Rebalanced(token, toWithdraw, false);
            }
        }
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Storage gap ─────────────────────────────────────────────────────────
    //
    //  9 slots explicites (0-8) + __gap[41] = 50 ✅

    uint256[41] private __gap;
}
