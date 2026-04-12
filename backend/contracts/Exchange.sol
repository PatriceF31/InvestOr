// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Interface minimale Chainlink AggregatorV3
interface AggregatorV3Interface {
    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    );
    function decimals() external view returns (uint8);
}

/// @dev Interface minimale GLD
interface IGLD {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function decimals() external view returns (uint8);
}

/// @dev Interface minimale Treasury
interface ITreasury {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function operatorWithdraw(address to, uint256 amount) external;
    function usdc() external view returns (address);
}

/// @title Exchange — Achat et vente de GLD contre USDC
/// @notice Prix via Chainlink XAU/USD avec fallback owner
/// @dev UUPS upgradeable — nécessite d'être approuvé comme minter sur GLD
contract Exchange is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,  
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ─── Storage ─────────────────────────────────────────────────────────────

    IGLD     public gld;
    ITreasury public treasury;
    IERC20   public usdc;

    /// @dev Oracle Chainlink XAU/USD (peut être address(0) si non disponible)
    AggregatorV3Interface public priceOracle;

    /// @dev Prix fallback en USD par gramme d'or, 8 décimales (ex: 9000_00000000 = $90 000/kg = $90/g)
    uint256 public fallbackPrice;

    /// @dev Durée max de fraîcheur des données oracle (défaut: 1 heure)
    uint256 public oracleMaxAge;

    /// @dev Fee en basis points (1 bp = 0.01%) — 0 par défaut
    uint256 public feeBps;

    /// @dev Adresse de collecte des fees
    address public feeCollector;

    uint256 public constant BASIS_POINTS = 10_000;

    // ─── Events ──────────────────────────────────────────────────────────────

    event TokensBought(address indexed buyer, uint256 usdcAmount, uint256 gldAmount, uint256 price);
    event TokensSold(address indexed seller, uint256 gldAmount, uint256 usdcAmount, uint256 price);
    event FallbackPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event OracleMaxAgeUpdated(uint256 oldMaxAge, uint256 newMaxAge);
    event FeeBpsUpdated(uint256 oldFee, uint256 newFee);
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);
    event ContractsPaused(address indexed by);
    event ContractsUnpaused(address indexed by);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error NoPriceAvailable();
    error InvalidOraclePrice();
    error StaleOracleData(uint256 updatedAt, uint256 maxAge);
    error InsufficientUsdcInTreasury(uint256 requested, uint256 available);

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /// @notice Initialise l'Exchange
    /// @param initialOwner  Propriétaire
    /// @param gldAddress    Adresse du proxy GLD
    /// @param treasuryAddress Adresse du proxy Treasury
    /// @param oracleAddress Adresse Chainlink XAU/USD (address(0) = oracle désactivé)
    /// @param initFallbackPrice Prix fallback initial (8 décimales, ex: 9000_00000000)
    function initialize(
        address initialOwner,
        address gldAddress,
        address treasuryAddress,
        address oracleAddress,
        uint256 initFallbackPrice
    ) external initializer {
        if (initialOwner   == address(0)) revert ZeroAddress();
        if (gldAddress     == address(0)) revert ZeroAddress();
        if (treasuryAddress == address(0)) revert ZeroAddress();
        if (initFallbackPrice == 0) revert ZeroAmount();

        __Ownable_init(initialOwner);
        __Pausable_init();

        gld      = IGLD(gldAddress);
        treasury = ITreasury(treasuryAddress);
        usdc     = IERC20(ITreasury(treasuryAddress).usdc());

        if (oracleAddress != address(0)) {
            priceOracle = AggregatorV3Interface(oracleAddress);
        }

        fallbackPrice = initFallbackPrice;
        oracleMaxAge  = 3600; // 1 heure par défaut
        feeCollector  = initialOwner;
    }

    // ─── Prix ────────────────────────────────────────────────────────────────

    /// @notice Retourne le prix actif (oracle si disponible, sinon fallback)
    /// @return price    Prix en USD par gramme, 8 décimales
    /// @return isOracle true si le prix vient de l'oracle
    function getPrice() public view returns (uint256 price, bool isOracle) {
        if (address(priceOracle) != address(0)) {
            try priceOracle.latestRoundData() returns (
                uint80,
                int256 answer,
                uint256,
                uint256 updatedAt,
                uint80
            ) {
                if (answer > 0 && block.timestamp - updatedAt <= oracleMaxAge) {
                    return (uint256(answer), true);
                }
            } catch {}
        }
        if (fallbackPrice == 0) revert NoPriceAvailable();
        return (fallbackPrice, false);
    }

    // ─── Preview ─────────────────────────────────────────────────────────────

    /// @notice Calcule la quantité de GLD reçue pour un montant USDC
    /// @param usdcAmount Montant USDC (6 décimales)
    /// @return gldAmount Quantité GLD (3 décimales)
    function previewBuy(uint256 usdcAmount) public view returns (uint256 gldAmount) {
        if (usdcAmount == 0) revert ZeroAmount();
        (uint256 price,) = getPrice();
        // USDC: 6 dec | price: 8 dec | GLD: 3 dec
        // gldAmount = usdcAmount * 10^(8+3) / (price * 10^6)
        // = usdcAmount * 10^5 / price
        gldAmount = (usdcAmount * 1e5) / price;
    }

    /// @notice Calcule la quantité d'USDC reçue pour un montant GLD
    /// @param gldAmount Quantité GLD (3 décimales)
    /// @return usdcAmount Montant USDC (6 décimales)
    function previewSell(uint256 gldAmount) public view returns (uint256 usdcAmount) {
        if (gldAmount == 0) revert ZeroAmount();
        (uint256 price,) = getPrice();
        // usdcAmount = gldAmount * price / 10^5
        usdcAmount = (gldAmount * price) / 1e5;
    }

    // ─── Achat ───────────────────────────────────────────────────────────────

    /// @notice Achète des GLD en déposant des USDC dans le Treasury
    /// @dev L'utilisateur doit avoir approuvé usdc.approve(exchange, usdcAmount)
    /// @param usdcAmount Montant USDC à dépenser (6 décimales)
    function buy(uint256 usdcAmount) external whenNotPaused nonReentrant {
        if (usdcAmount == 0) revert ZeroAmount();

        uint256 gldAmount = previewBuy(usdcAmount);
        if (gldAmount == 0) revert ZeroAmount();

        (uint256 price,) = getPrice();

        // 1. Calcul et transfert des frais (pas d'interaction)
        uint256 feeAmount = (usdcAmount * feeBps) / BASIS_POINTS;
        uint256 netAmount = usdcAmount - feeAmount;

        // 2. Transfert USDC user → Exchange (entrée des fonds)
        usdc.safeTransferFrom(msg.sender, address(this), usdcAmount);

        // 3. Dépôt USDC net dans Treasury
        usdc.forceApprove(address(treasury), netAmount);
        treasury.deposit(netAmount);

        // 4. Mint GLD pour l'utilisateur (AVANT d'envoyer les fees vers l'extérieur, pour éviter les reentrancy)
        gld.mint(msg.sender, gldAmount);

        // 5. Fees en dernier (même si feeCollector ré-entre, le mint est déjà fait)
        if (feeAmount > 0 && feeCollector != address(0)) {
            usdc.safeTransfer(feeCollector, feeAmount);
        }

        emit TokensBought(msg.sender, usdcAmount, gldAmount, price);
    }

    // ─── Vente ───────────────────────────────────────────────────────────────

    /// @notice Vend des GLD et récupère des USDC depuis le Treasury
    /// @param gldAmount Quantité de GLD à vendre (3 décimales)
    function sell(uint256 gldAmount) external whenNotPaused nonReentrant {
        if (gldAmount == 0) revert ZeroAmount();

        uint256 usdcAmount = previewSell(gldAmount);
        if (usdcAmount == 0) revert ZeroAmount();

        (uint256 price,) = getPrice();

        // 1. Calcul des frais
        uint256 feeAmount = (usdcAmount * feeBps) / BASIS_POINTS;
        uint256 netAmount = usdcAmount - feeAmount;

        // 2. Burn GLD de l'utilisateur
        gld.burn(msg.sender, gldAmount);

        // 3. Retrait USDC depuis Treasury
        // Frais vers feeCollector, net vers l'utilisateur
        if (feeAmount > 0 && feeCollector != address(0)) {
            treasury.operatorWithdraw(feeCollector, feeAmount);
        }
        treasury.operatorWithdraw(msg.sender, netAmount);

        emit TokensSold(msg.sender, gldAmount, usdcAmount, price);
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function pause() external onlyOwner {
        _pause();
        emit ContractsPaused(msg.sender);
    }
    function unpause() external onlyOwner {
        _unpause();
        emit ContractsUnpaused(msg.sender);
    }

    /// @notice Met à jour l'adresse du Treasury
    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = ITreasury(newTreasury);
        usdc = IERC20(ITreasury(newTreasury).usdc());
    }

    /// @notice Met à jour le prix fallback
    function setFallbackPrice(uint256 newPrice) external onlyOwner {
        if (newPrice == 0) revert ZeroAmount();
        emit FallbackPriceUpdated(fallbackPrice, newPrice);
        fallbackPrice = newPrice;
    }

    /// @notice Met à jour l'adresse oracle Chainlink
    function setOracle(address newOracle) external onlyOwner {
        emit OracleUpdated(address(priceOracle), newOracle);
        priceOracle = AggregatorV3Interface(newOracle);
    }

    /// @notice Met à jour la durée max de fraîcheur oracle
    function setOracleMaxAge(uint256 newMaxAge) external onlyOwner {
        emit OracleMaxAgeUpdated(oracleMaxAge, newMaxAge);
        oracleMaxAge = newMaxAge;
    }

    /// @notice Met à jour les fees (en basis points)
    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        emit FeeBpsUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    /// @notice Met à jour le collecteur de fees
    function setFeeCollector(address newCollector) external onlyOwner {
        if (newCollector == address(0)) revert ZeroAddress();
        emit FeeCollectorUpdated(feeCollector, newCollector);
        feeCollector = newCollector;
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Storage gap ─────────────────────────────────────────────────────────

    /// @dev => 8 slots utilisés, soit 42 restants pour les futures variables
    /// Slot Variable 
    /// 1. gld
    /// 2. treasury
    /// 3. usdc
    /// 4. priceOracle
    /// 5. fallbackPrice
    /// 6. oracleMaxAge
    /// 7. feeBps
    /// 8. feeCollector
    uint256[42] private __gap;
}
