import { network } from "hardhat";

const LINGOT_ADDRESS = "0x69159BBd5EaFf05C381497890F02d78F1b595A83";
const DEPLOYER       = "0x7ad6030e13EaCc968184893729444724A6aDfcd3";

async function main() {
  const { ethers } = await network.create();
  const [deployer]  = await ethers.getSigners();

  const lingot = await ethers.getContractAt("LingotOr", LINGOT_ADDRESS, deployer);

  const grammes    = await lingot.totalGrammesEnCoffre();
  const balance    = await lingot.balanceOf(DEPLOYER, 1000n);
  const mintP5     = await lingot.getMintProposal(5n);
  const burnP1     = await lingot.getBurnProposal(1n);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Vérification LingotOr");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Grammes en coffre      : ${grammes} mg (${Number(grammes)/1000}g)`);
  console.log(`  Balance deployer (1g)  : ${balance} lingot(s)`);
  console.log(`  Mint Proposal #5 executed  : ${mintP5.executed}`);
  console.log(`  Burn Proposal #1 executed  : ${burnP1.executed}`);
  console.log(`  Burn Proposal #1 rejected  : ${burnP1.rejected}`);
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);