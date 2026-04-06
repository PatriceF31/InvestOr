import { hardhat, sepolia } from "wagmi/chains";

export type ContractAddresses = {
  GLD: `0x${string}`;
  Treasury: `0x${string}`;
  Exchange: `0x${string}`;
  Reserve: `0x${string}`;
  EventLogger: `0x${string}`;
  SerialNumber: `0x${string}`;
};

// ── Adresses Sepolia ───────────────────────────────────────────────────────
const SEPOLIA_ADDRESSES: ContractAddresses = {
  GLD:          "0xA4ddCDf84F0C0acC8cA22E77f501d308C4E87dD4",
  Treasury:     "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af",
  Exchange:     "0x69C73469C427A9adbFA9a54E5a7711746A34d508",
  Reserve:      "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce",
  EventLogger:  "0x70eFf6af5aCE213cEe7a3AFC4587db478c4F4b5a",
  SerialNumber: "0x24622EfA10CfBA2B6F0e2845a89B09711293867d",
};

// ── Adresses Hardhat local ─────────────────────────────────────────────────
const HARDHAT_ADDRESSES: ContractAddresses = {
  GLD:          "0x0000000000000000000000000000000000000000",
  Treasury:     "0x0000000000000000000000000000000000000000",
  Exchange:     "0x0000000000000000000000000000000000000000",
  Reserve:      "0x0000000000000000000000000000000000000000",
  EventLogger:  "0x0000000000000000000000000000000000000000",
  SerialNumber: "0x0000000000000000000000000000000000000000",
};

const ADDRESSES: Record<number, ContractAddresses> = {
  [sepolia.id]: SEPOLIA_ADDRESSES,
  [hardhat.id]: HARDHAT_ADDRESSES,
};

export function getAddresses(chainId: number): ContractAddresses {
  return ADDRESSES[chainId] ?? SEPOLIA_ADDRESSES;
}
