// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockTellorOracle
/// @notice Mock de l'oracle Tellor pour les tests — même pattern que MockChainlinkOracle
/// @dev Tellor retourne les prix en 18 décimales via getDataBefore(queryId, timestamp)
///      Exchange/Reserve divisent par 1e10 pour obtenir 8 décimales (cohérent avec Chainlink)
contract MockTellorOracle {

    /// @dev Prix stocké en 18 décimales (format Tellor natif)
    uint256 private _price;

    /// @dev Timestamp de la dernière mise à jour (block.timestamp par défaut)
    uint256 private _updatedAt;

    /// @dev Si true, getDataBefore() revert — simule une panne oracle
    bool private _shouldRevert;

    /// @dev Si true, retourne des bytes vides — simule l'absence de données
    bool private _returnEmpty;

    constructor(uint256 initialPrice18Dec) {
        _price     = initialPrice18Dec;
        _updatedAt = block.timestamp;
    }

    // ─── Interface Tellor ────────────────────────────────────────────────────

    /// @notice Retourne la valeur la plus récente avant _timestamp pour le queryId donné
    /// @dev On ignore queryId dans le mock — on retourne toujours _price
    function getDataBefore(bytes32 /*_queryId*/, uint256 /*_timestamp*/)
        external
        view
        returns (bytes memory value, uint256 timestampRetrieved)
    {
        if (_shouldRevert) revert("MockTellor: oracle down");
        if (_returnEmpty)  return ("", 0);

        value              = abi.encode(_price);
        timestampRetrieved = _updatedAt;
    }

    // ─── Helpers de test ─────────────────────────────────────────────────────

    /// @notice Définit le prix en 18 décimales et reset le timestamp à now
    /// @param newPrice18Dec Prix en 18 décimales (ex: 14750e18 / 31.1 ≈ 474_279_871_000_000_000_000)
    function setPrice(uint256 newPrice18Dec) external {
        _price     = newPrice18Dec;
        _updatedAt = block.timestamp;
    }

    /// @notice Force un timestamp précis (pour simuler des données périmées)
    function setUpdatedAt(uint256 ts) external {
        _updatedAt = ts;
    }

    /// @notice Si true, getDataBefore revert (simule panne totale)
    function setShouldRevert(bool shouldRevert) external {
        _shouldRevert = shouldRevert;
    }

    /// @notice Si true, retourne bytes vides (simule absence de données Tellor)
    function setReturnEmpty(bool returnEmpty) external {
        _returnEmpty = returnEmpty;
    }

    // ─── Vues ────────────────────────────────────────────────────────────────

    function currentPrice() external view returns (uint256) { return _price; }
    function updatedAt()    external view returns (uint256) { return _updatedAt; }
}
