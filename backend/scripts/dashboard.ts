// scripts/dashboard.ts
//
// Vue d'ensemble en direct de la stratégie de rendement InvestOr sur Morpho
// Blue (marché cirBTC/USDC) — lecture seule, rien n'est modifié on-chain.
//
// Usage :
//   npx hardhat run scripts/dashboard.ts --network sepolia

import { network } from "hardhat";

const MORPHO_BLUE        = "0xd011EE229E7459ba1ddd22631eF7bF528d424A14";
const CIRBTC              = "0x3a3fe695F684Bf9b9e43CF43C2b895Ea5e392bB3";
const USDC_CIRCLE         = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const ORACLE_ADDRESS      = "0xb3931fF80Da38CB80E4CA5e31cf91C6c57bD0F5d";
const ADAPTIVE_CURVE_IRM  = "0x8C5dDCD3F601c91D1BF51c8ec26066010ACAbA7c";
const LLTV_86             = 860000000000000000n;

const TREASURY_PROXY   = "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af";
const STRATEGY_ADDRESS = "0x52fE94B36AE126fFf145b8B43f334De8679D6065";

const WAD = 10n ** 18n;
const SECONDS_PER_YEAR = 31_536_000;

function bar(pct: number, width = 30): string {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(Math.max(0, Math.min(width, filled))) + "░".repeat(Math.max(0, width - filled));
}

async function main() {
  const { ethers } = await network.create();
  const [wallet] = await ethers.getSigners();

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

  const morphoAbi = [
    "function market(bytes32) external view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
    "function position(bytes32, address) external view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  ];
  const morpho = new ethers.Contract(MORPHO_BLUE, morphoAbi, ethers.provider);

  const irmAbi = [
    "function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) external view returns (uint256)",
  ];
  const irm = new ethers.Contract(ADAPTIVE_CURVE_IRM, irmAbi, ethers.provider);

  const oracleAbi = ["function price() external view returns (uint256)"];
  const oracle = new ethers.Contract(ORACLE_ADDRESS, oracleAbi, ethers.provider);

  const [m, walletPos, price] = await Promise.all([
    morpho.market(id),
    morpho.position(id, wallet.address),
    oracle.price(),
  ]);

  const strategy = await ethers.getContractAt("MorphoYieldStrategy", STRATEGY_ADDRESS);
  const [strategyTotalAssets, treasury] = await Promise.all([
    strategy.totalAssets(),
    ethers.getContractAt("Treasury", TREASURY_PROXY),
  ]);
  const treasuryManaged = await treasury.totalManaged(USDC_CIRCLE);

  const utilizationPct = m.totalSupplyAssets > 0n
    ? Number((m.totalBorrowAssets * 10000n) / m.totalSupplyAssets) / 100
    : 0;

  // --- Taux d'intérêt (best effort — ne bloque pas le reste du dashboard) ---
  let borrowAPR: number | null = null;
  let supplyAPR: number | null = null;
  try {
    // Reconstruction explicite en objet "plain" — réutiliser directement le
    // Result retourné par market() en argument d'un autre appel peut mal se
    // ré-encoder côté ethers (métadonnées du Result plutôt que le tuple pur).
    const marketPlain = {
      totalSupplyAssets: m.totalSupplyAssets,
      totalSupplyShares: m.totalSupplyShares,
      totalBorrowAssets: m.totalBorrowAssets,
      totalBorrowShares: m.totalBorrowShares,
      lastUpdate: m.lastUpdate,
      fee: m.fee,
    };
    const ratePerSecond: bigint = await irm.borrowRateView(marketParams, marketPlain);
    const ratePerSecondFloat = Number(ratePerSecond) / Number(WAD);
    borrowAPR = ratePerSecondFloat * SECONDS_PER_YEAR * 100;
    const feeFloat = Number(m.fee) / Number(WAD);
    supplyAPR = borrowAPR * (utilizationPct / 100) * (1 - feeFloat);
  } catch (e: any) {
    console.log("⚠️  Taux d'intérêt indisponible — erreur réelle :");
    console.log("   ", e.reason ?? e.shortMessage ?? e.message);
  }

  const collateralValueUsdc = (walletPos.collateral * price) / (10n ** 36n);
  const debtUsdc = m.totalBorrowShares > 0n
    ? (BigInt(walletPos.borrowShares) * m.totalBorrowAssets) / m.totalBorrowShares
    : 0n;

  console.log("");
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║           InvestOr — Dashboard MorphoYieldStrategy              ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log("");
  console.log("📊 Marché cirBTC/USDC (LLTV 86%)");
  console.log("   Fourni  :", ethers.formatUnits(m.totalSupplyAssets, 6), "USDC");
  console.log("   Emprunté:", ethers.formatUnits(m.totalBorrowAssets, 6), "USDC");
  console.log("   Utilisation : [" + bar(utilizationPct) + "]", utilizationPct.toFixed(2) + "%", "(cible IRM : 90%)");
  console.log("");
  console.log("💰 Taux (Adaptive Curve IRM)");
  console.log("   Borrow APR  :", borrowAPR !== null ? "~" + borrowAPR.toFixed(2) + "%" : "N/A");
  console.log("   Supply APR  :", supplyAPR !== null ? "~" + supplyAPR.toFixed(4) + "%  (ce que Treasury gagne réellement)" : "N/A");
  console.log("");
  console.log("🏦 Treasury");
  console.log("   Total géré (liquide + investi) :", ethers.formatUnits(treasuryManaged, 6), "USDC");
  console.log("   Investi dans la stratégie       :", ethers.formatUnits(strategyTotalAssets, 6), "USDC");
  console.log("");
  console.log("🔐 Ta position d'emprunteur (bootstrap)");
  console.log("   Collatéral cirBTC : ", ethers.formatUnits(walletPos.collateral, 8), "(~$" + Number(ethers.formatUnits(collateralValueUsdc, 6)).toFixed(2) + ")");
  console.log("   Dette empruntée   : ", ethers.formatUnits(debtUsdc, 6), "USDC");
  console.log("");
  console.log("Prix oracle BTC/USD : ~$" + (Number(price) / 1e34).toLocaleString());
  console.log("");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
