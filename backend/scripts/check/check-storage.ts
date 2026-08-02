/**
 * check-storage.ts
 * Vérifie le storage layout d'Exchange et Reserve avant tout upgrade UUPS.
 *
 * Usage :
 *   npx hardhat run scripts/check-storage.ts           # vérification normale
 *   npx hardhat run scripts/check-storage.ts -- --debug  # dump structure brute
 *
 * Comparaison entre deux versions :
 *   npx hardhat run scripts/check-storage.ts > storage-before.txt
 *   # modifier le contrat, puis : npx hardhat compile --force
 *   npx hardhat run scripts/check-storage.ts > storage-after.txt
 *   diff storage-before.txt storage-after.txt
 */

import fs   from "fs";
import path from "path";

// ─── Config ───────────────────────────────────────────────────────────────────

const CONTRACTS: { source: string; name: string }[] = [
  { source: "contracts/Exchange.sol", name: "Exchange" },
  { source: "contracts/Reserve.sol",  name: "Reserve"  },
  { source: "contracts/Treasury.sol", name: "Treasury" },
];

const DEBUG = process.argv.includes("--debug");

// ─── Types ────────────────────────────────────────────────────────────────────

interface StorageEntry {
  label:  string;
  slot:   string;
  offset: number;
  type:   string;
}

interface StorageLayout {
  storage: StorageEntry[];
  types:   Record<string, { label: string; numberOfBytes: string }>;
}

// ─── Lecture build-info ───────────────────────────────────────────────────────

function getBuildInfoFiles(): string[] {
  const buildInfoDir = path.join("artifacts", "build-info");
  if (!fs.existsSync(buildInfoDir)) {
    throw new Error(
      "artifacts/build-info introuvable.\n" +
      "Lance d'abord : npx hardhat compile --force"
    );
  }
  return fs.readdirSync(buildInfoDir)
    .filter(f => f.endsWith(".json"))
    .map(f => path.join(buildInfoDir, f))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs); // plus récent en premier
}

function findStorageLayout(source: string, name: string): StorageLayout | null {
  const files = getBuildInfoFiles();

  for (const filePath of files) {
    let bi: any;
    try {
      bi = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      continue;
    }

    if (DEBUG) {
      console.log(`\n[DEBUG] build-info: ${path.basename(filePath)}`);
      console.log("[DEBUG] Clés racine:", Object.keys(bi));
      if (bi.output) console.log("[DEBUG] bi.output keys:", Object.keys(bi.output));
      if (bi.output?.contracts) {
        const contractKeys = Object.keys(bi.output.contracts);
        console.log("[DEBUG] bi.output.contracts keys (premiers 10):", contractKeys.slice(0, 10));
        const exKey = contractKeys.find(k => k.includes("Exchange") || k.includes("Reserve"));
        if (exKey) {
          console.log(`[DEBUG] Clé trouvée: "${exKey}"`);
          console.log("[DEBUG] Sous-clés:", Object.keys(bi.output.contracts[exKey]));
        }
      }
    }

    // ── Tentative 1 : format Hardhat 2 / Hardhat 3 standard ─────────────────
    // bi.output.contracts["contracts/Exchange.sol"]["Exchange"].storageLayout
    const t1 = bi?.output?.contracts?.[source]?.[name]?.storageLayout;
    if (isValidLayout(t1)) return t1;

    // ── Tentative 2 : clé FQN directe ────────────────────────────────────────
    // bi.output.contracts["contracts/Exchange.sol:Exchange"].storageLayout
    const t2 = bi?.output?.contracts?.[`${source}:${name}`]?.storageLayout;
    if (isValidLayout(t2)) return t2;

    // ── Tentative 3 : storageLayout à la racine du contrat ───────────────────
    // Hardhat 3 viaIR peut aplatir la structure
    const t3 = bi?.output?.contracts?.[source]?.[name];
    if (t3 && isValidLayout(t3)) return t3;

    // ── Tentative 4 : via solcOutput (Hardhat 3 interne) ─────────────────────
    const t4 = bi?.solcOutput?.contracts?.[source]?.[name]?.storageLayout;
    if (isValidLayout(t4)) return t4;

    // ── Tentative 5 : recherche générique dans tout le JSON ──────────────────
    const t5 = deepSearch(bi, source, name);
    if (t5) return t5;
  }

  return null;
}

function isValidLayout(obj: any): obj is StorageLayout {
  return (
    obj !== null &&
    obj !== undefined &&
    typeof obj === "object" &&
    Array.isArray(obj.storage) &&
    typeof obj.types === "object"
  );
}

/**
 * Recherche récursive du storageLayout dans un arbre JSON.
 * S'arrête à profondeur 10 pour éviter les boucles infinies sur gros fichiers.
 */
function deepSearch(
  obj: any,
  source: string,
  name: string,
  depth = 0,
  inRightContext = false
): StorageLayout | null {
  if (depth > 10 || !obj || typeof obj !== "object") return null;

  // Si on trouve une clé storageLayout valide dans le bon contexte
  if (inRightContext && isValidLayout(obj.storageLayout)) {
    return obj.storageLayout;
  }

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const isContext =
      key === name ||
      key === source ||
      key === `${source}:${name}`;

    const result = deepSearch(val, source, name, depth + 1, inRightContext || isContext);
    if (result) return result;
  }

  return null;
}

// ─── Affichage ────────────────────────────────────────────────────────────────

function printLayout(name: string, layout: StorageLayout): void {
  const sep = "─".repeat(72);
  console.log(`\n${sep}`);
  console.log(`  ${name} — Storage Layout`);
  console.log(sep);
  console.log(`  ${"Slot".padEnd(6)} ${"Off".padEnd(5)} ${"Label".padEnd(30)} Type`);
  console.log(sep);

  [...layout.storage]
    .sort((a, b) => parseInt(a.slot) - parseInt(b.slot))
    .forEach(entry => {
      const typeLabel = layout.types?.[entry.type]?.label ?? entry.type;
      console.log(
        `  ${String(entry.slot).padEnd(6)} ${String(entry.offset).padEnd(5)} ${entry.label.padEnd(30)} ${typeLabel}`
      );
    });

  console.log(sep);
}

// ─── Vérifications UUPS ──────────────────────────────────────────────────────

function checkSlotBounds(name: string, layout: StorageLayout): boolean {
  let ok = true;
  for (const entry of layout.storage) {
    if (parseInt(entry.slot) > 49) {
      console.error(`❌  ${name}: "${entry.label}" dépasse slot 49 (slot ${entry.slot}) — OVERFLOW UUPS !`);
      ok = false;
    }
  }
  return ok;
}

function checkGapIntegrity(name: string, layout: StorageLayout): boolean {
  const explicit = layout.storage.filter(e => !e.label.startsWith("__gap"));
  const gapEntry = layout.storage.find(e => e.label === "__gap");

  if (!gapEntry) {
    console.warn(`⚠️   ${name}: __gap introuvable — vérifier manuellement`);
    return false;
  }

  const gapBytes = parseInt(layout.types?.[gapEntry.type]?.numberOfBytes ?? "0");
  const gapSlots = gapBytes / 32;
  const total    = explicit.length + gapSlots;

  if (total !== 50) {
    console.error(
      `❌  ${name}: ${explicit.length} slots + __gap[${gapSlots}] = ${total} ≠ 50`
    );
    return false;
  }

  console.log(`✅  ${name}: ${explicit.length} slots + __gap[${gapSlots}] = 50`);
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║           InvestOr — Vérification Storage Layout UUPS              ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");

  // Vérifier que outputSelection est dans le config
  const configFile = ["hardhat.config.ts", "hardhat.config.js"].find(fs.existsSync);
  if (configFile) {
    const cfg = fs.readFileSync(configFile, "utf-8");
    if (!cfg.includes("storageLayout")) {
      console.error(
        "\n❌  'storageLayout' absent de " + configFile +
        "\n    Ajouter dans chaque profil solidity :" +
        "\n      outputSelection: { \"*\": { \"*\": [\"storageLayout\"] } }"
      );
      process.exitCode = 1;
      return;
    }
  }

  let allOk = true;

  for (const { source, name } of CONTRACTS) {
    process.stdout.write(`\n⏳  Lecture de ${name}...`);
    const layout = findStorageLayout(source, name);

    if (!layout) {
      console.error(
        `\r❌  ${name}: storageLayout introuvable` +
        `\n    → npx hardhat compile --force  puis relancer ce script`
      );
      allOk = false;
      continue;
    }

    process.stdout.write(`\r`);
    printLayout(name, layout);
    const boundsOk = checkSlotBounds(name, layout);
    const gapOk    = checkGapIntegrity(name, layout);
    if (!boundsOk || !gapOk) allOk = false;
  }

  console.log("\n" + "═".repeat(72));
  if (allOk) {
    console.log("✅  Storage layouts valides — upgrade UUPS sûr.");
  } else {
    console.log("❌  Problèmes détectés — NE PAS upgrader avant correction.");
    process.exitCode = 1;
  }
  console.log("═".repeat(72) + "\n");
}

main().catch(err => { console.error(err); process.exitCode = 1; });
