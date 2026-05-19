// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IComplianceModule
/// @notice Interface du module de conformité pluggable pour GLD
/// @dev Implémenté par CountryComplianceModule (et tout module futur)
///      GLD appelle canTransfer() dans son hook _update() avant chaque transfert
interface IComplianceModule {

    // ─── Vérification de transfert ────────────────────────────────────────────

    /// @notice Vérifie si un transfert est autorisé selon les règles de conformité
    /// @param from  Adresse expéditrice (address(0) = mint)
    /// @param to    Adresse destinataire (address(0) = burn)
    /// @param amount Montant transféré
    /// @return true si le transfert est autorisé
    /// @dev Les agents (Exchange) sont exemptés — retourne toujours true pour eux
    function canTransfer(address from, address to, uint256 amount) external view returns (bool);

    // ─── Gestion des agents ───────────────────────────────────────────────────

    /// @notice Retourne true si l'adresse est un agent autorisé (exempté de conformité)
    /// @dev Les agents typiques : Exchange (mint/burn), Reserve, owner
    function isAgent(address account) external view returns (bool);

    // ─── Identité ─────────────────────────────────────────────────────────────

    /// @notice Retourne true si le wallet a une identité KYC vérifiée
    function isVerified(address wallet) external view returns (bool);

    /// @notice Retourne le code pays ISO-3166 du wallet (0 si inconnu)
    function getCountry(address wallet) external view returns (uint16);

    // ─── Events ───────────────────────────────────────────────────────────────

    event AgentAdded(address indexed agent);
    event AgentRemoved(address indexed agent);
    event TransferBlocked(address indexed from, address indexed to, string reason);
}
