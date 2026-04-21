/**
 * @file setup-roles.ts
 * @description Script de configuration des rôles post-déploiement InvestOr
 *
 * Ce script doit être exécuté UNE SEULE FOIS après le déploiement de tous les contrats.
 * Il configure les autorisations entre les contrats selon l'architecture InvestOr.
 *
 * Usage :
 *   npx hardhat run scripts/setup-roles.ts --network sepolia
 *
 * Prérequis :
 *   - Tous les contrats déployés (GLD, Treasury, Exchange, Reserve)
 *   - Wallet déployeur configuré dans .env (SEPOLIA_PRIVATE_KEY)
 *   - Mettre à jour les adresses ci-dessous si nécessaire
 */

import { network } from "hardhat";

// ─── Adresses des contrats (proxies) ──────────────────────────────────────────
const ADDRESSES = {
  GLD:      "0xA4ddCDf84F0C0acC8cA22E77f501d308C4E87dD4",
  Treasury: "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af",
  Exchange: "0x69C73469C427A9adbFA9a54E5a7711746A34d508",
  Reserve:  "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce",
};

// ─── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  // Prix fallback : $147.50/gramme en 8 décimales (format Chainlink)
  // Calcul : 147.50 * 1e8 = 14750000000
  FALLBACK_PRICE: 14_750_000_000n,

  // Oracle Chainlink XAU/USD Sepolia
  // Mettre address(0) pour désactiver (prix figé sur Sepolia)
  ORACLE_ADDRESS: "0x0000000000000000000000000000000000000000",

  // Frais d'échange en basis points (100 = 1%, 50 = 0.5%, 0 = gratuit)
  FEE_BPS: 100n,
};

// ─── ABIs minimaux ────────────────────────────────────────────────────────────
const GLD_ABI = [
  "function setMinter(address) external",
  "function minter() view returns (address)",
  "function owner() view returns (address)",
];

const TREASURY_ABI = [
  "function setOperator(address) external",
  "function setReserve(address) external",
  "function operator() view returns (address)",
  "function reserve() view returns (address)",
];

const EXCHANGE_ABI = [
  "function transferOwnership(address) external",
  "function owner() view returns (address)",
  "function treasury() view returns (address)",
  "function feeBps() view returns (uint256)",
];

const RESERVE_ABI = [
  "function setExchangeOracle(address) external",
  "function setExchangeFallbackPrice(uint256) external",
  "function exchange() view returns (address)",
  "function treasury() view returns (address)",
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function short(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

async function step(label: string, fn: () => Promise<void>) {
  process.stdout.write(`  ${label}... `);
  try {
    await fn();
    console.log("✅");
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
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Configuration des rôles post-déploiement");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Wallet déployeur : ${deployer.address}`);
  console.log(`  Réseau           : ${(await ethers.provider.getNetwork()).name}`);
  console.log("───────────────────────────────────────────────────────");
  console.log("  Adresses des contrats :");
  console.log(`    GLD      : ${ADDRESSES.GLD}`);
  console.log(`    Treasury : ${ADDRESSES.Treasury}`);
  console.log(`    Exchange : ${ADDRESSES.Exchange}`);
  console.log(`    Reserve  : ${ADDRESSES.Reserve}`);
  console.log("═══════════════════════════════════════════════════════\n");

  // Instanciation des contrats
  const gld      = new ethers.Contract(ADDRESSES.GLD,      GLD_ABI,      deployer);
  const treasury = new ethers.Contract(ADDRESSES.Treasury, TREASURY_ABI, deployer);
  const exchange = new ethers.Contract(ADDRESSES.Exchange, EXCHANGE_ABI, deployer);
  const reserve  = new ethers.Contract(ADDRESSES.Reserve,  RESERVE_ABI,  deployer);

  // ── Étape 1 : GLD ───────────────────────────────────────────────────────────
  console.log("1. GLD Token");
  await step("setMinter(Exchange)", async () => {
    const tx = await gld.setMinter(ADDRESSES.Exchange);
    await tx.wait();
  });

  // ── Étape 2 : Treasury ──────────────────────────────────────────────────────
  console.log("\n2. Treasury");
  await step("setOperator(Exchange)", async () => {
    const tx = await treasury.setOperator(ADDRESSES.Exchange);
    await tx.wait();
  });
  await step("setReserve(Reserve)", async () => {
    const tx = await treasury.setReserve(ADDRESSES.Reserve);
    await tx.wait();
  });

  // ── Étape 3 : Exchange ──────────────────────────────────────────────────────
  console.log("\n3. Exchange");
  await step("transferOwnership(Reserve)", async () => {
    const tx = await exchange.transferOwnership(ADDRESSES.Reserve);
    await tx.wait();
  });

  // ── Étape 4 : Reserve ───────────────────────────────────────────────────────
  console.log("\n4. Reserve");
  await step(`setExchangeFallbackPrice(${CONFIG.FALLBACK_PRICE})`, async () => {
    const tx = await reserve.setExchangeFallbackPrice(CONFIG.FALLBACK_PRICE);
    await tx.wait();
  });
  await step(`setExchangeOracle(${short(CONFIG.ORACLE_ADDRESS)})`, async () => {
    const tx = await reserve.setExchangeOracle(CONFIG.ORACLE_ADDRESS);
    await tx.wait();
  });

  // ── Vérifications finales ───────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Vérifications finales");
  console.log("═══════════════════════════════════════════════════════");

  const minter       = await gld.minter();
  const operator     = await treasury.operator();
  const reserveAddr  = await treasury.reserve();
  const exchOwner    = await exchange.owner();
  const exchTreasury = await exchange.treasury();
  const exchFeeBps   = await exchange.feeBps();
  const resExchange  = await reserve.exchange();
  const resTreasury  = await reserve.treasury();

  const checks = [
    { label: "GLD.minter      == Exchange", ok: minter.toLowerCase()      === ADDRESSES.Exchange.toLowerCase() },
    { label: "Treasury.operator == Exchange", ok: operator.toLowerCase()   === ADDRESSES.Exchange.toLowerCase() },
    { label: "Treasury.reserve  == Reserve",  ok: reserveAddr.toLowerCase() === ADDRESSES.Reserve.toLowerCase() },
    { label: "Exchange.owner   == Reserve",   ok: exchOwner.toLowerCase()  === ADDRESSES.Reserve.toLowerCase() },
    { label: "Exchange.treasury == Treasury", ok: exchTreasury.toLowerCase() === ADDRESSES.Treasury.toLowerCase() },
    { label: "Reserve.exchange == Exchange",  ok: resExchange.toLowerCase() === ADDRESSES.Exchange.toLowerCase() },
    { label: "Reserve.treasury == Treasury", ok: resTreasury.toLowerCase() === ADDRESSES.Treasury.toLowerCase() },
  ];

  let allOk = true;
  for (const check of checks) {
    const icon = check.ok ? "✅" : "❌";
    console.log(`  ${icon} ${check.label}`);
    if (!check.ok) allOk = false;
  }

  console.log(`\n  Exchange.feeBps  : ${exchFeeBps} bps (${Number(exchFeeBps) / 100}%)`);
  console.log("═══════════════════════════════════════════════════════");

  if (allOk) {
    console.log("  ✅ Configuration complète — tous les rôles sont corrects !\n");
  } else {
    console.log("  ❌ Certains rôles sont incorrects — vérifier les erreurs ci-dessus\n");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
