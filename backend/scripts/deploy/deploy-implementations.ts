// deploy-implementations.ts
//
// Déploie les nouvelles implémentations Exchange V5 et Treasury V4 (logique
// seule — les proxies existants ne sont PAS touchés ici). À lancer avec :
//
//   npx hardhat run scripts/deploy-implementations.ts --network sepolia
//
// Récupère ensuite les deux adresses affichées et colle-les dans
// upgradeToAndCall(...) via Safe Transaction Builder.

import { network } from "hardhat";

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  InvestOr — Déploiement Exchange V5 + Treasury V4");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Wallet : ${deployer.address}`);
  console.log(`  Réseau : ${(await ethers.provider.getNetwork()).name}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  console.log("1. Exchange V5");
  process.stdout.write("  Déploiement impl... ");
  const Exchange = await ethers.getContractFactory("Exchange", deployer);
  const exchangeImpl = await Exchange.deploy();
  await exchangeImpl.waitForDeployment();
  const exchangeImplAddress = await exchangeImpl.getAddress();
  console.log(`✅  ${exchangeImplAddress}`);
  console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract contracts/Exchange.sol:Exchange ${exchangeImplAddress}`);
  console.log();

  console.log("2. Treasury V4");
  process.stdout.write("  Déploiement impl... ");
  const Treasury = await ethers.getContractFactory("Treasury", deployer);
  const treasuryImpl = await Treasury.deploy();
  await treasuryImpl.waitForDeployment();
  const treasuryImplAddress = await treasuryImpl.getAddress();
  console.log(`✅  ${treasuryImplAddress}`);
  console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract contracts/Treasury.sol:Treasury ${treasuryImplAddress}`);
  console.log();

  console.log("3. Reserve V3");
  process.stdout.write("  Déploiement impl... ");
  const Reserve = await ethers.getContractFactory("Reserve", deployer);
  const reserveImpl = await Reserve.deploy();
  await reserveImpl.waitForDeployment();
  const reserveImplAddress = await reserveImpl.getAddress();
  console.log(`✅  ${reserveImplAddress}`);
  console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract contracts/Reserve.sol:Reserve ${reserveImplAddress}`);
  console.log();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Récap pour Safe Transaction Builder (dans cet ordre)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  1. Reserve.upgradeExchange(newImpl)  — to: 0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce`);
  console.log(`     newImpl = ${exchangeImplAddress}`);
  console.log(`  2. upgradeToAndCall sur Reserve proxy — to: 0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce`);
  console.log(`     newImplementation = ${reserveImplAddress}, data = 0x`);
  console.log(`  3. Reserve.setExchangeEventLogger(logger) — to: 0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce`);
  console.log(`     newLogger = 0x70eFf6af5aCE213cEe7a3AFC4587db478c4F4b5a`);
  console.log(`  4. upgradeToAndCall sur Treasury proxy — to: 0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af`);
  console.log(`     newImplementation = ${treasuryImplAddress}, data = 0x`);
  console.log(`  5. Treasury.setEventLogger(logger) — to: 0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af`);
  console.log(`     newLogger = 0x70eFf6af5aCE213cEe7a3AFC4587db478c4F4b5a`);
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
