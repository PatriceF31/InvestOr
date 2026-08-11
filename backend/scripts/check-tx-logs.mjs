// check-tx-logs.mjs
//
// Inspecte le reçu d'une transaction et vérifie si EventLogger a émis
// un event ActionLogged pendant son exécution.
//
// Usage :
//   SEPOLIA_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/<ta-clé>" \
//   node check-tx-logs.mjs 0x862034f374553cf6c8edd593c04dd31cbe77ba8409dc39816c40ce51663c1d80

import { createPublicClient, http, decodeEventLog, getAddress } from "viem";
import { sepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ABI_PATH =
  process.env.EVENTLOGGER_ABI_PATH ??
  join(__dirname, "..", "ABI", "EventLoggerABI.json");
const EventLoggerABI = JSON.parse(readFileSync(ABI_PATH, "utf-8"));

const RPC_URL = process.env.SEPOLIA_RPC_URL;
const TX_HASH = process.argv[2];

if (!RPC_URL || !TX_HASH) {
  console.error("Usage: SEPOLIA_RPC_URL=... node check-tx-logs.mjs <tx_hash>");
  process.exit(1);
}

const EVENT_LOGGER = getAddress("0x70eFf6af5aCE213cEe7a3AFC4587db478c4F4b5a");

const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

async function main() {
  const receipt = await client.getTransactionReceipt({ hash: TX_HASH });

  console.log(`Statut       : ${receipt.status}`);
  console.log(`Bloc         : ${receipt.blockNumber}`);
  console.log(`Nombre de logs émis : ${receipt.logs.length}\n`);

  console.table(
    receipt.logs.map((log, i) => ({
      "#": i,
      Émetteur: log.address,
      "= EventLogger ?": getAddress(log.address) === EVENT_LOGGER ? "✅" : "",
      Topic0: log.topics[0]?.slice(0, 18) + "...",
    }))
  );

  const eventLoggerLogs = receipt.logs.filter(
    (log) => getAddress(log.address) === EVENT_LOGGER
  );

  if (eventLoggerLogs.length === 0) {
    console.log(
      "\n❌ Aucun log émis par EventLogger dans cette transaction.\n" +
        "   → Exchange.buy() n'a PAS appelé eventLogger.log() (ou l'appel a été absorbé " +
        "silencieusement, ex: try/catch autour de l'appel). Le contrat Exchange déployé " +
        "n'est probablement pas câblé vers EventLogger, malgré ce qu'indique la doc."
    );
    return;
  }

  console.log(`\n✅ ${eventLoggerLogs.length} log(s) émis par EventLogger :\n`);
  for (const log of eventLoggerLogs) {
    try {
      const decoded = decodeEventLog({
        abi: EventLoggerABI,
        data: log.data,
        topics: log.topics,
      });
      console.log(decoded.eventName, decoded.args);
    } catch (e) {
      console.log("(log non décodable avec cette ABI)", log);
    }
  }
}

main().catch((err) => {
  console.error("Erreur :", err);
  process.exit(1);
});
