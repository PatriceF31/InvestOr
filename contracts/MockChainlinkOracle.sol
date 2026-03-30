// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockChainlinkOracle — Simule un AggregatorV3Interface Chainlink
/// @notice Utilisé uniquement en tests — ne pas déployer en production
contract MockChainlinkOracle {

    // ─── Storage ─────────────────────────────────────────────────────────────

    int256  private _price;
    uint8   private _decimals;
    uint256 private _updatedAt;
    uint80  private _roundId;
    bool    private _shouldRevert;

    // ─── Constructor ──────────────────────────────────────────────────────────

    /// @param initialPrice  Prix initial (8 décimales, ex: 90_00000000 = $90)
    /// @param decimals_     Nombre de décimales (8 pour Chainlink XAU/USD)
    constructor(int256 initialPrice, uint8 decimals_) {
        _price     = initialPrice;
        _decimals  = decimals_;
        _updatedAt = block.timestamp;
        _roundId   = 1;
    }

    // ─── Interface AggregatorV3 ───────────────────────────────────────────────

    function decimals() external view returns (uint8) {
        return _decimals;
    }

    function latestRoundData() external view returns (
        uint80 roundId,
        int256 answer,
        uint256 startedAt,
        uint256 updatedAt,
        uint80 answeredInRound
    ) {
        if (_shouldRevert) revert("Oracle: reverted");
        return (_roundId, _price, _updatedAt, _updatedAt, _roundId);
    }

    // ─── Fonctions de contrôle pour les tests ────────────────────────────────

    /// @notice Met à jour le prix et horodate à maintenant
    function setPrice(int256 newPrice) external {
        _price     = newPrice;
        _updatedAt = block.timestamp;
        _roundId++;
    }

    /// @notice Met à jour le prix SANS changer l'horodatage (simule données périmées)
    function setPriceStale(int256 newPrice) external {
        _price = newPrice;
        // _updatedAt inchangé → données périmées
    }

    /// @notice Force l'horodatage à une valeur passée (simule oracle périmé)
    function setUpdatedAt(uint256 timestamp) external {
        _updatedAt = timestamp;
    }

    /// @notice Force le contrat à revert sur latestRoundData (simule oracle HS)
    function setShouldRevert(bool shouldRevert_) external {
        _shouldRevert = shouldRevert_;
    }

    /// @notice Retourne le prix actuel stocké
    function getPrice() external view returns (int256) {
        return _price;
    }

    /// @notice Retourne l'horodatage de la dernière mise à jour
    function getUpdatedAt() external view returns (uint256) {
        return _updatedAt;
    }
}
