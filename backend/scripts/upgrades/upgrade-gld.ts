/**
 * @file upgrades/upgrade-gld.ts
 * @description Upgrade du contrat GLD + vérification Etherscan automatique
 * Usage : npx hardhat run scripts/upgrades/upgrade-gld.ts --network sepolia
 */
import hre, { network } from "hardhat";


const PROXY = "0xA4ddCDf84F0C0acC8cA22E77f501d308C4E87dD4";
const UUPS_ABI = [
  "function upgradeToAndCall(address, bytes) external",
  "function owner() view returns (address)",
];

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Upgrade GLD");
  console.log(`  Proxy  : ${PROXY}`);
  console.log(`  Wallet : ${deployer.address}`);
  console.log("═══════════════════════════════════════════════════════\n");

  process.stdout.write("  Déploiement nouvelle impl... ");
  const factory = await ethers.getContractFactory("GLD", deployer);
  const impl = await factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`✅  ${implAddr}`);

  console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract contracts/GLD.sol:GLD ${implAddr}`);

  process.stdout.write("  upgradeToAndCall... ");
  const proxy = new ethers.Contract(PROXY, UUPS_ABI, deployer);
  const tx = await proxy.upgradeToAndCall(implAddr, "0x");
  await tx.wait();
  console.log("✅");

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ✅ GLD upgradé avec succès");
  console.log(`  ℹ️  Nouvelle impl : ${implAddr}`);
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);
