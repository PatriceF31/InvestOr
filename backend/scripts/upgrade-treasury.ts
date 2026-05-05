/**
 * @file upgrades/upgrade-treasury.ts
 * @description Upgrade du contrat Treasury
 * Usage : npx hardhat run scripts/upgrades/upgrade-treasury.ts --network sepolia
 */
import { network } from "hardhat";

const PROXY = "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af";
const UUPS_ABI = [
  "function upgradeToAndCall(address, bytes) external",
  "function owner() view returns (address)",
];

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Upgrade Treasury");
  console.log(`  Proxy  : ${PROXY}`);
  console.log(`  Wallet : ${deployer.address}`);
  console.log("═══════════════════════════════════════════════════════\n");

  process.stdout.write("  Déploiement nouvelle impl... ");
  const factory = await ethers.getContractFactory("Treasury", deployer);
  const impl = await factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`✅  ${implAddr}`);

  process.stdout.write("  upgradeToAndCall... ");
  const proxy = new ethers.Contract(PROXY, UUPS_ABI, deployer);
  const tx = await proxy.upgradeToAndCall(implAddr, "0x");
  await tx.wait();
  console.log("✅");

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ✅ Treasury upgradé avec succès");
  console.log(`  ℹ️  Nouvelle impl : ${implAddr}`);
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);
