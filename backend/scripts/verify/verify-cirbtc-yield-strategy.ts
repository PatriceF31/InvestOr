// scripts/verify-cirbtc-yield-strategy.ts
//
// Vérifications en lecture seule après le déploiement corrigé (cirBTC),
// AVANT de proposer la transaction Safe sur Reserve. Ne modifie rien on-chain.
//
// Usage :
//   npx hardhat run scripts/verify-cirbtc-yield-strategy.ts --network sepolia

import { network } from "hardhat";

const ORACLE_ADDRESS   = "0xb3931fF80Da38CB80E4CA5e31cf91C6c57bD0F5d"; // réutilisé (8 déc confirmées)
const STRATEGY_ADDRESS = "0x52fE94B36AE126fFf145b8B43f334De8679D6065"; // nouveau proxy cirBTC
const MORPHO_BLUE       = "0xd011EE229E7459ba1ddd22631eF7bF528d424A14";

const USDC_CIRCLE = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const CIRBTC       = "0x3a3fe695F684Bf9b9e43CF43C2b895Ea5e392bB3";
const ADAPTIVE_CURVE_IRM = "0x8C5dDCD3F601c91D1BF51c8ec26066010ACAbA7c";
const LLTV_86 = 860000000000000000n;
const RESERVE_PROXY = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";

async function main() {

  const { ethers } = await network.create();

  console.log("=== 1. Oracle ===");
  const oracleAbi = ["function price() external view returns (uint256)"];
  const oracle = new ethers.Contract(ORACLE_ADDRESS, oracleAbi, ethers.provider);
  const price = await oracle.price();
  console.log("price() brut       :", price.toString());
  // Convention Morpho : price = valeur de 1 unité de base (cirBTC, 8 déc) en
  // unités de quote (USDC, 6 déc), mise à l'échelle en 1e36.
  // => prix BTC en USD ≈ price / 1e(36 + 6 - 8) = price / 1e34
  const impliedBtcPrice = Number(price) / 1e34;
  console.log("Prix BTC implicite  : ~$" + impliedBtcPrice.toLocaleString());
  if (impliedBtcPrice < 10_000 || impliedBtcPrice > 500_000) {
    console.log("⚠️  Prix hors fourchette plausible (10k–500k $) — À VÉRIFIER avant de continuer.");
  } else {
    console.log("✅ Prix dans une fourchette plausible.");
  }
  console.log("");

  console.log("=== 2. Marché Morpho Blue ===");
  const morphoAbi = [
    "function idToMarketParams(bytes32) external view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  ];
  const marketParams = {
    loanToken: USDC_CIRCLE,
    collateralToken: CIRBTC,
    oracle: ORACLE_ADDRESS,
    irm: ADAPTIVE_CURVE_IRM,
    lltv: LLTV_86,
  };
  const id = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256"],
      [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]
    )
  );
  console.log("Market id           :", id);

  const morphoMarketAbi = [
    "function market(bytes32) external view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  ];
  const morpho = new ethers.Contract(MORPHO_BLUE, morphoMarketAbi, ethers.provider);
  const m = await morpho.market(id);
  console.log("totalSupplyAssets   :", m.totalSupplyAssets.toString());
  console.log("totalBorrowAssets   :", m.totalBorrowAssets.toString());
  console.log("lastUpdate          :", new Date(Number(m.lastUpdate) * 1000).toISOString());
  if (m.lastUpdate === 0n) {
    console.log("❌ lastUpdate = 0 — le marché n'existe PAS avec ces paramètres exacts !");
  } else {
    console.log("✅ Le marché existe bien avec ces paramètres.");
  }
  console.log("");

  console.log("=== 3. MorphoYieldStrategy ===");
  const strategy = await ethers.getContractAt("MorphoYieldStrategy", STRATEGY_ADDRESS);
  const [owner, treasury, morphoAddr, storedParams, asset, totalAssets] = await Promise.all([
    strategy.owner(),
    strategy.treasury(),
    strategy.morpho(),
    strategy.marketParams(),
    strategy.asset(),
    strategy.totalAssets(),
  ]);
  console.log("owner()             :", owner);
  console.log("treasury()          :", treasury);
  console.log("morpho()            :", morphoAddr);
  console.log("asset()             :", asset);
  console.log("totalAssets()       :", totalAssets.toString(), "(attendu 0, marché vide)");
  console.log("marketParams.oracle :", storedParams.oracle);
  console.log("marketParams.lltv   :", storedParams.lltv.toString());

  const checks = [
    [asset.toLowerCase() === USDC_CIRCLE.toLowerCase(), "asset() == USDC Circle"],
    [storedParams.oracle.toLowerCase() === ORACLE_ADDRESS.toLowerCase(), "marketParams.oracle == oracle déployé"],
    [storedParams.lltv === LLTV_86, "marketParams.lltv == 86%"],
    [totalAssets === 0n, "totalAssets() == 0 (rien déposé encore, normal)"],
    [owner.toLowerCase() === RESERVE_PROXY.toLowerCase(), "owner() == Reserve (sinon setTreasuryYieldStrategy via Safe échouera au 2e hop)"],
  ] as const;

  console.log("");
  console.log("=== Résumé ===");
  let allOk = true;
  for (const [ok, label] of checks) {
    console.log(ok ? "✅" : "❌", label);
    if (!ok) allOk = false;
  }
  console.log("");
  console.log(allOk
    ? "Tout est cohérent — la transaction Safe peut être proposée en confiance."
    : "⚠️  Au moins une vérification a échoué — NE PAS proposer la transaction Safe avant d'avoir compris pourquoi."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
