// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title IdentityRegistry
/// @notice Registre KYC on-chain : mapping wallet → identité vérifiée + code pays
/// @dev Upgradeable UUPS — owné par le Safe
///      Les agents autorisés peuvent enregistrer/mettre à jour des identités
///      Inspiré du standard T-REX (ERC-3643) mais simplifié pour InvestOr
contract IdentityRegistry is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    // ─── Types ────────────────────────────────────────────────────────────────

    struct Identity {
        bytes32 identityId;   // Hash de l'identité ONCHAINID (ou identifiant KYC interne)
        uint16  country;      // Code pays ISO-3166 (ex: 250 = France, 392 = Japon)
        bool    verified;     // true = KYC validé
        uint256 verifiedAt;   // Timestamp de vérification
    }

    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @dev wallet → identité KYC
    mapping(address => Identity) private _identities;

    /// @dev Agents autorisés à enregistrer des identités (ex: opérateur KYC)
    mapping(address => bool) public agents;

    /// @dev Liste des wallets enregistrés (pour itération admin)
    address[] public registeredWallets;

    // ─── Events ──────────────────────────────────────────────────────────────

    event IdentityRegistered(
        address indexed wallet,
        bytes32 indexed identityId,
        uint16  country,
        uint256 timestamp
    );
    event IdentityRevoked(address indexed wallet, uint256 timestamp);
    event IdentityUpdated(address indexed wallet, uint16 newCountry);
    event AgentAdded(address indexed agent);
    event AgentRemoved(address indexed agent);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAddress();
    error NotAuthorized(address caller);
    error IdentityNotFound(address wallet);
    error InvalidCountry(uint16 country);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyAgent() {
        if (msg.sender != owner() && !agents[msg.sender])
            revert NotAuthorized(msg.sender);
        _;
    }

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address initialOwner) external initializer {
        if (initialOwner == address(0)) revert ZeroAddress();
        __Ownable_init(initialOwner);
    }

    // ─── Enregistrement d'identités ──────────────────────────────────────────

    /// @notice Enregistre ou met à jour l'identité KYC d'un wallet
    /// @param wallet     Adresse du wallet à enregistrer
    /// @param identityId Hash de l'identité (ONCHAINID ou identifiant KYC interne)
    /// @param country    Code pays ISO-3166 (ex: 250 = France)
    /// @dev Appelable par un agent KYC ou le owner
    function registerIdentity(
        address wallet,
        bytes32 identityId,
        uint16  country
    ) external onlyAgent {
        if (wallet == address(0)) revert ZeroAddress();
        if (identityId == bytes32(0)) revert IdentityNotFound(wallet);
        if (country == 0) revert InvalidCountry(country);

        bool isNew = !_identities[wallet].verified;

        _identities[wallet] = Identity({
            identityId: identityId,
            country:    country,
            verified:   true,
            verifiedAt: block.timestamp
        });

        if (isNew) {
            registeredWallets.push(wallet);
        }

        emit IdentityRegistered(wallet, identityId, country, block.timestamp);
    }

    /// @notice Enregistrement batch — jusqu'à 50 wallets en une seule tx
    /// @dev Optimisation gas pour onboarding initial ou migration
    function registerBatch(
        address[] calldata wallets,
        bytes32[] calldata identityIds,
        uint16[]  calldata countries
    ) external onlyAgent {
        require(
            wallets.length == identityIds.length &&
            wallets.length == countries.length,
            "IdentityRegistry: longueurs incoherentes"
        );
        require(wallets.length <= 50, "IdentityRegistry: max 50 par batch");

        for (uint256 i = 0; i < wallets.length; i++) {
            if (wallets[i] == address(0)) continue;
            if (identityIds[i] == bytes32(0)) continue;
            if (countries[i] == 0) continue;

            bool isNew = !_identities[wallets[i]].verified;

            _identities[wallets[i]] = Identity({
                identityId: identityIds[i],
                country:    countries[i],
                verified:   true,
                verifiedAt: block.timestamp
            });

            if (isNew) {
                registeredWallets.push(wallets[i]);
            }

            emit IdentityRegistered(wallets[i], identityIds[i], countries[i], block.timestamp);
        }
    }

    /// @notice Révoque l'identité KYC d'un wallet (ex: document expiré, fraude)
    function revokeIdentity(address wallet) external onlyAgent {
        if (!_identities[wallet].verified) revert IdentityNotFound(wallet);
        _identities[wallet].verified = false;
        emit IdentityRevoked(wallet, block.timestamp);
    }

    /// @notice Met à jour le code pays d'un wallet déjà enregistré
    function updateCountry(address wallet, uint16 newCountry) external onlyAgent {
        if (!_identities[wallet].verified) revert IdentityNotFound(wallet);
        if (newCountry == 0) revert InvalidCountry(newCountry);
        _identities[wallet].country = newCountry;
        emit IdentityUpdated(wallet, newCountry);
    }

    // ─── Vues ─────────────────────────────────────────────────────────────────

    /// @notice Retourne true si le wallet a une identité KYC vérifiée
    function isVerified(address wallet) external view returns (bool) {
        return _identities[wallet].verified;
    }

    /// @notice Retourne le code pays ISO-3166 du wallet (0 si non enregistré)
    function getCountry(address wallet) external view returns (uint16) {
        return _identities[wallet].country;
    }

    /// @notice Retourne l'identité complète d'un wallet
    function getIdentity(address wallet) external view returns (Identity memory) {
        return _identities[wallet];
    }

    /// @notice Nombre de wallets enregistrés
    function totalRegistered() external view returns (uint256) {
        return registeredWallets.length;
    }

    /// @notice Lecture paginée des wallets enregistrés
    function getRegisteredWallets(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory)
    {
        uint256 total = registeredWallets.length;
        if (offset >= total) return new address[](0);
        uint256 end = offset + limit > total ? total : offset + limit;
        address[] memory result = new address[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            result[i - offset] = registeredWallets[i];
        }
        return result;
    }

    // ─── Gestion des agents KYC ───────────────────────────────────────────────

    function addAgent(address agent) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        agents[agent] = true;
        emit AgentAdded(agent);
    }

    function removeAgent(address agent) external onlyOwner {
        agents[agent] = false;
        emit AgentRemoved(agent);
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Storage gap ─────────────────────────────────────────────────────────
    //
    // Slots utilisés (50 total) :
    //  1. _identities     (mapping)
    //  2. agents          (mapping)
    //  3. registeredWallets (array)
    //
    // 47 slots restants

    uint256[47] private __gap;
}
