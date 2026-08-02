/**
 * @file upgrades/upgrade-reserve.ts
 * @description Upgrade du contrat Reserve + vérification Etherscan automatique
 * ⚠️  Reserve est owné par le Safe — le script déploie l'impl et affiche les instructions Safe
 * Usage : npx hardhat run scripts/upgrades/upgrade-reserve.ts --network sepolia
 */
import hre, { network } from "hardhat";


const PROXY = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";
const UUPS_ABI = [
  "function upgradeToAndCall(address, bytes) external",
  "function owner() view returns (address)",
];

async function main() {
  const { ethers } = await network.create();
  const [deployer] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Upgrade Reserve");
  console.log(`  Proxy  : ${PROXY}`);
  console.log(`  Wallet : ${deployer.address}`);
  console.log("═══════════════════════════════════════════════════════\n");

  process.stdout.write("  Déploiement nouvelle impl... ");
  // Nom qualifié — contracts/backup/Reserve.sol existe aussi dans le projet
  const factory = await ethers.getContractFactory("contracts/Reserve.sol:Reserve", deployer);
  const impl = await factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`✅  ${implAddr}`);

  console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract contracts/Reserve.sol:Reserve ${implAddr}`);

  const proxy = new ethers.Contract(PROXY, UUPS_ABI, deployer);
  const owner = await proxy.owner();

  if (owner.toLowerCase() === deployer.address.toLowerCase()) {
    process.stdout.write("  upgradeToAndCall... ");
    const tx = await proxy.upgradeToAndCall(implAddr, "0x");
    await tx.wait();
    console.log("✅");
    console.log("\n  ✅ Reserve upgradé avec succès");
  } else {
    console.log(`\n  ⚠️  Reserve est owné par le Safe : ${owner}`);
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
