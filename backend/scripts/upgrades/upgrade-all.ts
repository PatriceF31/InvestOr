/**
 * @file upgrade-all.ts
 * @description Upgrade de tous les contrats InvestOr + vérification Etherscan automatique
 *
 * Usage :
 *   npx hardhat run scripts/upgrade-all.ts --network sepolia
 *
 * IMPORTANT : Ne jamais modifier l'ordre des variables de storage dans les contrats !
 * Toujours ajouter les nouvelles variables APRÈS les existantes.
 */

import { network, run } from "hardhat";

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

// ─── Noms qualifiés — nécessaires si contracts/backup/ existe ─────────────────
// Pour les contrats sans backup, le nom court suffit
const CONTRACT_NAMES: Record<keyof typeof PROXIES, string> = {
  GLD:          "GLD",
  Treasury:     "Treasury",
  Exchange:     "contracts/Exchange.sol:Exchange",
  Reserve:      "contracts/Reserve.sol:Reserve",
  LingotOr:     "LingotOr",
  EventLogger:  "EventLogger",
  SerialNumber: "SerialNumber",
};

// ─── Quels contrats upgrader ? (mettre false pour ignorer) ────────────────────
const UPGRADE: Record<keyof typeof PROXIES, boolean> = {
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

async function deployAndVerify(contractKey: keyof typeof PROXIES): Promise<string> {
  const contractName = CONTRACT_NAMES[contractKey];
  let implAddr: string;

  await step("Déploiement nouvelle impl", async () => {
    const factory = await ethersRef.getContractFactory(contractName, deployerRef);
    const impl = await factory.deploy();
    await impl.waitForDeployment();
    implAddr = await impl.getAddress();
    return implAddr;
  });

  await step("Vérification Etherscan", async () => {
    try {
      await run("verify:verify", {
        address: implAddr!,
        constructorArguments: [],
        // contract uniquement si nom qualifié nécessaire
        ...(contractName.includes(":") ? { contract: contractName } : {}),
      });
      return "OK";
    } catch (e: any) {
      if (e.message?.includes("Already Verified") || e.message?.includes("already verified")) {
        return "déjà vérifié";
      }
      return `⚠️  ${e.message}`;
    }
  });

  return implAddr!;
}

// ─── Script principal ─────────────────────────────────────────────────────────
async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  ethersRef   = ethers;
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
    const implAddr = await deployAndVerify("GLD");
    await step("upgradeToAndCall", async () => {
      const proxy = new ethers.Contract(PROXIES.GLD, UUPS_ABI, deployer);
      const tx = await proxy.upgradeToAndCall(implAddr, "0x");
      await tx.wait();
      return "OK";
    });
    console.log();
  }

  // ── Treasury ──────────────────────────────────────────────────────────────
  if (UPGRADE.Treasury) {
    console.log("2. Upgrade Treasury");
    const implAddr = await deployAndVerify("Treasury");
    await step("upgradeToAndCall", async () => {
      const proxy = new ethers.Contract(PROXIES.Treasury, UUPS_ABI, deployer);
      const tx = await proxy.upgradeToAndCall(implAddr, "0x");
      await tx.wait();
      return "OK";
    });
    console.log();
  }

  // ── Reserve (avant Exchange — Reserve est owner d'Exchange) ───────────────
  if (UPGRADE.Reserve) {
    console.log("3. Upgrade Reserve");
    const implAddr = await deployAndVerify("Reserve");
    const owner = await reserve.owner();
    if (owner.toLowerCase() === deployer.address.toLowerCase()) {
      await step("upgradeToAndCall", async () => {
        const tx = await reserve.upgradeToAndCall(implAddr, "0x");
        await tx.wait();
        return "OK";
      });
    } else {
      console.log(`  ⚠️  Reserve est owné par le Safe : ${owner}`);
      console.log(`  ℹ️  → upgradeToAndCall(${implAddr}, 0x) via app.safe.global`);
    }
    console.log();
  }

  // ── Exchange (via Reserve — Reserve est owner d'Exchange) ─────────────────
  if (UPGRADE.Exchange) {
    console.log("4. Upgrade Exchange (via Reserve)");
    const implAddr = await deployAndVerify("Exchange");
    const reserveOwner = await reserve.owner();
    if (reserveOwner.toLowerCase() === deployer.address.toLowerCase()) {
      await step("upgradeExchange (via Reserve)", async () => {
        const tx = await reserve.upgradeExchange(implAddr);
        await tx.wait();
        return "OK";
      });
    } else {
      console.log(`  ⚠️  Reserve est owné par le Safe : ${reserveOwner}`);
      console.log(`  ℹ️  → upgradeExchange(${implAddr}) via app.safe.global`);
    }
    console.log();
  }

  // ── LingotOr ──────────────────────────────────────────────────────────────
  if (UPGRADE.LingotOr) {
    console.log("5. Upgrade LingotOr");
    const implAddr = await deployAndVerify("LingotOr");
    const proxy = new ethers.Contract(PROXIES.LingotOr, UUPS_ABI, deployer);
    const owner = await proxy.owner();
    if (owner.toLowerCase() === deployer.address.toLowerCase()) {
      await step("upgradeToAndCall", async () => {
        const tx = await proxy.upgradeToAndCall(implAddr, "0x");
        await tx.wait();
        return "OK";
      });
    } else {
      console.log(`  ⚠️  LingotOr est owné par le Safe : ${owner}`);
      console.log(`  ℹ️  → upgradeToAndCall(${implAddr}, 0x) via app.safe.global`);
    }
    console.log();
  }

  // ── EventLogger ───────────────────────────────────────────────────────────
  if (UPGRADE.EventLogger) {
    console.log("6. Upgrade EventLogger");
    const implAddr = await deployAndVerify("EventLogger");
    const proxy = new ethers.Contract(PROXIES.EventLogger, UUPS_ABI, deployer);
    const owner = await proxy.owner();
    if (owner.toLowerCase() === deployer.address.toLowerCase()) {
      await step("upgradeToAndCall", async () => {
        const tx = await proxy.upgradeToAndCall(implAddr, "0x");
        await tx.wait();
        return "OK";
      });
    } else {
      console.log(`  ⚠️  EventLogger est owné par le Safe : ${owner}`);
      console.log(`  ℹ️  → upgradeToAndCall(${implAddr}, 0x) via app.safe.global`);
    }
    console.log();
  }

  // ── SerialNumber ──────────────────────────────────────────────────────────
  if (UPGRADE.SerialNumber) {
    console.log("7. Upgrade SerialNumber");
    const implAddr = await deployAndVerify("SerialNumber");
    const proxy = new ethers.Contract(PROXIES.SerialNumber, UUPS_ABI, deployer);
    const owner = await proxy.owner();
    if (owner.toLowerCase() === deployer.address.toLowerCase()) {
      await step("upgradeToAndCall", async () => {
        const tx = await proxy.upgradeToAndCall(implAddr, "0x");
        await tx.wait();
        return "OK";
      });
    } else {
      console.log(`  ⚠️  SerialNumber est owné par le Safe : ${owner}`);
      console.log(`  ℹ️  → upgradeToAndCall(${implAddr}, 0x) via app.safe.global`);
    }
    console.log();
  }

  console.log("═══════════════════════════════════════════════════════");
  console.log("  ✅ Upgrade terminé — adresses proxies inchangées");
  console.log("  ℹ️  Vérifier le storage layout : npx hardhat run scripts/check-storage.ts");
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
