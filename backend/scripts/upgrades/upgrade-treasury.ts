/**
 * @file upgrades/upgrade-treasury.ts
 * @description Upgrade du contrat Treasury (ajout de la poche rendement 2.2)
 * ⚠️  Vérifie l'owner on-chain — affiche les instructions Safe si nécessaire
 * Usage : npx hardhat run scripts/upgrades/upgrade-treasury.ts --network sepolia
 */
import hre, { network } from "hardhat";

const PROXY = "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af";
const UUPS_ABI = [
  "function upgradeToAndCall(address, bytes) external",
  "function owner() view returns (address)",
];

async function main() {
  const { ethers } = await network.create();
  const [deployer] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Upgrade Treasury");
  console.log(`  Proxy  : ${PROXY}`);
  console.log(`  Wallet : ${deployer.address}`);
  console.log("═══════════════════════════════════════════════════════\n");

  process.stdout.write("  Déploiement nouvelle impl... ");
  // Nom qualifié, au cas où (comme pour Reserve, un contracts/backup/ existe peut-être)
  const factory = await ethers.getContractFactory("contracts/Treasury.sol:Treasury", deployer);
  const impl = await factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`✅  ${implAddr}`);

  console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract contracts/Treasury.sol:Treasury ${implAddr}`);

  const proxy = new ethers.Contract(PROXY, UUPS_ABI, deployer);
  const owner = await proxy.owner();

  if (owner.toLowerCase() === deployer.address.toLowerCase()) {
    process.stdout.write("  upgradeToAndCall... ");
    const tx = await proxy.upgradeToAndCall(implAddr, "0x");
    await tx.wait();
    console.log("✅");
    console.log("\n  ✅ Treasury upgradé avec succès");
  } else {
    console.log(`\n  ⚠️  Treasury est owné par : ${owner}`);
    console.log("  ℹ️  Finaliser via app.safe.global (si c'est bien le Safe) :");
    console.log(`     → Adresse : ${PROXY}`);
    console.log(`     → Fonction : upgradeToAndCall`);
    console.log(`     → newImplementation : ${implAddr}`);
    console.log(`     → data : 0x`);
    console.log(`     → ETH value : 0`);
  }

  console.log(`\n  ℹ️  Nouvelle impl : ${implAddr}`);
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);
