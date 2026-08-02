// scripts/check-cirbtc-decimals.ts
//
// Vérification en lecture seule — à lancer AVANT de créer un nouveau marché
// Morpho avec cirBTC. Si decimals() != 8, il faudra redéployer un nouvel
// oracle avec le bon baseTokenDecimals plutôt que réutiliser celui déjà en
// place pour cbBTC.
//
// Usage :
//   npx hardhat run scripts/check-cirbtc-decimals.ts --network sepolia

import { network } from "hardhat";

const CIRBTC = "0x3a3fe695F684Bf9b9e43CF43C2b895Ea5e392bB3";

async function main() {
  const { ethers } = await network.create();
  const erc20Abi = [
    "function decimals() external view returns (uint8)",
    "function symbol() external view returns (string)",
    "function name() external view returns (string)",
  ];
  const cirbtc = new ethers.Contract(CIRBTC, erc20Abi, ethers.provider);

  const [decimals, symbol, name] = await Promise.all([
    cirbtc.decimals(),
    cirbtc.symbol(),
    cirbtc.name(),
  ]);

  console.log("name()     :", name);
  console.log("symbol()   :", symbol);
  console.log("decimals() :", decimals);
  console.log("");
  console.log(decimals === 8n
    ? "✅ 8 décimales confirmées — l'oracle cbBTC existant (mêmes decimals) peut être réutilisé tel quel."
    : `⚠️  ${decimals} décimales, PAS 8 — il faut redéployer un nouvel oracle avec baseTokenDecimals=${decimals}.`
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
