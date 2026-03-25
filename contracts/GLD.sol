// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title GLD — Gold Token
/// @notice 1 GLD = 1 gramme d'or physique | decimals = 3 | unité minimale = 1 mg
/// @dev ERC-20 upgradeable (UUPS) avec pause et blacklist
contract GLD is
    Initializable,
    ERC20Upgradeable,
    ERC20PausableUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    // ─── Storage ────────────────────────────────────────────────────────────────

    /// @dev Adresses blacklistées : ne peuvent ni envoyer ni recevoir
    mapping(address => bool) private _blacklisted;

    // ─── Events ─────────────────────────────────────────────────────────────────

    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);

    // ─── Errors ─────────────────────────────────────────────────────────────────

    error AccountBlacklisted(address account);
    error ZeroAddress();
    error ZeroAmount();

    // ─── Initializer (remplace le constructeur pour UUPS) ───────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialise le contrat (appelé une seule fois via le proxy)
    /// @param initialOwner Adresse du propriétaire initial
    function initialize(address initialOwner) external initializer {
        if (initialOwner == address(0)) revert ZeroAddress();

        __ERC20_init("Gold Token", "GLD");
        __ERC20Pausable_init();
        __Ownable_init(initialOwner);
    }

    // ─── ERC-20 overrides ───────────────────────────────────────────────────────

    /// @notice Retourne 3 décimales : 1 GLD = 1g, 0.001 GLD = 1 mg (unité min)
    function decimals() public pure override returns (uint8) {
        return 3;
    }

    // ─── Mint / Burn ────────────────────────────────────────────────────────────

    /// @notice Crée des tokens GLD (réservé au owner — gardien des réserves)
    /// @param to      Adresse destinataire
    /// @param amount  Quantité en unités de base (1 GLD = 1000 unités)
    function mint(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (_blacklisted[to]) revert AccountBlacklisted(to);
        _mint(to, amount);
    }

    /// @notice Détruit des tokens GLD (réservé au owner)
    /// @param from    Adresse dont les tokens sont brûlés
    /// @param amount  Quantité en unités de base
    function burn(address from, uint256 amount) external onlyOwner {
        if (from == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _burn(from, amount);
    }

    // ─── Pause ──────────────────────────────────────────────────────────────────

    /// @notice Suspend tous les transferts
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Reprend tous les transferts
    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── Blacklist ───────────────────────────────────────────────────────────────

    /// @notice Ajoute une adresse à la blacklist
    function blacklist(address account) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        _blacklisted[account] = true;
        emit Blacklisted(account);
    }

    /// @notice Retire une adresse de la blacklist
    function unblacklist(address account) external onlyOwner {
        _blacklisted[account] = false;
        emit Unblacklisted(account);
    }

    /// @notice Retourne true si l'adresse est blacklistée
    function isBlacklisted(address account) external view returns (bool) {
        return _blacklisted[account];
    }

    // ─── Hooks ───────────────────────────────────────────────────────────────────

    /// @dev Vérifie pause + blacklist avant chaque transfert
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        // Blacklist : bloque expéditeur et destinataire (sauf mint/burn)
        if (from != address(0) && _blacklisted[from]) revert AccountBlacklisted(from);
        if (to != address(0) && _blacklisted[to]) revert AccountBlacklisted(to);

        super._update(from, to, value);
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────────

    /// @dev Seul le owner peut autoriser une mise à jour de l'implémentation
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}