// verify-contracts.mjs
//
// Vérifie que les adresses de contrats InvestOr notées manuellement
// correspondent bien à des contrats déployés sur Sepolia, et diagnostique
// le bug "events EventLogger invisibles sur la dapp".
//
// Usage :
//   npm install viem
//   SEPOLIA_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/<ta-clé>" node verify-contracts.mjs
//
// (remplace par ton endpoint Alchemy/Infura habituel)

import { createPublicClient, http, isAddress, getAddress } from "viem";
import { sepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cherche l'ABI dans backend/ABI/ par défaut (script placé dans backend/scripts/).
// Surchargeable via EVENTLOGGER_ABI_PATH si ton arborescence diffère.
const ABI_PATH =
  process.env.EVENTLOGGER_ABI_PATH ??
  join(__dirname, "..", "ABI", "EventLoggerABI.json");

let EventLoggerABI;
try {
  EventLoggerABI = JSON.parse(readFileSync(ABI_PATH, "utf-8"));
} catch (err) {
  console.error(`❌ Impossible de lire l'ABI à : ${ABI_PATH}`);
  console.error(`   Corrige le chemin ou lance avec EVENTLOGGER_ABI_PATH="/chemin/vers/EventLoggerABI.json"`);
  process.exit(1);
}

const RPC_URL = process.env.SEPOLIA_RPC_URL;
if (!RPC_URL) {
  console.error("❌ Définis SEPOLIA_RPC_URL avant de lancer le script.");
  process.exit(1);
}

// Masque tout ce qui suit le host, quel que soit le format du provider (Alchemy /v2/, Infura /v3/, etc.)
function maskRpcUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/***`;
  } catch {
    return "(url invalide)";
  }
}

const client = createPublicClient({
  chain: sepolia,
  transport: http(RPC_URL),
});

// Adresses notées par Gisdu — à confronter à la chaîne
const CONTRACTS = {
  GLD: "0xA4ddCDf84F0C0acC8cA22E77f501d308C4E87dD4",
  Treasury: "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af",
  Exchange: "0x69C73469C427A9adbFA9a54E5a7711746A34d508",
  Reserve: "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce",
  EventLogger: "0x70eFf6af5aCE213cEe7a3AFC4587db478c4F4b5a",
  SerialNumber: "0x24622EfA10CfBA2B6F0e2845a89B09711293867d",
  LingotOr: "0x69159BBd5EaFf05C381497890F02d78F1b595A83",
  ReserveKeeper: "0x0F1F52138c93162538B61e80bEDfCd180e6fa5a1",
  IdentityRegistry: "0xE1a54BF8cfEeb58A3343Eeb6d63925AB03c5209C",
  CountryComplianceModule: "0xcCB5D93C17eEC2c7a8bb0E25D470810565bfE959",
};

// Slot standard EIP-1967 pour l'adresse d'implémentation d'un proxy UUPS/Transparent
const EIP1967_IMPL_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bb";

async function getImplementation(address) {
  try {
    const raw = await client.getStorageAt({ address, slot: EIP1967_IMPL_SLOT });
    if (!raw || /^0x0+$/.test(raw)) return null;
    return getAddress("0x" + raw.slice(-40));
  } catch {
    return null;
  }
}

async function checkContract(name, address) {
  const line = { name, address };

  if (!isAddress(address)) {
    line.status = "❌ adresse mal formée";
    return line;
  }

  const bytecode = await client.getCode({ address });
  if (!bytecode || bytecode === "0x") {
    line.status = "❌ AUCUN bytecode à cette adresse sur Sepolia (typo, mauvais réseau, ou pas déployé)";
    return line;
  }

  const impl = await getImplementation(address);
  line.status = "✅ bytecode présent";
  line.implementation = impl ?? "(pas un proxy EIP-1967, ou lecture impossible)";
  return line;
}

async function main() {
  console.log(`\nRéseau : Sepolia`);
  console.log(`RPC    : ${maskRpcUrl(RPC_URL)}\n`);

  const results = [];
  for (const [name, address] of Object.entries(CONTRACTS)) {
    results.push(await checkContract(name, address));
  }

  console.table(
    results.map((r) => ({
      Contrat: r.name,
      Adresse: r.address,
      Statut: r.status,
      Implémentation: r.implementation ?? "-",
    }))
  );

  // ── Diagnostic ciblé EventLogger ─────────────────────────────────────────
  console.log("\n── Diagnostic EventLogger ──\n");

  const eventLoggerAddress = CONTRACTS.EventLogger;

  const [totalEntries, owner, exchangeAuthorized, treasuryAuthorized] =
    await Promise.all([
      client.readContract({
        address: eventLoggerAddress,
        abi: EventLoggerABI,
        functionName: "totalEntries",
      }),
      client.readContract({
        address: eventLoggerAddress,
        abi: EventLoggerABI,
        functionName: "owner",
      }),
      client.readContract({
        address: eventLoggerAddress,
        abi: EventLoggerABI,
        functionName: "authorizedSources",
        args: [CONTRACTS.Exchange],
      }),
      client.readContract({
        address: eventLoggerAddress,
        abi: EventLoggerABI,
        functionName: "authorizedSources",
        args: [CONTRACTS.Treasury],
      }),
    ]);

  console.log(`totalEntries()                    = ${totalEntries}`);
  console.log(`owner()                            = ${owner}`);
  console.log(`authorizedSources(Exchange)        = ${exchangeAuthorized}`);
  console.log(`authorizedSources(Treasury)        = ${treasuryAuthorized}`);

  if (!exchangeAuthorized || !treasuryAuthorized) {
    console.log(
      "\n⚠️  Au moins une source n'est pas autorisée → c'est probablement la cause : " +
        "appelle authorizeSource() depuis le owner pour la source manquante."
    );
  } else if (totalEntries > 0n) {
    console.log(
      "\n➡️  Exchange et Treasury sont autorisés, ET des entrées existent déjà on-chain " +
        `(${totalEntries.toString()} au total). Le contrat fonctionne normalement : ` +
        "le bug est donc bien côté frontend (ABI utilisée, adresse configurée, ou méthode " +
        "de récupération des logs — getLogs / useWatchContractEvent / bloc de départ trop restrictif)."
    );
  } else {
    console.log(
      "\n➡️  Exchange et Treasury sont autorisés mais totalEntries() = 0 : " +
        "aucune opération n'a encore appelé log(), donc il est normal qu'il n'y ait rien à afficher. " +
        "Fais un buy()/sell() de test puis relance ce script."
    );
  }

  // Récupère les dernières entrées via l'API de lecture du contrat lui-même
  // (getRecentEntries) plutôt que via un scan getLogs — évite les limites de
  // plage de blocs imposées par les providers gratuits (Infura, Alchemy...).
  if (totalEntries > 0n) {
    const n = totalEntries > 5n ? 5n : totalEntries;
    const recent = await client.readContract({
      address: eventLoggerAddress,
      abi: EventLoggerABI,
      functionName: "getRecentEntries",
      args: [n],
    });
    console.log(`\nDernières entrées via getRecentEntries(${n}) :`);
    console.table(recent);
  } else {
    console.log("\n(getRecentEntries ignoré : totalEntries() = 0, rien à lister)");
  }
}

main().catch((err) => {
  console.error("Erreur :", err);
  process.exit(1);
});
