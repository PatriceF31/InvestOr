
import { network } from "hardhat";

const RESERVE_ADDRESS = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";
const LINGOT_ADDRESS  = "0x69159BBd5EaFf05C381497890F02d78F1b595A83";

async function main() {
  const { ethers } = await network.create();
  const [deployer]  = await ethers.getSigners();

  const reserve = await ethers.getContractAt("Reserve", RESERVE_ADDRESS, deployer);
  const lingot  = await ethers.getContractAt("LingotOr", LINGOT_ADDRESS, deployer);

  const lingotOrAddr      = await reserve.lingotOr();
  const grammes           = await lingot.totalGrammesEnCoffre();
  const [usdcReserve, gldSupply, goldValue, ratioBps] = await reserve.checkReserve();
  const isHealthy         = await reserve.isHealthy();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Proof of Reserve V2");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  lingotOr configuré     : ${lingotOrAddr}`);
  console.log(`  Mode                   : ${lingotOrAddr !== "0x0000000000000000000000000000000000000000" ? "V2 (grammes)" : "V1 (USDC)"}`);
  console.log(`  Grammes en coffre      : ${grammes} mg (${Number(grammes)/1000}g)`);
  console.log(`  GLD supply             : ${gldSupply} mg`);
  console.log(`  Ratio                  : ${Number(ratioBps)/100}%`);
  console.log(`  Healthy                : ${isHealthy ? "✅ Sain" : "❌ Déficit"}`);
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);