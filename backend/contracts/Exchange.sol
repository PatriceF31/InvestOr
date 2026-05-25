// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface AggregatorV3Interface {
    function latestRoundData() external view returns (
        uint80, int256 answer, uint256, uint256 updatedAt, uint80
    );
    function decimals() external view returns (uint8);
}

interface ITellorOracle {
    function getDataBefore(bytes32 _queryId, uint256 _timestamp)
        external view returns (bytes memory _value, uint256 _timestampRetrieved);
}

interface IGLD {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function decimals() external view returns (uint8);
}

interface ITreasury {
    function deposit(uint256 amount, address token) external;
    function withdraw(uint256 amount, address token) external;
    function operatorWithdraw(address to, uint256 amount, address token) external;
    function isSupportedToken(address token) external view returns (bool);
    function usdc() external view returns (address);
    function eurc() external view returns (address);
}

/// @title Exchange V4 — Achat/vente GLD contre USDC ou EURC avec conversion EUR/USD
/// @notice Multi-token : buy/sell acceptent USDC et EURC
///         Oracle EUR/USD Chainlink pour conversion correcte EURC→USD
/// @dev UUPS upgradeable
///
/// Changements V4 vs V3 :
///   - eurusdOracle (slot 15) : oracle Chainlink EUR/USD
///   - eurusdFallbackRate (slot 16) : taux fallback EUR/USD (ex: 1.08e8)
///   - _toUsd(amount, token) : helper de conversion EUR→USD
///   - previewBuy/buy : applique taux EUR/USD si token = EURC
///   - previewSell/sell : applique conversion inverse USD→EUR si token = EURC
///   - getEurUsdRate() : vue publique du taux actuel
///   - __gap passe de [35] à [33]
contract Exchange is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ─── Storage ─────────────────────────────────────────────────────────────
    //
    //  0. gld
    //  1. treasury
    //  2. usdc
    //  3. priceOracle
    //  4. fallbackPrice
    //  5. oracleMaxAge
    //  6. feeBps
    //  7. feeCollector
    //  8. deployedAt
    //  9. feesBySlot        (V1 déprécié)
    // 10. lastActivityAt
    // 11. cashbackBps
    // 12. tellorOracle
    // 13. eurc              (V3)
    // 14. feesBySlotV2      (V3)
    // 15. eurusdOracle      (V4) — Chainlink EUR/USD
    // 16. eurusdFallbackRate (V4) — taux fallback en 8 décimales
    //

    IGLD      public gld;           // slot 0
    ITreasury public treasury;      // slot 1
    IERC20    public usdc;          // slot 2

    AggregatorV3Interface public priceOracle;  // slot 3
    uint256 public fallbackPrice;              // slot 4
    uint256 public oracleMaxAge;               // slot 5
    uint256 public feeBps;                     // slot 6
    address public feeCollector;               // slot 7

    uint256 public constant BASIS_POINTS = 10_000;

    uint256 public deployedAt;                                // slot 8
    mapping(address => uint256[8]) public feesBySlot;         // slot 9 déprécié
    mapping(address => uint256)    public lastActivityAt;     // slot 10
    uint256 public cashbackBps;                               // slot 11

    ITellorOracle public tellorOracle;                        // slot 12

    IERC20 public eurc;                                       // slot 13 V3
    mapping(address => mapping(address => uint256[8])) public feesBySlotV2; // slot 14 V3

    AggregatorV3Interface public eurusdOracle;   // slot 15 V4
    uint256 public eurusdFallbackRate;           // slot 16 V4 — ex: 108_000_000 = 1.08 (8 dec)

    bytes32 public constant TELLOR_XAU_USD_QUERY_ID =
        0x5c13cd9c97dbb98f2429c101a2a8150e6c7a0ddaff6124ee176a3a411067ded0;
    uint256 public constant TELLOR_DECIMALS_FACTOR = 1e10;
    uint256 public constant EUR_USD_DECIMALS = 1e8; // 8 décimales Chainlink EUR/USD

    // ─── Events ──────────────────────────────────────────────────────────────

    event TokensBought(address indexed buyer, address indexed token, uint256 stableAmount, uint256 gldAmount, uint256 price);
    event TokensSold(address indexed seller, address indexed token, uint256 gldAmount, uint256 stableAmount, uint256 price);
    event FallbackPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event TellorOracleUpdated(address indexed oldOracle, address indexed newOracle);
    event EurUsdOracleUpdated(address indexed oldOracle, address indexed newOracle);
    event EurUsdFallbackRateUpdated(uint256 oldRate, uint256 newRate);
    event OracleMaxAgeUpdated(uint256 oldMaxAge, uint256 newMaxAge);
    event FeeBpsUpdated(uint256 oldFee, uint256 newFee);
    event FeeCollectorUpdated(address indexed oldCollector, address indexed newCollector);
    event ContractsPaused(address indexed by);
    event ContractsUnpaused(address indexed by);
    event CashbackClaimed(address indexed user, address indexed token, uint256 amount);
    event CashbackBpsUpdated(uint256 oldBps, uint256 newBps);
    event EurcUpdated(address indexed oldEurc, address indexed newEurc);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error NoPriceAvailable();
    error InactiveAccount();
    error NoCashbackAvailable();
    error UnsupportedToken(address token);

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(
        address initialOwner,
        address gldAddress,
        address treasuryAddress,
        address oracleAddress,
        uint256 initFallbackPrice
    ) external initializer {
        if (initialOwner    == address(0)) revert ZeroAddress();
        if (gldAddress      == address(0)) revert ZeroAddress();
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

        fallbackPrice      = initFallbackPrice;
        oracleMaxAge       = 3600;
        feeCollector       = initialOwner;
        deployedAt         = block.timestamp;
        cashbackBps        = 50;
        eurusdFallbackRate = 108_000_000; // 1.08 par défaut
    }

    // ─── Oracle XAU/USD ───────────────────────────────────────────────────────

    function _getChainlinkPrice() internal view returns (uint256 price, bool valid) {
        if (address(priceOracle) == address(0)) return (0, false);
        try priceOracle.latestRoundData() returns (
            uint80, int256 answer, uint256, uint256 updatedAt, uint80
        ) {
            if (answer > 0 && block.timestamp - updatedAt <= oracleMaxAge)
                return (uint256(answer), true);
        } catch {}
        return (0, false);
    }

    function _getTellorPrice() internal view returns (uint256 price, bool valid) {
        if (address(tellorOracle) == address(0)) return (0, false);
        try tellorOracle.getDataBefore(TELLOR_XAU_USD_QUERY_ID, block.timestamp) returns (
            bytes memory value, uint256 timestampRetrieved
        ) {
            if (value.length > 0 && timestampRetrieved > 0 &&
                block.timestamp - timestampRetrieved <= oracleMaxAge) {
                uint256 rawPrice = abi.decode(value, (uint256));
                uint256 converted = rawPrice / TELLOR_DECIMALS_FACTOR;
                if (converted > 0) return (converted, true);
            }
        } catch {}
        return (0, false);
    }

    function getPrice() public view returns (uint256 price, uint8 source) {
        (uint256 clPrice, bool clOk) = _getChainlinkPrice();
        (uint256 tlPrice, bool tlOk) = _getTellorPrice();
        if (clOk && tlOk) return ((clPrice + tlPrice) / 2, 0);
        if (clOk)         return (clPrice, 1);
        if (tlOk)         return (tlPrice, 2);
        if (fallbackPrice == 0) revert NoPriceAvailable();
        return (fallbackPrice, 3);
    }

    function getOracleStatus() external view returns (
        uint256 chainlinkPrice, bool chainlinkOk,
        uint256 tellorPrice,    bool tellorOk,
        uint256 activePrice,    uint8 activeSource
    ) {
        (chainlinkPrice, chainlinkOk) = _getChainlinkPrice();
        (tellorPrice,    tellorOk)    = _getTellorPrice();
        (activePrice,    activeSource) = getPrice();
    }

    // ─── Oracle EUR/USD ───────────────────────────────────────────────────────

    /// @notice Retourne le taux EUR/USD actuel (8 décimales)
    /// @dev Ex : 108_500_000 = 1.085 USD pour 1 EUR
    /// @return rate   Taux EUR/USD (8 décimales)
    /// @return isLive true si l'oracle Chainlink répond, false si fallback
    function getEurUsdRate() public view returns (uint256 rate, bool isLive) {
        if (address(eurusdOracle) != address(0)) {
            try eurusdOracle.latestRoundData() returns (
                uint80, int256 answer, uint256, uint256 updatedAt, uint80
            ) {
                if (answer > 0 && block.timestamp - updatedAt <= oracleMaxAge) {
                    return (uint256(answer), true);
                }
            } catch {}
        }
        // Fallback : taux configuré par l'owner (défaut 1.08)
        return (eurusdFallbackRate, false);
    }

    /// @dev Convertit un montant de stablecoin en USD équivalent (6 décimales)
    ///      USDC : 1 USDC = 1 USD → pas de conversion
    ///      EURC : 1 EURC = eurUsdRate USD → multiplication par le taux
    function _toUsd(uint256 amount, address token) internal view returns (uint256 usdAmount) {
        if (token == address(eurc) && address(eurc) != address(0)) {
            (uint256 rate, ) = getEurUsdRate();
            // amount (6 dec) * rate (8 dec) / 1e8 = usdAmount (6 dec)
            return (amount * rate) / EUR_USD_DECIMALS;
        }
        return amount; // USDC : 1:1
    }

    /// @dev Convertit un montant USD (6 dec) en stablecoin de sortie
    ///      USDC : 1 USD = 1 USDC → pas de conversion
    ///      EURC : 1 USD = 1/eurUsdRate EURC → division par le taux
    function _fromUsd(uint256 usdAmount, address token) internal view returns (uint256 stableAmount) {
        if (token == address(eurc) && address(eurc) != address(0)) {
            (uint256 rate, ) = getEurUsdRate();
            // usdAmount (6 dec) * 1e8 / rate (8 dec) = eurcAmount (6 dec)
            return (usdAmount * EUR_USD_DECIMALS) / rate;
        }
        return usdAmount; // USDC : 1:1
    }

    // ─── Validation token ─────────────────────────────────────────────────────

    function _requireSupportedToken(address token) internal view {
        bool isUsdc = (token == address(usdc) && address(usdc) != address(0));
        bool isEurc = (token == address(eurc) && address(eurc) != address(0));
        if (!isUsdc && !isEurc) revert UnsupportedToken(token);
    }

    // ─── Preview ─────────────────────────────────────────────────────────────

    /// @notice Calcule le GLD reçu pour un montant de stablecoin
    /// @dev EURC : converti en USD via oracle EUR/USD avant calcul
    function previewBuy(uint256 stableAmount, address token)
        public view returns (uint256 gldAmount)
    {
        if (stableAmount == 0) revert ZeroAmount();
        _requireSupportedToken(token);
        (uint256 price, ) = getPrice();
        uint256 feeAmount = (stableAmount * feeBps) / BASIS_POINTS;
        uint256 netAmount = stableAmount - feeAmount;
        // Convertir en USD si EURC
        uint256 netUsd = _toUsd(netAmount, token);
        gldAmount = (netUsd * 1e5) / price;
    }

    /// @notice Calcule le stablecoin reçu pour un montant de GLD vendu
    /// @dev EURC : montant USD converti en EURC via oracle EUR/USD
    function previewSell(uint256 gldAmount, address token)
        public view returns (uint256 stableAmount)
    {
        if (gldAmount == 0) revert ZeroAmount();
        _requireSupportedToken(token);
        (uint256 price, ) = getPrice();
        // Calcul en USD
        uint256 grossUsd  = (gldAmount * price) / 1e5;
        uint256 feeUsd    = (grossUsd * feeBps) / BASIS_POINTS;
        uint256 netUsd    = grossUsd - feeUsd;
        // Convertir USD → stablecoin de sortie
        stableAmount = _fromUsd(netUsd, token);
    }

    // ─── Achat ───────────────────────────────────────────────────────────────

    /// @notice Achète des GLD avec USDC ou EURC
    /// @param stableAmount Montant de stablecoin (6 décimales)
    /// @param token        Adresse du stablecoin (USDC ou EURC)
    function buy(uint256 stableAmount, address token)
        external whenNotPaused nonReentrant
    {
        if (stableAmount == 0) revert ZeroAmount();
        _requireSupportedToken(token);

        uint256 gldAmount = previewBuy(stableAmount, token);
        if (gldAmount == 0) revert ZeroAmount();

        (uint256 price,) = getPrice();
        uint256 feeAmount = (stableAmount * feeBps) / BASIS_POINTS;
        uint256 netAmount = stableAmount - feeAmount;

        // Tracking cashback V3 par token
        lastActivityAt[msg.sender] = block.timestamp;
        feesBySlotV2[msg.sender][token][_currentSlot()] += feeAmount;

        // Transfert stablecoin user → Exchange
        IERC20(token).safeTransferFrom(msg.sender, address(this), stableAmount);

        // Dépôt net dans Treasury
        IERC20(token).forceApprove(address(treasury), netAmount);
        treasury.deposit(netAmount, token);

        // Mint GLD
        gld.mint(msg.sender, gldAmount);

        // Fees
        if (feeAmount > 0 && feeCollector != address(0)) {
            IERC20(token).safeTransfer(feeCollector, feeAmount);
        }

        emit TokensBought(msg.sender, token, netAmount, gldAmount, price);
    }

    // ─── Vente ───────────────────────────────────────────────────────────────

    /// @notice Vend des GLD contre USDC ou EURC
    /// @param gldAmount Quantité de GLD (3 décimales)
    /// @param token     Token de sortie (USDC ou EURC)
    function sell(uint256 gldAmount, address token)
        external nonReentrant
    {
        if (gldAmount == 0) revert ZeroAmount();
        _requireSupportedToken(token);

        (uint256 price,) = getPrice();

        // Calcul en USD
        uint256 grossUsd = (gldAmount * price) / 1e5;
        uint256 feeUsd   = (grossUsd * feeBps) / BASIS_POINTS;
        uint256 netUsd   = grossUsd - feeUsd;
        if (netUsd == 0) revert ZeroAmount();

        // Convertir USD → stablecoin de sortie
        uint256 netStable = _fromUsd(netUsd, token);
        uint256 feeStable = _fromUsd(feeUsd, token);
        if (netStable == 0) revert ZeroAmount();

        // Tracking cashback V3 par token (en unités du stablecoin)
        lastActivityAt[msg.sender] = block.timestamp;
        feesBySlotV2[msg.sender][token][_currentSlot()] += feeStable;

        // Burn GLD (pattern CEI)
        gld.burn(msg.sender, gldAmount);

        if (feeStable > 0 && feeCollector != address(0)) {
            treasury.operatorWithdraw(feeCollector, feeStable, token);
        }
        treasury.operatorWithdraw(msg.sender, netStable, token);

        emit TokensSold(msg.sender, token, gldAmount, netStable, price);
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function pause() external onlyOwner { _pause(); emit ContractsPaused(msg.sender); }
    function unpause() external onlyOwner { _unpause(); emit ContractsUnpaused(msg.sender); }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = ITreasury(newTreasury);
        usdc = IERC20(ITreasury(newTreasury).usdc());
    }

    function setEurc(address eurcAddress) external onlyOwner {
        if (eurcAddress == address(0)) revert ZeroAddress();
        emit EurcUpdated(address(eurc), eurcAddress);
        eurc = IERC20(eurcAddress);
    }

    function setFallbackPrice(uint256 newPrice) external onlyOwner {
        if (newPrice == 0) revert ZeroAmount();
        emit FallbackPriceUpdated(fallbackPrice, newPrice);
        fallbackPrice = newPrice;
    }

    function setOracle(address newOracle) external onlyOwner {
        emit OracleUpdated(address(priceOracle), newOracle);
        priceOracle = AggregatorV3Interface(newOracle);
    }

    function setTellorOracle(address newOracle) external onlyOwner {
        emit TellorOracleUpdated(address(tellorOracle), newOracle);
        tellorOracle = ITellorOracle(newOracle);
    }

    /// @notice Configure l'oracle Chainlink EUR/USD — V4
    /// @dev Sepolia : 0x1a81afB8146aeFfCFc5E50e8479e826E7D55b910
    ///      Mainnet : 0x1a81afB8146aeFfCFc5E50e8479e826E7D55b910
    function setEurUsdOracle(address newOracle) external onlyOwner {
        emit EurUsdOracleUpdated(address(eurusdOracle), newOracle);
        eurusdOracle = AggregatorV3Interface(newOracle);
    }

    /// @notice Configure le taux EUR/USD fallback (8 décimales)
    /// @dev Ex : 108_500_000 = 1.085. Utilisé si l'oracle est indisponible.
    function setEurUsdFallbackRate(uint256 newRate) external onlyOwner {
        if (newRate == 0) revert ZeroAmount();
        emit EurUsdFallbackRateUpdated(eurusdFallbackRate, newRate);
        eurusdFallbackRate = newRate;
    }

    function setOracleMaxAge(uint256 newMaxAge) external onlyOwner {
        emit OracleMaxAgeUpdated(oracleMaxAge, newMaxAge);
        oracleMaxAge = newMaxAge;
    }

    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        emit FeeBpsUpdated(feeBps, newFeeBps);
        feeBps = newFeeBps;
    }

    function setFeeCollector(address newCollector) external onlyOwner {
        if (newCollector == address(0)) revert ZeroAddress();
        emit FeeCollectorUpdated(feeCollector, newCollector);
        feeCollector = newCollector;
    }

    // ─── Cashback V3 (inchangé) ───────────────────────────────────────────────

    function _currentSlot() internal view returns (uint256) {
        uint256 elapsed = block.timestamp - deployedAt;
        uint256 slot    = elapsed / 180 days;
        return slot > 7 ? 7 : slot;
    }

    function setCashbackBps(uint256 newBps) external onlyOwner {
        require(newBps <= 200, "Max 2%");
        emit CashbackBpsUpdated(cashbackBps, newBps);
        cashbackBps = newBps;
    }

    function initCashback(uint256 _deployedAt, uint256 _cashbackBps) external onlyOwner {
        require(deployedAt == 0, "Already initialized");
        require(_cashbackBps <= 200, "Max 2%");
        deployedAt  = _deployedAt;
        cashbackBps = _cashbackBps;
    }

    function previewCashback(address user)
        external view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        uint256 currentSlot = _currentSlot();
        address[2] memory tkns = [address(usdc), address(eurc)];
        uint256 count = 0;
        for (uint256 t = 0; t < 2; t++) {
            if (tkns[t] != address(0)) count++;
        }
        tokens  = new address[](count);
        amounts = new uint256[](count);
        uint256 idx = 0;
        for (uint256 t = 0; t < 2; t++) {
            address token = tkns[t];
            if (token == address(0)) continue;
            uint256 totalFees = _sumFees(user, token, currentSlot);
            tokens[idx]  = token;
            amounts[idx] = (totalFees * cashbackBps) / BASIS_POINTS;
            idx++;
        }
    }

    function _sumFees(address user, address token, uint256 currentSlot)
        internal view returns (uint256 total)
    {
        for (uint256 i = 0; i < 4; i++) {
            if (currentSlot >= i) {
                total += feesBySlotV2[user][token][currentSlot - i];
            }
        }
    }

    function claimCashback(address token) external nonReentrant whenNotPaused {
        _requireSupportedToken(token);
        if (block.timestamp - lastActivityAt[msg.sender] > 180 days)
            revert InactiveAccount();

        uint256 currentSlot = _currentSlot();
        uint256 totalFees   = 0;
        for (uint256 i = 0; i < 4; i++) {
            if (currentSlot >= i) {
                uint256 slot = currentSlot - i;
                totalFees += feesBySlotV2[msg.sender][token][slot];
                feesBySlotV2[msg.sender][token][slot] = 0;
            }
        }
        if (totalFees == 0) revert NoCashbackAvailable();
        uint256 cashback = (totalFees * cashbackBps) / BASIS_POINTS;
        if (cashback == 0) revert NoCashbackAvailable();
        treasury.operatorWithdraw(msg.sender, cashback, token);
        emit CashbackClaimed(msg.sender, token, cashback);
    }

    function claimAllCashback() external nonReentrant whenNotPaused {
        if (block.timestamp - lastActivityAt[msg.sender] > 180 days)
            revert InactiveAccount();

        uint256 currentSlot = _currentSlot();
        bool claimed = false;
        address[2] memory tokens = [address(usdc), address(eurc)];

        for (uint256 t = 0; t < 2; t++) {
            address token = tokens[t];
            if (token == address(0)) continue;
            uint256 totalFees = 0;
            for (uint256 i = 0; i < 4; i++) {
                if (currentSlot >= i) {
                    uint256 slot = currentSlot - i;
                    totalFees += feesBySlotV2[msg.sender][token][slot];
                    feesBySlotV2[msg.sender][token][slot] = 0;
                }
            }
            if (totalFees == 0) continue;
            uint256 cashback = (totalFees * cashbackBps) / BASIS_POINTS;
            if (cashback == 0) continue;
            treasury.operatorWithdraw(msg.sender, cashback, token);
            emit CashbackClaimed(msg.sender, token, cashback);
            claimed = true;
        }
        if (!claimed) revert NoCashbackAvailable();
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Storage gap ─────────────────────────────────────────────────────────
    //
    // 17 slots explicites (0-16) + __gap[33] = 50 ✅

    uint256[33] private __gap;
}
