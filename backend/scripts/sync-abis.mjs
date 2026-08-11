// sync-abis.mjs
//
// Extrait les ABIs depuis artifacts/ (générées par `npx hardhat compile`) et
// les recopie dans lib/abis côté frontend, en régénérant l'index.ts qui les
// réexporte. À relancer après chaque compilation qui change une interface
// (fonction, event ou erreur custom ajoutée/modifiée/supprimée).
//
// Usage :
//   npx hardhat compile && node scripts/sync-abis.mjs

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ⚠️ À adapter à ton arborescence réelle.
// Chemin vers artifacts/contracts, relatif à ce script (backend/scripts/).
const ARTIFACTS_DIR = join(__dirname, "..", "artifacts", "contracts");

// ⚠️ À adapter : dossier lib/abis du frontend. Si backend et frontend sont deux
// repos séparés (pas un monorepo), remplace par un chemin absolu, par ex. :
//   "/home/meu/dev/Projet/InvestOr/frontend/lib/abis"
const FRONTEND_ABIS_DIR = join(__dirname, "..", "..", "frontend", "lib", "abis");

// Liste des contrats à synchroniser. Ajoute une ligne ici à chaque fois qu'un
// nouveau contrat doit être appelé depuis le frontend.
const CONTRACTS = [
  { file: "Exchange.sol", name: "Exchange", export: "ExchangeABI" },
  { file: "Treasury.sol", name: "Treasury", export: "TreasuryABI" },
  { file: "Reserve.sol", name: "Reserve", export: "ReserveABI" },
  { file: "EventLogger.sol", name: "EventLogger", export: "EventLoggerABI" },
  { file: "GLD.sol", name: "GLD", export: "GLDABI" },
  { file: "LingotOr.sol", name: "LingotOr", export: "LingotOrABI" },
];

function main() {
  if (!existsSync(ARTIFACTS_DIR)) {
    console.error(`❌ ${ARTIFACTS_DIR} introuvable — lance d'abord 'npx hardhat compile'.`);
    process.exit(1);
  }

  if (!existsSync(FRONTEND_ABIS_DIR)) {
    mkdirSync(FRONTEND_ABIS_DIR, { recursive: true });
  }

  const exportLines = [];
  let updated = 0;

  for (const { file, name, export: exportName } of CONTRACTS) {
    const artifactPath = join(ARTIFACTS_DIR, file, `${name}.json`);

    if (!existsSync(artifactPath)) {
      console.warn(`⚠️  ${artifactPath} introuvable — contrat renommé/déplacé ? Ignoré.`);
      continue;
    }

    const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
    const abiPath = join(FRONTEND_ABIS_DIR, `${exportName}.json`);
    writeFileSync(abiPath, JSON.stringify(artifact.abi, null, 2) + "\n");
    console.log(`✅ ${exportName}.json (${artifact.abi.length} entrées)`);

    exportLines.push(`export { default as ${exportName} } from "./${exportName}.json";`);
    updated++;
  }

  const indexPath = join(FRONTEND_ABIS_DIR, "index.ts");
  const header =
    "// Généré automatiquement par backend/scripts/sync-abis.mjs — ne pas éditer à la main.\n" +
    "// Relance ce script après chaque 'npx hardhat compile' pour resynchroniser.\n\n";
  writeFileSync(indexPath, header + exportLines.join("\n") + "\n");

  console.log(`\n✅ index.ts régénéré (${updated}/${CONTRACTS.length} contrats)`);
  if (updated < CONTRACTS.length) {
    console.log("⚠️  Certains contrats n'ont pas été trouvés — vérifie la liste CONTRACTS et relance après compilation.");
  }
}

main();
