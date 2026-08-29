// scripts/verify-lombard-wiring.ts
//
// Vérification en lecture seule, après les deux transactions Safe.
// Usage :
//   npx hardhat run scripts/verify-lombard-wiring.ts --network sepolia

import { network } from "hardhat";

const RESERVE_ADDRESS = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";
const VAULT_ADDRESS    = "0x4e1e4C06AA20bf589F99275Ac907a735F03b8E99";
const EXPECTED_OPERATOR = "0x7ad6030e13EaCc968184893729444724A6aDfcd3";

async function main() {
  const { ethers } = await network.create();

  const reserveAbi = ["function lombardVault() view returns (address)"];
  const reserve = new ethers.Contract(RESERVE_ADDRESS, reserveAbi, ethers.provider);

  const vault = await ethers.getContractAt("LombardVault", VAULT_ADDRESS);

  const [wiredVault, owner, operator, ltvMax, liqThreshold, borrowRate, supplierShare, protocolShare, discount] =
    await Promise.all([
      reserve.lombardVault(),
      vault.owner(),
      vault.operator(),
      vault.ltvMaxBps(),
      vault.liquidationThresholdBps(),
      vault.borrowRateBps(),
      vault.supplierShareBps(),
      vault.protocolShareBps(),
      vault.liquidationDiscountBps(),
    ]);

  console.log("=== Câblage ===");
  console.log("Reserve.lombardVault() :", wiredVault);
  console.log("LombardVault.owner()   :", owner, "(attendu : Reserve)");
  console.log("LombardVault.operator():", operator);
  console.log("");
  console.log("=== Paramètres (doivent être aux valeurs par défaut, rien n'a encore été modifié) ===");
  console.log("LTV max                :", ltvMax.toString(), "bps (attendu 7000)");
  console.log("Seuil de liquidation    :", liqThreshold.toString(), "bps (attendu 8000)");
  console.log("Taux d'emprunt          :", borrowRate.toString(), "bps (attendu 700)");
  console.log("Part prêteurs           :", supplierShare.toString(), "bps (attendu 400)");
  console.log("Part protocole          :", protocolShare.toString(), "bps (attendu 300)");
  console.log("Décote de liquidation   :", discount.toString(), "bps (attendu 500)");
  console.log("");

  const checks: [boolean, string][] = [
    [wiredVault.toLowerCase() === VAULT_ADDRESS.toLowerCase(), "Reserve pointe bien vers LombardVault"],
    [owner.toLowerCase() === RESERVE_ADDRESS.toLowerCase(), "LombardVault est bien owned par Reserve"],
    [operator.toLowerCase() === EXPECTED_OPERATOR.toLowerCase(), "operator() est bien réglé sur l'adresse attendue"],
    [ltvMax === 7000n, "LTV max = 70%"],
    [liqThreshold === 8000n, "Seuil de liquidation = 80%"],
    [borrowRate === 700n, "Taux d'emprunt = 7%/an"],
  ];

  console.log("=== Résumé ===");
  let allOk = true;
  for (const [ok, label] of checks) {
    console.log(ok ? "✅" : "❌", label);
    if (!ok) allOk = false;
  }
  console.log("");
  console.log(allOk
    ? "🎉 Câblage complet et cohérent — prêt pour le bootstrap."
    : "⚠️  Au moins une vérification a échoué — à regarder avant de continuer."
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
