import { network } from "hardhat";

const LINGOT_ADDRESS = "0x69159BBd5EaFf05C381497890F02d78F1b595A83";
const DEPLOYER       = "0x7ad6030e13EaCc968184893729444724A6aDfcd3";

async function main() {
  const { ethers } = await network.create();
  const [deployer]  = await ethers.getSigners();

  const lingot = await ethers.getContractAt("LingotOr", LINGOT_ADDRESS, deployer);

  const grammes  = await lingot.totalGrammesEnCoffre();
  const balance  = await lingot.balanceOf(DEPLOYER, 1000n);
  const proposal = await lingot.getMintProposal(4n);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Vérification LingotOr après approveMint");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Grammes en coffre      : ${grammes} mg (${Number(grammes)/1000}g)`);
  console.log(`  Balance deployer (1g)  : ${balance} lingot(s)`);
  console.log(`  Proposal #4 executed   : ${proposal.executed}`);
  console.log(`  Proposal #4 rejected   : ${proposal.rejected}`);
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);