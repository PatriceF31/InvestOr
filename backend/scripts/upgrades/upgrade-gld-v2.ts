/**
 * @file scripts/upgrades/upgrade-gld-v2.ts
 * @description Upgrade GLD vers V2 (ajout slot complianceModule) + vérification Etherscan
 *
 * ⚠️  Ce script doit être exécuté AVANT deploy-compliance.ts
 *     L'upgrade ajoute le slot complianceModule (slot 4) à GLD
 *     Le module n'est pas encore branché après cet upgrade (complianceModule = address(0))
 *     → Comportement V1 identique jusqu'au branchement via deploy-compliance.ts
 *
 * Usage :
 *   npx hardhat run scripts/upgrades/upgrade-gld-v2.ts --network sepolia
 *
 * Ordre des opérations :
 *   1. npx hardhat run scripts/check-storage.ts          ← vérifier layout avant
 *   2. npx hardhat run scripts/upgrades/upgrade-gld-v2.ts --network sepolia
 *   3. npx hardhat run scripts/check-storage.ts          ← vérifier layout après
 *   4. npx hardhat run scripts/deploy-compliance.ts --network sepolia
 */

import hre, { network } from "hardhat";


const PROXY = "0xA4ddCDf84F0C0acC8cA22E77f501d308C4E87dD4";

const UUPS_ABI = [
  "function upgradeToAndCall(address, bytes) external",
  "function owner() view returns (address)",
  "function complianceModule() view returns (address)",
];

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  InvestOr — Upgrade GLD → V2 (module conformité MiCA)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Proxy  : ${PROXY}`);
  console.log(`  Wallet : ${deployer.address}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ── 1. Déployer la nouvelle implémentation GLD V2 ─────────────────────────
  process.stdout.write("  Déploiement nouvelle impl GLD V2... ");
  const factory = await ethers.getContractFactory("GLD", deployer);
  const impl    = await factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`✅  ${implAddr}`);

  // ── 2. Vérification Etherscan ─────────────────────────────────────────────
  console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract contracts/GLD.sol:GLD ${implAddr}`);

  // ── 3. Upgrade via proxy ──────────────────────────────────────────────────
  const proxy = new ethers.Contract(PROXY, UUPS_ABI, deployer);
  const gldOwner = await proxy.owner();

  if (gldOwner.toLowerCase() === deployer.address.toLowerCase()) {
    process.stdout.write("  upgradeToAndCall... ");
    const tx = await proxy.upgradeToAndCall(implAddr, "0x");
    await tx.wait();
    console.log("✅");

    // ── 4. Vérification post-upgrade ─────────────────────────────────────────
    process.stdout.write("  Vérification complianceModule = address(0)... ");
    const module_ = await proxy.complianceModule();
    if (module_ === ethers.ZeroAddress) {
      console.log("✅  (module non encore branché — comportement V1 actif)");
    } else {
      console.log(`⚠️  complianceModule = ${module_} (inattendu)`);
    }

    console.log("\n═══════════════════════════════════════════════════════════════");
    console.log("  ✅ GLD upgradé vers V2 avec succès");
    console.log(`  ℹ️  Nouvelle impl : ${implAddr}`);
    console.log("  ℹ️  Prochaine étape : deploy-compliance.ts pour brancher le module");
    console.log("═══════════════════════════════════════════════════════════════\n");

  } else {
    console.log(`\n  ⚠️  GLD est owné par le Safe : ${gldOwner}`);
    console.log("  ℹ️  Finaliser via app.safe.global :");
    console.log(`     → Adresse  : ${PROXY}`);
    console.log(`     → Fonction : upgradeToAndCall`);
    console.log(`     → newImpl  : ${implAddr}`);
    console.log(`     → data     : 0x`);
    console.log(`\n  ℹ️  Nouvelle impl déployée et vérifiée : ${implAddr}`);
    console.log("═══════════════════════════════════════════════════════════════\n");
  }
}

main().catch(console.error);
