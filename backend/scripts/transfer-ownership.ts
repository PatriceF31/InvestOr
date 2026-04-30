/**
 * @file transfer-ownership.ts
 * @description Transfert de l'ownership des contrats vers le Gnosis Safe
 * 
 * Usage :
 *   npx hardhat run scripts/transfer-ownership.ts --network sepolia
 */

import { network } from "hardhat";

const SAFE_ADDRESS = "0x7f7533Ea6aA203d07eBB6F06aE1a8A4AD0B33917";

const ADDRESSES = {
  GLD:      "0xA4ddCDf84F0C0acC8cA22E77f501d308C4E87dD4",
  Treasury: "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af",
  Reserve:  "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce",
  // Exchange est owné par Reserve — pas de transfert direct
};

const OWNABLE_ABI = [
  "function owner() view returns (address)",
  "function transferOwnership(address) external",
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
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();
  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Transfert ownership vers Gnosis Safe");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Wallet déployeur : ${deployer.address}`);
  console.log(`  Safe cible       : ${SAFE_ADDRESS}`);
  console.log("═══════════════════════════════════════════════════════\n");

  const gld      = new ethers.Contract(ADDRESSES.GLD,      OWNABLE_ABI, deployer);
  const treasury = new ethers.Contract(ADDRESSES.Treasury, OWNABLE_ABI, deployer);
  const reserve  = new ethers.Contract(ADDRESSES.Reserve,  OWNABLE_ABI, deployer);

  // Vérifications avant transfert
  console.log("Owners actuels :");
  console.log(`  GLD      : ${await gld.owner()}`);
  console.log(`  Treasury : ${await treasury.owner()}`);
  console.log(`  Reserve  : ${await reserve.owner()}`);
  console.log();

  // Transferts
  console.log("Transferts en cours :");
  await step("GLD.transferOwnership(Safe)", async () => {
    const tx = await gld.transferOwnership(SAFE_ADDRESS);
    await tx.wait();
  });
  await step("Treasury.transferOwnership(Safe)", async () => {
    const tx = await treasury.transferOwnership(SAFE_ADDRESS);
    await tx.wait();
  });
  await step("Reserve.transferOwnership(Safe)", async () => {
    const tx = await reserve.transferOwnership(SAFE_ADDRESS);
    await tx.wait();
  });

  // Vérifications après transfert
  console.log("\nVérifications finales :");
  const checks = [
    { label: "GLD.owner     == Safe", ok: (await gld.owner()).toLowerCase()      === SAFE_ADDRESS.toLowerCase() },
    { label: "Treasury.owner == Safe", ok: (await treasury.owner()).toLowerCase() === SAFE_ADDRESS.toLowerCase() },
    { label: "Reserve.owner  == Safe", ok: (await reserve.owner()).toLowerCase()  === SAFE_ADDRESS.toLowerCase() },
  ];

  let allOk = true;
  for (const check of checks) {
    console.log(`  ${check.ok ? "✅" : "❌"} ${check.label}`);
    if (!check.ok) allOk = false;
  }

  console.log("\n═══════════════════════════════════════════════════════");
  if (allOk) {
    console.log("  ✅ Ownership transféré — toutes les actions admin");
    console.log("     passent désormais par le Gnosis Safe 2/3");
    console.log(`  ℹ️  Exchange reste owné par Reserve (inchangé)`);
  } else {
    console.log("  ❌ Certains transferts ont échoué");
    process.exit(1);
  }
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});