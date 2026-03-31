// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title EventLogger — Historique centralisé des opérations InvestOr
/// @notice Enregistre les actions importantes de tous les contrats du protocole
/// @dev Seuls les contrats autorisés (sources) peuvent écrire dans le log
contract EventLogger is
    Initializable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    // ─── Types ───────────────────────────────────────────────────────────────

    enum ActionType {
        DEPOSIT,        // 0 — dépôt USDC dans Treasury
        WITHDRAWAL,     // 1 — retrait USDC depuis Treasury
        BUY,            // 2 — achat GLD via Exchange
        SELL,           // 3 — vente GLD via Exchange
        MINT,           // 4 — mint GLD direct (owner/minter)
        BURN,           // 5 — burn GLD direct (owner/minter)
        BLACKLIST,      // 6 — blacklistage d'une adresse
        EMERGENCY       // 7 — retrait d'urgence
    }

    struct LogEntry {
        uint256 timestamp;
        address user;
        ActionType action;
        uint256 amount;     // montant principal (USDC ou GLD selon l'action)
        uint256 price;      // prix au moment de l'action (0 si non applicable)
        address source;     // contrat émetteur
    }

    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @dev Contrats autorisés à écrire dans le log
    mapping(address => bool) public authorizedSources;

    /// @dev Historique complet (append-only)
    LogEntry[] private _log;

    /// @dev Index des entrées par utilisateur : user → indices dans _log
    mapping(address => uint256[]) private _userEntries;

    // ─── Events ──────────────────────────────────────────────────────────────

    event ActionLogged(
        uint256 indexed entryId,
        address indexed user,
        ActionType indexed action,
        uint256 amount,
        uint256 price,
        address source,
        uint256 timestamp
    );
    event SourceAuthorized(address indexed source);
    event SourceRevoked(address indexed source);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error UnauthorizedSource(address caller);
    error ZeroAddress();

    // ─── Modifiers ───────────────────────────────────────────────────────────

    modifier onlyAuthorized() {
        if (!authorizedSources[msg.sender])
            revert UnauthorizedSource(msg.sender);
        _;
    }

    // ─── Initializer ─────────────────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() { _disableInitializers(); }

    function initialize(address initialOwner) external initializer {
        if (initialOwner == address(0)) revert ZeroAddress();
        __Ownable_init(initialOwner);
    }

    // ─── Écriture (sources autorisées) ───────────────────────────────────────

    /// @notice Enregistre une action dans le log
    /// @param user    Adresse de l'utilisateur concerné
    /// @param action  Type d'action
    /// @param amount  Montant principal
    /// @param price   Prix au moment de l'action (0 si non applicable)
    function log(
        address user,
        ActionType action,
        uint256 amount,
        uint256 price
    ) external onlyAuthorized {
        uint256 entryId = _log.length;

        _log.push(LogEntry({
            timestamp: block.timestamp,
            user:      user,
            action:    action,
            amount:    amount,
            price:     price,
            source:    msg.sender
        }));

        _userEntries[user].push(entryId);

        emit ActionLogged(entryId, user, action, amount, price, msg.sender, block.timestamp);
    }

    // ─── Lecture ─────────────────────────────────────────────────────────────

    /// @notice Retourne une entrée du log par son id
    function getEntry(uint256 entryId) external view returns (LogEntry memory) {
        return _log[entryId];
    }

    /// @notice Retourne le nombre total d'entrées
    function totalEntries() external view returns (uint256) {
        return _log.length;
    }

    /// @notice Retourne les ids des entrées d'un utilisateur
    function getUserEntryIds(address user) external view returns (uint256[] memory) {
        return _userEntries[user];
    }

    /// @notice Retourne le nombre d'entrées d'un utilisateur
    function getUserEntryCount(address user) external view returns (uint256) {
        return _userEntries[user].length;
    }

    /// @notice Retourne les N dernières entrées globales
    /// @param count Nombre d'entrées à retourner (depuis la fin)
    function getRecentEntries(uint256 count) external view returns (LogEntry[] memory) {
        uint256 total = _log.length;
        uint256 n = count > total ? total : count;
        LogEntry[] memory entries = new LogEntry[](n);
        for (uint256 i = 0; i < n; i++) {
            entries[i] = _log[total - n + i];
        }
        return entries;
    }

    /// @notice Retourne les entrées d'un utilisateur paginées
    /// @param user   Adresse utilisateur
    /// @param offset Index de départ
    /// @param limit  Nombre maximum d'entrées
    function getUserEntries(
        address user,
        uint256 offset,
        uint256 limit
    ) external view returns (LogEntry[] memory) {
        uint256[] storage ids = _userEntries[user];
        uint256 total = ids.length;
        if (offset >= total) return new LogEntry[](0);

        uint256 end = offset + limit > total ? total : offset + limit;
        uint256 count = end - offset;
        LogEntry[] memory entries = new LogEntry[](count);

        for (uint256 i = 0; i < count; i++) {
            entries[i] = _log[ids[offset + i]];
        }
        return entries;
    }

    // ─── Admin ───────────────────────────────────────────────────────────────

    /// @notice Autorise un contrat à écrire dans le log
    function authorizeSource(address source) external onlyOwner {
        if (source == address(0)) revert ZeroAddress();
        authorizedSources[source] = true;
        emit SourceAuthorized(source);
    }

    /// @notice Révoque l'autorisation d'un contrat
    function revokeSource(address source) external onlyOwner {
        authorizedSources[source] = false;
        emit SourceRevoked(source);
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Storage gap ─────────────────────────────────────────────────────────

    /// @dev Variables actuelles : authorizedSources(1) + _log(1) + _userEntries(1) = 3 slots
    uint256[47] private __gap;
}
