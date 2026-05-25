/**
 * @file scripts/upgrades/upgrade-exchange.ts
 * @description Upgrade Exchange → V4 (oracle EUR/USD pour conversion EURC)
 *
 * Nouveautés V4 :
 *   - eurusdOracle (slot 15) : Chainlink EUR/USD
 *   - eurusdFallbackRate (slot 16) : taux fallback (défaut 1.08)
 *   - previewBuy/buy : conversion EURC→USD via oracle
 *   - previewSell/sell : conversion USD→EURC via oracle
 *
 * Post-upgrade — configurer l'oracle EUR/USD via Safe :
 *   → Reserve.setExchangeEurUsdOracle(0x1a81afB8146aeFfCFc5E50e8479e826E7D55b910)
 *   OU directement sur Exchange si owner = deployer :
 *   → exchange.setEurUsdOracle(0x1a81afB8146aeFfCFc5E50e8479e826E7D55b910)
 *
 * Usage :
 *   npx hardhat run scripts/upgrades/upgrade-exchange.ts --network sepolia
 */

import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";

const PROXY = "0x69C73469C427A9adbFA9a54E5a7711746A34d508";

// Oracle EUR/USD Chainlink Sepolia (et Mainnet — même adresse)
const EURUSD_ORACLE_SEPOLIA = "0x1a81afB8146aeFfCFc5E50e8479e826E7D55b910";

const RESERVE_ABI = [
  "function setExchangeEurUsdOracle(address oracle) external",
  "function owner() view returns (address)",
];

const UUPS_ABI = [
  "function upgradeToAndCall(address, bytes) external",
  "function owner() view returns (address)",
  "function eurusdOracle() view returns (address)",
  "function setEurUsdOracle(address) external",
];

const RESERVE_PROXY = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  InvestOr — Upgrade Exchange → V4 (oracle EUR/USD)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Proxy    : ${PROXY}`);
  console.log(`  Wallet   : ${deployer.address}`);
  console.log(`  EUR/USD  : ${EURUSD_ORACLE_SEPOLIA}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ── 1. Déployer nouvelle impl ─────────────────────────────────────────────
  process.stdout.write("  Déploiement impl Exchange V4... ");
  const factory = await ethers.getContractFactory("contracts/Exchange.sol:Exchange", deployer);
  const impl    = await factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`✅  ${implAddr}`);
  console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract contracts/Exchange.sol:Exchange ${implAddr}`);
  console.log();

  // ── 2. Upgrade via Reserve (owner d'Exchange) ─────────────────────────────
  const reserve = new ethers.Contract(RESERVE_PROXY, RESERVE_ABI, deployer);
  const reserveOwner = await reserve.owner();

  if (reserveOwner.toLowerCase() === deployer.address.toLowerCase()) {
    process.stdout.write("  upgradeExchange via Reserve... ");
    // Reserve expose upgradeExchange(address)
    const reserveFull = new ethers.Contract(RESERVE_PROXY, [
      ...RESERVE_ABI,
      "function upgradeExchange(address newImpl) external",
    ], deployer);
    const tx = await reserveFull.upgradeExchange(implAddr);
    await tx.wait();
    console.log("✅");
  } else {
    console.log(`  ⚠️  Reserve est owné par le Safe : ${reserveOwner}`);
    console.log("  ℹ️  Tx Safe 1 — upgradeExchange :");
    console.log(`     → Contrat  : ${RESERVE_PROXY}`);
    console.log(`     → Fonction : upgradeExchange`);
    console.log(`     → newImpl  : ${implAddr}`);
  }
  console.log();

  // ── 3. Configurer l'oracle EUR/USD ────────────────────────────────────────
  console.log("  ℹ️  Tx Safe 2 — configurer l'oracle EUR/USD :");
  console.log(`     → Contrat  : ${RESERVE_PROXY}`);
  console.log(`     → Fonction : setExchangeEurUsdOracle`);
  console.log(`     → oracle   : ${EURUSD_ORACLE_SEPOLIA}`);
  console.log();

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ✅ Script terminé");
  console.log(`  Impl V4 : ${implAddr}`);
  console.log("  → Effectuer les 2 transactions Safe ci-dessus");
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
