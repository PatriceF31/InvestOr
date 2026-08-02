// scripts/verify-full-wiring.ts
//
// Vérification finale, en lecture seule, que toute la chaîne est bien câblée :
// Treasury.yieldStrategy -> MorphoYieldStrategy -> marché Morpho cirBTC/USDC.
//
// Usage :
//   npx hardhat run scripts/verify-full-wiring.ts --network sepolia

import { network } from "hardhat";

const TREASURY_PROXY   = "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af";
const RESERVE_PROXY    = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";
const STRATEGY_ADDRESS = "0x52fE94B36AE126fFf145b8B43f334De8679D6065";
const USDC_CIRCLE      = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

async function main() {
  const { ethers } = await network.create();

  const treasury = await ethers.getContractAt("Treasury", TREASURY_PROXY);
  const strategy = await ethers.getContractAt("MorphoYieldStrategy", STRATEGY_ADDRESS);

  const [wiredStrategy, strategyTreasury, strategyOwner, asset, totalAssets, totalManaged] = await Promise.all([
    treasury.yieldStrategy(),
    strategy.treasury(),
    strategy.owner(),
    strategy.asset(),
    strategy.totalAssets(),
    treasury.totalManaged(USDC_CIRCLE),
  ]);

  console.log("=== Chaîne complète ===");
  console.log("Treasury.yieldStrategy() :", wiredStrategy);
  console.log("Strategy.treasury()      :", strategyTreasury);
  console.log("Strategy.owner()         :", strategyOwner, "(attendu Reserve)");
  console.log("Strategy.asset()         :", asset, "(attendu USDC)");
  console.log("Strategy.totalAssets()   :", totalAssets.toString(), "(0 tant que rien n'est déposé)");
  console.log("Treasury.totalManaged()  :", totalManaged.toString(), "(liquide + investi, doit être cohérent avec le solde réel)");
  console.log("");

  const checks = [
    [wiredStrategy.toLowerCase() === STRATEGY_ADDRESS.toLowerCase(), "Treasury pointe bien vers la stratégie cirBTC"],
    [strategyTreasury.toLowerCase() === TREASURY_PROXY.toLowerCase(), "La stratégie pointe bien vers Treasury"],
    [strategyOwner.toLowerCase() === RESERVE_PROXY.toLowerCase(), "La stratégie est bien owned par Reserve"],
    [asset.toLowerCase() === USDC_CIRCLE.toLowerCase(), "asset() == USDC Circle"],
  ] as const;

  console.log("=== Résumé ===");
  let allOk = true;
  for (const [ok, label] of checks) {
    console.log(ok ? "✅" : "❌", label);
    if (!ok) allOk = false;
  }
  console.log("");
  console.log(allOk
    ? "🎉 Toute la chaîne Reserve → Treasury → MorphoYieldStrategy → marché cirBTC/USDC est correctement câblée."
    : "⚠️  Au moins une vérification a échoué — à regarder avant de passer au bootstrap."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
