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

/// @dev Interface Treasury V2 multi-token
interface ITreasury {
    function deposit(uint256 amount, address token) external;
    function withdraw(uint256 amount, address token) external;
    function operatorWithdraw(address to, uint256 amount, address token) external;
    function isSupportedToken(address token) external view returns (bool);
    function usdc() external view returns (address);
    function eurc() external view returns (address);
}

/// @title Exchange V3 — Achat/vente GLD contre USDC ou EURC
/// @notice Multi-token : buy/sell acceptent USDC et EURC
///         Cashback tracké séparément par devise dans feesBySlotV2
/// @dev UUPS upgradeable
///
/// Changements V3 :
///   - buy(amount, token) / sell(gldAmount, token) — paramètre token ajouté
///   - previewBuy(amount, token) / previewSell(gldAmount, token)
///   - feesBySlotV2 (slot 14) : mapping(user => mapping(token => uint256[8]))
///   - claimCashback(token) / claimAllCashback()
///   - previewCashback(user) → (address[] tokens, uint256[] amounts)
///   - eurc (slot 13) : adresse EURC Circle
///   - feesBySlot (slot 9) : conservé mais ignoré (données V1)
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
    // Slots V1/V2 — NE JAMAIS RÉORDONNER
    //  0. gld
    //  1. treasury
    //  2. usdc            (conservé pour compatibilité)
    //  3. priceOracle
    //  4. fallbackPrice
    //  5. oracleMaxAge
    //  6. feeBps
    //  7. feeCollector
    //  8. deployedAt
    //  9. feesBySlot      (V1 déprécié — conservé)
    // 10. lastActivityAt
    // 11. cashbackBps
    // 12. tellorOracle
    //
    // Slots V3 — nouveaux
    // 13. eurc
    // 14. feesBySlotV2
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

    bytes32 public constant TELLOR_XAU_USD_QUERY_ID =
        0x5c13cd9c97dbb98f2429c101a2a8150e6c7a0ddaff6124ee176a3a411067ded0;
    uint256 public constant TELLOR_DECIMALS_FACTOR = 1e10;

    // ─── Events ──────────────────────────────────────────────────────────────

    event TokensBought(address indexed buyer, address indexed token, uint256 stableAmount, uint256 gldAmount, uint256 price);
    event TokensSold(address indexed seller, address indexed token, uint256 gldAmount, uint256 stableAmount, uint256 price);
    event FallbackPriceUpdated(uint256 oldPrice, uint256 newPrice);
    event OracleUpdated(address indexed oldOracle, address indexed newOracle);
    event TellorOracleUpdated(address indexed oldOracle, address indexed newOracle);
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

        fallbackPrice = initFallbackPrice;
        oracleMaxAge  = 3600;
        feeCollector  = initialOwner;
        deployedAt    = block.timestamp;
        cashbackBps   = 50;
    }

    // ─── Prix ────────────────────────────────────────────────────────────────

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

    // ─── Validation token ─────────────────────────────────────────────────────

    function _requireSupportedToken(address token) internal view {
        bool isUsdc = (token == address(usdc) && address(usdc) != address(0));
        bool isEurc = (token == address(eurc) && address(eurc) != address(0));
        if (!isUsdc && !isEurc) revert UnsupportedToken(token);
    }

    // ─── Preview ─────────────────────────────────────────────────────────────

    function previewBuy(uint256 stableAmount, address token)
        public view returns (uint256 gldAmount)
    {
        if (stableAmount == 0) revert ZeroAmount();
        _requireSupportedToken(token);
        (uint256 price, ) = getPrice();
        uint256 feeAmount = (stableAmount * feeBps) / BASIS_POINTS;
        uint256 netAmount = stableAmount - feeAmount;
        gldAmount = (netAmount * 1e5) / price;
    }

    function previewSell(uint256 gldAmount, address token)
        public view returns (uint256 stableAmount)
    {
        if (gldAmount == 0) revert ZeroAmount();
        _requireSupportedToken(token);
        (uint256 price, ) = getPrice();
        uint256 grossAmount = (gldAmount * price) / 1e5;
        uint256 feeAmount   = (grossAmount * feeBps) / BASIS_POINTS;
        stableAmount = grossAmount - feeAmount;
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

        // Mint GLD (pattern CEI — avant fees)
        gld.mint(msg.sender, gldAmount);

        // Fees en dernier
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
        uint256 grossAmount = (gldAmount * price) / 1e5;
        uint256 feeAmount   = (grossAmount * feeBps) / BASIS_POINTS;
        uint256 netAmount   = grossAmount - feeAmount;
        if (netAmount == 0) revert ZeroAmount();

        // Tracking cashback V3 par token
        lastActivityAt[msg.sender] = block.timestamp;
        feesBySlotV2[msg.sender][token][_currentSlot()] += feeAmount;

        // Burn GLD (pattern CEI)
        gld.burn(msg.sender, gldAmount);

        if (feeAmount > 0 && feeCollector != address(0)) {
            treasury.operatorWithdraw(feeCollector, feeAmount, token);
        }
        treasury.operatorWithdraw(msg.sender, netAmount, token);

        emit TokensSold(msg.sender, token, gldAmount, netAmount, price);
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

    // ─── Cashback V3 ──────────────────────────────────────────────────────────

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

    /// @notice Cashback disponible pour un user (USDC + EURC séparément)
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

    /// @notice Réclame le cashback pour un token spécifique
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

    /// @notice Réclame le cashback USDC et EURC en une seule tx
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
    // 15 slots explicites (0-14) + __gap[35] = 50 ✅

    uint256[35] private __gap;
}
