// scripts/bootstrap-cirbtc-market.ts
//
// Étape 2 du bootstrap : dépose du cirBTC en collatéral puis emprunte de
// l'USDC contre — génère une utilisation réelle sur le marché, condition
// nécessaire pour que le rendement déposé par Treasury (étape 1,
// rebalanceYield) génère un vrai APY observable.
//
// Tous les montants sont calculés en BigInt à partir de l'état on-chain lu
// au moment de l'exécution (balance réelle + prix oracle live) — pas de
// valeur codée en dur, pour éviter tout écart avec l'état réel au moment
// du run.
//
// Usage :
//   npx hardhat run scripts/bootstrap-cirbtc-market.ts --network sepolia

import { network } from "hardhat";

const MORPHO_BLUE   = "0xd011EE229E7459ba1ddd22631eF7bF528d424A14";
const CIRBTC         = "0x3a3fe695F684Bf9b9e43CF43C2b895Ea5e392bB3";
const USDC_CIRCLE    = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const ORACLE_ADDRESS = "0xb3931fF80Da38CB80E4CA5e31cf91C6c57bD0F5d";
const ADAPTIVE_CURVE_IRM = "0x8C5dDCD3F601c91D1BF51c8ec26066010ACAbA7c";
const LLTV_86 = 860000000000000000n;

// Part du solde cirBTC à déposer en collatéral (100% = tout le solde,
// montant de toute façon minime sur ce testnet)
const COLLATERAL_BPS = 10000n; // 100%
// LTV cible à l'emprunt — bien en dessous des 86% de LLTV pour absorber
// une variation de prix oracle sans risque de liquidation pendant les tests
const BORROW_LTV_BPS = 4000n; // 40%

async function main() {
  const { ethers } = await network.create();
  const [wallet] = await ethers.getSigners();
  console.log("Wallet :", wallet.address);
  console.log("");

  const marketParams = {
    loanToken: USDC_CIRCLE,
    collateralToken: CIRBTC,
    oracle: ORACLE_ADDRESS,
    irm: ADAPTIVE_CURVE_IRM,
    lltv: LLTV_86,
  };

  const erc20Abi = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) external returns (bool)",
  ];
  const cirbtc = new ethers.Contract(CIRBTC, erc20Abi, wallet);
  const usdc = new ethers.Contract(USDC_CIRCLE, erc20Abi, wallet);

  const cirbtcBalance: bigint = await cirbtc.balanceOf(wallet.address);
  console.log("Solde cirBTC :", ethers.formatUnits(cirbtcBalance, 8));
  if (cirbtcBalance === 0n) {
    throw new Error("Solde cirBTC nul — rien à déposer en collatéral.");
  }

  const collateralAmount = (cirbtcBalance * COLLATERAL_BPS) / 10000n;
  console.log("Collatéral à déposer :", ethers.formatUnits(collateralAmount, 8), "cirBTC");

  // Valeur du collatéral en unités USDC — convention Morpho exacte (vérifiée
  // sur un exemple officiel cbBTC/USDC) : loan_base_units = collateral_base_units * price / 1e36
  const oracleAbi = ["function price() external view returns (uint256)"];
  const oracle = new ethers.Contract(ORACLE_ADDRESS, oracleAbi, ethers.provider);
  const price: bigint = await oracle.price();
  const collateralValueUsdc = (collateralAmount * price) / (10n ** 36n);
  console.log("Valeur du collatéral :", ethers.formatUnits(collateralValueUsdc, 6), "USDC");

  const borrowAmount = (collateralValueUsdc * BORROW_LTV_BPS) / 10000n;
  console.log("Montant à emprunter (", Number(BORROW_LTV_BPS) / 100, "% LTV) :", ethers.formatUnits(borrowAmount, 6), "USDC");
  console.log("");

  // Vérifie qu'il y a assez de liquidité côté prêt avant de tenter le borrow
  const morphoReadAbi = [
    "function market(bytes32) external view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  ];
  const morphoRead = new ethers.Contract(MORPHO_BLUE, morphoReadAbi, ethers.provider);
  const id = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256"],
      [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]
    )
  );
  const m = await morphoRead.market(id);
  const availableLiquidity = m.totalSupplyAssets - m.totalBorrowAssets;
  console.log("Liquidité disponible dans le marché :", ethers.formatUnits(availableLiquidity, 6), "USDC");
  if (borrowAmount > availableLiquidity) {
    throw new Error(
      `Liquidité insuffisante : besoin de ${ethers.formatUnits(borrowAmount, 6)} USDC, ` +
      `disponible ${ethers.formatUnits(availableLiquidity, 6)} USDC. ` +
      `Vérifie que le rebalanceYield (étape 1) a bien été exécuté.`
    );
  }
  console.log("✅ Liquidité suffisante.");
  console.log("");

  const morphoAbi = [
    "function supplyCollateral((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, address onBehalf, bytes data) external",
    "function borrow((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) external returns (uint256, uint256)",
  ];
  const morpho = new ethers.Contract(MORPHO_BLUE, morphoAbi, wallet);

  console.log("1/3 — Approve cirBTC pour Morpho...");
  await (await cirbtc.approve(MORPHO_BLUE, collateralAmount)).wait();
  console.log("     OK.");

  console.log("2/3 — supplyCollateral...");
  await (await morpho.supplyCollateral(marketParams, collateralAmount, wallet.address, "0x")).wait();
  console.log("     OK.");

  console.log("3/3 — borrow...");
  const borrowTx = await morpho.borrow(marketParams, borrowAmount, 0, wallet.address, wallet.address);
  await borrowTx.wait();
  console.log("     OK.");
  console.log("");

  const usdcBalanceAfter: bigint = await usdc.balanceOf(wallet.address);
  console.log("=== Terminé ===");
  console.log("Nouveau solde USDC du wallet :", ethers.formatUnits(usdcBalanceAfter, 6));
  console.log("Le marché a désormais une utilisation réelle — Treasury devrait");
  console.log("commencer à accumuler des intérêts sur sa poche investie.");
  console.log("Vérifiable via strategy.totalAssets() qui augmentera avec le temps.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
