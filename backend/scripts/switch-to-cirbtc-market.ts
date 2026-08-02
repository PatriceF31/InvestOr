// scripts/switch-to-cirbtc-market.ts
//
// Corrige l'erreur cbBTC → cirBTC :
//   1. Crée un nouveau marché Morpho Blue (collateralToken=cirBTC), en
//      réutilisant l'oracle déjà déployé (8 décimales confirmées identiques
//      à cbBTC — aucun nouvel oracle nécessaire) et le même IRM/LLTV.
//   2. Déploie un NOUVEAU proxy MorphoYieldStrategy — réutilise
//      l'implémentation déjà déployée, pas besoin de la recompiler.
//      (L'ancien proxy est déjà owned par Reserve — setMarketParams()
//      dessus reverterait avec OwnableUnauthorizedAccount depuis un simple
//      wallet de déploiement. Repartir d'un nouveau proxy évite un upgrade
//      UUPS de Reserve rien que pour une fonction relais à usage unique.)
//   3. Configure le nouveau marché dessus, puis transfère l'ownership à
//      Reserve — exactement comme le déploiement initial.
//
// L'ancien marché cbBTC et l'ancien proxy de stratégie restent orphelins —
// immuables, inoffensifs, aucun fonds dessus (totalAssets() = 0).
//
// Usage :
//   npx hardhat run scripts/switch-to-cirbtc-market.ts --network sepolia

import { network } from "hardhat";

const MORPHO_BLUE        = "0xd011EE229E7459ba1ddd22631eF7bF528d424A14";
const ORACLE_ADDRESS      = "0xb3931fF80Da38CB80E4CA5e31cf91C6c57bD0F5d"; // réutilisé tel quel
const ADAPTIVE_CURVE_IRM  = "0x8C5dDCD3F601c91D1BF51c8ec26066010ACAbA7c";
const USDC_CIRCLE         = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const CIRBTC              = "0x3a3fe695F684Bf9b9e43CF43C2b895Ea5e392bB3";
const LLTV_86             = 860000000000000000n;

const STRATEGY_IMPL    = "0x8b3fb19A1EE64604Eff8Db62dAc4A892A726E9a5"; // réutilisée telle quelle
const TREASURY_PROXY   = "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af";
const RESERVE_PROXY    = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";

async function main() {
  const { ethers } = await network.create();
  const [deployer] = await ethers.getSigners();
  console.log("Déploiement depuis :", deployer.address);
  console.log("");

  const newMarketParams = {
    loanToken: USDC_CIRCLE,
    collateralToken: CIRBTC,
    oracle: ORACLE_ADDRESS,
    irm: ADAPTIVE_CURVE_IRM,
    lltv: LLTV_86,
  };

  console.log("1/3 — Création du marché Morpho Blue cirBTC/USDC (LLTV 86%)...");
  const morphoAbi = [
    "function createMarket((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams) external",
  ];
  const morpho = new ethers.Contract(MORPHO_BLUE, morphoAbi, deployer);
  const marketTx = await morpho.createMarket(newMarketParams);
  await marketTx.wait();
  console.log("     Marché créé.");
  console.log("");

  console.log("2/3 — Déploiement d'un nouveau proxy MorphoYieldStrategy...");
  const strategyImpl = await ethers.getContractAt("MorphoYieldStrategy", STRATEGY_IMPL);
  const strategyInitData = strategyImpl.interface.encodeFunctionData("initialize", [
    deployer.address, MORPHO_BLUE, TREASURY_PROXY,
  ]);
  const strategyProxyRaw = await ethers.deployContract("InvestOrProxy", [
    STRATEGY_IMPL, strategyInitData,
  ]);
  await strategyProxyRaw.waitForDeployment();
  const strategyAddress = await strategyProxyRaw.getAddress();
  const strategy = await ethers.getContractAt("MorphoYieldStrategy", strategyAddress);
  console.log("     Nouveau proxy déployé :", strategyAddress);
  console.log("");

  console.log("3/3 — Configuration du marché puis transfert à Reserve...");
  await (await strategy.setMarketParams(
    newMarketParams.loanToken,
    newMarketParams.collateralToken,
    newMarketParams.oracle,
    newMarketParams.irm,
    newMarketParams.lltv
  )).wait();
  await (await strategy.transferOwnership(RESERVE_PROXY)).wait();
  console.log("     OK.");
  console.log("");

  console.log("=== Récapitulatif ===");
  console.log("Marché Morpho Blue      : loanToken=USDC, collateralToken=cirBTC, LLTV=86%");
  console.log("Oracle (réutilisé)      :", ORACLE_ADDRESS);
  console.log("MorphoYieldStrategy     :", strategyAddress, "(NOUVELLE adresse — remplace l'ancienne)");
  console.log("");
  console.log("=== À FAIRE VIA LE SAFE (2/3) ===");
  console.log("Si la transaction Safe pour l'ancienne adresse n'a pas encore été");
  console.log("exécutée : remplace simplement le paramètre par la nouvelle adresse.");
  console.log("Si elle l'a déjà été exécutée : propose une nouvelle transaction —");
  console.log("  Contrat cible : Reserve —", RESERVE_PROXY);
  console.log("  Fonction      : setTreasuryYieldStrategy(address newStrategy)");
  console.log("  Paramètre     :", strategyAddress);
  console.log("");
  console.log("Bootstrap à faire : un wallet dépose du cirBTC en collatéral");
  console.log("(supplyCollateral) puis emprunte de l'USDC (borrow) pour générer");
  console.log("une utilisation réelle avant tout rebalance().");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

