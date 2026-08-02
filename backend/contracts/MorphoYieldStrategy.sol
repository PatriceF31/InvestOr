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

/// @dev Les 5 paramètres immuables identifiant un marché Morpho Blue.
///      L'égalité de cette struct (via keccak256/abi.encode) EST l'identifiant du
///      marché côté Morpho — voir `_marketId()` plus bas.
struct MorphoMarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @dev Interface minimale Morpho Blue — uniquement les fonctions utilisées ici.
///      Définie localement plutôt qu'importée d'un package externe, cohérent avec le
///      reste du protocole (voir IExchange/IOracle/ITellorOracleReserve dans Reserve.sol).
interface IMorphoBlue {
    function supply(
        MorphoMarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes calldata data
    ) external returns (uint256 assetsSupplied, uint256 sharesSupplied);

    function withdraw(
        MorphoMarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsWithdrawn, uint256 sharesWithdrawn);

    /// @dev Getter auto-généré du mapping position(Id => user => Position)
    function position(bytes32 id, address user)
        external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);

    /// @dev Getter auto-généré du mapping market(Id => Market)
    function market(bytes32 id)
        external view returns (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        );

    /// @notice Force l'accrual des intérêts sur un marché, sans mouvement de fonds
    function accrueInterest(MorphoMarketParams memory marketParams) external;
}

/// @title MorphoYieldStrategy — Stratégie de rendement Treasury via Morpho Blue
/// @notice Dépose une partie de la trésorerie stablecoin (USDC) dans un marché Morpho
///         Blue isolé pour générer un rendement, rapatriable à tout moment par Treasury.
/// @dev Implémente IYieldStrategy — Treasury ne connaît que cette interface, jamais
///      Morpho directement (pattern adaptateur, cf. discussion d'architecture).
///      UUPS upgradeable, owned par Reserve — même pattern qu'Exchange.
///
///      Marché visé initialement (Sepolia, test) :
///        loanToken       = USDC Circle Sepolia   (0x1c7D...7238)
///        collateralToken = cbBTC Sepolia         (0xcbB7...33Bf)
///        oracle          = MorphoChainlinkOracleV2 (wrap Chainlink BTC/USD Sepolia)
///        irm             = Adaptive Curve IRM (seul IRM approuvé par la gouvernance Morpho)
///        lltv            = 86 % (860000000000000000 en WAD)
///
///      NE GÈRE JAMAIS GLD — uniquement le stablecoin de la poche rendement. Aucun
///      conflit avec la couche de conformité ERC-3643 (voir note MiCA/ERC-3643 séparée).
contract MorphoYieldStrategy is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuard,
    UUPSUpgradeable,
    IYieldStrategy
{
    using SafeERC20 for IERC20;

    // ─── Storage ─────────────────────────────────────────────────────────────
    //
    //  0.   morpho        (address)            — singleton Morpho Blue
    //  1.   treasury      (address)            — seul autorisé à deposit()/withdraw()
    //  2-6. marketParams  (MorphoMarketParams) — 5 champs, immuables côté Morpho une
    //                                             fois un dépôt actif (voir setMarketParams)
    //

    IMorphoBlue         public morpho;        // slot 0
    address             public treasury;      // slot 1
    MorphoMarketParams  public marketParams;  // slots 2-6

    // ─── Events ──────────────────────────────────────────────────────────────

    event Deposited(uint256 amount, uint256 sharesSupplied);
    event Withdrawn(uint256 requested, uint256 actual, uint256 sharesBurned);
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);
    event MarketParamsUpdated(
        address loanToken,
        address collateralToken,
        address oracle,
        address irm,
        uint256 lltv
    );
    event TokensRescued(address indexed token, address indexed to, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error ZeroAmount();
    error UnauthorizedTreasury(address caller);
    error MarketNotSet();
    error ActivePositionExists();
    error CannotRescueActiveAsset();

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyTreasury() {
        if (msg.sender != treasury) revert UnauthorizedTreasury(msg.sender);
        _;
    }

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /// @notice Initialise le contrat. Le marché n'est PAS configuré ici — voir
    ///         setMarketParams(), à appeler séparément par le owner (Reserve) une fois
    ///         le marché Morpho créé et l'oracle déployé.
    function initialize(
        address initialOwner,
        address morphoAddress,
        address treasuryAddress
    ) external initializer {
        if (initialOwner    == address(0)) revert ZeroAddress();
        if (morphoAddress   == address(0)) revert ZeroAddress();
        if (treasuryAddress == address(0)) revert ZeroAddress();

        __Ownable_init(initialOwner);
        __Pausable_init();

        morpho   = IMorphoBlue(morphoAddress);
        treasury = treasuryAddress;
    }

    // ─── IYieldStrategy ──────────────────────────────────────────────────────

    /// @inheritdoc IYieldStrategy
    function asset() external view returns (address) {
        return marketParams.loanToken;
    }

    /// @inheritdoc IYieldStrategy
    function deposit(uint256 amount) external whenNotPaused onlyTreasury nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (marketParams.loanToken == address(0)) revert MarketNotSet();

        IERC20(marketParams.loanToken).safeTransferFrom(msg.sender, address(this), amount);
        IERC20(marketParams.loanToken).forceApprove(address(morpho), amount);

        (, uint256 sharesSupplied) = morpho.supply(marketParams, amount, 0, address(this), "");

        emit Deposited(amount, sharesSupplied);
    }

    /// @inheritdoc IYieldStrategy
    /// @dev Pas de whenNotPaused ici volontairement : Treasury doit pouvoir rapatrier ses
    ///      fonds même si la stratégie est en pause (garde-fou, pas un piège à liquidité).
    ///
    ///      Retrait "best effort" : si le marché est tendu (forte utilisation, ex. le cas
    ///      vécu par certains vaults Morpho en juin 2026 après l'effondrement d'un
    ///      collatéral illiquide), Morpho.withdraw() reverte purement si on demande plus
    ///      que la liquidité non empruntée disponible. On plafonne donc la demande à cette
    ///      liquidité réelle plutôt que de laisser remonter un revert Morpho brut — Treasury
    ///      compare ensuite son solde réel après coup et sait déjà réagir proprement
    ///      (InsufficientBalance) si le montant récupéré ne suffit toujours pas.
    function withdraw(uint256 amount)
        external
        onlyTreasury
        nonReentrant
        returns (uint256 withdrawn)
    {
        if (amount == 0) revert ZeroAmount();
        if (marketParams.loanToken == address(0)) revert MarketNotSet();

        morpho.accrueInterest(marketParams); // rafraîchit avant de lire la liquidité dispo

        bytes32 id = _marketId();
        (uint128 totalSupplyAssets, , uint128 totalBorrowAssets, , , ) = morpho.market(id);
        uint256 availableLiquidity = uint256(totalSupplyAssets) > uint256(totalBorrowAssets)
            ? uint256(totalSupplyAssets) - uint256(totalBorrowAssets)
            : 0;

        uint256 requested = amount > availableLiquidity ? availableLiquidity : amount;
        if (requested == 0) return 0;

        (withdrawn, ) = morpho.withdraw(marketParams, requested, 0, address(this), msg.sender);

        emit Withdrawn(amount, withdrawn, 0);
    }

    /// @inheritdoc IYieldStrategy
    /// @dev Conversion shares → assets à partir du dernier snapshot de marché
    ///      (`market().totalSupplyAssets/totalSupplyShares`), PAS d'une simulation live
    ///      seconde par seconde. Morpho accrue l'intérêt à chaque interaction sur le
    ///      marché (par nous ou par un tiers) — ce chiffre peut donc être légèrement en
    ///      retard entre deux touches. Pour une valeur exacte à l'instant T, appeler
    ///      syncInterest() (state-changing) juste avant de lire totalAssets().
    function totalAssets() external view returns (uint256) {
        if (marketParams.loanToken == address(0)) return 0;

        bytes32 id = _marketId();
        (uint256 supplyShares, , ) = morpho.position(id, address(this));
        if (supplyShares == 0) return 0;

        (uint128 totalSupplyAssets, uint128 totalSupplyShares, , , , ) = morpho.market(id);
        if (totalSupplyShares == 0) return 0;

        return supplyShares * uint256(totalSupplyAssets) / uint256(totalSupplyShares);
    }

    /// @notice Force l'accrual des intérêts Morpho sur le marché courant
    /// @dev Aucun mouvement de fonds. Utile avant un rebalance() qui a besoin d'un
    ///      chiffre de totalAssets() exact plutôt que le dernier snapshot.
    function syncInterest() external {
        if (marketParams.loanToken == address(0)) revert MarketNotSet();
        morpho.accrueInterest(marketParams);
    }

    // ─── Vue interne ─────────────────────────────────────────────────────────

    /// @dev Reproduit MarketParamsLib.id() de Morpho Blue : Id = keccak256(abi.encode(params))
    function _marketId() internal view returns (bytes32) {
        return keccak256(abi.encode(marketParams));
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    /// @notice Configure ou migre le marché Morpho ciblé
    /// @dev Refuse la bascule tant qu'une position de supply est active sur l'ANCIEN
    ///      marché — il faut d'abord withdraw() intégralement. Évite de "perdre" des
    ///      shares orphelines sur un marché qu'on ne référence plus.
    function setMarketParams(
        address loanToken,
        address collateralToken,
        address oracleAddr,
        address irm,
        uint256 lltv
    ) external onlyOwner {
        if (loanToken == address(0) || collateralToken == address(0) ||
            oracleAddr == address(0) || irm == address(0)) revert ZeroAddress();

        if (marketParams.loanToken != address(0)) {
            (uint256 supplyShares, , ) = morpho.position(_marketId(), address(this));
            if (supplyShares != 0) revert ActivePositionExists();
        }

        marketParams = MorphoMarketParams({
            loanToken: loanToken,
            collateralToken: collateralToken,
            oracle: oracleAddr,
            irm: irm,
            lltv: lltv
        });

        emit MarketParamsUpdated(loanToken, collateralToken, oracleAddr, irm, lltv);
    }

    /// @notice Filet de sécurité pour un token envoyé par erreur à ce contrat
    /// @dev Interdit explicitement de rescue le loanToken actif — sinon cette fonction
    ///      deviendrait une porte dérobée pour siphonner les fonds de Treasury en
    ///      contournant onlyTreasury sur withdraw().
    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (token == marketParams.loanToken) revert CannotRescueActiveAsset();
        IERC20(token).safeTransfer(to, amount);
        emit TokensRescued(token, to, amount);
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Storage gap ─────────────────────────────────────────────────────────
    //
    //  7 slots utilisés (morpho, treasury, marketParams×5) + __gap[43] = 50 ✅
    //  Toujours ajouter après, jamais insérer entre les slots existants.

    uint256[43] private __gap;
}
