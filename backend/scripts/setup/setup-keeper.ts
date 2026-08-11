import { network } from "hardhat";

const KEEPER_ADDRESS = "0x0F1F52138c93162538B61e80bEDfCd180e6fa5a1";
const SAFE_ADDRESS   = "0x7f7533Ea6aA203d07eBB6F06aE1a8A4AD0B33917";

const ABI = [
  "function transferOwnership(address) external",
  "function owner() view returns (address)",
  "function checkInterval() view returns (uint256)",
  "function reserve() view returns (address)",
];

async function main() {
  const { ethers } = await network.create();
  const [deployer] = await ethers.getSigners();

  const keeper = new ethers.Contract(KEEPER_ADDRESS, ABI, deployer);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Setup ReserveKeeper");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Owner actuel   : ${await keeper.owner()}`);
  console.log(`  Reserve        : ${await keeper.reserve()}`);
  console.log(`  Check interval : ${await keeper.checkInterval()}s`);

  process.stdout.write("\n  transferOwnership(Safe)... ");
  const tx = await keeper.transferOwnership(SAFE_ADDRESS);
  await tx.wait();
  console.log("✅");

  console.log(`  Nouveau owner  : ${await keeper.owner()}`);
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);