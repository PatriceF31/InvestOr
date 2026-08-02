/**
 * @file scripts/deploy-compliance.ts
 * @description Déploiement du système de conformité MiCA (ERC-3643 inspiré)
 *
 * Ce script déploie :
 *   1. IdentityRegistry  — registre KYC wallet → identité + pays
 *   2. CountryComplianceModule — module conformité pays + agents
 *   3. Configure les agents, pays autorisés, mode strict
 *   4. Branche le module sur GLD via setComplianceModule()
 *
 * Prérequis :
 *   - GLD proxy déjà déployé et upgradé vers V2
 *   - Owner = Safe (ou wallet deployer sur testnet)
 *
 * Usage :
 *   npx hardhat run scripts/deploy-compliance.ts --network sepolia
 */

import hre, { network } from "hardhat";



// Helper : attendre N secondes (Etherscan a besoin de temps pour indexer)// ─── Adresses existantes (proxies permanents) ─────────────────────────────────
const GLD_PROXY     = "0xA4ddCDf84F0C0acC8cA22E77f501d308C4E87dD4";
const EXCHANGE_PROXY = "0x69C73469C427A9adbFA9a54E5a7711746A34d508";
const RESERVE_PROXY  = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";

// ─── Pays autorisés (codes ISO-3166) ─────────────────────────────────────────
// Phase 1 : Europe (marché cible initial)
// À étendre avec l'Asie/Afrique via allowCountry() après déploiement
// 27 États membres de l'Union Européenne — tous couverts par MiCA
// Règlement (UE) 2023/1114 applicable depuis juin 2024
// Note : Suisse (756) NON incluse — régime FINMA distinct, à ajouter manuellement si nécessaire
const ALLOWED_COUNTRIES: number[] = [
  40,   // Autriche
  56,   // Belgique
  100,  // Bulgarie
  196,  // Chypre
  191,  // Croatie
  203,  // Tchéquie
  208,  // Danemark
  233,  // Estonie
  246,  // Finlande
  250,  // France
  276,  // Allemagne
  300,  // Grèce
  348,  // Hongrie
  372,  // Irlande
  380,  // Italie
  428,  // Lettonie
  440,  // Lituanie
  442,  // Luxembourg
  470,  // Malte
  528,  // Pays-Bas
  616,  // Pologne
  620,  // Portugal
  642,  // Roumanie
  703,  // Slovaquie
  705,  // Slovénie
  724,  // Espagne
  752,  // Suède
];

// ─── Mode strict ──────────────────────────────────────────────────────────────
// false = permissif (testnet — tout passe, KYC non requis)
// true  = strict    (production — KYC + pays requis)
const STRICT_MODE = false;

// ─── ABIs minimaux ────────────────────────────────────────────────────────────
const GLD_ABI = [
  "function setComplianceModule(address newModule) external",
  "function complianceModule() view returns (address)",
  "function owner() view returns (address)",
];

const UUPS_ABI = [
  "function upgradeToAndCall(address, bytes) external",
  "function owner() view returns (address)",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function deployProxy(
  ethers: any,
  deployer: any,
  contractName: string,
  initData: string,
  label: string
): Promise<string> {
  process.stdout.write(`  Déploiement impl ${label}... `);
  const factory  = await ethers.getContractFactory(contractName, deployer);
  const impl     = await factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`✅  ${implAddr}`);

  // Commande CLI pour vérifier manuellement après le déploiement
  console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract <FQN> ${implAddr}`);

  process.stdout.write(`  Déploiement proxy ${label}... `);
  const ProxyFactory = await ethers.getContractFactory("InvestOrProxy", deployer);
  const proxy = await ProxyFactory.deploy(implAddr, initData);
  await proxy.waitForDeployment();
  const proxyAddr = await proxy.getAddress();
  console.log(`✅  ${proxyAddr}`);

  return proxyAddr;
}

// ─── Script principal ─────────────────────────────────────────────────────────

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  InvestOr V2 — Déploiement Conformité MiCA (ERC-3643)");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Wallet         : ${deployer.address}`);
  console.log(`  Réseau         : ${(await ethers.provider.getNetwork()).name}`);
  console.log(`  GLD proxy      : ${GLD_PROXY}`);
  console.log(`  Exchange proxy : ${EXCHANGE_PROXY}`);
  console.log(`  Mode strict    : ${STRICT_MODE}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ── 1. Déployer IdentityRegistry ─────────────────────────────────────────
  console.log("1. IdentityRegistry");
  const registryImpl = await (await ethers.getContractFactory("IdentityRegistry", deployer)).deploy();
  await registryImpl.waitForDeployment();
  const registryImplAddr = await registryImpl.getAddress();

  process.stdout.write(`  Déploiement impl... `);
  console.log(`✅  ${registryImplAddr}`);

  console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract contracts/IdentityRegistry.sol:IdentityRegistry ${registryImplAddr}`);

  process.stdout.write(`  Déploiement proxy... `);
  const ProxyFactory = await ethers.getContractFactory("InvestOrProxy", deployer);
  const registryInitData = registryImpl.interface.encodeFunctionData("initialize", [deployer.address]);
  const registryProxy    = await ProxyFactory.deploy(registryImplAddr, registryInitData);
  await registryProxy.waitForDeployment();
  const REGISTRY_PROXY = await registryProxy.getAddress();
  console.log(`✅  ${REGISTRY_PROXY}`);

  const registry = await ethers.getContractAt("IdentityRegistry", REGISTRY_PROXY, deployer);
  console.log();

  // ── 2. Déployer CountryComplianceModule ──────────────────────────────────
  console.log("2. CountryComplianceModule");
  const moduleImpl = await (await ethers.getContractFactory("CountryComplianceModule", deployer)).deploy();
  await moduleImpl.waitForDeployment();
  const moduleImplAddr = await moduleImpl.getAddress();

  process.stdout.write(`  Déploiement impl... `);
  console.log(`✅  ${moduleImplAddr}`);

  console.log(`  ℹ️  Vérifier : npx hardhat verify --network sepolia --build-profile default --contract contracts/CountryComplianceModule.sol:CountryComplianceModule ${moduleImplAddr}`);

  process.stdout.write(`  Déploiement proxy... `);
  const moduleInitData = moduleImpl.interface.encodeFunctionData("initialize", [
    deployer.address,
    REGISTRY_PROXY,
    STRICT_MODE,
  ]);
  const moduleProxy = await ProxyFactory.deploy(moduleImplAddr, moduleInitData);
  await moduleProxy.waitForDeployment();
  const MODULE_PROXY = await moduleProxy.getAddress();
  console.log(`✅  ${MODULE_PROXY}`);

  const module_ = await ethers.getContractAt("CountryComplianceModule", MODULE_PROXY, deployer);
  console.log();

  // ── 3. Configurer les pays autorisés ─────────────────────────────────────
  console.log("3. Configuration des pays autorisés");
  process.stdout.write(`  allowCountries(${ALLOWED_COUNTRIES.length} pays)... `);
  const tx1 = await module_.allowCountries(ALLOWED_COUNTRIES);
  await tx1.wait();
  console.log("✅");
  console.log(`  Pays : 27 États membres UE (MiCA) — AT BE BG CY HR CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE`);
  console.log();

  // ── 4. Configurer les agents ──────────────────────────────────────────────
  console.log("4. Configuration des agents (exemptés de conformité)");

  process.stdout.write(`  addAgent(Exchange)... `);
  const tx2 = await module_.addAgent(EXCHANGE_PROXY);
  await tx2.wait();
  console.log(`✅  ${EXCHANGE_PROXY}`);

  process.stdout.write(`  addAgent(Reserve)... `);
  const tx3 = await module_.addAgent(RESERVE_PROXY);
  await tx3.wait();
  console.log(`✅  ${RESERVE_PROXY}`);

  process.stdout.write(`  addAgent(deployer)... `);
  const tx4 = await module_.addAgent(deployer.address);
  await tx4.wait();
  console.log(`✅  ${deployer.address}`);
  console.log();

  // ── 5. Brancher le module sur GLD ─────────────────────────────────────────
  console.log("5. Branchement du module sur GLD");
  const gld      = new ethers.Contract(GLD_PROXY, GLD_ABI, deployer);
  const gldOwner = await gld.owner();

  if (gldOwner.toLowerCase() === deployer.address.toLowerCase()) {
    process.stdout.write(`  setComplianceModule(${MODULE_PROXY})... `);
    const tx5 = await gld.setComplianceModule(MODULE_PROXY);
    await tx5.wait();
    console.log("✅");
  } else {
    console.log(`  ⚠️  GLD est owné par le Safe : ${gldOwner}`);
    console.log("  ℹ️  Finaliser via app.safe.global :");
    console.log(`     → Adresse  : ${GLD_PROXY}`);
    console.log(`     → Fonction : setComplianceModule`);
    console.log(`     → argument : ${MODULE_PROXY}`);
  }
  console.log();

  // ── Récapitulatif ─────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ✅ Déploiement conformité terminé");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  IdentityRegistry proxy      : ${REGISTRY_PROXY}`);
  console.log(`  CountryComplianceModule proxy: ${MODULE_PROXY}`);
  console.log(`  GLD complianceModule         : ${MODULE_PROXY}`);
  console.log(`  Mode strict                  : ${STRICT_MODE}`);
  console.log("");
  console.log("  Prochaines étapes :");
  console.log("  → Enregistrer les identités KYC via registry.registerBatch()");
  if (!STRICT_MODE) {
    console.log("  → Activer le mode strict : module_.setStrictMode(true)");
  }
  console.log("  → Ajouter Asie/Afrique : module_.allowCountry(392) // Japon");
  console.log("  → Mettre à jour Contrat_v2.png avec les nouvelles adresses");
  console.log("═══════════════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
