import { network } from "hardhat";

const PROXIES = {
  EventLogger:  "0x70eFf6af5aCE213cEe7a3AFC4587db478c4F4b5a",
  SerialNumber: "0x24622EfA10CfBA2B6F0e2845a89B09711293867d",
};

const UUPS_ABI = [
  "function upgradeToAndCall(address newImplementation, bytes calldata data) external",
  "function owner() view returns (address)",
];

async function step(label: string, fn: () => Promise<string>) {
  process.stdout.write(`  ${label}... `);
  try {
    const result = await fn();
    console.log(`✅  ${result}`);
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
  console.log("  InvestOr — Upgrade EventLogger + SerialNumber");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Wallet : ${deployer.address}`);
  console.log("═══════════════════════════════════════════════════════\n");

  for (const [name, proxyAddr] of Object.entries(PROXIES)) {
    console.log(`Upgrade ${name}`);
    let implAddr: string;

    await step("Déploiement nouvelle impl", async () => {
      const factory = await ethers.getContractFactory(name, deployer);
      const impl = await factory.deploy();
      await impl.waitForDeployment();
      implAddr = await impl.getAddress();
      return implAddr;
    });

    await step("upgradeToAndCall", async () => {
      const proxy = new ethers.Contract(proxyAddr, UUPS_ABI, deployer);
      const tx = await proxy.upgradeToAndCall(implAddr!, "0x");
      await tx.wait();
      return "OK";
    });

    console.log();
  }

  console.log("═══════════════════════════════════════════════════════");
  console.log("  ✅ Upgrade terminé");
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});