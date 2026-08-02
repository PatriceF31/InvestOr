// scripts/check-reserve-owner.ts
//
// Vérification en lecture seule après l'upgrade de Reserve.
// Usage :
//   npx hardhat run scripts/check-reserve-owner.ts --network sepolia

import { network } from "hardhat";

const RESERVE_PROXY = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";
const SAFE_ADDRESS   = "0x7f7533Ea6aA203d07eBB6F06aE1a8A4AD0B33917";
const STRATEGY_ADDRESS = "0x52fE94B36AE126fFf145b8B43f334De8679D6065";
const TREASURY_PROXY = "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af";

async function main() {
  const { ethers } = await network.create();

  const reserveAbi = [
    "function owner() external view returns (address)",
    "function treasury() external view returns (address)",
    "function setTreasuryYieldStrategy(address) external",
  ];
  const reserve = new ethers.Contract(RESERVE_PROXY, reserveAbi, ethers.provider);

  console.log("=== Reserve ===");
  const owner = await reserve.owner();
  console.log("owner()    :", owner);
  console.log("== Safe ?  :", owner.toLowerCase() === SAFE_ADDRESS.toLowerCase() ? "✅ oui" : "❌ NON — c'est le problème");
  console.log("");

  const treasury = await reserve.treasury();
  console.log("treasury() :", treasury);
  console.log("== attendu :", treasury.toLowerCase() === TREASURY_PROXY.toLowerCase() ? "✅ oui" : "❌ NON — c'est le problème");
  console.log("");

  // La fonction est-elle bien présente dans le bytecode déployé ?
  console.log("=== Test de présence de la fonction (sans l'exécuter) ===");
  try {
    const data = reserve.interface.encodeFunctionData("setTreasuryYieldStrategy", [STRATEGY_ADDRESS]);
    // eth_call en tant que Safe lui-même, pour simuler exactement ce que fait la transaction Safe
    const result = await ethers.provider.call({
      to: RESERVE_PROXY,
      from: SAFE_ADDRESS,
      data,
    });
    console.log("✅ eth_call depuis le Safe réussit — result:", result);
  } catch (err: any) {
    console.log("❌ eth_call depuis le Safe échoue :");
    console.log("   reason  :", err.reason ?? "(aucune reason décodée)");
    console.log("   data    :", err.data ?? err.info?.error?.data ?? "(pas de data)");
    console.log("   message :", err.shortMessage ?? err.message);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
