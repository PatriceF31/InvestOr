// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IYieldStrategy — Interface générique pour les stratégies de rendement Treasury
/// @notice Permet à Treasury de déléguer une partie de sa trésorerie stablecoin à un
///         protocole de rendement externe (Morpho, Aave, ...) sans connaître son
///         implémentation. Chaque stratégie concrète gère un seul token sur un seul
///         marché/vault externe.
/// @dev Pattern adaptateur — cohérent avec IOracle/ITellorOracleReserve dans Reserve.sol :
///      une interface minimale, locale au protocole, plutôt qu'une dépendance externe.
interface IYieldStrategy {
    /// @notice Le token géré par cette stratégie (ex : USDC)
    function asset() external view returns (address);

    /// @notice Dépose `amount` de `asset()` dans le protocole externe
    /// @dev L'appelant (Treasury) doit détenir et avoir approuvé `amount` au préalable.
    ///      Réservé à Treasury (onlyTreasury côté implémentation).
    function deposit(uint256 amount) external;

    /// @notice Retire `amount` de `asset()` du protocole externe vers l'appelant (Treasury)
    /// @return withdrawn Montant réellement reçu (peut différer de `amount` en cas
    ///         d'arrondi propre au protocole sous-jacent)
    function withdraw(uint256 amount) external returns (uint256 withdrawn);

    /// @notice Valeur totale actuelle de la position (capital + intérêts courus),
    ///         exprimée en unités de `asset()`
    /// @dev Vue non state-changing. Voir l'implémentation pour la fraîcheur exacte du
    ///      chiffre (les protocoles de prêt accruent l'intérêt à chaque interaction,
    ///      pas en continu bloc par bloc).
    function totalAssets() external view returns (uint256);
}
