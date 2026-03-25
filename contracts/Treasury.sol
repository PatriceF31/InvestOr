// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Treasury — Gardien des dépôts USDC
/// @notice Reçoit et restitue des USDC pour le compte des utilisateurs
/// @dev UUPS upgradeable, indépendant de GLD.sol
contract Treasury is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ─── Storage ─────────────────────────────────────────────────────────────

    /// @dev Adresse du token USDC accepté
    IERC20 public usdc;

    /// @dev Solde USDC déposé par chaque utilisateur
    mapping(address => uint256) private _deposits;

    /// @dev Total USDC déposé dans le contrat
    uint256 private _totalDeposited;

    // ─── Events ──────────────────────────────────────────────────────────────

    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event EmergencyWithdrawn(address indexed to, uint256 amount);
    event UsdcAddressUpdated(address indexed oldUsdc, address indexed newUsdc);

    // ─── Errors ──────────────────────────────────────────────────────────────

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance(uint256 requested, uint256 available);

    // ─── Constructor / Initializer ───────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initialise le Treasury
    /// @param initialOwner Adresse du propriétaire
    /// @param usdcAddress  Adresse du contrat USDC (mock ou officiel)
    function initialize(
        address initialOwner,
        address usdcAddress
    ) external initializer {
        if (initialOwner == address(0)) revert ZeroAddress();
        if (usdcAddress == address(0)) revert ZeroAddress();

        __Ownable_init(initialOwner);
        __Pausable_init();

        usdc = IERC20(usdcAddress);
    }

    // ─── Fonctions utilisateur ───────────────────────────────────────────────

    /// @notice Dépose des USDC dans le Treasury
    /// @dev L'utilisateur doit avoir appelé usdc.approve(treasury, amount) avant
    /// @param amount Montant en unités USDC (6 décimales)
    function deposit(uint256 amount) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        _deposits[msg.sender] += amount;
        _totalDeposited += amount;

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(msg.sender, amount);
    }

    /// @notice Retire des USDC du Treasury
    /// @param amount Montant à retirer
    function withdraw(uint256 amount) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();

        uint256 available = _deposits[msg.sender];
        if (amount > available) revert InsufficientBalance(amount, available);

        _deposits[msg.sender] -= amount;
        _totalDeposited -= amount;

        usdc.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    // ─── Vues ────────────────────────────────────────────────────────────────

    /// @notice Retourne le solde USDC déposé par un utilisateur
    function balanceOf(address user) external view returns (uint256) {
        return _deposits[user];
    }

    /// @notice Retourne le total USDC déposé dans le contrat
    function totalDeposited() external view returns (uint256) {
        return _totalDeposited;
    }

    // ─── Fonctions owner ─────────────────────────────────────────────────────

    /// @notice Suspend les dépôts et retraits
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Reprend les dépôts et retraits
    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Retire tous les USDC vers une adresse (urgence)
    /// @param to Adresse de destination
    function emergencyWithdraw(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 balance = usdc.balanceOf(address(this));
        if (balance == 0) revert ZeroAmount();
        usdc.safeTransfer(to, balance);
        emit EmergencyWithdrawn(to, balance);
    }

    /// @notice Met à jour l'adresse USDC (ex: migration mock → officiel)
    /// @param newUsdc Nouvelle adresse USDC
    function setUsdcAddress(address newUsdc) external onlyOwner {
        if (newUsdc == address(0)) revert ZeroAddress();
        emit UsdcAddressUpdated(address(usdc), newUsdc);
        usdc = IERC20(newUsdc);
    }

    // ─── UUPS ────────────────────────────────────────────────────────────────

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {}
}
