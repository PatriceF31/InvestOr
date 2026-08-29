// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Interface minimale vers Exchange — définie localement, cohérent avec le
///      reste du protocole (voir IOracle/ITellorOracleReserve dans Reserve.sol)
interface IExchangePriceOracle {
    function getPrice() external view returns (uint256 price, uint8 source);
}

/// @title LombardVault — Prêt Lombard (US-01 Marthe, US-13 Farid)
/// @notice Dépôt de GLD en collatéral, emprunt d'USDC jusqu'à un LTV maximum,
///         financé par un pool de prêteurs stablecoin dédié (pas Treasury).
/// @dev UUPS upgradeable, owned par Reserve (même pattern qu'Exchange/MorphoYieldStrategy).
///
///      Option A retenue (vs un second marché Morpho Blue) : liquidation contrôlée
///      explicitement par un rôle opérateur, pas permissionless — cohérent avec le
///      guichet de rachat interne visé (US-11) et avec le fait que le collatéral (GLD)
///      ne peut de toute façon être détenu que par une adresse conforme ERC-3643.
///
///      IMPORTANT — déploiement : ce contrat NE DOIT PAS être enregistré comme agent
///      dans CountryComplianceModule. Un agent est exempté des DEUX côtés d'un
///      transfert (`_agents[from] || _agents[to]` ⇒ toujours autorisé) — si LombardVault
///      était agent, n'importe qui, KYC ou non, pourrait déposer du GLD via
///      depositCollateral(), contournant exactement le garde-fou de whitelist. La bonne
///      configuration est d'enregistrer l'adresse de ce contrat comme identité *vérifiée*
///      dans IdentityRegistry (pas comme agent) : la règle 4 de canTransfer() exige alors
///      _isCompliant(from) ET _isCompliant(to) — le contrat passe toujours son propre
///      test, mais le déposant réel (Marthe) doit rester réellement whitelisté.
contract LombardVault is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ─── Constantes ──────────────────────────────────────────────────────────

    uint256 private constant BPS = 10_000;
    uint256 private constant SECONDS_PER_YEAR = 365 days;
    // GLD (3 déc) × prix XAU/USD (8 déc) / 1e5 = valeur en USDC (6 déc)
    // Convention identique à Exchange.previewSell() — voir grossUsd = (gldAmount * price) / 1e5
    uint256 private constant PRICE_SCALE = 1e5;
    uint256 private constant SHARE_SCALE = 1e18;

    // ─── Storage ─────────────────────────────────────────────────────────────
    //
    //  0. collateralToken       (address)  — GLD
    //  1. loanToken             (address)  — USDC
    //  2. exchange              (address)  — source de prix (Exchange.getPrice())
    //  3. operator               (address)
    //  4. ltvMaxBps              (uint256)  — 7000 = 70 %
    //  5. liquidationThresholdBps(uint256)  — 8000 = 80 %
    //  6. borrowRateBps          (uint256)  — 700  = 7 %/an, payé par l'emprunteur
    //  7. supplierShareBps       (uint256)  — 400  = 4 %/an vers les prêteurs
    //  8. protocolShareBps       (uint256)  — 300  = 3 %/an vers le protocole
    //  9. liquidationDiscountBps (uint256)  — décote du guichet de rachat
    // 10. positions              (mapping)  — emprunteurs
    // 11. totalSupplied          (uint256)
    // 12. accInterestPerShare    (uint256)  — cumul intérêt/part, échelle 1e18
    // 13. supplierPrincipal      (mapping)
    // 14. supplierRewardDebt     (mapping)  — pattern MasterChef standard
    // 15. protocolAccruedUSDC    (uint256)

    struct BorrowPosition {
        uint256 collateralGLD;
        uint256 principalCapital; // capital réellement emprunté
        uint256 interestOwed;     // intérêt couru, non encore payé
        uint256 lastAccrual;
    }

    IERC20  public collateralToken;                        // slot 0
    IERC20  public loanToken;                               // slot 1
    address public exchange;                                // slot 2
    address public operator;                                // slot 3
    uint256 public ltvMaxBps;                                // slot 4
    uint256 public liquidationThresholdBps;                  // slot 5
    uint256 public borrowRateBps;                             // slot 6
    uint256 public supplierShareBps;                          // slot 7
    uint256 public protocolShareBps;                          // slot 8
    uint256 public liquidationDiscountBps;                    // slot 9
    mapping(address => BorrowPosition) public positions;      // slot 10
    uint256 public totalSupplied;                              // slot 11
    uint256 public accInterestPerShare;                        // slot 12
    mapping(address => uint256) public supplierPrincipal;      // slot 13
    mapping(address => uint256) public supplierRewardDebt;     // slot 14
    uint256 public protocolAccruedUSDC;                        // slot 15

    // ─── Events ──────────────────────────────────────────────────────────────

    event CollateralDeposited(address indexed user, uint256 amount);
    event CollateralWithdrawn(address indexed user, uint256 amount);
    event Borrowed(address indexed user, uint256 amount);
    event Repaid(address indexed user, uint256 interestPortion, uint256 principalPortion);
    event Liquidated(
        address indexed borrower, address indexed buyer,
        uint256 collateralSeized, uint256 usdcRecovered
    );
    event Supplied(address indexed user, uint256 amount);
    event SupplyWithdrawn(address indexed user, uint256 requested, uint256 actual);
    event RewardClaimed(address indexed user, uint256 amount);
    event ProtocolShareClaimed(address indexed to, uint256 amount);
    event ParamsUpdated();
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error NoCollateral();
    error NoDebt();
    error LtvExceeded(uint256 newLtvBps, uint256 maxLtvBps);
    error NotLiquidatable(uint256 currentLtvBps, uint256 thresholdBps);
    error InsufficientLiquidity(uint256 requested, uint256 available);
    error InsufficientCollateral(uint256 requested, uint256 available);
    error UnauthorizedOperator(address caller);
    error InvalidBps(uint256 value);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyOperator() {
        if (msg.sender != operator && msg.sender != owner()) revert UnauthorizedOperator(msg.sender);
        _;
    }

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(
        address initialOwner,
        address collateralTokenAddr,
        address loanTokenAddr,
        address exchangeAddr,
        address operatorAddr
    ) external initializer {
        if (initialOwner == address(0) || collateralTokenAddr == address(0) ||
            loanTokenAddr == address(0) || exchangeAddr == address(0) ||
            operatorAddr == address(0)) revert ZeroAddress();

        __Ownable_init(initialOwner);
        __Pausable_init();

        collateralToken = IERC20(collateralTokenAddr);
        loanToken        = IERC20(loanTokenAddr);
        exchange          = exchangeAddr;
        operator           = operatorAddr;

        ltvMaxBps               = 7_000; // 70 %
        liquidationThresholdBps = 8_000; // 80 %
        borrowRateBps           = 700;   // 7 %/an
        supplierShareBps        = 400;   // 4 %/an
        protocolShareBps        = 300;   // 3 %/an
        liquidationDiscountBps  = 500;   // 5 % — valeur de départ, modifiable par le Safe
    }

    // ─── Emprunteur (Marthe, US-01) ──────────────────────────────────────────

    function depositCollateral(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        collateralToken.safeTransferFrom(msg.sender, address(this), amount);
        positions[msg.sender].collateralGLD += amount;
        emit CollateralDeposited(msg.sender, amount);
    }

    function borrow(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        BorrowPosition storage pos = positions[msg.sender];
        if (pos.collateralGLD == 0) revert NoCollateral();

        _accrueBorrowerInterest(msg.sender);

        uint256 available = loanToken.balanceOf(address(this));
        if (amount > available) revert InsufficientLiquidity(amount, available);

        pos.principalCapital += amount;

        uint256 newLtv = _ltvBps(pos);
        if (newLtv > ltvMaxBps) revert LtvExceeded(newLtv, ltvMaxBps);

        loanToken.safeTransfer(msg.sender, amount);
        emit Borrowed(msg.sender, amount);
    }

    /// @notice Rembourse jusqu'à `amount` — l'intérêt couru est soldé en premier
    function repay(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        BorrowPosition storage pos = positions[msg.sender];

        _accrueBorrowerInterest(msg.sender);

        uint256 totalDebt = pos.principalCapital + pos.interestOwed;
        if (totalDebt == 0) revert NoDebt();

        uint256 payment = amount > totalDebt ? totalDebt : amount;
        uint256 interestPortion = payment > pos.interestOwed ? pos.interestOwed : payment;
        uint256 principalPortion = payment - interestPortion;

        pos.interestOwed -= interestPortion;
        pos.principalCapital -= principalPortion;

        loanToken.safeTransferFrom(msg.sender, address(this), payment);

        if (interestPortion > 0) _distributeInterest(interestPortion);

        emit Repaid(msg.sender, interestPortion, principalPortion);
    }

    function withdrawCollateral(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        BorrowPosition storage pos = positions[msg.sender];
        if (amount > pos.collateralGLD) revert InsufficientCollateral(amount, pos.collateralGLD);

        _accrueBorrowerInterest(msg.sender);

        pos.collateralGLD -= amount;

        if (pos.principalCapital + pos.interestOwed > 0) {
            uint256 newLtv = _ltvBps(pos);
            if (newLtv > ltvMaxBps) revert LtvExceeded(newLtv, ltvMaxBps);
        }

        collateralToken.safeTransfer(msg.sender, amount);
        emit CollateralWithdrawn(msg.sender, amount);
    }

    // ─── Prêteur (Farid, US-13) ──────────────────────────────────────────────

    function supply(uint256 amount) external whenNotPaused nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _settleSupplierReward(msg.sender);

        loanToken.safeTransferFrom(msg.sender, address(this), amount);
        supplierPrincipal[msg.sender] += amount;
        totalSupplied += amount;

        supplierRewardDebt[msg.sender] = (supplierPrincipal[msg.sender] * accInterestPerShare) / SHARE_SCALE;
        emit Supplied(msg.sender, amount);
    }

    /// @notice Retrait "best effort" — plafonné à la liquidité réellement disponible,
    ///         même pattern défensif que MorphoYieldStrategy.withdraw()
    function withdraw(uint256 amount) external whenNotPaused nonReentrant returns (uint256 withdrawn) {
        if (amount == 0) revert ZeroAmount();
        uint256 pending = _settleSupplierReward(msg.sender);

        uint256 principal = supplierPrincipal[msg.sender];
        uint256 requestedPrincipal = amount > principal ? principal : amount;

        uint256 available = loanToken.balanceOf(address(this));
        withdrawn = requestedPrincipal > available ? available : requestedPrincipal;

        supplierPrincipal[msg.sender] -= withdrawn;
        totalSupplied -= withdrawn;
        supplierRewardDebt[msg.sender] = (supplierPrincipal[msg.sender] * accInterestPerShare) / SHARE_SCALE;

        uint256 totalOut = withdrawn + pending;
        if (totalOut > 0) loanToken.safeTransfer(msg.sender, totalOut);

        emit SupplyWithdrawn(msg.sender, amount, withdrawn);
    }

    function claimReward() external whenNotPaused nonReentrant {
        uint256 pending = _settleSupplierReward(msg.sender);
        if (pending > 0) {
            loanToken.safeTransfer(msg.sender, pending);
            emit RewardClaimed(msg.sender, pending);
        }
    }

    function pendingReward(address user) external view returns (uint256) {
        return (supplierPrincipal[user] * accInterestPerShare) / SHARE_SCALE - supplierRewardDebt[user];
    }

    // ─── Liquidation (guichet interne, US-11) — réservée à l'opérateur ────────

    /// @notice Liquide une position sous-collatéralisée (LTV ≥ liquidationThresholdBps)
    /// @dev Saisie partielle par défaut : seul le collatéral nécessaire pour couvrir la
    ///      dette au prix décoté est prélevé — le surplus reste à l'emprunteur. La saisie
    ///      totale ne survient que si même la totalité du collatéral décoté ne suffit pas
    ///      à couvrir la dette (créance irrécouvrable, perte assumée par le pool).
    /// @param borrower Position à liquider
    /// @param buyer Adresse qui fournit l'USDC de rachat et reçoit le collatéral saisi
    ///        (Treasury en pratique, mais non figé en dur — désigné par l'opérateur
    ///        à chaque appel). `buyer` doit avoir approuvé le montant au préalable.
    function liquidate(address borrower, address buyer)
        external whenNotPaused onlyOperator nonReentrant
        returns (uint256 usdcRecovered, uint256 collateralSeized)
    {
        if (buyer == address(0)) revert ZeroAddress();
        BorrowPosition storage pos = positions[borrower];
        if (pos.collateralGLD == 0) revert NoCollateral();

        _accrueBorrowerInterest(borrower);

        uint256 ltv = _ltvBps(pos);
        if (ltv < liquidationThresholdBps) revert NotLiquidatable(ltv, liquidationThresholdBps);

        uint256 debt = pos.principalCapital + pos.interestOwed;
        uint256 collateralValueUsdc = _collateralValueUsdc(pos.collateralGLD);
        uint256 discountedTotalValue = (collateralValueUsdc * (BPS - liquidationDiscountBps)) / BPS;

        if (discountedTotalValue <= debt) {
            // Même décoté, le collatéral entier ne couvre pas la dette — créance
            // irrécouvrable, perte assumée par le pool. Saisie totale, position soldée.
            collateralSeized = pos.collateralGLD;
            usdcRecovered = discountedTotalValue;
        } else {
            // Saisie partielle : juste assez pour couvrir la dette au prix décoté.
            collateralSeized = (debt * pos.collateralGLD) / discountedTotalValue;
            usdcRecovered = debt;
        }

        uint256 interestPortion = usdcRecovered > pos.interestOwed ? pos.interestOwed : usdcRecovered;
        uint256 principalPortion = usdcRecovered - interestPortion;

        pos.collateralGLD -= collateralSeized;
        pos.interestOwed -= interestPortion;
        pos.principalCapital -= principalPortion;
        // Créance irrécouvrable : si tout le collatéral est parti, on solde la position
        // même si un résidu de dette subsiste (perte déjà actée dans discountedTotalValue).
        if (pos.collateralGLD == 0) delete positions[borrower];

        loanToken.safeTransferFrom(buyer, address(this), usdcRecovered);
        if (interestPortion > 0) _distributeInterest(interestPortion);

        collateralToken.safeTransfer(buyer, collateralSeized);

        emit Liquidated(borrower, buyer, collateralSeized, usdcRecovered);
    }

    // ─── Vues ────────────────────────────────────────────────────────────────

    function currentLTV(address borrower) external view returns (uint256) {
        return _ltvBps(positions[borrower]);
    }

    function debtOf(address borrower) external view returns (uint256 principal, uint256 interest) {
        BorrowPosition storage pos = positions[borrower];
        uint256 elapsed = block.timestamp - pos.lastAccrual;
        uint256 accrued = pos.principalCapital == 0 ? 0
            : (pos.principalCapital * borrowRateBps * elapsed) / (BPS * SECONDS_PER_YEAR);
        return (pos.principalCapital, pos.interestOwed + accrued);
    }

    function availableLiquidity() public view returns (uint256) {
        return loanToken.balanceOf(address(this));
    }

    // ─── Internes ────────────────────────────────────────────────────────────

    function _accrueBorrowerInterest(address borrower) internal {
        BorrowPosition storage pos = positions[borrower];
        if (pos.principalCapital == 0) { pos.lastAccrual = block.timestamp; return; }
        uint256 elapsed = block.timestamp - pos.lastAccrual;
        if (elapsed == 0) return;
        uint256 interest = (pos.principalCapital * borrowRateBps * elapsed) / (BPS * SECONDS_PER_YEAR);
        pos.interestOwed += interest;
        pos.lastAccrual = block.timestamp;
    }

    /// @dev Répartit un paiement d'intérêt réel (cash effectivement reçu) entre les
    ///      prêteurs (accInterestPerShare) et le protocole. Si aucun prêteur n'est
    ///      encore actif (totalSupplied == 0), la part prêteurs tombe au protocole —
    ///      cas limite documenté plutôt que silencieux.
    function _distributeInterest(uint256 interestPortion) internal {
        uint256 supplierCut = (interestPortion * supplierShareBps) / borrowRateBps;
        uint256 protocolCut = interestPortion - supplierCut;

        if (totalSupplied > 0) {
            accInterestPerShare += (supplierCut * SHARE_SCALE) / totalSupplied;
        } else {
            protocolCut += supplierCut; // aucun prêteur — la part leur revenant est retenue par le protocole
        }
        protocolAccruedUSDC += protocolCut;
    }

    function _settleSupplierReward(address user) internal view returns (uint256 pending) {
        uint256 principal = supplierPrincipal[user];
        pending = (principal * accInterestPerShare) / SHARE_SCALE - supplierRewardDebt[user];
    }

    function _ltvBps(BorrowPosition storage pos) internal view returns (uint256) {
        uint256 debt = pos.principalCapital + pos.interestOwed;
        if (debt == 0) return 0;
        if (pos.collateralGLD == 0) return type(uint256).max;
        uint256 collateralValueUsdc = _collateralValueUsdc(pos.collateralGLD);
        if (collateralValueUsdc == 0) return type(uint256).max;
        return (debt * BPS) / collateralValueUsdc;
    }

    /// @dev Même convention de mise à l'échelle que Exchange.previewSell() :
    ///      GLD (3 déc) × prix XAU/USD (8 déc) / 1e5 = valeur en USDC (6 déc)
    function _collateralValueUsdc(uint256 amountGLD) internal view returns (uint256) {
        (uint256 price, ) = IExchangePriceOracle(exchange).getPrice();
        return (amountGLD * price) / PRICE_SCALE;
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    function setLtvParams(uint256 newLtvMaxBps, uint256 newLiquidationThresholdBps) external onlyOwner {
        if (newLtvMaxBps == 0 || newLtvMaxBps > BPS) revert InvalidBps(newLtvMaxBps);
        if (newLiquidationThresholdBps <= newLtvMaxBps || newLiquidationThresholdBps > BPS)
            revert InvalidBps(newLiquidationThresholdBps);
        ltvMaxBps = newLtvMaxBps;
        liquidationThresholdBps = newLiquidationThresholdBps;
        emit ParamsUpdated();
    }

    function setRateParams(uint256 newBorrowRateBps, uint256 newSupplierShareBps, uint256 newProtocolShareBps)
        external onlyOwner
    {
        if (newSupplierShareBps + newProtocolShareBps != newBorrowRateBps) revert InvalidBps(newBorrowRateBps);
        borrowRateBps = newBorrowRateBps;
        supplierShareBps = newSupplierShareBps;
        protocolShareBps = newProtocolShareBps;
        emit ParamsUpdated();
    }

    function setLiquidationDiscount(uint256 newDiscountBps) external onlyOwner {
        if (newDiscountBps >= BPS) revert InvalidBps(newDiscountBps);
        liquidationDiscountBps = newDiscountBps;
        emit ParamsUpdated();
    }

    function claimProtocolShare(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = protocolAccruedUSDC;
        protocolAccruedUSDC = 0;
        if (amount > 0) {
            loanToken.safeTransfer(to, amount);
            emit ProtocolShareClaimed(to, amount);
        }
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Storage gap ─────────────────────────────────────────────────────────
    //
    //  16 slots explicites (0-15) + __gap[34] = 50 ✅

    uint256[34] private __gap;
}
