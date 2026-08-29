// scripts/bootstrap-lombard.ts
//
// Bootstrap du Prêt Lombard sur Sepolia :
//   1. Fournit de la liquidité USDC au pool (rôle Farid)
//   2. Dépose du GLD en collatéral et emprunte de l'USDC à un LTV prudent
//      (rôle Marthe) — même wallet jouant les deux rôles, comme pour le
//      bootstrap du marché Morpho cirBTC.
//
// Montants calculés à partir de l'état on-chain réel au moment du run (solde
// GLD disponible, prix oracle live) — pas de valeur codée en dur.
//
// Usage :
//   npx hardhat run scripts/bootstrap-lombard.ts --network sepolia

import { network } from "hardhat";

const GLD_ADDRESS      = "0xA4ddCDf84F0C0acC8cA22E77f501d308C4E87dD4";
const USDC_ADDRESS     = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const VAULT_ADDRESS    = "0x4e1e4C06AA20bf589F99275Ac907a735F03b8E99";
const EXCHANGE_ADDRESS = "0x69C73469C427A9adbFA9a54E5a7711746A34d508";

// Fraction du solde GLD à déposer en collatéral, et LTV cible à l'emprunt —
// bien en dessous des 70% max pour garder une marge confortable pendant les tests
const COLLATERAL_BPS = 5_000n; // 50% du solde GLD disponible
const BORROW_LTV_BPS = 4_000n; // 40% LTV — cohérent avec la marge de sécurité déjà retenue pour Morpho

async function main() {
  const { ethers } = await network.create();
  const [wallet] = await ethers.getSigners();
  console.log("Wallet :", wallet.address);
  console.log("");

  const erc20Abi = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) external returns (bool)",
  ];
  const gld = new ethers.Contract(GLD_ADDRESS, erc20Abi, wallet);
  const usdc = new ethers.Contract(USDC_ADDRESS, erc20Abi, wallet);
  const vault = await ethers.getContractAt("LombardVault", VAULT_ADDRESS);

  const [gldBalance, usdcBalance] = await Promise.all([
    gld.balanceOf(wallet.address),
    usdc.balanceOf(wallet.address),
  ]);
  console.log("Solde GLD  :", ethers.formatUnits(gldBalance, 3));
  console.log("Solde USDC :", ethers.formatUnits(usdcBalance, 6));
  if (gldBalance === 0n) throw new Error("Solde GLD nul — rien à déposer en collatéral.");

  const collateralAmount = (gldBalance * COLLATERAL_BPS) / 10_000n;
  console.log("Collatéral à déposer :", ethers.formatUnits(collateralAmount, 3), "GLD");

  // Valeur du collatéral — même convention que Exchange.previewSell() :
  // GLD (3 déc) × prix XAU/USD (8 déc) / 1e5 = valeur en USDC (6 déc)
  const exchangeAbi = ["function getPrice() view returns (uint256 price, uint8 source)"];
  const exchange = new ethers.Contract(EXCHANGE_ADDRESS, exchangeAbi, ethers.provider);
  const [price] = await exchange.getPrice();
  const collateralValueUsdc = (collateralAmount * price) / 100_000n;
  console.log("Valeur du collatéral :", ethers.formatUnits(collateralValueUsdc, 6), "USDC");

  const borrowAmount = (collateralValueUsdc * BORROW_LTV_BPS) / 10_000n;
  console.log("Montant à emprunter (", Number(BORROW_LTV_BPS) / 100, "% LTV) :", ethers.formatUnits(borrowAmount, 6), "USDC");
  console.log("");

  // ── 1. Fournir de la liquidité (rôle Farid) ──────────────────────────────
  // Fournit un peu plus que le montant emprunté pour laisser de la marge de retrait
  const supplyAmount = (borrowAmount * 12_000n) / 10_000n; // +20% de marge
  if (usdcBalance < supplyAmount) {
    throw new Error(
      `Solde USDC insuffisant pour fournir la liquidité : besoin de ${ethers.formatUnits(supplyAmount, 6)}, ` +
      `disponible ${ethers.formatUnits(usdcBalance, 6)}.`
    );
  }
  console.log("1/3 — Fourniture de liquidité (rôle Farid)...");
  await (await usdc.approve(VAULT_ADDRESS, supplyAmount)).wait();
  await (await vault.supply(supplyAmount)).wait();
  console.log("     OK —", ethers.formatUnits(supplyAmount, 6), "USDC fournis.");
  console.log("");

  // ── 2. Dépôt du collatéral (rôle Marthe) ─────────────────────────────────
  console.log("2/3 — Dépôt du collatéral GLD...");
  await (await gld.approve(VAULT_ADDRESS, collateralAmount)).wait();
  await (await vault.depositCollateral(collateralAmount)).wait();
  console.log("     OK.");
  console.log("");

  // ── 3. Emprunt ────────────────────────────────────────────────────────────
  console.log("3/3 — Emprunt...");
  await (await vault.borrow(borrowAmount)).wait();
  console.log("     OK.");
  console.log("");

  const ltv = await vault.currentLTV(wallet.address);
  console.log("=== Terminé ===");
  console.log("LTV de la position :", (Number(ltv) / 100).toFixed(2), "%");
  console.log("Nouveau solde USDC  :", ethers.formatUnits(await usdc.balanceOf(wallet.address), 6));
  console.log("Le Prêt Lombard a désormais une position réelle ouverte, prêteur et");
  console.log("emprunteur — démontrable en soutenance, pas seulement spécifié.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
