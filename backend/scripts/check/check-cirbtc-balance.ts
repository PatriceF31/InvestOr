// scripts/check-cirbtc-balance.ts
//
// Vérifie le solde cirBTC du wallet de déploiement + l'état du marché,
// pour calibrer les montants de l'étape 2 du bootstrap (supplyCollateral + borrow).
//
// Usage :
//   npx hardhat run scripts/check-cirbtc-balance.ts --network sepolia

import { network } from "hardhat";

const CIRBTC = "0x3a3fe695F684Bf9b9e43CF43C2b895Ea5e392bB3";
const MORPHO_BLUE = "0xd011EE229E7459ba1ddd22631eF7bF528d424A14";
const ORACLE_ADDRESS = "0xb3931fF80Da38CB80E4CA5e31cf91C6c57bD0F5d";
const USDC_CIRCLE = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const ADAPTIVE_CURVE_IRM = "0x8C5dDCD3F601c91D1BF51c8ec26066010ACAbA7c";
const LLTV_86 = 860000000000000000n;

async function main() {
  const { ethers } = await network.create();
  const [deployer] = await ethers.getSigners();

  const erc20Abi = ["function balanceOf(address) view returns (uint256)"];
  const cirbtc = new ethers.Contract(CIRBTC, erc20Abi, ethers.provider);
  const usdc = new ethers.Contract(USDC_CIRCLE, erc20Abi, ethers.provider);

  const [cirbtcBalance, usdcBalance] = await Promise.all([
    cirbtc.balanceOf(deployer.address),
    usdc.balanceOf(deployer.address),
  ]);

  console.log("Wallet              :", deployer.address);
  console.log("Solde cirBTC        :", ethers.formatUnits(cirbtcBalance, 8), "cirBTC");
  console.log("Solde USDC          :", ethers.formatUnits(usdcBalance, 6), "USDC");
  console.log("");

  // Prix actuel via l'oracle (même formule vérifiée précédemment : /1e34)
  const oracleAbi = ["function price() external view returns (uint256)"];
  const oracle = new ethers.Contract(ORACLE_ADDRESS, oracleAbi, ethers.provider);
  const price = await oracle.price();
  const btcPrice = Number(price) / 1e34;
  console.log("Prix BTC (oracle)   : ~$" + btcPrice.toLocaleString());

  const collateralValueUsd = Number(ethers.formatUnits(cirbtcBalance, 8)) * btcPrice;
  const maxBorrowAt86 = collateralValueUsd * 0.86;
  const suggestedBorrowConservative = collateralValueUsd * 0.4; // 40% LTV, marge large vs 86% LLTV

  console.log("");
  console.log("Valeur du solde cirBTC : ~$" + collateralValueUsd.toLocaleString());
  console.log("Emprunt max théorique (LLTV 86%) : ~$" + maxBorrowAt86.toLocaleString());
  console.log("Emprunt suggéré (40% LTV, marge de sécurité) : ~$" + suggestedBorrowConservative.toLocaleString());

  // État actuel du marché
  const marketParams = {
    loanToken: USDC_CIRCLE, collateralToken: CIRBTC,
    oracle: ORACLE_ADDRESS, irm: ADAPTIVE_CURVE_IRM, lltv: LLTV_86,
  };
  const id = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address", "uint256"],
      [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv]
    )
  );
  const morphoAbi = [
    "function market(bytes32) external view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  ];
  const morpho = new ethers.Contract(MORPHO_BLUE, morphoAbi, ethers.provider);
  const m = await morpho.market(id);
  console.log("");
  console.log("=== État actuel du marché ===");
  console.log("totalSupplyAssets (USDC dispo à emprunter) :", ethers.formatUnits(m.totalSupplyAssets, 6));
  console.log("totalBorrowAssets (déjà emprunté)          :", ethers.formatUnits(m.totalBorrowAssets, 6));
  if (m.totalSupplyAssets === 0n) {
    console.log("⚠️  Aucune liquidité côté prêt — l'étape 1 (rebalanceYield via Safe) doit être faite AVANT tout borrow().");
  } else {
    console.log("✅ Il y a de la liquidité disponible pour emprunter.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
