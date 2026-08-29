/**
 * @file upgrades/upgrade-eventlogger.ts
 * @description Upgrade du contrat EventLogger + vérification Etherscan automatique
 * Usage : npx hardhat run scripts/upgrades/upgrade-eventlogger.ts --network sepolia
 */
import hre, { network } from "hardhat";


const PROXY = "0x70eFf6af5aCE213cEe7a3AFC4587db478c4F4b5a";
const UUPS_ABI = [
  "function upgradeToAndCall(address, bytes) external",
  "function owner() view returns (address)",
];

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Upgrade EventLogger");
  console.log(`  Proxy  : ${PROXY}`);
  console.log(`  Wallet : ${deployer.address}`);
  console.log("═══════════════════════════════════════════════════════\n");

  process.stdout.write("  Déploiement nouvelle impl... ");
  const factory = await ethers.getContractFactory("EventLogger", deployer);
  const impl = await factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`✅  ${implAddr}`);

  console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract contracts/EventLogger.sol:EventLogger ${implAddr}`);

  const proxy = new ethers.Contract(PROXY, UUPS_ABI, deployer);
  const owner = await proxy.owner();

  if (owner.toLowerCase() === deployer.address.toLowerCase()) {
    process.stdout.write("  upgradeToAndCall... ");
    const tx = await proxy.upgradeToAndCall(implAddr, "0x");
    await tx.wait();
    console.log("✅");
    console.log("\n  ✅ EventLogger upgradé avec succès");
  } else {
    console.log(`\n  ⚠️  EventLogger est owné par le Safe : ${owner}`);
    console.log("  ℹ️  Finaliser via app.safe.global :");
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
