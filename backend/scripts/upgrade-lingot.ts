import { network } from "hardhat";

async function main() {
  const { ethers } = await network.create();
  const [deployer] = await ethers.getSigners();

  console.log("Déploiement nouvelle impl LingotOr...");
  const factory = await ethers.getContractFactory("LingotOr", deployer);
  const impl = await factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`✅ Nouvelle impl : ${implAddr}`);
  console.log("\nÉtape suivante — via Safe :");
  console.log(`  Adresse : 0x69159BBd5EaFf05C381497890F02d78F1b595A83`);
  console.log(`  Fonction : upgradeToAndCall`);
  console.log(`  newImplementation : ${implAddr}`);
  console.log(`  data : 0x`);
}

main().catch(console.error);