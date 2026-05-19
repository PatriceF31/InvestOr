// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @dev Interface minimale du module de conformité
/// @notice On évite l'import direct pour ne pas créer de dépendance de compilation circulaire
interface IComplianceModuleGLD {
    function canTransfer(address from, address to, uint256 amount) external view returns (bool);
}

/// @title GLD — Gold Token V2
/// @notice 1 GLD = 1 gramme d'or physique | decimals = 3 | unité minimale = 1 mg
/// @dev ERC-20 upgradeable (UUPS) avec pause, blacklist, rôle minter
///      et module de conformité MiCA pluggable (ERC-3643 inspiré)
///
/// Nouveauté V2 — Module de conformité :
///   - complianceModule (slot 4) : contrat IComplianceModule pluggable
///   - _update() vérifie canTransfer() si le module est configuré
///   - Exchange (agent) est exempté via canTransfer() → mint/burn toujours autorisés
///   - setComplianceModule(address) : owner peut brancher/débrancher le module
///   - Mode off : complianceModule = address(0) → comportement V1 identique
contract GLD is
    Initializable,
    ERC20Upgradeable,
    ERC20PausableUpgradeable,
    OwnableUpgradeable,
    UUPSUpgradeable
{
    // ─── Storage ─────────────────────────────────────────────────────────────
    //
    // ATTENTION : ne jamais réordonner ces slots — UUPS storage layout critique
    //
    // Slot 1 : _blacklisted      (mapping) — inchangé V1
    // Slot 2 : minter            (address) — inchangé V1
    // Slot 3 : blacklistList     (array)   — inchangé V1
    // Slot 4 : complianceModule  (address) — NOUVEAU V2
    //

    /// @dev Adresses blacklistées : ne peuvent ni envoyer ni recevoir
    mapping(address => bool) private _blacklisted;

    /// @dev Adresse autorisée à mint/burn (ex: Exchange)
    address public minter;

    /// @dev Liste des adresses blacklistées (pour itération admin)
    address[] public blacklistList;

    /// @dev Module de conformité MiCA pluggable (address(0) = désactivé)
    /// @notice Quand configuré : chaque transfert GLD passe par canTransfer()
    /// @notice Exchange est déclaré agent dans le module → toujours autorisé
    IComplianceModuleGLD public complianceModule;

    // ─── Events ──────────────────────────────────────────────────────────────

    event Blacklisted(address indexed account);
    event Unblacklisted(address indexed account);
    event MinterUpdated(address indexed oldMinter, address indexed newMinter);
    event ComplianceModuleUpdated(address indexed oldModule, address indexed newModule);
    event TransferBlockedByCompliance(address indexed from, address indexed to, uint256 amount);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error AccountBlacklisted(address account);
    error ZeroAddress();
    error ZeroAmount();
    error UnauthorizedMinter(address caller);
    error TransferNotCompliant(address from, address to);

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
    /// @dev Identique à V1 — complianceModule reste address(0) après initialize()
    ///      Brancher le module via setComplianceModule() après déploiement
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
    function setMinter(address newMinter) external onlyOwner {
        emit MinterUpdated(minter, newMinter);
        minter = newMinter;
    }

    // ─── Mint / Burn ─────────────────────────────────────────────────────────

    /// @notice Crée des tokens GLD
    /// @dev Exchange est agent dans le module → canTransfer() retourne true → pas de blocage
    function mint(address to, uint256 amount) external onlyMinter {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (_blacklisted[to]) revert AccountBlacklisted(to);
        _mint(to, amount);
    }

    /// @notice Détruit des tokens GLD
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

    // ─── Module de conformité ─────────────────────────────────────────────────

    /// @notice Branche ou débranche le module de conformité MiCA
    /// @param newModule address(0) pour désactiver (mode V1 — aucune vérification)
    /// @dev Appeler setStrictMode(false) sur le module avant de désactiver
    ///      pour éviter des transferts bloqués pendant la transition
    function setComplianceModule(address newModule) external onlyOwner {
        emit ComplianceModuleUpdated(address(complianceModule), newModule);
        complianceModule = IComplianceModuleGLD(newModule);
    }

    /// @notice Retourne l'état de conformité d'un transfert potentiel
    /// @dev Vue utilitaire pour le frontend et les tests
    function checkCompliance(address from, address to, uint256 amount)
        external
        view
        returns (bool)
    {
        if (address(complianceModule) == address(0)) return true;
        return complianceModule.canTransfer(from, to, amount);
    }

    // ─── Hooks ───────────────────────────────────────────────────────────────

    /// @notice Hook appelé avant chaque transfert, mint et burn
    /// @dev Ordre des vérifications :
    ///      1. Blacklist (V1 — toujours actif)
    ///      2. Module de conformité MiCA (V2 — si configuré)
    ///      3. super._update() → ERC20PausableUpgradeable (pause check)
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {

        // ── Vérification blacklist (V1 — inchangé) ────────────────────────────
        if (from != address(0) && _blacklisted[from]) revert AccountBlacklisted(from);
        if (to   != address(0) && _blacklisted[to])   revert AccountBlacklisted(to);

        // ── Vérification conformité MiCA (V2 — uniquement si module configuré) ─
        // Note : Exchange est agent dans le module → canTransfer() retourne true
        // pour tous les mint/burn d'Exchange, sans check KYC ni pays.
        if (address(complianceModule) != address(0)) {
            if (!complianceModule.canTransfer(from, to, value)) {
                emit TransferBlockedByCompliance(from, to, value);
                revert TransferNotCompliant(from, to);
            }
        }

        super._update(from, to, value);
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}

    // ─── Storage gap ─────────────────────────────────────────────────────────
    //
    // Slots utilisés (50 total UUPS standard) :
    //  1. _blacklisted       (mapping)  — V1
    //  2. minter             (address)  — V1
    //  3. blacklistList      (array)    — V1
    //  4. complianceModule   (address)  — V2 NOUVEAU
    //
    // 46 slots restants

    uint256[46] private __gap;
}
