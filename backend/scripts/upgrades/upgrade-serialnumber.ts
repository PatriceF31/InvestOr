/**
 * @file upgrades/upgrade-serialnumber.ts
 * @description Upgrade du contrat SerialNumber + vérification Etherscan automatique
 * Usage : npx hardhat run scripts/upgrades/upgrade-serialnumber.ts --network sepolia
 */
import { network, run } from "hardhat";

const PROXY = "0x24622EfA10CfBA2B6F0e2845a89B09711293867d";
const UUPS_ABI = [
  "function upgradeToAndCall(address, bytes) external",
  "function owner() view returns (address)",
];

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Upgrade SerialNumber");
  console.log(`  Proxy  : ${PROXY}`);
  console.log(`  Wallet : ${deployer.address}`);
  console.log("═══════════════════════════════════════════════════════\n");

  process.stdout.write("  Déploiement nouvelle impl... ");
  const factory = await ethers.getContractFactory("SerialNumber", deployer);
  const impl = await factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`✅  ${implAddr}`);

  process.stdout.write("  Vérification Etherscan... ");
  try {
    await run("verify:verify", {
      address: implAddr,
      constructorArguments: [],
    });
    console.log("✅");
  } catch (e: any) {
    if (e.message?.includes("Already Verified") || e.message?.includes("already verified")) {
      console.log("✅  (déjà vérifié)");
    } else {
      console.log(`⚠️  ${e.message}`);
    }
  }

  const proxy = new ethers.Contract(PROXY, UUPS_ABI, deployer);
  const owner = await proxy.owner();

  if (owner.toLowerCase() === deployer.address.toLowerCase()) {
    process.stdout.write("  upgradeToAndCall... ");
    const tx = await proxy.upgradeToAndCall(implAddr, "0x");
    await tx.wait();
    console.log("✅");
    console.log("\n  ✅ SerialNumber upgradé avec succès");
  } else {
    console.log(`\n  ⚠️  SerialNumber est owné par le Safe : ${owner}`);
    console.log("  ℹ️  Finaliser via app.safe.global :");
    console.log(`     → Adresse : ${PROXY}`);
    console.log(`     → Fonction : upgradeToAndCall`);
    console.log(`     → newImplementation : ${implAddr}`);
    console.log(`     → data : 0x`);
    console.log(`     → ETH value : 0`);
  }

  console.log(`\n  ℹ️  Nouvelle impl : ${implAddr}`);
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);
