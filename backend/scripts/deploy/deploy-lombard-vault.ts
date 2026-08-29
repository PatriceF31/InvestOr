// scripts/deploy-lombard-vault.ts
//
// Déploie LombardVault (US-01 Marthe, US-13 Farid) sur Sepolia :
//   1. Déploie l'implémentation
//   2. Déploie le proxy (InvestOrProxy) avec initialize()
//   3. Transfère l'ownership à Reserve
//   4. Enregistre LombardVault comme identité VÉRIFIÉE dans IdentityRegistry
//      (PAS comme agent — voir la note en tête de LombardVault.sol) — exécuté
//      directement si le déployeur est déjà agent/owner du registre, sinon
//      affiche les instructions Safe.
//
// Restent, séparément :
//   B. [SAFE] Reserve doit d'abord être upgradée avec les fonctions relais Lombard
//      (voir upgrade-reserve.ts) si ce n'est pas déjà fait.
//   C. [SAFE] Reserve.setLombardVault() puis Reserve.setLombardOperator() —
//      paramètres affichés en fin de script.
//
// Usage :
//   npx hardhat run scripts/deploy-lombard-vault.ts --network sepolia

import { network } from "hardhat";

// ─── Adresses InvestOr existantes ──────────────────────────────────────────
const GLD_ADDRESS              = "0xA4ddCDf84F0C0acC8cA22E77f501d308C4E87dD4";
const USDC_ADDRESS             = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const EXCHANGE_ADDRESS         = "0x69C73469C427A9adbFA9a54E5a7711746A34d508";
const RESERVE_ADDRESS          = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";
// ⚠️ Reprise de mémoire de session, pas revérifiée cette fois-ci — confirme
// avant de lancer, vu qu'on a déjà eu des adresses désynchronisées ce mois-ci.
const IDENTITY_REGISTRY_ADDRESS = "0xE1a54BF8cfEeb58A3343Eeb6d63925AB03c5209C";

async function main() {
  const { ethers } = await network.create();
  const [deployer] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Déploiement LombardVault");
  console.log(`  Wallet : ${deployer.address}`);
  console.log("═══════════════════════════════════════════════════════\n");

  // ── 1. Implémentation ────────────────────────────────────────────────────
  console.log("1/4 — Déploiement de l'implémentation...");
  const impl = await ethers.deployContract("LombardVault");
  await impl.waitForDeployment();
  const implAddress = await impl.getAddress();
  console.log(`     ✅ ${implAddress}`);
  console.log(`     ℹ️  Vérifier : npx hardhat verify --network sepolia --contract contracts/LombardVault.sol:LombardVault ${implAddress}`);
  console.log("");

  // ── 2. Proxy + initialize ────────────────────────────────────────────────
  console.log("2/4 — Déploiement du proxy...");
  const initData = impl.interface.encodeFunctionData("initialize", [
    deployer.address, GLD_ADDRESS, USDC_ADDRESS, EXCHANGE_ADDRESS, deployer.address,
  ]);
  const proxy = await ethers.deployContract("InvestOrProxy", [implAddress, initData]);
  await proxy.waitForDeployment();
  const vaultAddress = await proxy.getAddress();
  const vault = await ethers.getContractAt("LombardVault", vaultAddress);
  console.log(`     ✅ LombardVault (proxy) : ${vaultAddress}`);
  console.log("");

  // ── 3. Transfert d'ownership à Reserve ───────────────────────────────────
  console.log("3/4 — Transfert de l'ownership à Reserve...");
  await (await vault.transferOwnership(RESERVE_ADDRESS)).wait();
  console.log("     ✅ Reserve est désormais owner de LombardVault.");
  console.log("");

  // ── 4. Enregistrement IdentityRegistry (identité vérifiée, PAS agent) ───
  console.log("4/4 — Enregistrement de LombardVault comme identité vérifiée...");
  const identityRegistryAbi = [
    "function registerIdentity(address wallet, bytes32 identityId, uint16 country) external",
    "function owner() view returns (address)",
    "function agents(address) view returns (bool)",
  ];
  const identityRegistry = new ethers.Contract(IDENTITY_REGISTRY_ADDRESS, identityRegistryAbi, deployer);

  const lombardIdentityId = ethers.keccak256(ethers.toUtf8Bytes("InvestOr-LombardVault-v1"));
  const FRANCE_ISO = 250; // placeholder arbitraire — le contrat n'a pas de juridiction réelle,
                          // choisi par cohérence avec la juridiction de référence du projet

  const [registryOwner, isAgent] = await Promise.all([
    identityRegistry.owner(),
    identityRegistry.agents(deployer.address),
  ]);
  const deployerAuthorized = registryOwner.toLowerCase() === deployer.address.toLowerCase() || isAgent;

  if (deployerAuthorized) {
    await (await identityRegistry.registerIdentity(vaultAddress, lombardIdentityId, FRANCE_ISO)).wait();
    console.log("     ✅ LombardVault enregistré comme identité vérifiée.");
  } else {
    console.log("     ⚠️  Le wallet de déploiement n'est ni owner ni agent d'IdentityRegistry.");
    console.log("     ℹ️  Finaliser via app.safe.global (ou via un agent KYC existant) :");
    console.log(`        → Adresse   : ${IDENTITY_REGISTRY_ADDRESS}`);
    console.log(`        → Fonction  : registerIdentity(address wallet, bytes32 identityId, uint16 country)`);
    console.log(`        → wallet    : ${vaultAddress}`);
    console.log(`        → identityId: ${lombardIdentityId}`);
    console.log(`        → country   : ${FRANCE_ISO}`);
  }
  console.log("");

  console.log("=== Récapitulatif ===");
  console.log("LombardVault (proxy) :", vaultAddress);
  console.log("Implémentation       :", implAddress);
  console.log("Paramètres initiaux  : LTV max 70% · liquidation 80% · taux 7%/an (4%+3%) · décote 5%");
  console.log("Operator actuel      :", deployer.address, "(temporaire — à réassigner via Reserve)");
  console.log("");

  console.log("=== À FAIRE VIA LE SAFE ===");
  console.log("B. Vérifier que Reserve a bien été upgradée avec les fonctions relais Lombard");
  console.log("   (setLombardVault, setLombardOperator, etc.) — voir upgrade-reserve.ts.");
  console.log("");
  console.log("C. Transaction 1 :");
  console.log("     Contrat cible : Reserve —", RESERVE_ADDRESS);
  console.log("     Fonction      : setLombardVault(address newVault)");
  console.log("     Paramètre     :", vaultAddress);
  console.log("   Transaction 2 :");
  console.log("     Contrat cible : Reserve —", RESERVE_ADDRESS);
  console.log("     Fonction      : setLombardOperator(address newOperator)");
  console.log("     Paramètre     :", deployer.address, "(ou l'adresse du bot de liquidation si déjà décidée)");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
