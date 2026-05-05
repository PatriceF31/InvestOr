/**
 * @file upgrade-all.ts
 * @description Script d'upgrade de tous les contrats InvestOr
 *
 * Ce script upgrade les implémentations de tous les proxies UUPS sans changer leurs adresses.
 * Les données on-chain (balances, rôles, storage) sont préservées.
 *
 * Usage :
 *   npx hardhat run scripts/upgrade-all.ts --network sepolia
 *
 * IMPORTANT : Ne jamais modifier l'ordre des variables de storage dans les contrats !
 * Toujours ajouter les nouvelles variables APRÈS les existantes.
 */

import { network } from "hardhat";

// ─── Adresses des proxies (NE PAS MODIFIER — adresses permanentes) ────────────
const PROXIES = {
  GLD:          "0xA4ddCDf84F0C0acC8cA22E77f501d308C4E87dD4",
  Treasury:     "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af",
  Exchange:     "0x69C73469C427A9adbFA9a54E5a7711746A34d508",
  Reserve:      "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce",
  LingotOr:     "0x69159BBd5EaFf05C381497890F02d78F1b595A83",
  EventLogger:  "0x70eFf6af5aCE213cEe7a3AFC4587db478c4F4b5a",
  SerialNumber: "0x24622EfA10CfBA2B6F0e2845a89B09711293867d",
};

// ─── Quels contrats upgrader ? (mettre false pour ignorer) ────────────────────
const UPGRADE = {
  GLD:          false,
  Treasury:     false,
  Exchange:     false,
  Reserve:      false,
  LingotOr:     false,
  EventLogger:  false,
  SerialNumber: false,
};

// ─── ABIs minimaux ────────────────────────────────────────────────────────────
const UUPS_ABI = [
  "function upgradeToAndCall(address newImplementation, bytes calldata data) external",
  "function owner() view returns (address)",
];

const RESERVE_ABI = [
  ...UUPS_ABI,
  "function upgradeExchange(address newImpl) external",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
let ethersRef: any;
let deployerRef: any;

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

async function deployImpl(contractName: string): Promise<string> {
  const factory = await ethersRef.getContractFactory(contractName, deployerRef);
  const impl = await factory.deploy();
  await impl.waitForDeployment();
  return await impl.getAddress();
}

// ─── Script principal ─────────────────────────────────────────────────────────
async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  ethersRef  = ethers;
  deployerRef = deployer;

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr V2 — Upgrade des contrats");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Wallet : ${deployer.address}`);
  console.log(`  Réseau : ${(await ethers.provider.getNetwork()).name}`);
  console.log("═══════════════════════════════════════════════════════\n");

  const reserve = new ethers.Contract(PROXIES.Reserve, RESERVE_ABI, deployer);

  // ── GLD ───────────────────────────────────────────────────────────────────
  if (UPGRADE.GLD) {
    console.log("1. Upgrade GLD");
    let implAddr: string;
    await step("Déploiement nouvelle impl", async () => {
      implAddr = await deployImpl("GLD");
      return implAddr;
    });
    await step("upgradeToAndCall", async () => {
      const proxy = new ethers.Contract(PROXIES.GLD, UUPS_ABI, deployer);
      const tx = await proxy.upgradeToAndCall(implAddr!, "0x");
      await tx.wait();
      return "OK";
    });
    console.log();
  }

  // ── Treasury ──────────────────────────────────────────────────────────────
  if (UPGRADE.Treasury) {
    console.log("2. Upgrade Treasury");
    let implAddr: string;
    await step("Déploiement nouvelle impl", async () => {
      implAddr = await deployImpl("Treasury");
      return implAddr;
    });
    await step("upgradeToAndCall", async () => {
      const proxy = new ethers.Contract(PROXIES.Treasury, UUPS_ABI, deployer);
      const tx = await proxy.upgradeToAndCall(implAddr!, "0x");
      await tx.wait();
      return "OK";
    });
    console.log();
  }

  // ── Reserve (avant Exchange — Reserve est owner d'Exchange) ───────────────
  if (UPGRADE.Reserve) {
    console.log("3. Upgrade Reserve");
    let implAddr: string;
    await step("Déploiement nouvelle impl", async () => {
      implAddr = await deployImpl("Reserve");
      return implAddr;
    });
    await step("upgradeToAndCall", async () => {
      const tx = await reserve.upgradeToAndCall(implAddr!, "0x");
      await tx.wait();
      return "OK";
    });
    console.log();
  }

  // ── Exchange (via Reserve — Reserve est owner d'Exchange) ─────────────────
  if (UPGRADE.Exchange) {
    console.log("4. Upgrade Exchange (via Reserve)");
    let implAddr: string;
    await step("Déploiement nouvelle impl", async () => {
      implAddr = await deployImpl("Exchange");
      return implAddr;
    });
    await step("upgradeExchange (via Reserve)", async () => {
      const tx = await reserve.upgradeExchange(implAddr!);
      await tx.wait();
      return "OK";
    });
    console.log();
  }

  // ── LingotOr ──────────────────────────────────────────────────────────────
  if (UPGRADE.LingotOr) {
    console.log("5. Upgrade LingotOr");
    let implAddr: string;
    await step("Déploiement nouvelle impl", async () => {
      implAddr = await deployImpl("LingotOr");
      return implAddr;
    });
    // LingotOr est owné par le Safe → upgradeToAndCall doit passer par le Safe
    console.log(`  ⚠️  LingotOr est owné par le Safe — upgrade via Safe :`);
    console.log(`     → app.safe.global`);
    console.log(`     → LingotOr : ${PROXIES.LingotOr}`);
    console.log(`     → fonction : upgradeToAndCall`);
    console.log(`     → newImplementation : ${implAddr!}`);
    console.log(`     → data : 0x`);
    console.log();
  }

  // ── EventLogger ───────────────────────────────────────────────────────────
  if (UPGRADE.EventLogger) {
    console.log("6. Upgrade EventLogger");
    let implAddr: string;
    await step("Déploiement nouvelle impl", async () => {
      implAddr = await deployImpl("EventLogger");
      return implAddr;
    });
    await step("upgradeToAndCall", async () => {
      const proxy = new ethers.Contract(PROXIES.EventLogger, UUPS_ABI, deployer);
      const tx = await proxy.upgradeToAndCall(implAddr!, "0x");
      await tx.wait();
      return "OK";
    });
    console.log();
  }

  // ── SerialNumber ──────────────────────────────────────────────────────────
  if (UPGRADE.SerialNumber) {
    console.log("7. Upgrade SerialNumber");
    let implAddr: string;
    await step("Déploiement nouvelle impl", async () => {
      implAddr = await deployImpl("SerialNumber");
      return implAddr;
    });
    await step("upgradeToAndCall", async () => {
      const proxy = new ethers.Contract(PROXIES.SerialNumber, UUPS_ABI, deployer);
      const tx = await proxy.upgradeToAndCall(implAddr!, "0x");
      await tx.wait();
      return "OK";
    });
    console.log();
  }

  console.log("═══════════════════════════════════════════════════════");
  console.log("  ✅ Upgrade terminé — adresses proxies inchangées");
  console.log("  ℹ️  Vérifier le storage layout après chaque upgrade");
  console.log("  ℹ️  Relancer setup-roles.ts si de nouveaux rôles sont nécessaires");
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
