/**
 * @file scripts/deploy-eurc.ts
 * @description Configuration du support EURC sur InvestOr
 *
 * Ce script :
 *   1. Déploie MockEURC sur Sepolia testnet (ERC-20 mintable pour les tests)
 *      → Sur mainnet, utiliser l'adresse EURC Circle officielle directement
 *   2. Upgrade Treasury → V2 (multi-token) via upgradeToAndCall
 *   3. Upgrade Exchange → V3 (multi-token) via Reserve.upgradeExchange
 *   4. Configure EURC sur Treasury (setEurc) et Exchange (setEurc)
 *   5. Affiche les commandes verify Etherscan
 *
 * Prérequis :
 *   - Treasury et Exchange déjà déployés (proxies permanents)
 *   - Reserve est owner d'Exchange
 *   - npm run compile:force avant d'exécuter ce script
 *
 * Usage :
 *   npx hardhat run scripts/deploy-eurc.ts --network sepolia
 *
 * Mainnet : remplacer EURC_ADDRESS par "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c"
 *           et mettre DEPLOY_MOCK_EURC = false
 */

import hre, { network } from "hardhat";

// ─── Adresses des proxies (NE PAS MODIFIER) ───────────────────────────────────
const TREASURY_PROXY = "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af";
const EXCHANGE_PROXY = "0x69C73469C427A9adbFA9a54E5a7711746A34d508";
const RESERVE_PROXY  = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";

// ─── Configuration ────────────────────────────────────────────────────────────

/// @dev true = déployer MockEURC (testnet Sepolia)
/// @dev false = utiliser EURC_ADDRESS (mainnet ou réseau avec EURC officiel)
/// @dev false = utiliser EURC Circle officiel (recommandé — faucet disponible sur faucet.circle.com)
/// @dev true  = déployer MockEURC (fallback si faucet indisponible)
const DEPLOY_MOCK_EURC = false;

/// @dev Adresse EURC à utiliser si DEPLOY_MOCK_EURC = false
/// @notice Mainnet Ethereum : 0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c
/// @notice Sepolia (Circle officiel) : 0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4
/// @notice Mainnet Ethereum : 0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c
const EURC_ADDRESS_MAINNET = "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c";
const EURC_ADDRESS_SEPOLIA  = "0x08210F9170F89Ab7658F0B5E3fF39b0E03C594D4";

// ─── ABIs minimaux ────────────────────────────────────────────────────────────

const UUPS_ABI = [
  "function upgradeToAndCall(address newImplementation, bytes calldata data) external",
  "function owner() view returns (address)",
];

const RESERVE_ABI = [
  ...UUPS_ABI,
  "function upgradeExchange(address newImpl) external",
  "function owner() view returns (address)",
];

const TREASURY_ABI = [
  ...UUPS_ABI,
  "function setEurc(address eurcAddress) external",
  "function isSupportedToken(address token) view returns (bool)",
  "function eurc() view returns (address)",
  "function owner() view returns (address)",
];

const EXCHANGE_ABI = [
  "function setEurc(address eurcAddress) external",
  "function eurc() view returns (address)",
  "function owner() view returns (address)",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function step(label: string, fn: () => Promise<string>) {
  process.stdout.write(`  ${label}... `);
  try {
    const result = await fn();
    console.log(`✅  ${result}`);
  } catch (e: any) {
    console.log("❌");
    console.error(`     Erreur: ${e.message}`);
    throw e;
  }
}

// ─── Script principal ─────────────────────────────────────────────────────────

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  InvestOr V3 — Déploiement support EURC (multi-token)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Wallet          : ${deployer.address}`);
  console.log(`  Réseau          : ${(await ethers.provider.getNetwork()).name}`);
  console.log(`  Treasury proxy  : ${TREASURY_PROXY}`);
  console.log(`  Exchange proxy  : ${EXCHANGE_PROXY}`);
  console.log(`  Reserve proxy   : ${RESERVE_PROXY}`);
  console.log(`  Mode EURC       : ${DEPLOY_MOCK_EURC ? "MockEURC (testnet)" : "EURC officiel Circle"}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ── 1. MockEURC (testnet uniquement) ──────────────────────────────────────
  let eurcAddress: string;

  if (DEPLOY_MOCK_EURC) {
    console.log("1. Déploiement MockEURC (testnet Sepolia)");

    let implAddr: string;
    await step("Déploiement MockEURC", async () => {
      const factory = await ethers.getContractFactory("MockEURC", deployer);
      const mock = await factory.deploy();
      await mock.waitForDeployment();
      implAddr = await mock.getAddress();
      return implAddr;
    });

    eurcAddress = implAddr!;
    console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract contracts/MockEURC.sol:MockEURC ${eurcAddress}`);
    console.log();
  } else {
    const network = await ethers.provider.getNetwork();
    eurcAddress = network.chainId === 11155111n
      ? EURC_ADDRESS_SEPOLIA   // EURC Circle officiel Sepolia — faucet.circle.com
      : EURC_ADDRESS_MAINNET;  // EURC Circle officiel Mainnet
    console.log(`1. EURC officiel Circle utilisé : ${eurcAddress}\n`);
  }

  // ── 2. Upgrade Treasury → V2 ──────────────────────────────────────────────
  console.log("2. Upgrade Treasury → V2 (multi-token)");

  let treasuryImplAddr: string;
  await step("Déploiement nouvelle impl Treasury V2", async () => {
    const factory = await ethers.getContractFactory("contracts/Treasury.sol:Treasury", deployer);
    const impl = await factory.deploy();
    await impl.waitForDeployment();
    treasuryImplAddr = await impl.getAddress();
    return treasuryImplAddr;
  });

  console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract contracts/Treasury.sol:Treasury ${treasuryImplAddr!}`);

  const treasury = new ethers.Contract(TREASURY_PROXY, TREASURY_ABI, deployer);
  const treasuryOwner = await treasury.owner();

  if (treasuryOwner.toLowerCase() === deployer.address.toLowerCase()) {
    await step("upgradeToAndCall Treasury", async () => {
      const tx = await treasury.upgradeToAndCall(treasuryImplAddr!, "0x");
      await tx.wait();
      return "OK";
    });
  } else {
    console.log(`  ⚠️  Treasury est owné par le Safe : ${treasuryOwner}`);
    console.log("  ℹ️  Finaliser via app.safe.global :");
    console.log(`     → Contrat  : ${TREASURY_PROXY}`);
    console.log(`     → Fonction : upgradeToAndCall`);
    console.log(`     → newImpl  : ${treasuryImplAddr!}`);
    console.log(`     → data     : 0x`);
  }
  console.log();

  // ── 3. Upgrade Exchange → V3 ──────────────────────────────────────────────
  console.log("3. Upgrade Exchange → V3 (multi-token)");

  let exchangeImplAddr: string;
  await step("Déploiement nouvelle impl Exchange V3", async () => {
    const factory = await ethers.getContractFactory("contracts/Exchange.sol:Exchange", deployer);
    const impl = await factory.deploy();
    await impl.waitForDeployment();
    exchangeImplAddr = await impl.getAddress();
    return exchangeImplAddr;
  });

  console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract contracts/Exchange.sol:Exchange ${exchangeImplAddr!}`);

  const reserve = new ethers.Contract(RESERVE_PROXY, RESERVE_ABI, deployer);
  const reserveOwner = await reserve.owner();

  if (reserveOwner.toLowerCase() === deployer.address.toLowerCase()) {
    await step("upgradeExchange (via Reserve)", async () => {
      const tx = await reserve.upgradeExchange(exchangeImplAddr!);
      await tx.wait();
      return "OK";
    });
  } else {
    console.log(`  ⚠️  Reserve est owné par le Safe : ${reserveOwner}`);
    console.log("  ℹ️  Finaliser via app.safe.global :");
    console.log(`     → Contrat  : ${RESERVE_PROXY}`);
    console.log(`     → Fonction : upgradeExchange`);
    console.log(`     → newImpl  : ${exchangeImplAddr!}`);
  }
  console.log();

  // ── 4. Configurer EURC sur Treasury ───────────────────────────────────────
  console.log("4. Configuration EURC sur Treasury");

  if (treasuryOwner.toLowerCase() === deployer.address.toLowerCase()) {
    await step(`setEurc(${eurcAddress})`, async () => {
      const tx = await treasury.setEurc(eurcAddress);
      await tx.wait();
      return "OK";
    });

    // Vérification
    const isSupported = await treasury.isSupportedToken(eurcAddress);
    console.log(`  ℹ️  EURC supporté par Treasury : ${isSupported ? "✅" : "❌"}`);
  } else {
    console.log(`  ⚠️  Treasury est owné par le Safe : ${treasuryOwner}`);
    console.log("  ℹ️  Finaliser via app.safe.global :");
    console.log(`     → Contrat  : ${TREASURY_PROXY}`);
    console.log(`     → Fonction : setEurc`);
    console.log(`     → argument : ${eurcAddress}`);
  }
  console.log();

  // ── 5. Configurer EURC sur Exchange via Reserve.setExchangeEurc ────────────
  console.log("5. Configuration EURC sur Exchange (via Reserve)");

  const RESERVE_V3_ABI = [
    ...RESERVE_ABI,
    "function setExchangeEurc(address eurcAddress) external",
  ];
  const reserveV3 = new ethers.Contract(RESERVE_PROXY, RESERVE_V3_ABI, deployer);

  if (reserveOwner.toLowerCase() === deployer.address.toLowerCase()) {
    await step(`setExchangeEurc(${eurcAddress}) via Reserve`, async () => {
      const tx = await reserveV3.setExchangeEurc(eurcAddress);
      await tx.wait();
      return "OK";
    });
  } else {
    console.log(`  ⚠️  Reserve est owné par le Safe : ${reserveOwner}`);
    console.log("  ℹ️  Finaliser via app.safe.global :");
    console.log(`     → Contrat  : ${RESERVE_PROXY}`);
    console.log(`     → Fonction : setExchangeEurc`);
    console.log(`     → argument : ${eurcAddress}`);
  }
  console.log();

  // ── Récapitulatif ─────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ✅ Script deploy-eurc terminé");
  console.log("═══════════════════════════════════════════════════════════════");
  if (DEPLOY_MOCK_EURC) {
    console.log(`  MockEURC (Sepolia)        : ${eurcAddress}`);
  } else {
    console.log(`  EURC Circle (officiel)    : ${eurcAddress}`);
  }
  console.log(`  Treasury impl V2          : ${treasuryImplAddr!}`);
  console.log(`  Exchange impl V3          : ${exchangeImplAddr!}`);
  console.log("");
  console.log("  Actions Safe restantes (si owné par Safe) :");
  console.log(`  1. Treasury.upgradeToAndCall(${treasuryImplAddr!}, 0x)`);
  console.log(`  2. Reserve.upgradeExchange(${exchangeImplAddr!})`);
  console.log(`  3. Treasury.setEurc(${eurcAddress})`);
  console.log(`  4. Reserve.setExchangeEurc(${eurcAddress})`);
  console.log("");
  console.log("  Prochaines étapes :");
  console.log("  → Mint MockEURC pour les tests : mockEURC.mint(wallet, amount)");
  console.log("  → Mettre à jour le frontend : sélecteur USDC/EURC sur Trade page");
  console.log("  → Compléter pt.json avec les nouvelles clés EURC");
  console.log("  → Mettre à jour Contrat_v2.png avec MockEURC address");
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
