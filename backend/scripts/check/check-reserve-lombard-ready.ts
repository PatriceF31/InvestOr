// scripts/check-reserve-lombard-ready.ts
//
// Vérifie si l'implémentation Reserve actuellement live sur Sepolia connaît
// déjà les fonctions relais Lombard (donc si l'upgrade a déjà été fait), sans
// rien modifier on-chain.
//
// Usage :
//   npx hardhat run scripts/check-reserve-lombard-ready.ts --network sepolia

import { network } from "hardhat";

const RESERVE_ADDRESS = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";

async function main() {
  const { ethers } = await network.create();

  const reserveAbi = [
    "function lombardVault() view returns (address)",
  ];
  const reserve = new ethers.Contract(RESERVE_ADDRESS, reserveAbi, ethers.provider);

  try {
    const current = await reserve.lombardVault();
    console.log("✅ Reserve connaît déjà lombardVault() — upgrade déjà effectué.");
    console.log("   Valeur actuelle :", current);
    if (current === ethers.ZeroAddress) {
      console.log("   (encore à address(0) — normal si setLombardVault() n'a pas encore été exécutée)");
    }
  } catch (err: any) {
    console.log("❌ Reserve NE connaît PAS encore lombardVault() — upgrade nécessaire avant toute autre étape.");
    console.log("   Lancer scripts/upgrade-reserve.ts (avec le Reserve.sol mis à jour), puis la transaction");
    console.log("   Safe upgradeToAndCall, avant de proposer setLombardVault/setLombardOperator.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
