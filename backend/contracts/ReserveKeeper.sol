// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@chainlink/contracts/src/v0.8/automation/AutomationCompatible.sol";

// ─── Interface Reserve ────────────────────────────────────────────────────────
interface IReserve {
    function proofOfReserve() external;
    function isHealthy() external view returns (bool);
    function lastCheckAt() external view returns (uint256);
}

/**
 * @title ReserveKeeper
 * @notice Contrat Chainlink Automation pour automatiser proofOfReserve()
 * @dev Appelle Reserve.proofOfReserve() si :
 *   1. Le délai minimum depuis le dernier check est écoulé (checkInterval)
 *   2. OU le ratio est insuffisant (urgence — appel immédiat)
 */
contract ReserveKeeper is AutomationCompatibleInterface {

    // ─── State ────────────────────────────────────────────────────────────
    IReserve public reserve;
    address  public owner;
    uint256  public checkInterval; // délai minimum entre deux checks (secondes)
    uint256  public lastPerformedAt; // timestamp du dernier performUpkeep

    // ─── Events ───────────────────────────────────────────────────────────
    event UpkeepPerformed(uint256 timestamp, bool wasHealthy);
    event IntervalUpdated(uint256 oldInterval, uint256 newInterval);
    event ReserveUpdated(address oldReserve, address newReserve);
    event OwnershipTransferred(address oldOwner, address newOwner);

    // ─── Erreurs ──────────────────────────────────────────────────────────
    error NotOwner();
    error InvalidAddress();
    error InvalidInterval();

    // ─── Modifier ─────────────────────────────────────────────────────────
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────────────
    constructor(address reserveAddr, uint256 interval) {
        if (reserveAddr == address(0)) revert InvalidAddress();
        if (interval == 0)            revert InvalidInterval();

        reserve          = IReserve(reserveAddr);
        checkInterval    = interval;
        owner            = msg.sender;
        lastPerformedAt  = 0;
    }

    // ─── Chainlink Automation ─────────────────────────────────────────────

    /**
     * @notice Chainlink vérifie si une action est nécessaire
     * @return upkeepNeeded true si performUpkeep doit être appelé
     * @return performData  données à passer à performUpkeep (vide ici)
     */
    function checkUpkeep(bytes calldata /* checkData */)
        external
        view
        override
        returns (bool upkeepNeeded, bytes memory performData)
    {
        bool intervalElapsed = (block.timestamp - lastPerformedAt) >= checkInterval;
        bool isUnhealthy     = !reserve.isHealthy();

        // Appeler si délai écoulé OU ratio insuffisant (urgence)
        upkeepNeeded = intervalElapsed || isUnhealthy;
        performData  = "";
    }

    /**
     * @notice Chainlink exécute l'upkeep
     * @dev Appelé uniquement si checkUpkeep retourne true
     */
    function performUpkeep(bytes calldata /* performData */)
        external
        override
    {
        // Double vérification — éviter les appels inutiles
        bool intervalElapsed = (block.timestamp - lastPerformedAt) >= checkInterval;
        bool isUnhealthy     = !reserve.isHealthy();

        if (!intervalElapsed && !isUnhealthy) return;

        bool wasHealthy  = reserve.isHealthy();
        lastPerformedAt  = block.timestamp;

        reserve.proofOfReserve();

        emit UpkeepPerformed(block.timestamp, wasHealthy);
    }

    // ─── Admin (Safe uniquement) ──────────────────────────────────────────

    function setCheckInterval(uint256 newInterval) external onlyOwner {
        if (newInterval == 0) revert InvalidInterval();
        emit IntervalUpdated(checkInterval, newInterval);
        checkInterval = newInterval;
    }

    function setReserve(address newReserve) external onlyOwner {
        if (newReserve == address(0)) revert InvalidAddress();
        emit ReserveUpdated(address(reserve), newReserve);
        reserve = IReserve(newReserve);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}