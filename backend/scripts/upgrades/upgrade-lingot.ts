/**
 * @file upgrades/upgrade-lingot.ts
 * @description Upgrade du contrat LingotOr + vérification Etherscan automatique
 * ⚠️  LingotOr est owné par le Safe — le script déploie l'impl et affiche les instructions Safe
 * Usage : npx hardhat run scripts/upgrades/upgrade-lingot.ts --network sepolia
 */
import { network, run } from "hardhat";

const PROXY = "0x69159BBd5EaFf05C381497890F02d78F1b595A83";
const UUPS_ABI = [
  "function upgradeToAndCall(address, bytes) external",
  "function owner() view returns (address)",
];

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Upgrade LingotOr");
  console.log(`  Proxy  : ${PROXY}`);
  console.log(`  Wallet : ${deployer.address}`);
  console.log("═══════════════════════════════════════════════════════\n");

  process.stdout.write("  Déploiement nouvelle impl... ");
  const factory = await ethers.getContractFactory("LingotOr", deployer);
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
    console.log("\n  ✅ LingotOr upgradé avec succès");
  } else {
    console.log(`\n  ⚠️  LingotOr est owné par le Safe : ${owner}`);
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
