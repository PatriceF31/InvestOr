// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Doit rester binaire-identique à MorphoMarketParams (MorphoYieldStrategy.sol)
///      pour que keccak256(abi.encode(...)) produise le même id des deux côtés.
struct MockMarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

/// @title MockMorpho — simulateur minimal de Morpho Blue pour les tests unitaires
/// @notice Ne reproduit PAS la courbe d'intérêt réelle (Adaptive Curve IRM). Expose des
///         fonctions de test absentes du vrai Morpho Blue (`testAccrueYield`,
///         `testBorrowLiquidity`, `testRepayLiquidity`) pour piloter manuellement le
///         rendement et la tension de liquidité d'un marché, et ainsi tester
///         MorphoYieldStrategy dans les deux scénarios (nominal + marché tendu).
contract MockMorpho {
    using SafeERC20 for IERC20;

    struct Market {
        uint128 totalSupplyAssets;
        uint128 totalSupplyShares;
        uint128 totalBorrowAssets;
        uint128 totalBorrowShares;
        uint128 lastUpdate;
        uint128 fee;
        bool exists;
    }

    struct Position {
        uint256 supplyShares;
        uint128 borrowShares;
        uint128 collateral;
    }

    uint256 public constant VIRTUAL_SHARES = 1e6;

    mapping(bytes32 => Market) public markets;
    mapping(bytes32 => mapping(address => Position)) public positions;

    error MarketNotCreated();
    error InsufficientLiquidity();
    error InconsistentInput();

    function id(MockMarketParams memory p) public pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    function createMarket(MockMarketParams memory marketParams) external {
        bytes32 marketId = id(marketParams);
        markets[marketId].exists = true;
        markets[marketId].lastUpdate = uint128(block.timestamp);
    }

    function supply(
        MockMarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes calldata
    ) external returns (uint256, uint256) {
        bytes32 marketId = id(marketParams);
        Market storage m = markets[marketId];
        if (!m.exists) revert MarketNotCreated();
        if ((assets == 0) == (shares == 0)) revert InconsistentInput();

        if (shares == 0) {
            shares = m.totalSupplyShares == 0
                ? assets * VIRTUAL_SHARES
                : assets * m.totalSupplyShares / m.totalSupplyAssets;
        } else {
            assets = m.totalSupplyShares == 0
                ? shares / VIRTUAL_SHARES
                : shares * m.totalSupplyAssets / m.totalSupplyShares;
        }

        IERC20(marketParams.loanToken).safeTransferFrom(msg.sender, address(this), assets);

        m.totalSupplyAssets += uint128(assets);
        m.totalSupplyShares += uint128(shares);
        positions[marketId][onBehalf].supplyShares += shares;

        return (assets, shares);
    }

    function withdraw(
        MockMarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256, uint256) {
        bytes32 marketId = id(marketParams);
        Market storage m = markets[marketId];
        if (!m.exists) revert MarketNotCreated();
        if ((assets == 0) == (shares == 0)) revert InconsistentInput();

        if (shares == 0) {
            shares = assets * m.totalSupplyShares / m.totalSupplyAssets;
        } else {
            assets = shares * m.totalSupplyAssets / m.totalSupplyShares;
        }

        uint256 available = uint256(m.totalSupplyAssets) - uint256(m.totalBorrowAssets);
        if (assets > available) revert InsufficientLiquidity(); // reproduit le revert réel de Morpho

        positions[marketId][onBehalf].supplyShares -= shares;
        m.totalSupplyAssets -= uint128(assets);
        m.totalSupplyShares -= uint128(shares);

        IERC20(marketParams.loanToken).safeTransfer(receiver, assets);

        return (assets, shares);
    }

    /// @dev No-op dans ce mock — l'intérêt réel est simulé via testAccrueYield()
    function accrueInterest(MockMarketParams memory marketParams) external {
        markets[id(marketParams)].lastUpdate = uint128(block.timestamp);
    }

    function position(bytes32 marketId, address user)
        external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)
    {
        Position memory p = positions[marketId][user];
        return (p.supplyShares, p.borrowShares, p.collateral);
    }

    function market(bytes32 marketId)
        external view returns (uint128, uint128, uint128, uint128, uint128, uint128)
    {
        Market memory m = markets[marketId];
        return (m.totalSupplyAssets, m.totalSupplyShares, m.totalBorrowAssets, m.totalBorrowShares, m.lastUpdate, m.fee);
    }

    // ─── Helpers de test — absents du vrai Morpho Blue ─────────────────────

    /// @notice Simule un rendement gagné : injecte des assets sans changer les shares,
    ///         ce qui fait mécaniquement monter la valeur de chaque share (même effet
    ///         qu'un remboursement d'intérêt réel par des emprunteurs).
    function testAccrueYield(MockMarketParams memory marketParams, uint256 extraAssets) external {
        IERC20(marketParams.loanToken).safeTransferFrom(msg.sender, address(this), extraAssets);
        markets[id(marketParams)].totalSupplyAssets += uint128(extraAssets);
    }

    /// @notice Simule un emprunt externe qui réduit la liquidité disponible du marché
    ///         — pour tester MorphoYieldStrategy en situation de marché tendu (cf. le
    ///         cas réel du vault Morpho "AlphaUSDC Delta V2", juin 2026).
    function testBorrowLiquidity(MockMarketParams memory marketParams, uint256 amount, address to) external {
        bytes32 marketId = id(marketParams);
        Market storage m = markets[marketId];
        uint256 available = uint256(m.totalSupplyAssets) - uint256(m.totalBorrowAssets);
        require(amount <= available, "MockMorpho: exceeds available liquidity");
        m.totalBorrowAssets += uint128(amount);
        m.totalBorrowShares += uint128(amount);
        IERC20(marketParams.loanToken).safeTransfer(to, amount);
    }

    /// @notice Simule un remboursement qui restaure de la liquidité disponible
    function testRepayLiquidity(MockMarketParams memory marketParams, uint256 amount) external {
        IERC20(marketParams.loanToken).safeTransferFrom(msg.sender, address(this), amount);
        bytes32 marketId = id(marketParams);
        markets[marketId].totalBorrowAssets -= uint128(amount);
        markets[marketId].totalBorrowShares -= uint128(amount);
    }
}
