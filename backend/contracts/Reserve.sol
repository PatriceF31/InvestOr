// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Interface GLD
interface IGLDReserve {
    function totalSupply() external view returns (uint256);
    function decimals() external view returns (uint8);
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
}

/// @dev Interface Treasury
interface ITreasuryReserve {
    function totalDeposited() external view returns (uint256);
    function deposit(uint256 amount) external;
    function usdc() external view returns (address);
}

/// @dev Interface Oracle Chainlink
interface IOracle {
    function latestRoundData() external view returns (
        uint80, int256 answer, uint256, uint256 updatedAt, uint80
    );
}

/// @dev Interface Exchange
interface IExchange {
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
    function fallbackPrice() external view returns (uint256);
}

/// @title Reserve — Surveillance et Proof of Reserve du protocole InvestOr
/// @notice Vérifie que le Treasury USDC couvre les GLD en circulation au prix actuel
/// @dev Peut pauser Exchange automatiquement si le ratio est insuffisant
contract Reserve is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ─── Constantes ───────────────────────────────────────────────────────────

    /// @dev Base des ratios : 10000 = 100%
    uint256 public constant BASIS_POINTS = 10_000;

    /// @dev Ratio minimum par défaut : 10000 bps = 100%
    uint256 public constant DEFAULT_MIN_RATIO = 10_000;

    // ─── Storage ─────────────────────────────────────────────────────────────

    IGLDReserve      public gld;
    ITreasuryReserve public treasury;
    IExchange        public exchange;
    IOracle          public oracle;

    /// @dev Ratio minimum de collatéralisation en bps (10000 = 100%, 11000 = 110%)
    uint256 public minRatioBps;

    /// @dev Durée max de fraîcheur des données oracle (défaut: 1 heure)
    uint256 public oracleMaxAge;

    /// @dev Timestamp du dernier check
    uint256 public lastCheckAt;

    /// @dev Résultat du dernier check
    bool public lastCheckHealthy;

    // ─── Events ──────────────────────────────────────────────────────────────

    event ReserveChecked(
        uint256 indexed timestamp,
        uint256 usdcReserve,
        uint256 gldSupply,
        uint256 goldValueUsdc,
        uint256 ratioBps,
        bool healthy
    );
    event ReserveDeficit(
        uint256 indexed timestamp,
        uint256 deficit,
        uint256 ratioBps,
        uint256 minRatioBps
    );
    event ExchangePausedByReserve(uint256 indexed timestamp, uint256 ratioBps);
    event ExchangeUnpausedByReserve(uint256 indexed timestamp, uint256 ratioBps);
    event Recapitalized(address indexed by, uint256 amount, uint256 newRatioBps);
    event MinRatioUpdated(uint256 oldRatio, uint256 newRatio);
    event OracleMaxAgeUpdated(uint256 oldMaxAge, uint256 newMaxAge);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error NoGLDSupply();
    error NoPriceAvailable();
    error InvalidRatio(uint256 ratio);

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /// @notice Initialise le contrat Reserve
    /// @param initialOwner   Propriétaire
    /// @param gldAddress     Proxy GLD
    /// @param treasuryAddress Proxy Treasury
    /// @param exchangeAddress Proxy Exchange
    /// @param oracleAddress  Oracle Chainlink XAU/USD (address(0) = utilise fallback Exchange)
    /// @param initMinRatio   Ratio minimum initial en bps (ex: 10000 = 100%)
    function initialize(
        address initialOwner,
        address gldAddress,
        address treasuryAddress,
        address exchangeAddress,
        address oracleAddress,
        uint256 initMinRatio
    ) external initializer {
        if (initialOwner    == address(0)) revert ZeroAddress();
        if (gldAddress      == address(0)) revert ZeroAddress();
        if (treasuryAddress == address(0)) revert ZeroAddress();
        if (exchangeAddress == address(0)) revert ZeroAddress();
        if (initMinRatio == 0 || initMinRatio > 20_000) revert InvalidRatio(initMinRatio);

        __Ownable_init(initialOwner);

        gld      = IGLDReserve(gldAddress);
        treasury = ITreasuryReserve(treasuryAddress);
        exchange = IExchange(exchangeAddress);

        if (oracleAddress != address(0)) {
            oracle = IOracle(oracleAddress);
        }

        minRatioBps  = initMinRatio;
        oracleMaxAge = 3600;
        lastCheckHealthy = true;
    }

    // ─── Prix ────────────────────────────────────────────────────────────────

    /// @notice Retourne le prix actif (oracle ou fallback Exchange)
    /// @return price Prix en USD/gramme, 8 décimales
    function getPrice() public view returns (uint256 price) {
        if (address(oracle) != address(0)) {
            try oracle.latestRoundData() returns (
                uint80, int256 answer, uint256, uint256 updatedAt, uint80
            ) {
                if (answer > 0 && block.timestamp - updatedAt <= oracleMaxAge) {
                    return uint256(answer);
                }
            } catch {}
        }
        // Fallback : prix défini dans Exchange
        uint256 fp = exchange.fallbackPrice();
        if (fp == 0) revert NoPriceAvailable();
        return fp;
    }

    // ─── Vues ─────────────────────────────────────────────────────────────────

    /// @notice Calcule le ratio de collatéralisation actuel
    /// @return usdcReserve    USDC dans le Treasury
    /// @return gldSupply      GLD en circulation (unités de base)
    /// @return goldValueUsdc  Valeur des GLD en USDC au prix actuel
    /// @return ratioBps       Ratio en basis points (10000 = 100%)
    function checkReserve() public view returns (
        uint256 usdcReserve,
        uint256 gldSupply,
        uint256 goldValueUsdc,
        uint256 ratioBps
    ) {
        usdcReserve = treasury.totalDeposited();
        gldSupply   = gld.totalSupply();

        if (gldSupply == 0) {
            return (usdcReserve, 0, 0, type(uint256).max);
        }

        uint256 price = getPrice();

        // GLD decimals = 3, USDC decimals = 6, price decimals = 8
        // goldValueUsdc = gldSupply * price / 10^5
        // (gldSupply * price) / (10^3 * 10^8 / 10^6) = gldSupply * price / 10^5
        goldValueUsdc = (gldSupply * price) / 1e5;

        if (goldValueUsdc == 0) {
            return (usdcReserve, gldSupply, 0, type(uint256).max);
        }

        ratioBps = (usdcReserve * BASIS_POINTS) / goldValueUsdc;
    }

    /// @notice Retourne true si le ratio est au-dessus du seuil minimum
    function isHealthy() public view returns (bool) {
        (, , , uint256 ratioBps) = checkReserve();
        return ratioBps >= minRatioBps;
    }

    /// @notice Retourne un résumé complet de l'état de la réserve
    function getReserveStatus() external view returns (
        uint256 usdcReserve,
        uint256 gldSupply,
        uint256 goldValueUsdc,
        uint256 ratioBps,
        uint256 minRatio,
        bool healthy,
        bool exchangePaused,
        uint256 price,
        uint256 deficitUsdc
    ) {
        (usdcReserve, gldSupply, goldValueUsdc, ratioBps) = checkReserve();
        minRatio      = minRatioBps;
        healthy       = ratioBps >= minRatioBps;
        exchangePaused = exchange.paused();
        price         = getPrice();
        deficitUsdc   = healthy ? 0 : goldValueUsdc * minRatioBps / BASIS_POINTS - usdcReserve;
    }

    // ─── Proof of Reserve ─────────────────────────────────────────────────────

    /// @notice Vérifie la réserve et pause Exchange si le ratio est insuffisant
    /// @dev Appelable par n'importe qui — incitation à être appelé régulièrement
    function proofOfReserve() external {
        (
            uint256 usdcReserve,
            uint256 gldSupply,
            uint256 goldValueUsdc,
            uint256 ratioBps
        ) = checkReserve();

        bool healthy = ratioBps >= minRatioBps;

        lastCheckAt      = block.timestamp;
        lastCheckHealthy = healthy;

        emit ReserveChecked(
            block.timestamp,
            usdcReserve,
            gldSupply,
            goldValueUsdc,
            ratioBps,
            healthy
        );

        if (!healthy) {
            uint256 deficit = goldValueUsdc * minRatioBps / BASIS_POINTS - usdcReserve;

            emit ReserveDeficit(block.timestamp, deficit, ratioBps, minRatioBps);

            // Pauser Exchange si pas déjà pausé
            if (!exchange.paused()) {
                exchange.pause();
                emit ExchangePausedByReserve(block.timestamp, ratioBps);
            }
        } else {
            // Réactiver Exchange si c'était Reserve qui l'avait pausé
            if (exchange.paused()) {
                exchange.unpause();
                emit ExchangeUnpausedByReserve(block.timestamp, ratioBps);
            }
        }
    }

    // ─── Recapitalisation ─────────────────────────────────────────────────────

    /// @notice Injecte des USDC dans le Treasury pour restaurer le ratio
    /// @dev Réservé au owner — l'appelant doit avoir approuvé usdc.approve(reserve, amount)
    /// @param amount Montant USDC à injecter
    function recapitalize(uint256 amount) external onlyOwner {
        if (amount == 0) revert ZeroAmount();

        address usdcAddr = treasury.usdc();
        IERC20 usdc = IERC20(usdcAddr);

        // Transfert USDC appelant → Reserve → Treasury
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        usdc.forceApprove(address(treasury), amount);
        treasury.deposit(amount);

        (, , , uint256 newRatio) = checkReserve();

        emit Recapitalized(msg.sender, amount, newRatio);

        // Si le ratio est restauré, réactiver Exchange
        if (newRatio >= minRatioBps && exchange.paused()) {
            exchange.unpause();
            emit ExchangeUnpausedByReserve(block.timestamp, newRatio);
        }
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    /// @notice Met à jour le ratio minimum de collatéralisation
    /// @param newRatioBps Nouveau ratio en bps (ex: 11000 = 110%)
    function setMinRatio(uint256 newRatioBps) external onlyOwner {
        if (newRatioBps == 0 || newRatioBps > 20_000) revert InvalidRatio(newRatioBps);
        emit MinRatioUpdated(minRatioBps, newRatioBps);
        minRatioBps = newRatioBps;
    }

    /// @notice Met à jour la durée max de fraîcheur oracle
    function setOracleMaxAge(uint256 newMaxAge) external onlyOwner {
        emit OracleMaxAgeUpdated(oracleMaxAge, newMaxAge);
        oracleMaxAge = newMaxAge;
    }

    /// @notice Met à jour l'adresse oracle
    function setOracle(address newOracle) external onlyOwner {
        emit OracleUpdated(address(oracle), newOracle);
        oracle = IOracle(newOracle);
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Storage gap ─────────────────────────────────────────────────────────

    /// @dev Variables : gld(1)+treasury(1)+exchange(1)+oracle(1)+minRatioBps(1)
    /// @dev   +oracleMaxAge(1)+lastCheckAt(1)+lastCheckHealthy(1) = 8 slots
    uint256[42] private __gap;
}
