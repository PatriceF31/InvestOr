/**
 * @file upgrades/upgrade-exchange.ts
 * @description Upgrade du contrat Exchange + vérification Etherscan automatique
 * ⚠️  Exchange est owné par Reserve — l'upgrade passe par Reserve.upgradeExchange()
 * Usage : npx hardhat run scripts/upgrades/upgrade-exchange.ts --network sepolia
 */
import { network, run } from "hardhat";

const PROXY_EXCHANGE = "0x69C73469C427A9adbFA9a54E5a7711746A34d508";
const PROXY_RESERVE  = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";

const RESERVE_ABI = [
  "function upgradeExchange(address newImpl) external",
  "function owner() view returns (address)",
];

async function main() {
  const { ethers } = await network.connect();
  const [deployer] = await ethers.getSigners();

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  InvestOr — Upgrade Exchange (via Reserve)");
  console.log(`  Proxy Exchange : ${PROXY_EXCHANGE}`);
  console.log(`  Proxy Reserve  : ${PROXY_RESERVE}`);
  console.log(`  Wallet         : ${deployer.address}`);
  console.log("═══════════════════════════════════════════════════════\n");

  process.stdout.write("  Déploiement nouvelle impl Exchange... ");
  // Nom qualifié — contracts/backup/Exchange.sol existe aussi dans le projet
  const factory = await ethers.getContractFactory("contracts/Exchange.sol:Exchange", deployer);
  const impl = await factory.deploy();
  await impl.waitForDeployment();
  const implAddr = await impl.getAddress();
  console.log(`✅  ${implAddr}`);

  process.stdout.write("  Vérification Etherscan... ");
  try {
    await run("verify:verify", {
      address: implAddr,
      constructorArguments: [],
      contract: "contracts/Exchange.sol:Exchange",
    });
    console.log("✅");
  } catch (e: any) {
    if (e.message?.includes("Already Verified") || e.message?.includes("already verified")) {
      console.log("✅  (déjà vérifié)");
    } else {
      console.log(`⚠️  ${e.message}`);
    }
  }

  const reserve = new ethers.Contract(PROXY_RESERVE, RESERVE_ABI, deployer);
  const reserveOwner = await reserve.owner();

  if (reserveOwner.toLowerCase() === deployer.address.toLowerCase()) {
    process.stdout.write("  upgradeExchange (via Reserve)... ");
    const tx = await reserve.upgradeExchange(implAddr);
    await tx.wait();
    console.log("✅");
  } else {
    console.log(`  ⚠️  Reserve est owné par : ${reserveOwner}`);
    console.log("  ℹ️  Finaliser via Safe :");
    console.log(`     → Adresse : ${PROXY_RESERVE} (Reserve)`);
    console.log(`     → Fonction : upgradeExchange`);
    console.log(`     → newImpl  : ${implAddr}`);
  }

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("  ✅ Nouvelle impl Exchange déployée et vérifiée");
  console.log(`  ℹ️  Nouvelle impl : ${implAddr}`);
  console.log("═══════════════════════════════════════════════════════\n");
}

main().catch(console.error);
