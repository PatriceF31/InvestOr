// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title MockExchangeOracle — simulateur minimal de Exchange.getPrice() pour les tests
/// @notice Retourne un prix XAU/USD configurable (8 décimales, USD par gramme d'or) —
///         même convention que Exchange.sol réel, sans ses dépendances (Treasury,
///         Chainlink, Tellor).
contract MockExchangeOracle {
    uint256 public price;
    uint8 public source;

    constructor(uint256 initialPrice) {
        price = initialPrice;
        source = 1;
    }

    function getPrice() external view returns (uint256, uint8) {
        return (price, source);
    }

    function setPrice(uint256 newPrice) external {
        price = newPrice;
    }
}
