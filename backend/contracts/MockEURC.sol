// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockEURC
/// @notice Mock du token EURC Circle pour les tests sur Sepolia testnet
/// @dev Identique à MockUSDC mais avec nom/symbole EURC — 6 décimales comme l'EURC officiel
///      Sur mainnet : utiliser l'EURC Circle officiel (0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c)
contract MockEURC is ERC20 {
    constructor() ERC20("EUR Coin", "EURC") {}

    /// @notice Mint des EURC pour les tests — sans restriction d'accès sur testnet
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice EURC utilise 6 décimales comme l'original Circle
    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
