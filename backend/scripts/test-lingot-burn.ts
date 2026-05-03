/**
 * @file test-lingot-burn.ts
 * @description Test du flux proposeBurn → approveBurn (via Safe)
 *
 * Usage :
 *   npx hardhat run scripts/test-lingot-burn.ts --network sepolia
 */

import { network } from "hardhat";

const LINGOT_ADDRESS = "0x69159BBd5EaFf05C381497890F02d78F1b595A83";
const DEPLOYER       = "0x7ad6030e13EaCc968184893729444724A6aDfcd3";

async function main() {
  const { ethers } = await network.create();
  const [deployer, minter] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Test flux Burn LingotOr");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Deployer : ${deployer.address}`);
  console.log(`  Minter   : ${minter.address}`);
  console.log("═══════════════════════════════════════════════════════\n");

  const lingotMinter   = await ethers.getContractAt("LingotOr", LINGOT_ADDRESS, minter);
  const lingotDeployer = await ethers.getContractAt("LingotOr", LINGOT_ADDRESS, deployer);

  // État avant
  const grammesBefore = await lingotDeployer.totalGrammesEnCoffre();
  const balanceBefore = await lingotDeployer.balanceOf(DEPLOYER, 1000n);
  const countBefore   = await lingotDeployer.burnProposalCount();

  console.log(`  Grammes en coffre avant : ${grammesBefore} mg (${Number(grammesBefore)/1000}g)`);
  console.log(`  Balance deployer (1g)   : ${balanceBefore} lingot(s)`);
  console.log(`  Burn proposals avant    : ${countBefore}`);

  if (balanceBefore === 0n) {
    console.log("\n  ❌ Pas de lingot à brûler — lance d'abord test-lingot-flow.ts");
    process.exit(1);
  }

  // proposeBurn
  console.log("\n  Étape 1 — proposeBurn (minter/gardien)");
  process.stdout.write("    proposeBurn(tokenId=1000, amount=1)... ");
  const tx = await lingotMinter.proposeBurn(
    1000,            // tokenId = 1g
    1,               // 1 lingot
    DEPLOYER,        // from = deployer (détenteur)
    "GLD-2026-000003", // numéro de série
    "livraison physique" // raison
  );
  const receipt = await tx.wait();
  console.log("✅");
  console.log(`    Tx hash : ${receipt?.hash ?? tx.hash}`);

  // Lire la proposal
  const proposalId = await lingotDeployer.burnProposalCount();
  const proposal   = await lingotDeployer.getBurnProposal(proposalId);

  console.log(`\n  Burn Proposal #${proposalId} créée :`);
  console.log(`    tokenId    : ${proposal.tokenId} (${Number(proposal.tokenId)/1000}g)`);
  console.log(`    amount     : ${proposal.amount}`);
  console.log(`    from       : ${proposal.from}`);
  console.log(`    serialCode : ${proposal.serialCode}`);
  console.log(`    reason     : ${proposal.reason}`);
  console.log(`    executed   : ${proposal.executed}`);
  console.log(`    rejected   : ${proposal.rejected}`);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ✅ proposeBurn réussi !");
  console.log(`  ℹ️  Étape 2 — approveBurn(${proposalId}) via Safe :`);
  console.log(`     → app.safe.global`);
  console.log(`     → LingotOr : ${LINGOT_ADDRESS}`);
  console.log(`     → fonction : approveBurn`);
  console.log(`     → argument : ${proposalId}`);
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);