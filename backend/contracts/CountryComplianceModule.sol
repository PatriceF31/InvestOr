// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "./IComplianceModule.sol";

/// @dev Interface minimale IdentityRegistry
interface IIdentityRegistry {
    function isVerified(address wallet) external view returns (bool);
    function getCountry(address wallet) external view returns (uint16);
}

/// @title CountryComplianceModule
/// @notice Module de conformité MiCA : vérifie KYC + whitelist pays avant chaque transfert GLD
/// @dev Implémente IComplianceModule — pluggé dans GLD._update()
///      Règles appliquées :
///        1. Si from ou to est un agent (Exchange, Reserve) → toujours autorisé
///        2. Si from = address(0) (mint) → vérifier seulement `to` (KYC + pays)
///        3. Si to = address(0) (burn)  → vérifier seulement `from` (KYC)
///        4. Transfert normal → from ET to doivent être KYC + pays autorisé
contract CountryComplianceModule is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable,
    IComplianceModule
{
    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @dev Registre d'identités KYC
    IIdentityRegistry public identityRegistry;

    /// @dev Codes pays ISO-3166 autorisés (true = autorisé)
    /// @notice Exemples : 250 = France, 276 = Allemagne, 372 = Irlande,
    ///         392 = Japon, 702 = Singapour, 566 = Nigeria, 404 = Kenya
    mapping(uint16 => bool) public allowedCountries;

    /// @dev Agents exemptés de conformité (Exchange, Reserve, owner)
    mapping(address => bool) private _agents;

    /// @dev Liste des codes pays autorisés (pour lecture frontend)
    uint16[] public allowedCountryList;

    /// @dev Si true, le module est en mode strict (toute adresse non KYC est bloquée)
    /// @dev Si false, le module est en mode permissif (non KYC = autorisé — utile en dev)
    bool public strictMode;

    // ─── Events ──────────────────────────────────────────────────────────────

    event CountryAllowed(uint16 indexed country);
    event CountryDisallowed(uint16 indexed country);
    event IdentityRegistryUpdated(address indexed oldRegistry, address indexed newRegistry);
    event StrictModeUpdated(bool strictMode);

    // IComplianceModule events sont hérités de l'interface

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error CountryNotAllowed(address wallet, uint16 country);
    error IdentityNotVerified(address wallet);
    error InvalidCountryCode(uint16 country);

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    /// @notice Initialise le module de conformité
    /// @param initialOwner     Propriétaire (Safe)
    /// @param registryAddress  Adresse du registre d'identités KYC
    /// @param initialStrict    true = mode strict dès le départ
    function initialize(
        address initialOwner,
        address registryAddress,
        bool    initialStrict
    ) external initializer {
        if (initialOwner    == address(0)) revert ZeroAddress();
        if (registryAddress == address(0)) revert ZeroAddress();

        __Ownable_init(initialOwner);

        identityRegistry = IIdentityRegistry(registryAddress);
        strictMode       = initialStrict;
    }

    // ─── IComplianceModule — logique principale ───────────────────────────────

    /// @notice Vérifie si un transfert est autorisé
    /// @dev Appelé par GLD._update() avant chaque transfert/mint/burn
    function canTransfer(address from, address to, uint256 /*amount*/)
        external
        view
        override
        returns (bool)
    {
        // ── Règle 1 : agents toujours autorisés (Exchange mint/burn, Reserve) ──
        if (_agents[from] || _agents[to]) return true;

        // ── Règle 2 : mint (from = address(0)) → vérifier seulement le destinataire ──
        if (from == address(0)) {
            return _isCompliant(to);
        }

        // ── Règle 3 : burn (to = address(0)) → vérifier seulement l'expéditeur ──
        if (to == address(0)) {
            return _isCompliant(from);
        }

        // ── Règle 4 : transfert normal → les deux doivent être conformes ──
        return _isCompliant(from) && _isCompliant(to);
    }

    /// @dev Vérifie KYC + pays pour une adresse
    function _isCompliant(address wallet) internal view returns (bool) {
        if (!strictMode) return true; // mode permissif — dev/testnet

        // KYC vérifié ?
        if (!identityRegistry.isVerified(wallet)) return false;

        // Pays autorisé ?
        uint16 country = identityRegistry.getCountry(wallet);
        if (!allowedCountries[country]) return false;

        return true;
    }

    /// @notice Retourne true si l'adresse est un agent (Exchange, Reserve...)
    function isAgent(address account) external view override returns (bool) {
        return _agents[account];
    }

    /// @notice Retourne true si le wallet a une identité KYC vérifiée
    function isVerified(address wallet) external view override returns (bool) {
        return identityRegistry.isVerified(wallet);
    }

    /// @notice Retourne le code pays du wallet
    function getCountry(address wallet) external view override returns (uint16) {
        return identityRegistry.getCountry(wallet);
    }

    // ─── Gestion des pays ─────────────────────────────────────────────────────

    /// @notice Autorise un code pays ISO-3166
    /// @param country Code pays (ex: 250 = France, 276 = Allemagne)
    function allowCountry(uint16 country) external onlyOwner {
        if (country == 0) revert InvalidCountryCode(country);
        if (!allowedCountries[country]) {
            allowedCountries[country] = true;
            allowedCountryList.push(country);
            emit CountryAllowed(country);
        }
    }

    /// @notice Autorise plusieurs pays en une seule transaction
    function allowCountries(uint16[] calldata countries) external onlyOwner {
        for (uint256 i = 0; i < countries.length; i++) {
            if (countries[i] == 0) continue;
            if (!allowedCountries[countries[i]]) {
                allowedCountries[countries[i]] = true;
                allowedCountryList.push(countries[i]);
                emit CountryAllowed(countries[i]);
            }
        }
    }

    /// @notice Révoque l'autorisation d'un pays
    function disallowCountry(uint16 country) external onlyOwner {
        if (allowedCountries[country]) {
            allowedCountries[country] = false;
            emit CountryDisallowed(country);
            for (uint256 i = 0; i < allowedCountryList.length; i++) {
                if (allowedCountryList[i] == country) {
                    allowedCountryList[i] = allowedCountryList[allowedCountryList.length - 1];
                    allowedCountryList.pop();
                    break;
                }
            }
        }
    }

    /// @notice Retourne la liste complète des pays autorisés
    function getAllowedCountries() external view returns (uint16[] memory) {
        return allowedCountryList;
    }

    // ─── Gestion des agents ───────────────────────────────────────────────────

    /// @notice Ajoute un agent exempté de conformité (Exchange, Reserve, Safe...)
    function addAgent(address agent) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        _agents[agent] = true;
        emit AgentAdded(agent);
    }

    /// @notice Retire un agent
    function removeAgent(address agent) external onlyOwner {
        _agents[agent] = false;
        emit AgentRemoved(agent);
    }

    // ─── Admin ────────────────────────────────────────────────────────────────

    /// @notice Met à jour le registre d'identités
    function setIdentityRegistry(address newRegistry) external onlyOwner {
        if (newRegistry == address(0)) revert ZeroAddress();
        emit IdentityRegistryUpdated(address(identityRegistry), newRegistry);
        identityRegistry = IIdentityRegistry(newRegistry);
    }

    /// @notice Active/désactive le mode strict
    /// @dev false = permissif (tout passe) — utile sur testnet pour les tests
    /// @dev true  = strict (KYC + pays requis) — production
    function setStrictMode(bool strict) external onlyOwner {
        strictMode = strict;
        emit StrictModeUpdated(strict);
    }

    // ─── Vues utilitaires ─────────────────────────────────────────────────────

    /// @notice Résumé de l'état du module (utile pour le frontend)
    function getModuleStatus() external view returns (
        address registry,
        bool    strict,
        uint256 countryCount
    ) {
        registry     = address(identityRegistry);
        strict       = strictMode;
        countryCount = allowedCountryList.length;
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Storage gap ─────────────────────────────────────────────────────────
    //
    // Slots utilisés (50 total) :
    //  1. identityRegistry    (address)
    //  2. allowedCountries    (mapping)
    //  3. _agents             (mapping)
    //  4. allowedCountryList  (array)
    //  5. strictMode          (bool)
    //
    // 45 slots restants

    uint256[45] private __gap;
}
