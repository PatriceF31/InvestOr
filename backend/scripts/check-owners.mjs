// check-owners.mjs
//
// Vérifie qui est réellement owner() sur Exchange et Treasury (le Safe, ou
// encore le wallet déployeur ?). À lancer avant de retenter le batch Safe.
//
// Usage :
//   SEPOLIA_RPC_URL="https://sepolia.infura.io/v3/<ta-clé>" node check-owners.mjs

import { createPublicClient, http, getAddress } from "viem";
import { sepolia } from "viem/chains";

const RPC_URL = process.env.SEPOLIA_RPC_URL;
if (!RPC_URL) {
  console.error("❌ Définis SEPOLIA_RPC_URL avant de lancer le script.");
  process.exit(1);
}

const client = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });

const OWNER_ABI = [
  {
    inputs: [],
    name: "owner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
];

const SAFE = getAddress("0x7f7533Ea6aA203d07eBB6F06aE1a8A4AD0B33917");

const CONTRACTS = {
  Exchange: "0x69C73469C427A9adbFA9a54E5a7711746A34d508",
  Treasury: "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af",
  EventLogger: "0x70eFf6af5aCE213cEe7a3AFC4587db478c4F4b5a",
  Reserve: "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce",
};

async function main() {
  for (const [name, address] of Object.entries(CONTRACTS)) {
    try {
      const owner = await client.readContract({
        address,
        abi: OWNER_ABI,
        functionName: "owner",
      });
      const isSafe = getAddress(owner) === SAFE;
      console.log(
        `${name.padEnd(12)} owner() = ${owner}  ${isSafe ? "✅ = Safe" : "❌ ≠ Safe"}`
      );
    } catch (e) {
      console.log(`${name.padEnd(12)} erreur de lecture : ${e.shortMessage ?? e.message}`);
    }
  }
}

main().catch((err) => {
  console.error("Erreur :", err);
  process.exit(1);
});
