// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Force la compilation du proxy ERC1967 pour Hardhat Ignition et les tests
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

// Contrat wrapper pour forcer la compilation de l'artifact
contract InvestOrProxy is ERC1967Proxy {
    constructor(address implementation, bytes memory data)
        ERC1967Proxy(implementation, data) {}
}
