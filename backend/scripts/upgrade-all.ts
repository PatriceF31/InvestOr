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
 * Voir documentation technique — Addendum section 1 pour les détails.
 */

import { network } from "hardhat";

// ─── Adresses des proxies (NE PAS MODIFIER — adresses permanentes) ─────────────
const PROXIES = {
  GLD:      "0xA4ddCDf84F0C0acC8cA22E77f501d308C4E87dD4",
  Treasury: "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af",
  Exchange: "0x69C73469C427A9adbFA9a54E5a7711746A34d508",
  Reserve:  "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce",
};

// ─── Quels contrats upgrader ? (mettre false pour ignorer) ────────────────────
const UPGRADE = {
  GLD:          false,
  Treasury:     false,
  Exchange:     false,
  Reserve:      false,
  EventLogger:  true,
  SerialNumber: true,
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

// ─── Script principal ─────────────────────────────────────────────────────────
async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Upgrade de tous les contrats");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Wallet       : ${deployer.address}`);
  console.log(`  Réseau       : ${(await ethers.provider.getNetwork()).name}`);
  console.log("═══════════════════════════════════════════════════════\n");

  const reserve = new ethers.Contract(PROXIES.Reserve, RESERVE_ABI, deployer);


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

async function deployImpl(contractName: string): Promise<string> {
  const factory = await ethers.getContractFactory(contractName, deployer);
  const impl = await factory.deploy();
  await impl.waitForDeployment();
  return await impl.getAddress();
}

  // ── GLD ─────────────────────────────────────────────────────────────────────
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

  // ── Treasury ─────────────────────────────────────────────────────────────────
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

  // ── Reserve (avant Exchange car Reserve est owner d'Exchange) ─────────────────
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

  // ── Exchange (via Reserve car Reserve est owner d'Exchange) ──────────────────
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

  console.log("═══════════════════════════════════════════════════════");
  console.log("  ✅ Upgrade terminé — adresses proxies inchangées");
  console.log("  ℹ️  Vérifier que le storage layout n'a pas changé !");
  console.log("  ℹ️  Relancer setup-roles.ts si de nouveaux rôles sont nécessaires");
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
