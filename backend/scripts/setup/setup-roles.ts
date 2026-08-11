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
 *   - Tous les contrats déployés
 *   - Wallet déployeur configuré dans .env (SEPOLIA_PRIVATE_KEY)
 *   - Mettre à jour les adresses ci-dessous si nécessaire
 */

import { network } from "hardhat";

// ─── Adresses des contrats ────────────────────────────────────────────────────
const ADDRESSES = {
  GLD:           "0xA4ddCDf84F0C0acC8cA22E77f501d308C4E87dD4",
  Treasury:      "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af",
  Exchange:      "0x69C73469C427A9adbFA9a54E5a7711746A34d508",
  Reserve:       "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce",
  LingotOr:      "0x69159BBd5EaFf05C381497890F02d78F1b595A83",
  SerialNumber:  "0x24622EfA10CfBA2B6F0e2845a89B09711293867d",
  ReserveKeeper: "0x0F1F52138c93162538B61e80bEDfCd180e6fa5a1",
  Safe:          "0x7f7533Ea6aA203d07eBB6F06aE1a8A4AD0B33917",
  TestMinter:    "0x2EFb38F905058eCc289dc6E08Ab2dCd163B9F032",
};

// ─── Configuration ────────────────────────────────────────────────────────────
const CONFIG = {
  FALLBACK_PRICE: 14_750_000_000n, // $147.50/g en 8 décimales
  ORACLE_ADDRESS: "0x0000000000000000000000000000000000000000",
  FEE_BPS:        100n,
};

// ─── Rôles LingotOr ───────────────────────────────────────────────────────────
const MINTER_ROLE    = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";
const VALIDATOR_ROLE = "0x21702c8af46127c7fa207f89d0b0a8441bb32959a0ac7df790e9ab1a25c98926";

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
  "function setLingotOr(address) external",
  "function exchange() view returns (address)",
  "function treasury() view returns (address)",
  "function lingotOr() view returns (address)",
];

const LINGOT_ABI = [
  "function grantRole(bytes32, address) external",
  "function hasRole(bytes32, address) view returns (bool)",
  "function owner() view returns (address)",
];

const SERIAL_ABI = [
  "function authorizeIssuer(address) external",
  "function owner() view returns (address)",
];

const KEEPER_ABI = [
  "function transferOwnership(address) external",
  "function owner() view returns (address)",
  "function reserve() view returns (address)",
  "function checkInterval() view returns (uint256)",
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
  console.log("  InvestOr V2 — Configuration des rôles post-déploiement");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Wallet déployeur : ${deployer.address}`);
  console.log(`  Réseau           : ${(await ethers.provider.getNetwork()).name}`);
  console.log("───────────────────────────────────────────────────────");
  Object.entries(ADDRESSES).forEach(([k, v]) => console.log(`    ${k.padEnd(14)}: ${v}`));
  console.log("═══════════════════════════════════════════════════════\n");

  // Instanciation
  const gld           = new ethers.Contract(ADDRESSES.GLD,           GLD_ABI,      deployer);
  const treasury      = new ethers.Contract(ADDRESSES.Treasury,      TREASURY_ABI, deployer);
  const exchange      = new ethers.Contract(ADDRESSES.Exchange,      EXCHANGE_ABI, deployer);
  const reserve       = new ethers.Contract(ADDRESSES.Reserve,       RESERVE_ABI,  deployer);
  const lingotOr      = new ethers.Contract(ADDRESSES.LingotOr,      LINGOT_ABI,   deployer);
  const serialNumber  = new ethers.Contract(ADDRESSES.SerialNumber,  SERIAL_ABI,   deployer);
  const keeper        = new ethers.Contract(ADDRESSES.ReserveKeeper, KEEPER_ABI,   deployer);

  // ── 1. GLD ──────────────────────────────────────────────────────────────────
  console.log("1. GLD Token");
  await step("setMinter(Exchange)", async () => {
    const tx = await gld.setMinter(ADDRESSES.Exchange);
    await tx.wait();
  });

  // ── 2. Treasury ─────────────────────────────────────────────────────────────
  console.log("\n2. Treasury");
  await step("setOperator(Exchange)", async () => {
    const tx = await treasury.setOperator(ADDRESSES.Exchange);
    await tx.wait();
  });
  await step("setReserve(Reserve)", async () => {
    const tx = await treasury.setReserve(ADDRESSES.Reserve);
    await tx.wait();
  });

  // ── 3. Exchange ─────────────────────────────────────────────────────────────
  console.log("\n3. Exchange");
  await step("transferOwnership(Reserve)", async () => {
    const tx = await exchange.transferOwnership(ADDRESSES.Reserve);
    await tx.wait();
  });

  // ── 4. Reserve ──────────────────────────────────────────────────────────────
  console.log("\n4. Reserve");
  await step(`setExchangeFallbackPrice(${CONFIG.FALLBACK_PRICE})`, async () => {
    const tx = await reserve.setExchangeFallbackPrice(CONFIG.FALLBACK_PRICE);
    await tx.wait();
  });
  await step(`setExchangeOracle(${short(CONFIG.ORACLE_ADDRESS)})`, async () => {
    const tx = await reserve.setExchangeOracle(CONFIG.ORACLE_ADDRESS);
    await tx.wait();
  });
  await step("setLingotOr(LingotOr)", async () => {
    const tx = await reserve.setLingotOr(ADDRESSES.LingotOr);
    await tx.wait();
  });

  // ── 5. LingotOr ─────────────────────────────────────────────────────────────
  console.log("\n5. LingotOr");
  await step(`grantRole(MINTER_ROLE → TestMinter)`, async () => {
    const already = await lingotOr.hasRole(MINTER_ROLE, ADDRESSES.TestMinter);
    if (already) { process.stdout.write("déjà accordé "); return; }
    const tx = await lingotOr.grantRole(MINTER_ROLE, ADDRESSES.TestMinter);
    await tx.wait();
  });
  await step(`grantRole(VALIDATOR_ROLE → Safe)`, async () => {
    const already = await lingotOr.hasRole(VALIDATOR_ROLE, ADDRESSES.Safe);
    if (already) { process.stdout.write("déjà accordé "); return; }
    const tx = await lingotOr.grantRole(VALIDATOR_ROLE, ADDRESSES.Safe);
    await tx.wait();
  });

  // ── 6. SerialNumber ─────────────────────────────────────────────────────────
  console.log("\n6. SerialNumber");
  await step("authorizeIssuer(LingotOr)", async () => {
    const tx = await serialNumber.authorizeIssuer(ADDRESSES.LingotOr);
    await tx.wait();
  });

  // ── 7. ReserveKeeper ────────────────────────────────────────────────────────
  console.log("\n7. ReserveKeeper");
  await step("transferOwnership(Safe)", async () => {
    const currentOwner = await keeper.owner();
    if (currentOwner.toLowerCase() === ADDRESSES.Safe.toLowerCase()) {
      process.stdout.write("déjà Safe ");
      return;
    }
    const tx = await keeper.transferOwnership(ADDRESSES.Safe);
    await tx.wait();
  });

  // ── Vérifications finales ───────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  Vérifications finales");
  console.log("═══════════════════════════════════════════════════════");

  const minter      = await gld.minter();
  const operator    = await treasury.operator();
  const reserveAddr = await treasury.reserve();
  const exchOwner   = await exchange.owner();
  const exchFee     = await exchange.feeBps();
  const resExchange = await reserve.exchange();
  const resTreasury = await reserve.treasury();
  const resLingotOr = await reserve.lingotOr();
  const keeperOwner = await keeper.owner();
  const isMinter    = await lingotOr.hasRole(MINTER_ROLE, ADDRESSES.TestMinter);
  const isValidator = await lingotOr.hasRole(VALIDATOR_ROLE, ADDRESSES.Safe);

  const checks = [
    { label: "GLD.minter        == Exchange",   ok: minter.toLowerCase()      === ADDRESSES.Exchange.toLowerCase() },
    { label: "Treasury.operator == Exchange",   ok: operator.toLowerCase()    === ADDRESSES.Exchange.toLowerCase() },
    { label: "Treasury.reserve  == Reserve",    ok: reserveAddr.toLowerCase() === ADDRESSES.Reserve.toLowerCase() },
    { label: "Exchange.owner    == Reserve",    ok: exchOwner.toLowerCase()   === ADDRESSES.Reserve.toLowerCase() },
    { label: "Reserve.exchange  == Exchange",   ok: resExchange.toLowerCase() === ADDRESSES.Exchange.toLowerCase() },
    { label: "Reserve.treasury  == Treasury",   ok: resTreasury.toLowerCase() === ADDRESSES.Treasury.toLowerCase() },
    { label: "Reserve.lingotOr  == LingotOr",   ok: resLingotOr.toLowerCase() === ADDRESSES.LingotOr.toLowerCase() },
    { label: "LingotOr MINTER   == TestMinter", ok: isMinter },
    { label: "LingotOr VALIDATOR== Safe",       ok: isValidator },
    { label: "Keeper.owner      == Safe",       ok: keeperOwner.toLowerCase() === ADDRESSES.Safe.toLowerCase() },
  ];

  let allOk = true;
  for (const check of checks) {
    console.log(`  ${check.ok ? "✅" : "❌"} ${check.label}`);
    if (!check.ok) allOk = false;
  }

  console.log(`\n  Exchange.feeBps : ${exchFee} bps (${Number(exchFee) / 100}%)`);
  console.log(`  Keeper.interval : 3600s`);
  console.log("═══════════════════════════════════════════════════════");

  if (allOk) {
    console.log("  ✅ Configuration V2 complète !\n");
  } else {
    console.log("  ❌ Certains rôles sont incorrects\n");
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
