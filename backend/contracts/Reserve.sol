// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev Interface GLD
interface IGLDReserve {
    function totalSupply() external view returns (uint256);
    function decimals() external view returns (uint8);
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
}

/// @dev Interface Treasury V2 multi-token
interface ITreasuryReserve {
    /// @notice Total USDC + EURC déposés agrégés (1:1 USD sur Sepolia)
    function totalDeposited() external view returns (uint256);
    function usdc() external view returns (address);
    function eurc() external view returns (address);
    /// @notice Injection capital V2 — paramètre token requis
    function injectCapital(uint256 amount, address token) external;
}

/// @dev Interface Oracle Chainlink
interface IOracle {
    function latestRoundData() external view returns (
        uint80, int256 answer, uint256, uint256 updatedAt, uint80
    );
}

/// @dev Interface Oracle Tellor
/// @notice Même interface que dans Exchange — partagée par cohérence
interface ITellorOracleReserve {
    function getDataBefore(bytes32 _queryId, uint256 _timestamp)
        external
        view
        returns (bytes memory _value, uint256 _timestampRetrieved);
}

/// @dev Interface Exchange
interface IExchange {
    function pause() external;
    function unpause() external;
    function paused() external view returns (bool);
    function fallbackPrice() external view returns (uint256);
    function setOracle(address newOracle) external;
    function setTellorOracle(address newOracle) external;
    function setFallbackPrice(uint256 newPrice) external;
    function transferOwnership(address newOwner) external;
    function setTreasury(address newTreasury) external;
    function setFeeBps(uint256 newFeeBps) external;
    function setFeeCollector(address newCollector) external;
    function initCashback(uint256 deployedAt_, uint256 cashbackBps_) external;
    function setEurc(address eurcAddress) external;  // V3
}

/// @dev Interface LingotOr pour le Proof of Reserve en mode grammes
interface ILingotOr {
    function totalGrammesEnCoffre() external view returns (uint256);
}

/// @title Reserve — Surveillance et Proof of Reserve du protocole InvestOr
/// @notice Vérifie que le Treasury USDC couvre les GLD en circulation au prix actuel
/// @dev Prix via oracle multi-sources (Chainlink + Tellor) avec fallback Exchange
contract Reserve is
    Initializable,
    OwnableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ─── Constantes ───────────────────────────────────────────────────────────

    uint256 public constant BASIS_POINTS  = 10_000;
    uint256 public constant DEFAULT_MIN_RATIO = 10_000;

    /// @dev QueryId Tellor XAU/USD — identique à Exchange pour cohérence
    bytes32 public constant TELLOR_XAU_USD_QUERY_ID =
        0x5c13cd9c97dbb98f2429c101a2a8150e6c7a0ddaff6124ee176a3a411067ded0;

    /// @dev Tellor 18 dec → 8 dec (cohérent avec Chainlink)
    uint256 public constant TELLOR_DECIMALS_FACTOR = 1e10;

    // ─── Storage ─────────────────────────────────────────────────────────────

    IGLDReserve      public gld;          // slot 1
    ITreasuryReserve public treasury;     // slot 2
    IExchange        public exchange;     // slot 3
    IOracle          public oracle;       // slot 4 — Chainlink XAU/USD
    uint256          public minRatioBps;  // slot 5
    uint256          public oracleMaxAge; // slot 6
    uint256          public lastCheckAt;  // slot 7
    bool             public lastCheckHealthy; // slot 8
    mapping(address => bool) public recapitalizers;    // slot 9
    address[]        public recapitalizerList;          // slot 10
    ILingotOr        public lingotOr;    // slot 11 — mode grammes V2

    /// @dev Oracle Tellor XAU/USD — slot 12 (nouveau)
    ITellorOracleReserve public tellorOracle;

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
    event TellorOracleUpdated(address indexed oldOracle, address indexed newOracle);
    event RecapitalizerAdded(address indexed account);
    event RecapitalizerRemoved(address indexed account);
    event LingotOrUpdated(address indexed oldAddr, address indexed newAddr);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error NoGLDSupply();
    error NoPriceAvailable();
    error InvalidRatio(uint256 ratio);

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /// @notice Initialise le contrat Reserve (inchangé — tellorOracle configuré via setTellorOracle)
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

        minRatioBps      = initMinRatio;
        oracleMaxAge     = 3600;
        lastCheckHealthy = true;
    }

    // ─── Prix ────────────────────────────────────────────────────────────────

    /// @notice Tente de lire le prix Chainlink XAU/USD
    function _getChainlinkPrice() internal view returns (uint256 price, bool valid) {
        if (address(oracle) == address(0)) return (0, false);
        try oracle.latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            if (answer > 0 && block.timestamp - updatedAt <= oracleMaxAge) {
                return (uint256(answer), true);
            }
        } catch {}
        return (0, false);
    }

    /// @notice Tente de lire le prix Tellor XAU/USD
    /// @dev Même logique que Exchange._getTellorPrice() — cohérence des deux contrats
    function _getTellorPrice() internal view returns (uint256 price, bool valid) {
        if (address(tellorOracle) == address(0)) return (0, false);
        try tellorOracle.getDataBefore(TELLOR_XAU_USD_QUERY_ID, block.timestamp) returns (
            bytes memory value,
            uint256 timestampRetrieved
        ) {
            if (
                value.length > 0 &&
                timestampRetrieved > 0 &&
                block.timestamp - timestampRetrieved <= oracleMaxAge
            ) {
                uint256 rawPrice = abi.decode(value, (uint256));
                uint256 converted = rawPrice / TELLOR_DECIMALS_FACTOR;
                if (converted > 0) return (converted, true);
            }
        } catch {}
        return (0, false);
    }

    /// @notice Retourne le prix actif (médiane Chainlink+Tellor > l'un ou l'autre > fallback Exchange)
    /// @return price Prix en USD/gramme, 8 décimales
    function getPrice() public view returns (uint256 price) {
        (uint256 chainlinkPrice, bool chainlinkOk) = _getChainlinkPrice();
        (uint256 tellorPrice,    bool tellorOk)    = _getTellorPrice();

        if (chainlinkOk && tellorOk) {
            return (chainlinkPrice + tellorPrice) / 2;
        }
        if (chainlinkOk) return chainlinkPrice;
        if (tellorOk)    return tellorPrice;

        // Dernier recours : fallback défini dans Exchange
        uint256 fp = exchange.fallbackPrice();
        if (fp == 0) revert NoPriceAvailable();
        return fp;
    }

    /// @notice Résumé de l'état des oracles (utile pour monitoring et tests)
    function getOracleStatus() external view returns (
        uint256 chainlinkPrice,
        bool    chainlinkOk,
        uint256 tellorPrice,
        bool    tellorOk,
        uint256 activePrice
    ) {
        (chainlinkPrice, chainlinkOk) = _getChainlinkPrice();
        (tellorPrice,    tellorOk)    = _getTellorPrice();
        activePrice = getPrice();
    }

    // ─── Vues ─────────────────────────────────────────────────────────────────

    /// @notice Calcule le ratio de collatéralisation actuel
    /// @dev V1 : collatéral USDC vs valeur GLD en USDC (oracle requis)
    ///      V2 : grammes en coffre vs GLD en circulation (pas d'oracle)
    function checkReserve() public view returns (
        uint256 usdcReserve,
        uint256 gldSupply,
        uint256 goldValueUsdc,
        uint256 ratioBps
    ) {
        gldSupply = gld.totalSupply();

        if (gldSupply == 0) {
            return (0, 0, 0, type(uint256).max);
        }

        // ── V2 — collatéral physique (lingots ERC-1155) ──────────────────────
        if (address(lingotOr) != address(0)) {
            uint256 grammesEnCoffre = lingotOr.totalGrammesEnCoffre();
            usdcReserve   = grammesEnCoffre;
            goldValueUsdc = gldSupply;
            if (gldSupply == 0) return (grammesEnCoffre, 0, 0, type(uint256).max);
            ratioBps = (grammesEnCoffre * BASIS_POINTS) / gldSupply;
            return (usdcReserve, gldSupply, goldValueUsdc, ratioBps);
        }

        // ── V1 — collatéral USDC (oracle de prix requis) ─────────────────────
        usdcReserve = treasury.totalDeposited();

        uint256 price = getPrice();

        // GLD dec=3, USDC dec=6, price dec=8 → goldValueUsdc = gldSupply * price / 1e5
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
        bool    healthy,
        bool    exchangePaused,
        uint256 price,
        uint256 deficitUsdc
    ) {
        (usdcReserve, gldSupply, goldValueUsdc, ratioBps) = checkReserve();
        minRatio       = minRatioBps;
        healthy        = ratioBps >= minRatioBps;
        exchangePaused = exchange.paused();
        price          = getPrice();
        deficitUsdc    = healthy ? 0 : goldValueUsdc * minRatioBps / BASIS_POINTS - usdcReserve;
    }

    // ─── Proof of Reserve ─────────────────────────────────────────────────────

    /// @notice Vérifie la réserve et pause Exchange si le ratio est insuffisant
    /// @dev Appelable par n'importe qui — incitation à être appelé régulièrement (Chainlink Automation)
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

            if (!exchange.paused()) {
                exchange.pause();
                emit ExchangePausedByReserve(block.timestamp, ratioBps);
            }
        } else {
            if (exchange.paused()) {
                exchange.unpause();
                emit ExchangeUnpausedByReserve(block.timestamp, ratioBps);
            }
        }
    }

    // ─── Recapitalisation ─────────────────────────────────────────────────────

    modifier onlyRecapitalizerOrOwner() {
        if (msg.sender != owner() && !recapitalizers[msg.sender])
            revert OwnableUnauthorizedAccount(msg.sender);
        _;
    }

    /// @notice Injecte des USDC ou EURC dans le Treasury pour restaurer le ratio
    /// @param amount Montant à injecter
    /// @param token  Token à injecter (USDC ou EURC) — défaut USDC si address(0)
    function recapitalize(uint256 amount, address token) external onlyRecapitalizerOrOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();

        // Si token = address(0), on utilise USDC par défaut
        address tokenAddr = (token == address(0)) ? treasury.usdc() : token;
        IERC20 stablecoin = IERC20(tokenAddr);

        stablecoin.safeTransferFrom(msg.sender, address(this), amount);
        stablecoin.forceApprove(address(treasury), amount);
        ITreasuryReserve(address(treasury)).injectCapital(amount, tokenAddr);

        (, , , uint256 newRatio) = checkReserve();

        emit Recapitalized(msg.sender, amount, newRatio);

        if (newRatio >= minRatioBps && exchange.paused()) {
            exchange.unpause();
            emit ExchangeUnpausedByReserve(block.timestamp, newRatio);
        }
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function upgradeExchange(address newImpl) external onlyOwner {
        UUPSUpgradeable(address(exchange)).upgradeToAndCall(newImpl, "");
    }

    function setMinRatio(uint256 newRatioBps) external onlyOwner {
        if (newRatioBps == 0 || newRatioBps > 20_000) revert InvalidRatio(newRatioBps);
        emit MinRatioUpdated(minRatioBps, newRatioBps);
        minRatioBps = newRatioBps;
    }

    function setExchangeTreasury(address newTreasury) external onlyOwner {
        IExchange(address(exchange)).setTreasury(newTreasury);
    }

    function setOracleMaxAge(uint256 newMaxAge) external onlyOwner {
        emit OracleMaxAgeUpdated(oracleMaxAge, newMaxAge);
        oracleMaxAge = newMaxAge;
    }

    /// @notice Met à jour l'oracle Chainlink de Reserve
    function setOracle(address newOracle) external onlyOwner {
        emit OracleUpdated(address(oracle), newOracle);
        oracle = IOracle(newOracle);
    }

    /// @notice Met à jour l'oracle Tellor de Reserve
    /// @param newOracle address(0) pour désactiver Tellor
    function setTellorOracle(address newOracle) external onlyOwner {
        emit TellorOracleUpdated(address(tellorOracle), newOracle);
        tellorOracle = ITellorOracleReserve(newOracle);
    }

    function setExchangeOwner(address newOwner) external onlyOwner {
        IExchange(address(exchange)).transferOwnership(newOwner);
    }

    function setExchange(address newExchange) external onlyOwner {
        if (newExchange == address(0)) revert ZeroAddress();
        exchange = IExchange(newExchange);
    }

    /// @notice Propage le nouvel oracle Chainlink vers Exchange
    function setExchangeOracle(address newOracle) external onlyOwner {
        IExchange(address(exchange)).setOracle(newOracle);
    }

    /// @notice Propage le nouvel oracle Tellor vers Exchange
    function setExchangeTellorOracle(address newOracle) external onlyOwner {
        IExchange(address(exchange)).setTellorOracle(newOracle);
    }

    function setExchangeFallbackPrice(uint256 newPrice) external onlyOwner {
        IExchange(address(exchange)).setFallbackPrice(newPrice);
    }

    function setExchangeFeeBps(uint256 newFeeBps) external onlyOwner {
        IExchange(address(exchange)).setFeeBps(newFeeBps);
    }

    function setExchangeFeeCollector(address newCollector) external onlyOwner {
        IExchange(address(exchange)).setFeeCollector(newCollector);
    }

    /// @notice Configure l'adresse EURC sur Exchange (V3)
    function setExchangeEurc(address eurcAddress) external onlyOwner {
        IExchange(address(exchange)).setEurc(eurcAddress);
    }

    function addRecapitalizer(address account) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        if (!recapitalizers[account]) {
            recapitalizers[account] = true;
            recapitalizerList.push(account);
            emit RecapitalizerAdded(account);
        }
    }

    function removeRecapitalizer(address account) external onlyOwner {
        if (recapitalizers[account]) {
            recapitalizers[account] = false;
            emit RecapitalizerRemoved(account);
            for (uint256 i = 0; i < recapitalizerList.length; i++) {
                if (recapitalizerList[i] == account) {
                    recapitalizerList[i] = recapitalizerList[recapitalizerList.length - 1];
                    recapitalizerList.pop();
                    break;
                }
            }
        }
    }

    function getRecapitalizers() external view returns (address[] memory) {
        return recapitalizerList;
    }

    function setLingotOr(address newAddr) external onlyOwner {
        emit LingotOrUpdated(address(lingotOr), newAddr);
        lingotOr = ILingotOr(newAddr);
    }

    function initExchangeCashback(uint256 deployedAt_, uint256 cashbackBps_) external onlyOwner {
        IExchange(address(exchange)).initCashback(deployedAt_, cashbackBps_);
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Storage gap ─────────────────────────────────────────────────────────
    //
    // Slots utilisés (50 total UUPS standard) :
    //  1. gld
    //  2. treasury
    //  3. exchange
    //  4. oracle             (Chainlink)
    //  5. minRatioBps
    //  6. oracleMaxAge
    //  7. lastCheckAt
    //  8. lastCheckHealthy
    //  9. recapitalizers     (mapping)
    // 10. recapitalizerList  (array)
    // 11. lingotOr
    // 12. tellorOracle       ← nouveau slot V2
    //
    // 38 slots restants

    uint256[38] private __gap;
}
