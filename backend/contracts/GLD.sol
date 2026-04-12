// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
// Import du proxy pour que Hardhat génère son artifact (requis par Ignition)
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title GLD — Gold Token
/// @notice 1 GLD = 1 gramme d'or physique | decimals = 3 | unité minimale = 1 mg
/// @dev ERC-20 upgradeable (UUPS) avec pause, blacklist et rôle minter
contract GLD is
    Initializable,
    ERC20Upgradeable,
    ERC20PausableUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @dev Adresses blacklistées : ne peuvent ni envoyer ni recevoir
    mapping(address => bool) private _blacklisted;

    /// @dev Adresse autorisée à mint/burn (ex: Exchange)
    address public minter;

    /// @dev Liste des adresses blacklistées (pour itération, car mapping non itérable)
    address[] public blacklistList;

    // ─── Events ──────────────────────────────────────────────────────────────

    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);
    event MinterUpdated(address indexed oldMinter, address indexed newMinter);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error AccountBlacklisted(address account);
    error ZeroAddress();
    error ZeroAmount();
    error UnauthorizedMinter(address caller);

    // ─── Modifiers ───────────────────────────────────────────────────────────

    /// @dev Owner OU minter approuvé peuvent mint/burn
    modifier onlyMinter() {
        if (msg.sender != owner() && msg.sender != minter)
            revert UnauthorizedMinter(msg.sender);
        _;
    }

    // ─── Initializer ─────────────────────────────────────────────────────────

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

    // ─── ERC-20 overrides ────────────────────────────────────────────────────

    /// @notice Retourne 3 décimales : 1 GLD = 1g, 0.001 GLD = 1 mg (unité min)
    function decimals() public pure override returns (uint8) {
        return 3;
    }

    // ─── Minter role ─────────────────────────────────────────────────────────

    /// @notice Définit l'adresse autorisée à mint/burn (ex: Exchange)
    /// @param newMinter Nouvelle adresse minter (address(0) pour désactiver)
    function setMinter(address newMinter) external onlyOwner {
        emit MinterUpdated(minter, newMinter);
        minter = newMinter;
    }

    // ─── Mint / Burn ─────────────────────────────────────────────────────────

    /// @notice Crée des tokens GLD
    /// @dev Accessible au owner et au minter approuvé (Exchange)
    function mint(address to, uint256 amount) external onlyMinter {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (_blacklisted[to]) revert AccountBlacklisted(to);
        _mint(to, amount);
    }

    /// @notice Détruit des tokens GLD
    /// @dev Accessible au owner et au minter approuvé (Exchange)
    function burn(address from, uint256 amount) external onlyMinter {
        if (from == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        _burn(from, amount);
    }

    // ─── Pause ───────────────────────────────────────────────────────────────

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    // ─── Blacklist ────────────────────────────────────────────────────────────

    function blacklist(address account) external onlyOwner {
        if (!_blacklisted[account]) {
            _blacklisted[account] = true;
            blacklistList.push(account);
            emit Blacklisted(account);
        }
    }

    function unblacklist(address account) external onlyOwner {
        if (_blacklisted[account]) {
            _blacklisted[account] = false;
            emit Unblacklisted(account);
            for (uint256 i = 0; i < blacklistList.length; i++) {
                if (blacklistList[i] == account) {
                    blacklistList[i] = blacklistList[blacklistList.length - 1];
                    blacklistList.pop();
                    break;
                }
            }
        }
    }

    function getBlacklist() external view returns (address[] memory) {
        return blacklistList;
    }

    function isBlacklisted(address account) external view returns (bool) {
        return _blacklisted[account];
    }

    // ─── Hooks ───────────────────────────────────────────────────────────────

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        if (from != address(0) && _blacklisted[from]) revert AccountBlacklisted(from);
        if (to != address(0) && _blacklisted[to]) revert AccountBlacklisted(to);
        super._update(from, to, value);
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Storage gap ─────────────────────────────────────────────────────────

    /// @dev Toujours garder total storage (variables + gap) = 50 slots
    /// @dev => 3 slots utilisés, soit 47 restants pour les futures variables
    /// Slot Variable 
    /// 1. _blacklisted (mapping)
    /// 2. blacklistList (address[])
    /// 3. minter (address)
    uint256[47] private __gap;
}
