/**
 * @file test-lingot-flow.ts
 * @description Test du flux complet proposeMint → approveMint (via Safe)
 *
 * Usage :
 *   npx hardhat run scripts/test-lingot-flow.ts --network sepolia
 */

import { network } from "hardhat";

const LINGOT_ADDRESS = "0x69159BBd5EaFf05C381497890F02d78F1b595A83";

async function main() {
  const { ethers } = await network.create();
  const [deployer, minter] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Test flux LingotOr");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Minter   : ${minter.address}`);
  console.log("═══════════════════════════════════════════════════════\n");

  // getContractAt utilise l'ABI complet de l'artifact compilé
  const lingotMinter   = await ethers.getContractAt("LingotOr", LINGOT_ADDRESS, minter);
  const lingotDeployer = await ethers.getContractAt("LingotOr", LINGOT_ADDRESS, deployer);

  // Vérifier le rôle minter
  const MINTER_ROLE = await lingotMinter.MINTER_ROLE();
  const isMinter    = await lingotMinter.hasRole(MINTER_ROLE, minter.address);
  console.log(`  Minter a MINTER_ROLE : ${isMinter ? "✅" : "❌"}`);
  if (!isMinter) { process.exit(1); }

  // État avant
  const grammesBefore = await lingotDeployer.totalGrammesEnCoffre();
  const countBefore   = await lingotDeployer.mintProposalCount();
  console.log(`\n  Grammes en coffre avant : ${grammesBefore}`);
  console.log(`  Proposals avant         : ${countBefore}`);

  // proposeMint
  console.log("\n  Étape 1 — proposeMint (minter/gardien)");
  process.stdout.write("    proposeMint(tokenId=1000, amount=1)... ");
  const tx      = await lingotMinter.proposeMint(
    1000, 1, deployer.address,
    "GLD-2026-000003", "Valcambi", "Brinks", "Suisse"
  );
  const receipt = await tx.wait();
  console.log("✅");
  console.log(`    Tx hash : ${receipt?.hash ?? tx.hash}`);

  // Lire la proposal
  const proposalId = await lingotDeployer.mintProposalCount();
  const proposal   = await lingotDeployer.getMintProposal(proposalId);

  console.log(`\n  Proposal #${proposalId} créée :`);
  console.log(`    tokenId    : ${proposal.tokenId} (${Number(proposal.tokenId)/1000}g)`);
  console.log(`    amount     : ${proposal.amount}`);
  console.log(`    to         : ${proposal.to}`);
  console.log(`    serialCode : ${proposal.serialCode}`);
  console.log(`    refiner    : ${proposal.refiner}`);
  console.log(`    supplier   : ${proposal.supplier}`);
  console.log(`    origin     : ${proposal.origin}`);
  console.log(`    executed   : ${proposal.executed}`);
  console.log(`    rejected   : ${proposal.rejected}`);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ✅ proposeMint réussi !");
  console.log(`  ℹ️  Étape 2 — approveMint(${proposalId}) via Safe`);
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);