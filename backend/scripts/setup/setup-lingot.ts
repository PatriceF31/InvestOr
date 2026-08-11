/**
 * @file setup-lingot.ts
 * @description Configuration des rôles pour LingotOr
 *
 * Usage :
 *   npx hardhat run scripts/setup-lingot.ts --network sepolia
 */

import { network } from "hardhat";

// ─── Adresses ────────────────────────────────────────────────────────────────
const ADDRESSES = {
  LingotOr:     "0x69159BBd5EaFf05C381497890F02d78F1b595A83", // proxy
  SerialNumber: "0x24622EfA10CfBA2B6F0e2845a89B09711293867d", // proxy
  Safe:         "0x7f7533Ea6aA203d07eBB6F06aE1a8A4AD0B33917",
  // Wallet de test pour le rôle MINTER (gardien)
  // Utilise ton second wallet ou le déployeur pour les tests (Account Minter IO)
  TestMinter:   "0x2EFb38F905058eCc289dc6E08Ab2dCd163B9F032", // déployeur = gardien pour les tests
};

// ─── ABIs ────────────────────────────────────────────────────────────────────
const LINGOT_ABI = [
  "function grantRole(bytes32 role, address account) external",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function MINTER_ROLE() view returns (bytes32)",
  "function VALIDATOR_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function owner() view returns (address)",
];

const SERIAL_ABI = [
  "function authorizeIssuer(address issuer) external",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function owner() view returns (address)",
];

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

async function main() {
  const { ethers } = await network.create();
  const [deployer, minter] = await ethers.getSigners();
  // deployer = 0x7ad603... (wallet principal)
  // minter   = 0x2EFb38... (wallet gardien)

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Configuration rôles LingotOr");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Wallet déployeur : ${deployer.address}`);
  console.log(`  LingotOr proxy   : ${ADDRESSES.LingotOr}`);
  console.log(`  Safe (validator) : ${ADDRESSES.Safe}`);
  console.log(`  Test minter      : ${ADDRESSES.TestMinter}`);
  console.log("═══════════════════════════════════════════════════════\n");

  const lingotOr     = new ethers.Contract(ADDRESSES.LingotOr,     LINGOT_ABI, deployer);
  const serialNumber = new ethers.Contract(ADDRESSES.SerialNumber,  SERIAL_ABI, deployer);

  // Récupérer les bytes32 des rôles
  const MINTER_ROLE    = await lingotOr.MINTER_ROLE();
  const VALIDATOR_ROLE = await lingotOr.VALIDATOR_ROLE();

  console.log("État actuel :");
  console.log(`  Owner LingotOr      : ${await lingotOr.owner()}`);
  console.log(`  Owner SerialNumber  : ${await serialNumber.owner()}`);
  console.log();

  // ── 1. Accorder MINTER_ROLE au gardien de test ──────────────────────────
  console.log("1. Rôles LingotOr");
  await step(`grantRole(MINTER_ROLE → ${ADDRESSES.TestMinter.slice(0,10)}...)`, async () => {
    const alreadyMinter = await lingotOr.hasRole(MINTER_ROLE, ADDRESSES.TestMinter);
    if (alreadyMinter) { console.log("déjà accordé"); return; }
    const tx = await lingotOr.grantRole(MINTER_ROLE, ADDRESSES.TestMinter);
    await tx.wait();
  });

  await step(`grantRole(VALIDATOR_ROLE → Safe)`, async () => {
    const alreadyValidator = await lingotOr.hasRole(VALIDATOR_ROLE, ADDRESSES.Safe);
    if (alreadyValidator) { console.log("déjà accordé"); return; }
    const tx = await lingotOr.grantRole(VALIDATOR_ROLE, ADDRESSES.Safe);
    await tx.wait();
  });

  // ── 2. Autoriser LingotOr comme issuer dans SerialNumber ────────────────
  console.log("\n2. SerialNumber — autoriser LingotOr comme issuer");
  await step(`authorizeIssuer(LingotOr)`, async () => {
    const tx = await serialNumber.authorizeIssuer(ADDRESSES.LingotOr);
    await tx.wait();
  });

  // ── Vérifications finales ───────────────────────────────────────────────
  console.log("\nVérifications finales :");
  const checks = [
    {
      label: "LingotOr — TestMinter a MINTER_ROLE",
      ok: await lingotOr.hasRole(MINTER_ROLE, ADDRESSES.TestMinter),
    },
    {
      label: "LingotOr — Safe a VALIDATOR_ROLE",
      ok: await lingotOr.hasRole(VALIDATOR_ROLE, ADDRESSES.Safe),
    },
  ];

  let allOk = true;
  for (const check of checks) {
    console.log(`  ${check.ok ? "✅" : "❌"} ${check.label}`);
    if (!check.ok) allOk = false;
  }

  console.log("\n═══════════════════════════════════════════════════════");
  if (allOk) {
    console.log("  ✅ LingotOr configuré — prêt pour les tests");
    console.log("  ℹ️  Flux test :");
    console.log("     1. deployer.proposeMint(...)");
    console.log("     2. Safe.approveMint(...) via app.safe.global");
  } else {
    console.log("  ❌ Certaines configurations ont échoué");
    process.exit(1);
  }
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});